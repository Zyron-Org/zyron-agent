import * as fs from 'fs';
import * as path from 'path';
import { FindingToProve, ProverFindingResult } from '../types';

export type JobStatus = 'QUEUED' | 'RUNNING' | 'DELIVERING' | 'COMPLETED' | 'FAILED';

export interface RepoConfig {
  url?: string;
  branch?: string;
  commit?: string;
}

export interface StoredJob {
  jobId: string;
  auditId: string;
  status: JobStatus;
  repo?: RepoConfig;
  contractFileName?: string;
  sourceCode?: string;
  compilerVersion?: string;
  network?: string;
  callbackUrl?: string;
  findings: FindingToProve[];
  results?: ProverFindingResult[];
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  retryCount?: number;
}

export class FileQueue {
  private readonly queueDir: string;

  constructor(baseDir = path.join(process.cwd(), 'data', 'jobs')) {
    this.queueDir = baseDir;
    if (!fs.existsSync(this.queueDir)) {
      fs.mkdirSync(this.queueDir, { recursive: true });
    }
  }

  getQueueDir(): string {
    return this.queueDir;
  }

  private getJobPath(jobId: string): string {
    return path.join(this.queueDir, `${jobId}.json`);
  }

  enqueue(
    jobData: Omit<StoredJob, 'status' | 'createdAt'> & { status?: JobStatus; createdAt?: number }
  ): StoredJob {
    const job: StoredJob = {
      ...jobData,
      status: jobData.status || 'QUEUED',
      createdAt: jobData.createdAt || Date.now(),
      retryCount: jobData.retryCount || 0,
    };

    this.atomicSave(job);
    return job;
  }

  getJob(jobId: string): StoredJob | undefined {
    const filePath = this.getJobPath(jobId);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data) as StoredJob;
    } catch (err: any) {
      console.error(`[FileQueue] Error reading job ${jobId}: ${err.message}`);
      return undefined;
    }
  }

  updateJob(jobId: string, updates: Partial<StoredJob>): StoredJob | undefined {
    const current = this.getJob(jobId);
    if (!current) {
      return undefined;
    }
    const updated: StoredJob = {
      ...current,
      ...updates,
    };
    this.atomicSave(updated);
    return updated;
  }

  getNextQueuedJob(): StoredJob | undefined {
    const allJobs = this.listJobs();
    const queued = allJobs
      .filter((j) => j.status === 'QUEUED')
      .sort((a, b) => a.createdAt - b.createdAt);

    return queued[0];
  }

  /**
   * Recovers jobs that were interrupted in RUNNING or DELIVERING status upon process startup.
   */
  recoverCrashedJobs(): number {
    const allJobs = this.listJobs();
    let recoveredCount = 0;

    for (const job of allJobs) {
      if (job.status === 'RUNNING' || job.status === 'DELIVERING') {
        console.warn(`[FileQueue] Recovering interrupted job ${job.jobId} (was ${job.status})...`);
        this.updateJob(job.jobId, {
          status: 'QUEUED',
          retryCount: (job.retryCount || 0) + 1,
        });
        recoveredCount++;
      }
    }

    return recoveredCount;
  }

  listJobs(): StoredJob[] {
    if (!fs.existsSync(this.queueDir)) {
      return [];
    }
    const files = fs.readdirSync(this.queueDir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    const jobs: StoredJob[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.queueDir, file), 'utf8');
        jobs.push(JSON.parse(content));
      } catch {
        // Skip malformed temporary files
      }
    }

    return jobs;
  }

  private atomicSave(job: StoredJob): void {
    const targetPath = this.getJobPath(job.jobId);
    const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(tmpPath, targetPath);
  }
}
