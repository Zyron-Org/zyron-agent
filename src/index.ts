import express from 'express';
import cors from 'cors';
import { PORT } from './config/env';
import { router } from './api/routes';
import { fileQueue } from './api/controllers';
import { ProverWorker } from './queue/worker';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(router);

const worker = new ProverWorker(fileQueue);

const server = app.listen(PORT, async () => {
  console.log(`
=============================================================
🛡️  ZYRON AUTONOMOUS AI AGENT & EVM SANDBOX PROVER (v2.0)
=============================================================
  Service Port:     ${PORT}
  Health Check:     http://localhost:${PORT}/health
  Submit Prover:    http://localhost:${PORT}/api/v1/prover/jobs
  Read-Only RPC:    http://localhost:${PORT}/rpc/:network
  Queue Persistence: ./data/jobs/
  Streaming Logs:   ./logs/jobs/
=============================================================
`);

  await worker.start();
});

export { app, server, worker };
