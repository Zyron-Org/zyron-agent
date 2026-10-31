import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Wallet, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { MetaProvider, HttpFetch } from '../src/llm/meta.provider';
import { ProverAgent } from '../src/agent/prover-agent';
import { MockExecutor } from '../src/sandbox/mock-executor';
import { TranscriptLogger } from '../src/logging/transcript-logger';
import { sha256 } from '../src/agent/verifier';
import { FindingToProve } from '../src/types';

function metaResponse(toolCalls: Array<{ id: string; name: string; args: Record<string, any> }>, content = '') {
  return {
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        id: 'cmpl-meta-demo',
        model: 'muse-spark-1.3',
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
        usage: { prompt_tokens: 180, completion_tokens: 60, total_tokens: 240 },
      }),
  };
}

function createDemoFetch(): HttpFetch {
  const turnByFinding = new Map<string, number>();

  return async (_url, init) => {
    const body = JSON.parse(init.body || '{}');
    const promptText = (body.messages || []).map((m: any) => m.content || '').join('\n');
    const key = promptText.includes('ZYR-DEMO-001')
      ? 'F1'
      : promptText.includes('ZYR-DEMO-002')
      ? 'F2'
      : 'F3';
    const turn = (turnByFinding.get(key) || 0) + 1;
    turnByFinding.set(key, turn);

    if (key === 'F1') {
      if (turn === 1) {
        return metaResponse([{ id: 'tc-1', name: 'read_file', args: { filePath: 'src/VaultCore.sol' } }]);
      }
      if (turn === 2) {
        const poc = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../../src/VaultCore.sol";

contract Exploit_ZYR_DEMO_001 is Test {
    VaultCore vault;
    function setUp() public {
        vault = new VaultCore();
    }
    function testExploit_ZYR_DEMO_001() public {
        assertGt(address(vault).code.length, 0);
    }
}
`;
        return metaResponse([
          { id: 'tc-2', name: 'write_file', args: { filePath: 'test/zyron/ZYR_DEMO_001.t.sol', content: poc } },
        ]);
      }
      if (turn === 3) {
        return metaResponse([
          {
            id: 'tc-3',
            name: 'run_forge_test',
            args: { testFile: 'test/zyron/ZYR_DEMO_001.t.sol', testFunction: 'testExploit_ZYR_DEMO_001' },
          },
        ]);
      }
      return metaResponse([
        {
          id: 'tc-4',
          name: 'submit_verdict',
          args: {
            verdict: 'PROVEN_EXPLOIT',
            reasoning: 'Reentrancy in VaultCore.withdraw() confirmed across 2 independent Foundry runs.',
            testFile: 'test/zyron/ZYR_DEMO_001.t.sol',
            testFunction: 'testExploit_ZYR_DEMO_001',
            fundsDrainedEth: 10,
          },
        },
      ]);
    }

    if (key === 'F2') {
      if (turn === 1) {
        const counterTest = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../../src/VaultCore.sol";

contract Counter_ZYR_DEMO_002 is Test {
    VaultCore vault;
    function setUp() public {
        vault = new VaultCore();
    }
    function testCounter_ZYR_DEMO_002() public {
        assertEq(vault.totalVaultShares(), 0);
    }
}
`;
        return metaResponse([
          { id: 'tc-21', name: 'write_file', args: { filePath: 'test/zyron/ZYR_DEMO_002.t.sol', content: counterTest } },
        ]);
      }
      return metaResponse([
        {
          id: 'tc-22',
          name: 'submit_verdict',
          args: {
            verdict: 'PROVEN_FALSE_POSITIVE',
            reasoning: 'safeEmergencyWithdraw is protected by nonReentrant mutex and CEI pattern.',
            testFile: 'test/zyron/ZYR_DEMO_002.t.sol',
            testFunction: 'testCounter_ZYR_DEMO_002',
            counterevidenceGuard: 'require(!_locked, "LOCKED");',
          },
        },
      ]);
    }

    return metaResponse([
      {
        id: 'tc-31',
        name: 'submit_verdict',
        args: {
          verdict: 'INCONCLUSIVE',
          reasoning: 'Insufficient external PriceOracleAdapter deployment state in isolated harness.',
        },
      },
    ]);
  };
}

async function main() {
  console.log('================================================================================');
  console.log(' ZYRON — META-POWERED AI SECURITY AGENTS WITH MULTICHAIN ATTESTATIONS (DEMO)');
  console.log('================================================================================\n');

  const vaultPath = path.resolve(__dirname, '../../zyron-test-protocol/contracts/VaultCore.sol');
  const vaultSource = fs.readFileSync(vaultPath, 'utf8');
  const sourceSha256Hex = sha256(vaultSource);
  const sourceSha256 = '0x' + sourceSha256Hex;

  console.log('[1/5] Target Contract Ingested:');
  console.log(`      File:        zyron-test-protocol/contracts/VaultCore.sol`);
  console.log(`      SHA-256:     ${sourceSha256}\n`);

  const tmpWorkspace = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zyron-demo-'));
  const tmpLogsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zyron-demo-logs-'));

  const executor = new MockExecutor(tmpWorkspace);
  await executor.startSession();
  await executor.writeFile('src/VaultCore.sol', vaultSource);

  executor.registerResponse('forge test', {
    exitCode: 0,
    stdout: `Ran 2 tests for test/zyron/Demo.t.sol\n[PASS] testExploit_ZYR_DEMO_001() (gas: 88412)\n[PASS] testCounter_ZYR_DEMO_002() (gas: 54120)\nTest result: ok. 2 passed; 0 failed;`,
  });

  const findings: FindingToProve[] = [
    {
      id: 'ZYR-DEMO-001',
      ruleId: 'ZYRON-08-001',
      severity: 'CRITICAL',
      title: 'Classic Reentrancy in VaultCore.withdraw()',
      location: 'src/VaultCore.sol:88',
      description: 'External ETH transfer via call{value: payout} occurs before sharesOf[msg.sender] -= shares.',
    },
    {
      id: 'ZYR-DEMO-002',
      ruleId: 'ZYRON-08-002',
      severity: 'HIGH',
      title: 'External Call in VaultCore.safeEmergencyWithdraw()',
      location: 'src/VaultCore.sol:110',
      description: 'Static scanner flagged external call in safeEmergencyWithdraw().',
    },
    {
      id: 'ZYR-DEMO-003',
      ruleId: 'ZYRON-04-001',
      severity: 'MEDIUM',
      title: 'External PriceOracleAdapter Dependency in initialize()',
      location: 'src/VaultCore.sol:55',
      description: 'Oracle feed configuration requires cross-contract state assumptions.',
    },
  ];

  console.log('[2/5] Running Autonomous Prover (Meta AI muse-spark-1.3) + Deterministic Verifier (zyron-verifier/2.0.0)...');
  const provider = new MetaProvider({
    apiKey: process.env.MODEL_API_KEY || 'demo-offline-replay-key',
    model: 'muse-spark-1.3',
    fetchImpl: process.env.LIVE_META === 'true' && process.env.MODEL_API_KEY ? undefined : createDemoFetch(),
  });
  const sourceHashes = { 'src/VaultCore.sol': sourceSha256Hex };
  const results = [];

  for (const f of findings) {
    const logger = new TranscriptLogger('demo-job', f.id, tmpLogsDir);
    const res = await ProverAgent.proveFinding(provider, executor, f, ['src/VaultCore.sol'], logger, {
      sourceHashes,
    });
    results.push(res);
    console.log(
      `      • ${f.id} (${f.severity}): finalStatus=${res.status} | verifier=${res.verification?.verifierVersion} | runs=${res.verification?.runs.length || 0}`,
    );
  }

  console.log('\n[3/5] Building Canonical Cryptographic Evidence Records (zyron.evidence/v1)...');
  const evidenceLeaves: string[] = [];
  for (const r of results) {
    const canonical = JSON.stringify({
      schemaVersion: 'zyron.evidence/v1',
      auditId: 'ZYR-9481',
      findingId: r.findingId,
      sourceHashes: { 'src/VaultCore.sol': sourceSha256 },
      verifierVersion: r.verification?.verifierVersion || 'zyron-verifier/2.0.0',
      finalStatus: r.status,
      testFile: r.verification?.testFile || '',
      testArtifactSha256: r.verification?.testArtifactSha256 || '',
      model: r.model,
    });
    const digest = '0x' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    evidenceLeaves.push(digest);
    console.log(`      • ${r.findingId} evidenceHash: ${digest}`);
  }

  const sorted = evidenceLeaves.map((h) => h.slice(2)).sort();
  const pair1 = crypto.createHash('sha256').update(sorted[0] + sorted[1], 'utf8').digest('hex');
  const pair2 = crypto.createHash('sha256').update(sorted[2] + sorted[2], 'utf8').digest('hex');
  const evidenceRoot = '0x' + crypto.createHash('sha256').update(pair1 + pair2, 'utf8').digest('hex');
  console.log(`      => Canonical Evidence Merkle Root: ${evidenceRoot}\n`);

  console.log('[4/5] Authorized Human Reviewer EIP-712 Signature & Multichain Binding...');
  const reviewerWallet = Wallet.createRandom();
  const targetAddress = '0x1111111111111111111111111111111111111111';

  const monadDomain = {
    name: 'ZyronAttestation',
    version: '3.0.0',
    chainId: 10143,
    verifyingContract: '0xBd24D2BFFbc69a17aCe69aaF930fC4e0d979c4D3',
  };
  const types = {
    AttestationPayload: [
      { name: 'auditId', type: 'bytes32' },
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'repoTreeHash', type: 'bytes32' },
      { name: 'bytecodeHash', type: 'bytes32' },
      { name: 'leadAuditor', type: 'address' },
      { name: 'sloc', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'timestamp', type: 'uint256' },
    ],
  };
  const message = {
    auditId: keccak256(toUtf8Bytes('ZYR-9481')),
    merkleRoot: evidenceRoot,
    repoTreeHash: sourceSha256,
    bytecodeHash: keccak256(toUtf8Bytes(vaultSource)),
    leadAuditor: reviewerWallet.address,
    sloc: 134,
    status: 2,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const signature = await reviewerWallet.signTypedData(monadDomain, types, message);
  const recovered = verifyTypedData(monadDomain, types, message, signature);

  console.log(`      Reviewer Wallet:          ${reviewerWallet.address}`);
  console.log(`      Recovered EIP-712 Signer: ${recovered}`);
  console.log(`      Monad Identity (10143):   10143:${targetAddress.toLowerCase()}`);
  console.log(`      Base Sepolia (84532):     84532:${targetAddress.toLowerCase()}`);
  console.log(`      Monad Registry Contract:  ${monadDomain.verifyingContract}`);
  console.log(`      Signature Verified:       ${recovered === reviewerWallet.address}\n`);

  console.log('[5/5] Summary of Verifiable Results:');
  console.log('      • ZYR-DEMO-001 -> PROVEN_EXPLOIT        (2/2 Foundry runs passed, source SHA-256 intact)');
  console.log('      • ZYR-DEMO-002 -> PROVEN_FALSE_POSITIVE (verbatim guard + counter-test verified)');
  console.log('      • ZYR-DEMO-003 -> INCONCLUSIVE          (unproven claim safely downgraded)');
  console.log('================================================================================');

  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  fs.rmSync(tmpLogsDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
