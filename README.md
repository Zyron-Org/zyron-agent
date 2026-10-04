# 🛡️ Zyron Agent — Autonomous AI & EVM Sandbox Prover Microservice

[![Node.js Version](https://img.shields.io/badge/Node.js-22%20LTS-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Foundry](https://img.shields.io/badge/Foundry-Forge%20%26%20Anvil-black.svg)](https://getfoundry.sh/)
[![Google Gemini](https://img.shields.io/badge/LLM-Gemini%20Flash-orange.svg)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

**`zyron-agent`** is the autonomous security prover microservice of the **Zyron Security Protocol**. It acts as an autonomous virtual security researcher, taking static vulnerability findings, reasoning about exploit mechanics using Google Gemini LLMs, synthesizing concrete Foundry (`.t.sol`) proof-of-concept exploits, and executing them inside isolated EVM sandboxes to verify exploitability and eliminate false positives.

---

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Key Features](#-key-features)
- [Repository Structure](#-repository-structure)
- [Prerequisites](#-prerequisites)
- [Local Development Setup](#-local-development-setup)
- [Environment Configuration](#-environment-configuration)
- [Deployment Guide](#-deployment-guide)
  - [1. PM2 Process Manager (Recommended for Single Servers)](#1-pm2-process-manager)
  - [2. Systemd Service (Linux Bare-Metal / VPS)](#2-systemd-service)
  - [3. Docker Container Deployment](#3-docker-container-deployment)
  - [4. Production Kubernetes / Cloud ECS](#4-production-kubernetes--cloud-ecs)
- [API Reference](#-api-reference)
- [Security & Sandbox Isolation](#-security--sandbox-isolation)
- [Testing & Verification](#-testing--verification)

---

## 🏛️ Architecture Overview

The `zyron-agent` service sits between `zyron-backend` and ephemeral EVM execution sandboxes:

```
┌─────────────────┐             POST /api/v1/prover/jobs             ┌─────────────────────────┐
│                 │ ───────────────────────────────────────────────> │                         │
│  zyron-backend  │                                                  │       zyron-agent       │
│  (Port 4000)    │ <─────────────────────────────────────────────── │       (Port 5001)       │
└─────────────────┘       POST /api/v1/scanner/prover-callback       └────────────┬────────────┘
                                (HMAC SHA-256 Authenticated)                      │
                                                                                  │
                       ┌──────────────────────────────────────────────────────────┴────────────────────────────────┐
                       ▼                                                                                          ▼
       ┌──────────────────────────────┐                                                           ┌──────────────────────────────┐
       │   Google Gemini LLM Engine   │                                                           │     EVM Sandbox Executor     │
       │  (gemini-3.5-flash-lite)     │                                                           │                              │
       │  • Vulnerability Analysis    │                                                           │  • Docker Sandbox (Foundry)  │
       │  • PoC Exploit Synthesis     │                                                           │  • In-Memory EVM Simulator   │
       │  • False-Positive Reasoning  │                                                           │  • Read-Only RPC Gateway     │
       └──────────────────────────────┘                                                           └──────────────────────────────┘
```

### Execution Lifecycle

1. **Job Ingestion**: `zyron-backend` submits an audit request and suspected findings to `POST /api/v1/prover/jobs`.
2. **Persistent Queueing**: Jobs are recorded in the disk-backed FIFO queue (`data/jobs/`) with automated crash-recovery guarantees.
3. **Workspace Bootstrap**: The worker clones the repository or writes the target contracts and Foundry project scaffold into an isolated workspace directory (`data/workspaces/<jobId>`).
4. **Autonomous AI Reasoning Loop**:
   - The agent inspects contract source code, AST findings, and potential exploit vectors.
   - Synthesizes a dedicated Foundry test suite (`test/zyron/FINDING_XXX.t.sol`).
5. **Sandbox Execution**:
   - **Docker Sandbox Mode**: Runs inside an unprivileged Ubuntu 24.04 container with Foundry (`forge test -vvvv`) and strict memory/CPU limits.
   - **Local Simulation Mode**: If Docker is not running, falls back to the internal `EvmSimulator` with opcode call traces.
6. **Result Packaging & Callback**:
   - Transcripts, step-by-step EVM call traces, and synthesized PoC code are logged to `logs/jobs/<jobId>.jsonl`.
   - Sends a cryptographically signed HMAC callback to `zyron-backend` to update audit findings in real time.

---

## ✨ Key Features

- **Autonomous PoC Synthesis**: Automatically crafts working Foundry test suites proving or disproving exploitability.
- **False-Positive Elimination**: Validates whether protections (e.g., `ReentrancyGuard`, checks-effects-interactions, access modifiers) neutralize suspected vectors.
- **Interactive Replay & Trace Generation**: Produces line-by-line EVM execution traces (`CALL`, `DELEGATECALL`, gas consumption, storage modifications) for display in the client and auditor workbench.
- **Dual Sandbox Engines**:
  - **Docker Sandbox Engine**: Ephemeral container execution with Foundry, Node.js 22, and multi-version `solc-select` (0.8.20, 0.8.24, 0.8.28).
  - **In-Memory EVM Simulator**: Rapid zero-dependency simulation fallback when container runtimes are unavailable.
- **Read-Only RPC Reverse Proxy**: Built-in RPC gateway allowing sandboxes to safely fork live mainnet or Arbitrum state without leaking private RPC keys.
- **Fault-Tolerant File Queue**: Preserves job states across restarts; automatically resumes crashed or interrupted jobs.

---

## 📂 Repository Structure

```
zyron-agent/
├── docker/
│   └── Dockerfile.sandbox          # Ephemeral Foundry sandbox container image
├── scripts/
│   └── test-agent-e2e.ts           # End-to-end exploit synthesis & sandbox test
├── src/
│   ├── agent/                      # Autonomous prover agent loop & verifier
│   │   ├── prover-agent.ts         # Main LLM reasoning & tool loop
│   │   ├── tools.ts                # Agent tool definitions (bash, solc, read, write)
│   │   └── verifier.ts             # Exploit verification & result parser
│   ├── api/                        # Express HTTP API & middleware
│   │   ├── auth.middleware.ts      # API key verification
│   │   ├── controllers.ts          # Prover HTTP controller
│   │   └── routes.ts               # API route definitions
│   ├── config/                     # Environment and service configuration
│   │   └── env.ts                  # Typed environment loader
│   ├── llm/                        # LLM provider abstraction & Gemini client
│   │   ├── gemini.provider.ts      # Google Gemini 3.5 API integration
│   │   └── provider.ts             # Provider interface
│   ├── logging/                    # Transcript and execution streaming
│   │   └── transcript-logger.ts    # JSONL event logger
│   ├── queue/                      # Persistent job queue & background worker
│   │   ├── file-queue.ts           # Disk-backed FIFO queue
│   │   ├── job-manager.ts          # Job status tracker
│   │   └── worker.ts               # Background worker polling loop
│   ├── rpc/                        # Read-only RPC gateway for mainnet forks
│   │   └── rpc-gateway.ts          # Sanitized JSON-RPC reverse proxy
│   ├── sandbox/                    # Execution sandboxes
│   │   ├── docker-executor.ts      # Docker container executor
│   │   ├── evm-simulator.ts        # In-memory EVM state simulator
│   │   ├── executor.ts             # Base executor interface
│   │   └── solc-compiler.ts        # In-process solc compilation helper
│   ├── types/                      # TypeScript domain types & interfaces
│   ├── workspace/                  # Workspace scaffold & repository bootstrapper
│   │   └── bootstrap.ts            # Foundry project scaffolding
│   └── index.ts                    # Microservice entrypoint & server bootstrap
├── .env.example                    # Environment variable template
├── package.json                    # Dependencies & npm scripts
└── tsconfig.json                   # TypeScript compiler configuration
```

---

## 📋 Prerequisites

| Requirement | Minimum Version | Recommended | Notes |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 20.0.0` | `22.x LTS` | Required runtime |
| **npm** | `>= 9.0.0` | `10.x` | Package manager |
| **Foundry** | Latest | `foundryup` | Required for native test runs |
| **Docker** | `>= 24.0.0` | Latest | Required for Docker sandbox isolation |
| **Gemini API Key** | N/A | Active Key | [Google AI Studio](https://aistudio.google.com/) |

---

## 🚀 Local Development Setup

### 1. Clone & Install Dependencies

```bash
cd zyron-agent
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and provide your Google Gemini API key:

```bash
cp .env.example .env
```

Edit `.env`:
```env
PORT=5001
NODE_ENV=development
GEMINI_API_KEY="AIzaSy..."
GEMINI_MODEL="gemini-3.5-flash-lite"
AGENT_API_KEY="zyron_agent_internal_secret_key_2026_secure"
CALLBACK_SHARED_SECRET="zyron_callback_hmac_secret_2026"
BACKEND_URL="http://localhost:4000"
```

### 3. Build Sandbox Docker Image (Optional but Recommended)

If you plan to run live Docker sandboxes:

```bash
docker build -f docker/Dockerfile.sandbox -t zyron-sandbox:latest .
```

### 4. Start Development Server

```bash
npm run dev
```

The service will start on `http://localhost:5001`:
```text
=============================================================
🛡️  ZYRON AUTONOMOUS AI AGENT & EVM SANDBOX PROVER (v2.0)
=============================================================
  Service Port:     5001
  Health Check:     http://localhost:5001/health
  Submit Prover:    http://localhost:5001/api/v1/prover/jobs
  Read-Only RPC:    http://localhost:5001/rpc/:network
  Queue Persistence: ./data/jobs/
  Streaming Logs:   ./logs/jobs/
=============================================================
```

---

## ⚙️ Environment Configuration

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `PORT` | No | `5001` | HTTP port for the Express microservice |
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`, `test`) |
| `GEMINI_API_KEY` | **Yes** | — | Google Gemini API key for autonomous AI reasoning |
| `GEMINI_MODEL` | No | `gemini-3.5-flash-lite` | Gemini model (`gemini-3.5-flash-lite`, `gemini-3.5-flash`) |
| `AGENT_API_KEY` | **Yes** | — | Secret key shared with `zyron-backend` via `x-zyron-agent-key` header |
| `CALLBACK_SHARED_SECRET` | **Yes** | — | Secret key used to generate HMAC-SHA256 callback signatures |
| `BACKEND_URL` | No | `http://localhost:4000` | Target URL of `zyron-backend` for webhook delivery |
| `RPC_MAINNET` | No | `https://cloudflare-eth.com` | Read-only Ethereum RPC used for mainnet fork tests |
| `RPC_ARBITRUM` | No | `https://arb1.arbitrum.io/rpc` | Read-only Arbitrum One RPC |
| `RPC_SEPOLIA` | No | `https://sepolia-rollup.arbitrum.io/rpc` | Read-only Arbitrum Sepolia RPC |
| `AGENT_PRIVATE_KEY` | No | — | Optional Ethereum private key for signing prover attestations |

---

## 🚢 Deployment Guide

### 1. PM2 Process Manager

PM2 provides daemonization, zero-downtime reloads, and automatic crash recovery on VPS or dedicated servers.

1. **Build the TypeScript application**:
   ```bash
   npm run build
   ```

2. **Install PM2 globally**:
   ```bash
   npm install -g pm2
   ```

3. **Create `ecosystem.config.js` in `zyron-agent/`**:
   ```javascript
   module.exports = {
     apps: [
       {
         name: "zyron-agent",
         script: "dist/index.js",
         instances: 1, // Single worker maintains orderly FIFO queue processing
         autorestart: true,
         watch: false,
         max_memory_restart: "2G",
         env: {
           NODE_ENV: "production",
           PORT: 5001,
         },
       },
     ],
   };
   ```

4. **Launch with PM2**:
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

---

### 2. Systemd Service

For Ubuntu / Debian production hosts:

1. **Create service file** `/etc/systemd/system/zyron-agent.service`:
   ```ini
   [Unit]
   Description=Zyron AI Agent & EVM Sandbox Prover Microservice
   After=network.target docker.service
   Requires=docker.service

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/var/www/zyron/zyron-agent
   ExecStart=/usr/bin/node dist/index.js
   Restart=always
   RestartSec=5
   Environment=NODE_ENV=production
   EnvironmentFile=/var/www/zyron/zyron-agent/.env
   StandardOutput=append:/var/log/zyron-agent.log
   StandardError=append:/var/log/zyron-agent-error.log
   LimitNOFILE=65535

   [Install]
   WantedBy=multi-user.target
   ```

2. **Enable and start the service**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable zyron-agent
   sudo systemctl start zyron-agent
   sudo systemctl status zyron-agent
   ```

---

### 3. Docker Container Deployment

To run the entire agent service inside Docker:

1. **Create `Dockerfile` in `zyron-agent/`**:
   ```dockerfile
   FROM node:22-bullseye-slim

   WORKDIR /app

   # Install Docker CLI so the agent can spawn sandbox sibling containers
   RUN apt-get update && apt-get install -y --no-install-recommends \
       curl \
       ca-certificates \
       gnupg \
       && install -m 0755 -d /etc/apt/keyrings \
       && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
       && chmod a+r /etc/apt/keyrings/docker.gpg \
       && echo "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bullseye stable" > /etc/apt/sources.list.d/docker.list \
       && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
       && rm -rf /var/lib/apt/lists/*

   COPY package*.json ./
   RUN npm ci

   COPY . .
   RUN npm run build

   EXPOSE 5001

   CMD ["node", "dist/index.js"]
   ```

2. **Run container with mounted Docker socket**:
   ```bash
   docker run -d \
     --name zyron-agent \
     --restart unless-stopped \
     -p 5001:5001 \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v $(pwd)/data:/app/data \
     -v $(pwd)/logs:/app/logs \
     --env-file .env \
     zyron-agent:latest
   ```

---

### 4. Production Kubernetes / Cloud ECS

When deploying to Kubernetes:

- **Volume Mounts**: Mount persistent storage at `/app/data` and `/app/logs` so job queues and transcripts survive pod restarts.
- **Liveness Probe**:
  ```yaml
  livenessProbe:
    httpGet:
      path: /health
      port: 5001
    initialDelaySeconds: 10
    periodSeconds: 15
  ```
- **Readiness Probe**:
  ```yaml
  readinessProbe:
    httpGet:
      path: /health
      port: 5001
    initialDelaySeconds: 5
    periodSeconds: 10
  ```
- **Resources**: Recommended minimum of `2 CPU cores` and `4GB RAM` per agent pod to support concurrent Solidity compilations and test replays.

---

## 📡 API Reference

All `/api/v1/prover/*` endpoints require the `x-zyron-agent-key` header matching `AGENT_API_KEY`.

### 1. Health Probe
```http
GET /health
```
**Response (200 OK):**
```json
{
  "status": "healthy",
  "service": "zyron-agent",
  "version": "2.0.0",
  "timestamp": 1791108342
}
```

---

### 2. Submit Prover Job
```http
POST /api/v1/prover/jobs
Content-Type: application/json
x-zyron-agent-key: <AGENT_API_KEY>
```

**Payload:**
```json
{
  "auditId": "ZYR-9481",
  "findings": [
    {
      "id": "ZYR-9481-001",
      "ruleId": "SWC-107",
      "severity": "CRITICAL",
      "title": "State-Change Reentrancy in VaultCore.withdraw()",
      "location": "VaultCore.sol:45",
      "description": "External ETH call before state decrement enables drainage."
    }
  ],
  "contractFileName": "VaultCore.sol",
  "sourceCode": "// Solidity code...",
  "repo": {
    "url": "https://github.com/protocol/vault",
    "branch": "main",
    "commit": "8f9b2d4"
  }
}
```

**Response (202 Accepted):**
```json
{
  "jobId": "job-1791108342000-abc123",
  "status": "QUEUED",
  "position": 1,
  "estimatedTimeMs": 15000
}
```

---

### 3. Query Job Status
```http
GET /api/v1/prover/jobs/:jobId
x-zyron-agent-key: <AGENT_API_KEY>
```

**Response (200 OK):**
```json
{
  "jobId": "job-1791108342000-abc123",
  "auditId": "ZYR-9481",
  "status": "COMPLETED",
  "results": [
    {
      "findingId": "ZYR-9481-001",
      "fuzzTestStatus": "PASSED",
      "falsePositive": false,
      "synthesizedPoC": "contract ExploitTest is Test { ... }",
      "traceSteps": [
        {
          "step": 1,
          "caller": "0xAttacker",
          "target": "0xVaultCore",
          "functionName": "deposit()",
          "value": "1.0 ETH",
          "status": "SUCCESS"
        }
      ]
    }
  ]
}
```

---

### 4. Fetch Execution Transcript
```http
GET /api/v1/prover/jobs/:jobId/transcript
x-zyron-agent-key: <AGENT_API_KEY>
```
Returns line-delimited JSONL execution events, including LLM tool calls, compiler outputs, and trace step evaluations.

---

### 5. Read-Only RPC Fork Proxy
```http
POST /rpc/:network
Content-Type: application/json
```
Proxies read-only RPC requests (`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`) to upstream networks for sandbox test execution. State-mutating methods (`eth_sendTransaction`, `eth_sendRawTransaction`) are strictly rejected.

Supported `:network` values: `mainnet`, `arbitrum`, `sepolia`.

---

## 🔒 Security & Sandbox Isolation

1. **Non-Root Execution**: Ephemeral sandbox containers execute as the unprivileged `zyron` user (`UID 1000`). Root access is strictly prohibited.
2. **Read-Only Root Filesystems**: Temporary workspaces are mounted exclusively under `/workspace`.
3. **Strict Resource Constraints**: Docker containers run with memory caps (default: `2GB`), CPU allocation caps, and execution timeouts (default: `120s`).
4. **Network Filtering**: The internal RPC reverse proxy blocks destructive RPC methods, outbound WAN connections, and internal private subnet traversal.
5. **HMAC Webhook Signatures**: All callbacks delivered to `zyron-backend` include `x-zyron-agent-signature` calculated using SHA-256 HMAC:
   ```text
   HMAC-SHA256(payload, CALLBACK_SHARED_SECRET)
   ```

---

## 🧪 Testing & Verification

### Run Unit Tests
```bash
npm test
```

### Run End-to-End Exploit Synthesis Test
Executes a full cycle against a sample reentrant vault contract:
```bash
npm run test:e2e
```

Example E2E Output:
```text
=============================================================
🧪 ZYRON AGENT: STANDALONE END-TO-END VERIFICATION TEST
=============================================================
Target Contract: EtherVault.sol
Target Finding:  [CRITICAL] State-Change Reentrancy in EtherVault.withdraw()
-------------------------------------------------------------
[Agent] Synthesizing Foundry PoC test...
[Sandbox] Compiling exploit test suite...
[Sandbox] Executing forge test...
Test result: ok. 1 passed; 0 failed.
[Verifier] Invariant breach confirmed. Vulnerability verified!
✅ End-to-end verification passed!
```

---

## 📄 License

This microservice is open-source software licensed under the **[MIT License](LICENSE)**.
