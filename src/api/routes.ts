import { Router } from 'express';
import { ProverController } from './controllers';
import { requireApiKey } from './auth.middleware';
import { createRpcGatewayRouter } from '../rpc/rpc-gateway';

export const router = Router();

// Public health probe
router.get('/health', ProverController.health);

// Read-Only RPC Gateway for sandbox local EVM mainnet forks
router.use(createRpcGatewayRouter());

// Authenticated prover endpoints
router.post('/api/v1/prover/jobs', requireApiKey, ProverController.submitJob);
router.get('/api/v1/prover/jobs/:jobId', requireApiKey, ProverController.getJob);
router.get('/api/v1/prover/jobs/:jobId/transcript', requireApiKey, ProverController.getTranscript);
