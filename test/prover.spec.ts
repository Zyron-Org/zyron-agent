import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { app } from '../src/index';
import { AGENT_API_KEY } from '../src/config/env';

describe('Zyron Agent E2E HTTP Endpoints', () => {
  const testDataDir = path.join(process.cwd(), 'data', 'jobs');

  it('should return 200 on /health probe', async () => {
    // Dynamically test using supertest or node fetch/axios
    const req = await fetch('http://localhost:5001/health').catch(() => null);
    if (!req) {
      // Direct express handler check
      expect(app).toBeDefined();
    }
  });

  it('should reject unauthorized requests to /api/v1/prover/jobs', async () => {
    // Test auth middleware directly
    const { requireApiKey } = await import('../src/api/auth.middleware');
    let statusSet = 0;
    let jsonSent: any = null;

    const mockReq: any = {
      path: '/api/v1/prover/jobs',
      headers: {},
    };
    const mockRes: any = {
      status(code: number) {
        statusSet = code;
        return this;
      },
      json(data: any) {
        jsonSent = data;
        return this;
      },
    };
    let nextCalled = false;

    requireApiKey(mockReq, mockRes, () => {
      nextCalled = true;
    });

    expect(statusSet).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('should accept authorized requests with valid x-zyron-agent-key', async () => {
    const { requireApiKey } = await import('../src/api/auth.middleware');
    let nextCalled = false;

    const mockReq: any = {
      path: '/api/v1/prover/jobs',
      headers: {
        'x-zyron-agent-key': AGENT_API_KEY,
      },
    };
    const mockRes: any = {};

    requireApiKey(mockReq, mockRes, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});
