import axios from 'axios';
import { ProverJobInput, ProverJobResult, ProverFindingResult } from '../types';
import { PoCSynthesizer } from '../ai/poc-synthesizer';
import { SolcCompiler } from '../sandbox/solc-compiler';
import { EvmSimulator } from '../sandbox/evm-simulator';
import { TraceFormatter } from '../trace/trace-formatter';

export class JobManager {
  private static jobs: Map<string, ProverJobResult> = new Map();

  static getJob(jobId: string): ProverJobResult | undefined {
    return this.jobs.get(jobId);
  }

  static async processJob(job: ProverJobInput): Promise<ProverJobResult> {
    const startTime = Date.now();
    console.log(`[JobManager] Processing job ${job.jobId} for audit ${job.auditId} (${job.findingsToProve.length} finding(s) to prove)...`);

    const results: ProverFindingResult[] = [];

    // Attempt compiling the original contract
    const compileResult = SolcCompiler.compileSources({
      [job.contractFileName]: job.sourceCode,
    });

    for (const finding of job.findingsToProve) {
      console.log(`[JobManager] Synthesizing PoC for finding: ${finding.id} (${finding.title})`);
      
      // Step 1: Synthesize PoC exploit
      const synthesizedPoC = await PoCSynthesizer.synthesizePoC(
        job.contractFileName,
        job.sourceCode,
        finding,
      );

      // Step 2: Run simulation in virtual sandbox
      const findingResult = await EvmSimulator.simulateExploit({
        contractFileName: job.contractFileName,
        sourceCode: job.sourceCode,
        finding,
        synthesizedPoC,
        artifacts: compileResult.artifacts,
      });

      // Step 3: Format and sanitize trace steps
      findingResult.traceSteps = TraceFormatter.sanitizeTrace(findingResult.traceSteps);
      findingResult.summary = TraceFormatter.formatSummary(findingResult);

      results.push(findingResult);
    }

    const durationMs = Date.now() - startTime;
    const finalResult: ProverJobResult = {
      jobId: job.jobId,
      auditId: job.auditId,
      status: 'COMPLETED',
      durationMs,
      results,
    };

    this.jobs.set(job.jobId, finalResult);
    console.log(`[JobManager] Job ${job.jobId} finished in ${durationMs}ms with ${results.length} result(s).`);

    // Step 4: Dispatch callback webhook to zyron-backend if provided
    if (job.callbackUrl) {
      this.dispatchCallback(job.callbackUrl, finalResult).catch((err) => {
        console.warn(`[JobManager] Webhook callback failed for ${job.callbackUrl}: ${err.message}`);
      });
    }

    return finalResult;
  }

  private static async dispatchCallback(callbackUrl: string, result: ProverJobResult) {
    const crypto = await import('crypto');
    const { CALLBACK_SHARED_SECRET } = await import('../config/env');
    const payloadStr = JSON.stringify(result);
    const hmacSig = crypto.createHmac('sha256', CALLBACK_SHARED_SECRET).update(payloadStr).digest('hex');

    console.log(`[JobManager] Dispatching authenticated prover callback to ${callbackUrl}...`);
    await axios.post(callbackUrl, result, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-Zyron-Agent-Signature': `sha256=${hmacSig}`,
      },
    });
    console.log(`[JobManager] Callback successfully delivered to ${callbackUrl}`);
  }
}
