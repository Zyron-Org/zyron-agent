import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ForgeTraceParser } from '../src/trace/forge-trace';
import { HarnessVerifier } from '../src/agent/verifier';
import { MockExecutor } from '../src/sandbox/mock-executor';
import { ProverAgent } from '../src/agent/prover-agent';
import { TranscriptLogger } from '../src/logging/transcript-logger';
import { LlmProvider } from '../src/llm/provider';
import { LlmMessage, ToolDefinition, LlmResponse } from '../src/llm/types';

describe('Phase 3 Agent Workflow, Verifier & Trace Parsing', () => {
  const testWorkspace = path.join(process.cwd(), 'data', 'test-phase3-ws');
  const testLogs = path.join(process.cwd(), 'logs', 'test-phase3');

  beforeEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    if (fs.existsSync(testLogs)) {
      fs.rmSync(testLogs, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    if (fs.existsSync(testLogs)) {
      fs.rmSync(testLogs, { recursive: true, force: true });
    }
  });

  describe('ForgeTraceParser', () => {
    it('should parse successful test run and extract gas', () => {
      const forgeOutput = `
Running 1 test for test/zyron/Exploit.t.sol:ExploitTest
[PASS] test_exploit() (gas: 142100)
Traces:
  [142100] ExploitTest::test_exploit()
    ├─ [45000] Target::deposit{value: 1000000000000000000}()
    ├─ [62000] Target::withdraw()
    └─ ← [Return]
Test result: ok. 1 passed; 0 failed; 0 skipped; finished in 12.34ms
`;

      const parsed = ForgeTraceParser.parse(forgeOutput, 'test_exploit');
      expect(parsed.success).toBe(true);
      expect(parsed.traceSteps.length).toBeGreaterThanOrEqual(1);
      expect(parsed.traceSteps.some((s) => s.functionName.includes('deposit'))).toBe(true);
    });

    it('should parse failed test run and capture revert reason', () => {
      const forgeOutput = `
Running 1 test for test/zyron/Exploit.t.sol:ExploitTest
[FAIL. Reason: LOCKED] test_exploit() (gas: 82000)
Traces:
  [82000] ExploitTest::test_exploit()
    ├─ [35000] Target::withdraw()
    │   └─ ← [Revert] LOCKED
    └─ ← [Revert] LOCKED
Test result: FAILED. 0 passed; 1 failed; 0 skipped
`;

      const parsed = ForgeTraceParser.parse(forgeOutput, 'test_exploit');
      expect(parsed.success).toBe(false);
      expect(parsed.revertReason).toContain('LOCKED');
    });
  });

  describe('HarnessVerifier', () => {
    it('should reject verdict if original target contract was modified (anti-tamper)', async () => {
      const executor = new MockExecutor(testWorkspace);
      await executor.startSession();

      // Register git status showing modified target file
      executor.registerResponse('git status --porcelain', {
        stdout: ' M src/Vault.sol\n?? test/zyron/Exploit.t.sol',
        exitCode: 0,
      });

      const result = await HarnessVerifier.verify(
        executor,
        { id: 'F-1', title: 'Reentrancy', severity: 'CRITICAL', description: '' },
        {
          verdict: 'PROVEN_EXPLOIT',
          testFile: 'test/zyron/Exploit.t.sol',
          testFunction: 'test_exploit',
          reasoning: 'Drained funds',
        },
        ['src/Vault.sol']
      );

      expect(result.status).toBe('CANNOT_REPRODUCE');
      expect(result.summary).toContain('Anti-tamper violation');
    });

    it('should independently execute test and confirm PROVEN_EXPLOIT when test passes', async () => {
      const executor = new MockExecutor(testWorkspace);
      await executor.startSession();

      await executor.writeFile('test/zyron/Exploit.t.sol', 'contract ExploitTest {}');

      executor.registerResponse('git status --porcelain', {
        stdout: '?? test/zyron/Exploit.t.sol',
        exitCode: 0,
      });

      executor.registerResponse('forge test --match-path "test/zyron/Exploit.t.sol"', {
        stdout: '[PASS] test_exploit() (gas: 215000)\nTest result: ok. 1 passed;',
        exitCode: 0,
      });

      const result = await HarnessVerifier.verify(
        executor,
        { id: 'F-1', title: 'Reentrancy', severity: 'CRITICAL', description: '' },
        {
          verdict: 'PROVEN_EXPLOIT',
          testFile: 'test/zyron/Exploit.t.sol',
          testFunction: 'test_exploit',
          reasoning: 'Successfully drained 10 ETH',
          fundsDrainedEth: 10,
        },
        ['src/Vault.sol']
      );

      expect(result.status).toBe('PROVEN_EXPLOIT');
      expect(result.confidence).toBe('HIGH');
      expect(result.fundsDrainedEth).toBe(10);
    });
  });

  describe('ProverAgent Loop', () => {
    it('should complete multi-turn tool interaction and submit proven exploit', async () => {
      const executor = new MockExecutor(testWorkspace);
      await executor.startSession();

      await executor.writeFile('src/Target.sol', 'contract Target { function withdraw() external {} }');

      executor.registerResponse('git status --porcelain', {
        stdout: '?? test/zyron/FINDING_001.t.sol',
        exitCode: 0,
      });

      executor.registerResponse('forge test', {
        stdout: '[PASS] test_exploit() (gas: 150000)\nTest result: ok. 1 passed;',
        exitCode: 0,
      });

      let turnCount = 0;
      const mockLlm: LlmProvider = {
        providerName: 'mock',
        modelName: 'mock-llm',
        async chat(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
          turnCount++;
          if (turnCount === 1) {
            return {
              content: 'I will inspect the target code.',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'read_file',
                  arguments: { filePath: 'src/Target.sol' },
                },
              ],
            };
          }
          if (turnCount === 2) {
            return {
              content: 'Now I will write the Foundry exploit test.',
              toolCalls: [
                {
                  id: 'call-2',
                  name: 'write_file',
                  arguments: {
                    filePath: 'test/zyron/FINDING_001.t.sol',
                    content: 'contract ExploitTest { function test_exploit() public {} }',
                  },
                },
              ],
            };
          }
          return {
            content: 'The exploit succeeded. Submitting verdict.',
            toolCalls: [
              {
                id: 'call-3',
                name: 'submit_verdict',
                arguments: {
                  verdict: 'PROVEN_EXPLOIT',
                  testFile: 'test/zyron/FINDING_001.t.sol',
                  testFunction: 'test_exploit',
                  reasoning: 'Reentrancy condition verified.',
                  fundsDrainedEth: 50,
                },
              },
            ],
          };
        },
      };

      const logger = new TranscriptLogger('test-job-loop', 'FINDING-001', testLogs);

      const result = await ProverAgent.proveFinding(
        mockLlm,
        executor,
        { id: 'FINDING-001', title: 'Reentrancy', severity: 'CRITICAL', description: '' },
        ['src/Target.sol'],
        logger
      );

      expect(result.status).toBe('PROVEN_EXPLOIT');
      expect(result.fundsDrainedEth).toBe(50);
      expect(turnCount).toBe(3);

      const entries = logger.readEntries();
      expect(entries.length).toBeGreaterThanOrEqual(6);
    });
  });
});
