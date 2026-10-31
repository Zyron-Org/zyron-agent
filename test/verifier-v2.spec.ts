import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HarnessVerifier, sha256 } from '../src/agent/verifier';
import { MockExecutor } from '../src/sandbox/mock-executor';

describe('HarnessVerifier v2 — Deterministic Evidence Rules', () => {
  const ws = path.join(process.cwd(), 'data', 'test-verifier-v2-ws');
  const targetCode = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract Vault {
    mapping(address => uint256) public balances;
    bool private locked;
    modifier nonReentrant() { require(!locked, "LOCKED"); locked = true; _; locked = false; }
    function withdraw() external nonReentrant {
        uint256 bal = balances[msg.sender];
        require(bal > 0, "Zero");
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: bal}("");
        require(ok);
    }
}`;

  beforeEach(async () => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  async function setup(testCode: string) {
    const ex = new MockExecutor(ws);
    await ex.startSession();
    await ex.writeFile('src/Vault.sol', targetCode);
    await ex.writeFile('test/zyron/F_1.t.sol', testCode);
    const sourceHashes = { 'src/Vault.sol': sha256(targetCode) };
    return { ex, sourceHashes };
  }

  it('confirms PROVEN_EXPLOIT only when integrity holds, static checks pass, and 2/2 runs pass', async () => {
    const { ex, sourceHashes } = await setup(`
      import "../../src/Vault.sol";
      contract ExploitTest {
        function test_exploit() public {
          Vault v = new Vault();
          assertTrue(address(v) != address(0));
        }
      }
    `);
    ex.registerResponse('forge test', {
      stdout: '[PASS] test_exploit() (gas: 120000)\nTest result: ok. 1 passed;',
      exitCode: 0,
    });

    const res = await HarnessVerifier.verify(
      ex,
      { id: 'F-1', title: 'Drain', severity: 'CRITICAL', description: '' },
      { verdict: 'PROVEN_EXPLOIT', testFile: 'test/zyron/F_1.t.sol', testFunction: 'test_exploit', reasoning: 'Drained', fundsDrainedEth: 5 },
      ['src/Vault.sol'],
      { sourceHashes }
    );

    expect(res.status).toBe('PROVEN_EXPLOIT');
    expect(res.verification?.finalStatus).toBe('PROVEN_EXPLOIT');
    expect(res.verification?.runs).toHaveLength(2);
    expect(res.verification?.testArtifactSha256).toHaveLength(64);
  });

  it('rejects source mutation detected via SHA-256 baseline even without git', async () => {
    const { ex, sourceHashes } = await setup(`
      import "../../src/Vault.sol";
      contract ExploitTest { function test_exploit() public { assertTrue(true); } }
    `);
    // Tamper with src/Vault.sol after bootstrap hash capture
    await ex.writeFile('src/Vault.sol', targetCode + '\n// tampered');

    const res = await HarnessVerifier.verify(
      ex,
      { id: 'F-1', title: 'Drain', severity: 'CRITICAL', description: '' },
      { verdict: 'PROVEN_EXPLOIT', testFile: 'test/zyron/F_1.t.sol', testFunction: 'test_exploit', reasoning: 'Drained' },
      ['src/Vault.sol'],
      { sourceHashes }
    );

    expect(res.status).toBe('INCONCLUSIVE');
    expect(res.verification?.reasonCodes).toContain('SOURCE_MUTATED');
  });

  it('rejects tests that use banned state-faking cheatcodes (vm.store / vm.etch / vm.mockCall)', async () => {
    const { ex, sourceHashes } = await setup(`
      import "../../src/Vault.sol";
      contract ExploitTest {
        function test_exploit() public {
          vm.store(address(0x1), bytes32(0), bytes32(uint256(100 ether)));
          assertTrue(true);
        }
      }
    `);

    const res = await HarnessVerifier.verify(
      ex,
      { id: 'F-1', title: 'Fake state', severity: 'CRITICAL', description: '' },
      { verdict: 'PROVEN_EXPLOIT', testFile: 'test/zyron/F_1.t.sol', testFunction: 'test_exploit', reasoning: 'Fake' },
      ['src/Vault.sol'],
      { sourceHashes }
    );

    expect(res.status).toBe('INCONCLUSIVE');
    expect(res.verification?.reasonCodes).toContain('BANNED_CHEATCODE');
  });

  it('rejects PROVEN_FALSE_POSITIVE unless test_counter* passes AND cited guard exists verbatim in target', async () => {
    const { ex, sourceHashes } = await setup(`
      import "../../src/Vault.sol";
      contract CounterTest {
        function test_counter_reentrancy_blocked() public {
          vm.expectRevert("LOCKED");
        }
      }
    `);
    ex.registerResponse('forge test', {
      stdout: '[PASS] test_counter_reentrancy_blocked() (gas: 88000)\nTest result: ok. 1 passed;',
      exitCode: 0,
    });

    // Missing or fabricated guard -> INCONCLUSIVE
    const bad = await HarnessVerifier.verify(
      ex,
      { id: 'F-1', title: 'Reentrancy', severity: 'HIGH', description: '' },
      {
        verdict: 'PROVEN_FALSE_POSITIVE',
        testFile: 'test/zyron/F_1.t.sol',
        testFunction: 'test_counter_reentrancy_blocked',
        counterevidenceGuard: 'nonExistentModifier()',
        reasoning: 'Protected',
      },
      ['src/Vault.sol'],
      { sourceHashes }
    );
    expect(bad.status).toBe('INCONCLUSIVE');
    expect(bad.verification?.reasonCodes).toContain('GUARD_NOT_IN_SOURCE');

    // Real verbatim guard from target source -> PROVEN_FALSE_POSITIVE
    const ok = await HarnessVerifier.verify(
      ex,
      { id: 'F-1', title: 'Reentrancy', severity: 'HIGH', description: '' },
      {
        verdict: 'PROVEN_FALSE_POSITIVE',
        testFile: 'test/zyron/F_1.t.sol',
        testFunction: 'test_counter_reentrancy_blocked',
        counterevidenceGuard: 'modifier nonReentrant()',
        reasoning: 'Protected by nonReentrant lock',
      },
      ['src/Vault.sol'],
      { sourceHashes }
    );
    expect(ok.status).toBe('PROVEN_FALSE_POSITIVE');
    expect(ok.verification?.finalStatus).toBe('PROVEN_FALSE_POSITIVE');
  });

  it('returns INCONCLUSIVE on sandbox timeout or compilation failure', async () => {
    const { ex, sourceHashes } = await setup(`
      import "../../src/Vault.sol";
      contract ExploitTest { function test_exploit() public { assertTrue(true); } }
    `);
    ex.registerResponse('forge test', {
      stdout: '',
      stderr: '[Command "docker exec" timed out after 120000ms]',
      exitCode: 124,
    });

    const res = await HarnessVerifier.verify(
      ex,
      { id: 'F-1', title: 'Timeout', severity: 'HIGH', description: '' },
      { verdict: 'PROVEN_EXPLOIT', testFile: 'test/zyron/F_1.t.sol', testFunction: 'test_exploit', reasoning: 'Timed out' },
      ['src/Vault.sol'],
      { sourceHashes }
    );

    expect(res.status).toBe('INCONCLUSIVE');
    expect(res.verification?.reasonCodes).toContain('EXECUTION_TIMEOUT');
  });
});
