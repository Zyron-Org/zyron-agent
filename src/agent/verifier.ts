import { Executor } from '../sandbox/executor';
import { FindingToProve, ProverFindingResult } from '../types';
import { ForgeTraceParser } from '../trace/forge-trace';

export interface VerdictSubmission {
  verdict: 'PROVEN_EXPLOIT' | 'PROVEN_FALSE_POSITIVE' | 'CANNOT_REPRODUCE';
  testFile: string;
  testFunction: string;
  reasoning: string;
  fundsDrainedEth?: number;
  executionMode?: string;
  declaredMocks?: string[];
}

export class HarnessVerifier {
  /**
   * Independently verifies an exploit or false-positive submission.
   */
  static async verify(
    executor: Executor,
    finding: FindingToProve,
    submission: VerdictSubmission,
    originalFiles: string[] = []
  ): Promise<ProverFindingResult> {
    const { verdict, testFile, testFunction, reasoning } = submission;

    // Check 1: Anti-Tamper Check - original source files must be pristine
    if (originalFiles.length > 0) {
      const diffCheck = await executor.exec('git status --porcelain');
      if (diffCheck.exitCode === 0 && diffCheck.stdout) {
        const modifiedFiles = diffCheck.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/^[MADRCU?! ]+\s+/, ''))
          .filter((file) => originalFiles.includes(file));

        if (modifiedFiles.length > 0) {
          console.error(`[HarnessVerifier] Anti-Tamper Violation: Target contract source was modified: ${modifiedFiles.join(', ')}`);
          return {
            findingId: finding.id,
            ruleId: finding.ruleId,
            status: 'CANNOT_REPRODUCE',
            verdict: 'CANNOT_REPRODUCE',
            confidence: 'LOW',
            summary: `Anti-tamper violation: Original contract source was modified during testing (${modifiedFiles.join(', ')}). Exploit cannot be validated.`,
            executionLogs: [`[VERIFIER] Tampering detected in: ${modifiedFiles.join(', ')}`],
            traceSteps: [],
          };
        }
      }
    }

    // If the agent conceded cannot reproduce
    if (verdict === 'CANNOT_REPRODUCE') {
      return {
        findingId: finding.id,
        ruleId: finding.ruleId,
        status: 'CANNOT_REPRODUCE',
        verdict: 'CANNOT_REPRODUCE',
        confidence: 'HIGH',
        summary: `Vulnerability not reproducible: ${reasoning}`,
        executionLogs: [`[VERIFIER] Agent could not reproduce finding: ${reasoning}`],
        traceSteps: [],
      };
    }

    // Check 2: Verify test file exists
    const testExists = await executor.fileExists(testFile);
    if (!testExists) {
      return {
        findingId: finding.id,
        ruleId: finding.ruleId,
        status: 'CANNOT_REPRODUCE',
        verdict: 'CANNOT_REPRODUCE',
        confidence: 'LOW',
        summary: `Harness could not find submitted test file: ${testFile}`,
        executionLogs: [`[VERIFIER] Test file missing: ${testFile}`],
        traceSteps: [],
      };
    }

    // Check 3: Independent re-run by the harness
    const cmd = `forge test --match-path "${testFile}" --match-test "${testFunction}" -vvvv`;
    console.log(`[HarnessVerifier] Independently executing test: ${cmd}`);

    const run1 = await executor.exec(cmd, { timeoutMs: 90000 });
    const parsedRun1 = ForgeTraceParser.parse(run1.stdout + '\n' + run1.stderr, testFunction);

    if (!parsedRun1.success) {
      console.warn(`[HarnessVerifier] Independent test run failed: ${parsedRun1.revertReason || 'Test assertions failed'}`);
      return {
        findingId: finding.id,
        ruleId: finding.ruleId,
        status: 'CANNOT_REPRODUCE',
        verdict: 'CANNOT_REPRODUCE',
        confidence: 'MEDIUM',
        summary: `Test execution failed during independent verification: ${parsedRun1.revertReason || 'Assertion failure'}`,
        executionLogs: [run1.stdout, run1.stderr],
        traceSteps: parsedRun1.traceSteps,
      };
    }

    // Check 4: Double re-run to confirm consistency (anti-flakiness)
    const run2 = await executor.exec(cmd, { timeoutMs: 90000 });
    const parsedRun2 = ForgeTraceParser.parse(run2.stdout + '\n' + run2.stderr, testFunction);

    if (!parsedRun2.success) {
      return {
        findingId: finding.id,
        ruleId: finding.ruleId,
        status: 'CANNOT_REPRODUCE',
        verdict: 'CANNOT_REPRODUCE',
        confidence: 'LOW',
        summary: `Test proved flaky: Passed on run 1 but failed on run 2.`,
        executionLogs: [run2.stdout, run2.stderr],
        traceSteps: parsedRun1.traceSteps,
      };
    }

    let testSource = '';
    try {
      testSource = await executor.readFile(testFile);
    } catch {
      // Ignore
    }

    const isExploit = verdict === 'PROVEN_EXPLOIT';

    return {
      findingId: finding.id,
      ruleId: finding.ruleId,
      status: verdict,
      verdict,
      confidence: isExploit ? 'HIGH' : 'MEDIUM',
      fundsDrainedEth: submission.fundsDrainedEth,
      deltaBalance: submission.fundsDrainedEth ? `+${submission.fundsDrainedEth} ETH` : undefined,
      gasUsed: parsedRun1.gasUsed,
      synthesizedPoC: testSource,
      summary: isExploit
        ? `Exploit independently verified via Foundry test ${testFunction}(): ${reasoning}`
        : `False positive verified: Mutex / invariant preserved under attack test: ${reasoning}`,
      traceSteps: parsedRun1.traceSteps,
      executionLogs: [
        `[VERIFIER] Run 1: SUCCESS (gas: ${parsedRun1.gasUsed})`,
        `[VERIFIER] Run 2: SUCCESS (deterministic)`,
        `[VERIFIER] Verdict confirmed: ${verdict}`,
      ],
    };
  }
}
