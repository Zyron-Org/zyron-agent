import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  isMethodAllowed,
  handleRpcRequest,
  ALLOWED_RPC_METHODS,
  FORBIDDEN_RPC_METHODS,
} from '../src/rpc/rpc-gateway';
import { MockExecutor } from '../src/sandbox/mock-executor';
import { DockerExecutor } from '../src/sandbox/docker-executor';

describe('Phase 2 Docker Sandbox & RPC Gateway', () => {
  const testWorkspace = path.join(process.cwd(), 'data', 'test-phase2-ws');

  beforeEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe('Read-Only RPC Gateway Security Filter', () => {
    it('should permit safe read-only RPC methods', () => {
      expect(isMethodAllowed('eth_call')).toBe(true);
      expect(isMethodAllowed('eth_getBalance')).toBe(true);
      expect(isMethodAllowed('eth_getCode')).toBe(true);
      expect(isMethodAllowed('eth_chainId')).toBe(true);
      expect(isMethodAllowed('eth_blockNumber')).toBe(true);
      expect(isMethodAllowed('eth_getStorageAt')).toBe(true);
    });

    it('should strictly forbid transaction broadcasting and signing methods', () => {
      expect(isMethodAllowed('eth_sendRawTransaction')).toBe(false);
      expect(isMethodAllowed('eth_sendTransaction')).toBe(false);
      expect(isMethodAllowed('personal_sendTransaction')).toBe(false);
      expect(isMethodAllowed('eth_sign')).toBe(false);
      expect(isMethodAllowed('personal_sign')).toBe(false);
      expect(isMethodAllowed('eth_signTypedData_v4')).toBe(false);
    });

    it('should intercept forbidden method without calling upstream network', async () => {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: ['0xf86c01...'],
      };

      const result = await handleRpcRequest(payload, 'http://non-existent-url:8545');

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32601);
      expect(result.error.message).toContain('Security Policy Violation');
    });

    it('should filter batch requests individually', async () => {
      const batchPayload = [
        { jsonrpc: '2.0', id: 10, method: 'eth_sendRawTransaction', params: [] },
        { jsonrpc: '2.0', id: 11, method: 'unknown_dangerous_method', params: [] },
      ];

      const results = await handleRpcRequest(batchPayload, 'http://non-existent-url:8545');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      expect(results[0].error.code).toBe(-32601);
      expect(results[1].error.code).toBe(-32601);
    });
  });

  describe('Sandbox Executor Contract & Operations', () => {
    it('should start session, execute commands and write/read files with MockExecutor', async () => {
      const executor = new MockExecutor(testWorkspace);
      await executor.startSession();

      executor.registerResponse('forge build', {
        stdout: '[⠢] Compiling...\nCompiler run successful!',
        exitCode: 0,
      });

      const execResult = await executor.exec('forge build');
      expect(execResult.exitCode).toBe(0);
      expect(execResult.stdout).toContain('Compiler run successful!');

      await executor.writeFile('src/Target.sol', 'contract Target {}');
      expect(await executor.fileExists('src/Target.sol')).toBe(true);

      const content = await executor.readFile('src/Target.sol');
      expect(content).toBe('contract Target {}');

      await executor.endSession();
    });

    it('should instantiate DockerExecutor with sanitized container names and limits', () => {
      const dockerExec = new DockerExecutor({
        jobId: 'ZYR:JOB/01#alpha',
        workspaceDir: testWorkspace,
        memoryLimit: '2g',
        cpuLimit: '2.0',
      });

      expect(dockerExec.containerName).toBe('zyron-job-ZYR_JOB_01_alpha');
      expect(dockerExec.workspaceDir).toBe(testWorkspace);
    });
  });
});
