import { Router } from 'express';
import { ProverController } from './controllers';
import { requireApiKey } from './auth.middleware';

export const router = Router();

// Public health probe
router.get('/health', ProverController.health);

// Authenticated prover endpoints
router.post('/api/v1/prover/jobs', requireApiKey, ProverController.submitJob);
router.get('/api/v1/prover/jobs/:jobId', requireApiKey, ProverController.getJob);
router.post('/api/v1/prover/simulate', requireApiKey, ProverController.simulateInstant);

