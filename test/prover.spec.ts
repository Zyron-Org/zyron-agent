import { describe, it, expect } from 'vitest';
import { SolcCompiler } from '../src/sandbox/solc-compiler';
import { EvmSimulator } from '../src/sandbox/evm-simulator';
import { JobManager } from '../src/queue/job-manager';
import { FindingToProve } from '../src/types';

describe('Zyron Agent: Autonomous EVM Sandbox Prover', () => {
  const vulnerableVault = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VulnerableVault {
    mapping(address => uint256) public userBalances;

    function deposit() external payable {
        userBalances[msg.sender] += msg.value;
    }

    function withdrawAll() external {
        uint256 amount = userBalances[msg.sender];
        require(amount > 0, "No balance");

        // Vulnerable: External call before state zeroing
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Transfer failed");

        userBalances[msg.sender] = 0;
    }
}
`;

  const secureVault = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SecureVault {
    mapping(address => uint256) public userBalances;
    uint256 private unlocked = 1;

    modifier lock() {
        require(unlocked == 1, "LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    function deposit() external payable {
        userBalances[msg.sender] += msg.value;
    }

    function withdrawAll() external lock {
        uint256 amount = userBalances[msg.sender];
        require(amount > 0, "No balance");

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Transfer failed");

        userBalances[msg.sender] = 0;
    }
}
`;

  it('should compile valid Solidity source in memory using SolcCompiler', () => {
    const res = SolcCompiler.compileSources({
      'VulnerableVault.sol': vulnerableVault,
    });

    expect(res.success).toBe(true);
    expect(res.artifacts['VulnerableVault']).toBeDefined();
    expect(res.artifacts['VulnerableVault'].bytecode.length).toBeGreaterThan(10);
  });

  it('should mathematically prove a real Reentrancy exploit in the sandbox', async () => {
    const finding: FindingToProve = {
      id: 'FINDING-001',
      ruleId: 'ZYRON-08-001',
      severity: 'CRITICAL',
      title: 'State-Change Reentrancy in withdrawAll()',
      description: 'External call before balance zeroing allows attacker to re-enter and drain funds.',
      pocScenario: 'Attacker deposits 1 ETH, invokes withdrawAll(), fallback recursively calls withdrawAll().',
    };

    const result = await EvmSimulator.simulateExploit({
      contractFileName: 'VulnerableVault.sol',
      sourceCode: vulnerableVault,
      finding,
    });

    expect(result.status).toBe('PROVEN_EXPLOIT');
    expect(result.confidence).toBe('HIGH');
    expect(result.deltaBalance).toBe('+100.0 ETH');
    expect(result.traceSteps.length).toBeGreaterThanOrEqual(6);

    // Verify step 6 drained target
    const drainStep = result.traceSteps.find((s) => s.functionName.includes('REENTRANT DRAIN'));
    expect(drainStep).toBeDefined();
    expect(drainStep?.status).toBe('SUCCESS');
  });

  it('should verify a False Positive when reentrancy lock mutex is present', async () => {
    const finding: FindingToProve = {
      id: 'FINDING-002',
      ruleId: 'ZYRON-08-001',
      severity: 'CRITICAL',
      title: 'Potential Reentrancy in withdrawAll()',
      description: 'Static AST flagged low-level call before state update.',
    };

    const result = await EvmSimulator.simulateExploit({
      contractFileName: 'SecureVault.sol',
      sourceCode: secureVault,
      finding,
    });

    expect(result.status).toBe('PROVEN_FALSE_POSITIVE');
    expect(result.confidence).toBe('HIGH');
    expect(result.deltaBalance).toBe('0.0 ETH');

    // Verify reentrant call reverted with LOCKED
    const revertedStep = result.traceSteps.find((s) => s.status === 'REVERTED');
    expect(revertedStep).toBeDefined();
    expect(revertedStep?.stateChange).toContain('LOCKED');
  });

  it('should process a complete Prover Job through JobManager and format traces', async () => {
    const jobResult = await JobManager.processJob({
      jobId: 'test-job-001',
      auditId: 'ZYR-TEST',
      contractFileName: 'VulnerableVault.sol',
      sourceCode: vulnerableVault,
      findingsToProve: [
        {
          id: 'FINDING-CRIT-1',
          ruleId: 'ZYRON-08-001',
          severity: 'CRITICAL',
          title: 'State-Change Reentrancy',
          description: 'Allows funds drain.',
        },
      ],
    });

    expect(jobResult.status).toBe('COMPLETED');
    expect(jobResult.results.length).toBe(1);
    expect(jobResult.results[0].status).toBe('PROVEN_EXPLOIT');
    expect(jobResult.results[0].traceSteps[0].step).toBe(1);
    expect(jobResult.results[0].summary).toContain('Exploit verified');
  });
});
