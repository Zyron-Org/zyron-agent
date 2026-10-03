import { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { FileQueue } from '../queue/file-queue';
import { ProverJobInput } from '../types';
import { TranscriptLogger } from '../logging/transcript-logger';

const fileQueue = new FileQueue();

export class ProverController {
  static async health(req: Request, res: Response) {
    res.json({
      status: 'healthy',
      service: 'zyron-agent-prover',
      engine: 'autonomous-foundry-agent',
      version: '2.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }

  static async submitJob(req: Request, res: Response) {
    const body = req.body as ProverJobInput & { repo?: any; findings?: any };
    const findings = body.findingsToProve || body.findings;

    if (!body.auditId || (!body.sourceCode && !body.repo) || !findings) {
      return res.status(400).json({
        error: 'Missing required fields: auditId, (sourceCode or repo), findings are mandatory.',
      });
    }

    const jobId = body.jobId || `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const queuedJob = fileQueue.enqueue({
      jobId,
      auditId: body.auditId,
      status: 'QUEUED',
      repo: body.repo,
      contractFileName: body.contractFileName,
      sourceCode: body.sourceCode,
      callbackUrl: body.callbackUrl,
      findings,
    });

    return res.status(202).json({
      message: 'Prover job queued for execution in autonomous sandbox',
      jobId,
      auditId: body.auditId,
      status: queuedJob.status,
      findingsCount: findings.length,
    });
  }

  static async getJob(req: Request, res: Response) {
    const jobId = String(req.params.jobId);
    const job = fileQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: `Job ${jobId} not found` });
    }

    return res.json(job);
  }

  static async getTranscript(req: Request, res: Response) {
    const jobId = String(req.params.jobId);
    const findingId = req.query.findingId ? String(req.query.findingId) : undefined;

    const logger = new TranscriptLogger(jobId, findingId);
    const entries = logger.readEntries();

    return res.json({
      jobId,
      findingId,
      entriesCount: entries.length,
      entries,
    });
  }
}

export { fileQueue };
