import { Router } from 'express';
import { ProverController } from './controllers';

export const router = Router();

router.get('/health', ProverController.health);
router.post('/api/v1/prover/jobs', ProverController.submitJob);
router.get('/api/v1/prover/jobs/:jobId', ProverController.getJob);
router.post('/api/v1/prover/simulate', ProverController.simulateInstant);
