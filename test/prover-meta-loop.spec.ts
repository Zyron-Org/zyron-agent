import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MetaProvider, HttpFetch } from '../src/llm/meta.provider';
import { ProverAgent } from '../src/agent/prover-agent';
import { MockExecutor } from '../src/sandbox/mock-executor';
import { TranscriptLogger } from '../src/logging/transcript-logger';
import { sha256 } from '../src/agent/verifier';

function metaResponse(toolCalls: Array<{ id: string; name: string; args: Record<string, any> }>, content = '') {
  return {
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        id: 'cmpl-meta',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content,
              tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }),
  };
}

describe('Meta AI in ProverAgent Investigation Loop', () => {
  const ws = path.join(process.cwd(), 'data', 'test-meta-loop-ws');
  const logsDir = path.join(process.cwd(), 'logs', 'test-meta-loop');
  const vaultCode = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract VulnerableVault {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        uint256 b = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: b}("");
        require(ok);
        balances[msg.sender] = 0;
    }
}`;

  beforeEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it('drives multi-turn Meta tool selection (read -> write -> run_forge_test -> submit_verdict) and records auditable evidence', async () => {
    const ex = new MockExecutor(ws);
    await ex.startSession();
    await ex.writeFile('src/VulnerableVault.sol', vaultCode);
    const sourceHashes = { 'src/VulnerableVault.sol': sha256(vaultCode) };

    ex.registerResponse('forge test', {
      stdout: '[PASS] test_exploit_reentrancy() (gas: 184200)\nTest result: ok. 1 passed;',
      exitCode: 0,
    });

    let callIdx = 0;
    const fetchImpl: HttpFetch = async () => {
      callIdx++;
      if (callIdx === 1) {
        return metaResponse(
          [{ id: 'tc1', name: 'read_file', args: { filePath: 'src/VulnerableVault.sol' } }],
          'Reading target contract to inspect state update ordering in withdraw().'
        );
      }
      if (callIdx === 2) {
        return metaResponse(
          [
            {
              id: 'tc2',
              name: 'write_file',
              args: {
                filePath: 'test/zyron/ZYR_001.t.sol',
                content:
                  'import "../../src/VulnerableVault.sol";\ncontract ExploitTest { function test_exploit_reentrancy() public { assertEq(uint256(1), uint256(1)); } }',
              },
            },
          ],
          'Writing Foundry reentrancy reproduction test.'
        );
      }
      if (callIdx === 3) {
        return metaResponse(
          [{ id: 'tc3', name: 'run_forge_test', args: { testFile: 'test/zyron/ZYR_001.t.sol', testFunction: 'test_exploit_reentrancy' } }],
          'Executing Foundry test inside sandbox.'
        );
      }
      return metaResponse(
        [
          {
            id: 'tc4',
            name: 'submit_verdict',
            args: {
              verdict: 'PROVEN_EXPLOIT',
              testFile: 'test/zyron/ZYR_001.t.sol',
              testFunction: 'test_exploit_reentrancy',
              reasoning: 'External call precedes balance zeroing in withdraw().',
              fundsDrainedEth: 10,
            },
          },
        ],
        'Test passed; submitting claim for independent verification.'
      );
    };

    const meta = new MetaProvider({ apiKey: 'test-key', model: 'muse-spark-1.3', fetchImpl, logger: () => {} });
    const logger = new TranscriptLogger('job-meta-1', 'ZYR-001', logsDir);

    const result = await ProverAgent.proveFinding(
      meta,
      ex,
      { id: 'ZYR-001', ruleId: 'ZYRON-08-001', severity: 'CRITICAL', title: 'Reentrancy in withdraw()', description: 'CEI violation' },
      ['src/VulnerableVault.sol'],
      logger,
      { sourceHashes }
    );

    expect(result.status).toBe('PROVEN_EXPLOIT');
    expect(result.model).toEqual({ provider: 'meta', model: 'muse-spark-1.3', turns: 4, totalTokens: 560 });
    expect(result.investigation?.map((s) => s.tool)).toEqual(['read_file', 'write_file', 'run_forge_test', 'submit_verdict']);
    expect(result.verification?.finalStatus).toBe('PROVEN_EXPLOIT');
    expect(result.verification?.runs).toHaveLength(2);
  });

  it('returns INCONCLUSIVE when turn budget expires without a verified proof', async () => {
    const ex = new MockExecutor(ws);
    await ex.startSession();
    await ex.writeFile('src/VulnerableVault.sol', vaultCode);

    const fetchImpl: HttpFetch = async () =>
      metaResponse([{ id: 'tc', name: 'list_dir', args: { dirPath: '.' } }], 'Listing directory.');

    const meta = new MetaProvider({ apiKey: 'test-key', model: 'muse-spark-1.3', fetchImpl, logger: () => {} });
    const logger = new TranscriptLogger('job-meta-2', 'ZYR-002', logsDir);

    const result = await ProverAgent.proveFinding(
      meta,
      ex,
      { id: 'ZYR-002', severity: 'MEDIUM', title: 'Unresolved', description: '' },
      ['src/VulnerableVault.sol'],
      logger,
      { maxTurns: 2, sourceHashes: { 'src/VulnerableVault.sol': sha256(vaultCode) } }
    );

    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.summary).toMatch(/Turn budget \(2\) exhausted/);
  });
});
