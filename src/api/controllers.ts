import { Request, Response } from 'express';
import { JobManager } from '../queue/job-manager';
import { ProverJobInput } from '../types';

export class ProverController {
  static async health(req: Request, res: Response) {
    res.json({
      status: 'healthy',
      service: 'zyron-agent-prover',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }

  static async submitJob(req: Request, res: Response) {
    const body = req.body as ProverJobInput;
    const findings = body.findingsToProve || (body as any).findings;
    if (!body.auditId || !body.sourceCode || !findings) {
      return res.status(400).json({
        error: 'Missing required fields: auditId, sourceCode, findingsToProve are mandatory.',
      });
    }

    const jobId = body.jobId || `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const jobInput: ProverJobInput = { ...body, findingsToProve: findings, jobId };

    // Fire asynchronous background processing
    JobManager.processJob(jobInput).catch((err) => {
      console.error(`[ProverController] Background job ${jobId} failed: ${err.message}`);
    });

    return res.status(202).json({
      message: 'Prover job queued for execution',
      jobId,
      auditId: body.auditId,
      status: 'QUEUED',
      findingsCount: findings.length,
    });
  }

  static async getJob(req: Request, res: Response) {
    const jobId = String(req.params.jobId);
    const result = JobManager.getJob(jobId);

    if (!result) {
      return res.status(404).json({ error: `Job ${jobId} not found` });
    }

    return res.json(result);
  }

  static async simulateInstant(req: Request, res: Response) {
    const body = req.body as ProverJobInput;
    const findings = body.findingsToProve || (body as any).findings;

    if (!body.sourceCode || !findings) {
      return res.status(400).json({
        error: 'Missing required fields: sourceCode and findingsToProve are mandatory.',
      });
    }

    const jobId = body.jobId || `sim-${Date.now()}`;
    const result = await JobManager.processJob({ ...body, findingsToProve: findings, jobId });

    return res.json(result);
  }
}
