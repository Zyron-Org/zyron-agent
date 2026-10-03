import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as crypto from 'crypto';
import { FileQueue, StoredJob } from './file-queue';
import { LlmProvider } from '../llm/provider';
import { GeminiProvider } from '../llm/gemini.provider';
import { Executor } from '../sandbox/executor';
import { DockerExecutor } from '../sandbox/docker-executor';
import { WorkspaceBootstrap } from '../workspace/bootstrap';
import { ProverAgent } from '../agent/prover-agent';
import { TranscriptLogger } from '../logging/transcript-logger';
import { ProverFindingResult } from '../types';
import { CALLBACK_SHARED_SECRET, BACKEND_URL, AGENT_API_KEY } from '../config/env';

export interface WorkerOptions {
  pollIntervalMs?: number;
  workspacesBaseDir?: string;
  executorFactory?: (jobId: string, workspaceDir: string) => Executor;
}

export class ProverWorker {
  private readonly fileQueue: FileQueue;
  private readonly llmProvider: LlmProvider;
  private readonly pollIntervalMs: number;
  private readonly workspacesBaseDir: string;
  private readonly executorFactory: (jobId: string, workspaceDir: string) => Executor;
  private isRunning = false;
  private isProcessing = false;

  constructor(
    fileQueue: FileQueue,
    llmProvider?: LlmProvider,
    options: WorkerOptions = {}
  ) {
    this.fileQueue = fileQueue;
    this.llmProvider = llmProvider || new GeminiProvider();
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.workspacesBaseDir = options.workspacesBaseDir || path.join(process.cwd(), 'data', 'workspaces');
    this.executorFactory =
      options.executorFactory ||
      ((jobId, wsDir) => new DockerExecutor({ jobId, workspaceDir: wsDir }));
  }

  async start(): Promise<void> {
    this.isRunning = true;
    const recovered = this.fileQueue.recoverCrashedJobs();
    if (recovered > 0) {
      console.log(`[ProverWorker] Recovered ${recovered} crashed job(s) back to QUEUED.`);
    }

    console.log('[ProverWorker] Single-worker queue processor started.');
    this.loop();
  }

  stop(): void {
    this.isRunning = false;
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      if (!this.isProcessing) {
        const nextJob = this.fileQueue.getNextQueuedJob();
        if (nextJob) {
          this.isProcessing = true;
          try {
            await this.processJob(nextJob);
          } catch (err: any) {
            console.error(`[ProverWorker] Unexpected error in job ${nextJob.jobId}: ${err.message}`);
          } finally {
            this.isProcessing = false;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async processJob(job: StoredJob): Promise<void> {
    const startTime = Date.now();
    console.log(`[ProverWorker] Processing job ${job.jobId} for audit ${job.auditId} (${job.findings.length} findings)...`);

    this.fileQueue.updateJob(job.jobId, {
      status: 'RUNNING',
      startedAt: startTime,
    });

    const jobWorkspace = path.join(this.workspacesBaseDir, job.jobId);
    const executor = this.executorFactory(job.jobId, jobWorkspace);
    const results: ProverFindingResult[] = [];

    try {
      await executor.startSession();

      // Bootstrap workspace
      let githubToken: string | undefined;
      if (job.repo?.url) {
        try {
          const credRes = await axios.get(
            `${BACKEND_URL}/api/v1/scanner/audits/${job.auditId}/repo-credentials`,
            {
              headers: { 'x-zyron-agent-key': AGENT_API_KEY },
              timeout: 5000,
            }
          );
          if (credRes.data?.token) {
            githubToken = credRes.data.token;
          }
        } catch (err: any) {
          console.warn(`[ProverWorker] Could not fetch repo credentials: ${err.message}`);
        }
      }

      const bootstrap = await WorkspaceBootstrap.setup(executor, job, githubToken);
      if (!bootstrap.success) {
        throw new Error(`Workspace bootstrap failed: ${bootstrap.buildOutput}`);
      }

      for (const finding of job.findings) {
        console.log(`[ProverWorker] Beginning prover loop for finding: ${finding.id} (${finding.title})`);
        const logger = new TranscriptLogger(job.jobId, finding.id);

        const result = await ProverAgent.proveFinding(
          this.llmProvider,
          executor,
          finding,
          bootstrap.originalFiles,
          logger,
          { initialBuildOutput: bootstrap.buildOutput }
        );

        results.push(result);
      }

      const durationMs = Date.now() - startTime;
      this.fileQueue.updateJob(job.jobId, {
        status: 'DELIVERING',
        results,
        completedAt: Date.now(),
        durationMs,
      });

      // Dispatch webhook callback if configured
      if (job.callbackUrl) {
        await this.dispatchCallback(job.callbackUrl, {
          jobId: job.jobId,
          auditId: job.auditId,
          status: 'COMPLETED',
          durationMs,
          results,
        });
      }

      this.fileQueue.updateJob(job.jobId, {
        status: 'COMPLETED',
      });

      console.log(`[ProverWorker] Job ${job.jobId} successfully completed in ${durationMs}ms.`);
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err.message || 'Prover worker execution failed';
      console.error(`[ProverWorker] Job ${job.jobId} failed: ${errorMsg}`);

      this.fileQueue.updateJob(job.jobId, {
        status: 'FAILED',
        error: errorMsg,
        completedAt: Date.now(),
        durationMs,
      });

      if (job.callbackUrl) {
        await this.dispatchCallback(job.callbackUrl, {
          jobId: job.jobId,
          auditId: job.auditId,
          status: 'FAILED',
          error: errorMsg,
          durationMs,
          results: [],
        }).catch((e) => console.warn(`[ProverWorker] Failure callback failed: ${e.message}`));
      }
    } finally {
      // Cleanup container session
      await executor.endSession().catch(() => {});

      // Cleanup workspace files if not debugging
      if (process.env.KEEP_WORKSPACES !== 'true' && fs.existsSync(jobWorkspace)) {
        try {
          fs.rmSync(jobWorkspace, { recursive: true, force: true });
        } catch (e: any) {
          console.warn(`[ProverWorker] Could not remove workspace ${jobWorkspace}: ${e.message}`);
        }
      }
    }
  }

  private async dispatchCallback(callbackUrl: string, payload: any): Promise<void> {
    const payloadStr = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', CALLBACK_SHARED_SECRET);
    hmac.update(payloadStr);
    const signature = `sha256=${hmac.digest('hex')}`;

    console.log(`[ProverWorker] Dispatching authenticated HMAC callback to ${callbackUrl}...`);
    await axios.post(callbackUrl, payload, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'X-Zyron-Agent-Signature': signature,
      },
    });
    console.log(`[ProverWorker] Callback delivered successfully.`);
  }
}
