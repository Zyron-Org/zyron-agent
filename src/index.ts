import express from 'express';
import cors from 'cors';
import { PORT } from './config/env';
import { router } from './api/routes';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(router);

const server = app.listen(PORT, () => {
  console.log(`
=============================================================
🛡️  ZYRON AUTONOMOUS AI AGENT & EVM SANDBOX PROVER
=============================================================
  Service Port:   ${PORT}
  Health Check:   http://localhost:${PORT}/health
  Submit Prover:  http://localhost:${PORT}/api/v1/prover/jobs
  Instant Sim:    http://localhost:${PORT}/api/v1/prover/simulate
=============================================================
`);
});

export { app, server };
