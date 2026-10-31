import { createHash } from 'crypto';
import * as path from 'path';
import { Executor } from '../sandbox/executor';
import { FindingToProve, ProverFindingResult, VerificationCheck, VerificationRecord, VerificationRun } from '../types';
import { ForgeTraceParser } from '../trace/forge-trace';
import { TEST_FILE_RE, TEST_FN_RE, forgeTestCommand } from './tool-policy';

export const VERIFIER_VERSION = 'zyron-verifier/2.0.0';

export interface VerdictSubmission {
  /** CANNOT_REPRODUCE is accepted for backward compatibility and treated as INCONCLUSIVE. */
  verdict: 'PROVEN_EXPLOIT' | 'PROVEN_FALSE_POSITIVE' | 'INCONCLUSIVE' | 'CANNOT_REPRODUCE';
  testFile?: string;
  testFunction?: string;
  reasoning: string;
  counterevidenceGuard?: string;
  fundsDrainedEth?: number;
  executionMode?: string;
  declaredMocks?: string[];
}

export interface VerifyOptions {
  /** sha256 of every original file, recorded at bootstrap before the model ran. */
  sourceHashes?: Record<string, string>;
  testTimeoutMs?: number;
}

/**
 * Cheatcodes that can fabricate target state or touch the host. A test using them cannot prove anything
 * about the unmodified target. vm.deal / vm.prank / vm.warp / vm.roll remain allowed.
 */
export const BANNED_CHEATCODES =
  /\bvm\s*\.\s*(etch|store|mockCall|mockCallRevert|mockFunction|clearMockedCalls|ffi|readFile|readFileBinary|readLine|writeFile|writeFileBinary|writeLine|writeJson|writeToml|removeFile|setEnv|copyStorage|setArbitraryStorage|loadAllocs|allowCheatcodes|createSelectFork|createFork|selectFork|rpc)\b/;
const ASSERTION_RE = /\b(assert[A-Za-z]*\s*\(|vm\s*\.\s*expectRevert\s*\()/;
const COUNTER_FN_RE = /^test_?counter/i;

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Strict per-function result: looks for this exact function's [PASS]/[FAIL] line. */
export function parseTestOutcome(output: string, fn: string): 'PASS' | 'FAIL' | 'NOT_FOUND' {
  const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\[PASS\\]\\s+${esc}\\(`).test(output)) return 'PASS';
  if (new RegExp(`\\[FAIL[^\\]]*\\]\\s+${esc}\\(`).test(output)) return 'FAIL';
  return 'NOT_FOUND';
}

function isEnvironmentalFailure(output: string, exitCode: number): string | null {
  if (exitCode === 124 || /timed out after/i.test(output)) return 'EXECUTION_TIMEOUT';
  if (/Compiler run failed|Error \(\d+\)|error\[\d+\]|Failed to resolve|Unable to resolve imports/i.test(output)) return 'COMPILATION_FAILED';
  if (/forge: command not found|No such file or directory.*forge/i.test(output)) return 'TOOLCHAIN_UNAVAILABLE';
  if (/No tests (found|match)/i.test(output)) return 'TEST_NOT_FOUND';
  return null;
}

export class HarnessVerifier {
  /**
   * Deterministically evaluates a model's claim. The model's verdict is only a claim; the returned
   * status is derived exclusively from integrity checks, static test rules and two independent runs.
   */
  static async verify(
    executor: Executor,
    finding: FindingToProve,
    submission: VerdictSubmission,
    originalFiles: string[] = [],
    options: VerifyOptions = {},
  ): Promise<ProverFindingResult> {
    const checks: VerificationCheck[] = [];
    const reasons: string[] = [];
    const runs: VerificationRun[] = [];
    const claimed = submission.verdict === 'CANNOT_REPRODUCE' ? 'INCONCLUSIVE' : submission.verdict;
    const sourceHashes = options.sourceHashes || {};
    let integrityMethod: VerificationRecord['integrityMethod'] = 'none';
    let testSource = '';
    let gasUsed: number | undefined;
    let traceSteps: ProverFindingResult['traceSteps'] = [];
    let lastOutput = '';

    const finish = (status: VerificationRecord['finalStatus'], summary: string): ProverFindingResult => {
      const verification: VerificationRecord = {
        verifierVersion: VERIFIER_VERSION,
        claimedVerdict: submission.verdict,
        finalStatus: status,
        reasonCodes: reasons,
        checks,
        integrityMethod,
        sourceHashes,
        testFile: submission.testFile,
        testFunction: submission.testFunction,
        testArtifactSha256: testSource ? sha256(testSource) : undefined,
        counterevidenceGuard: status === 'PROVEN_FALSE_POSITIVE' ? submission.counterevidenceGuard : undefined,
        runs,
        verifiedAt: new Date().toISOString(),
      };
      return {
        findingId: finding.id,
        ruleId: finding.ruleId,
        status,
        verdict: status,
        confidence: status === 'INCONCLUSIVE' ? 'LOW' : 'HIGH',
        fundsDrainedEth: status === 'PROVEN_EXPLOIT' ? submission.fundsDrainedEth : undefined,
        deltaBalance: status === 'PROVEN_EXPLOIT' && submission.fundsDrainedEth ? `+${submission.fundsDrainedEth} ETH` : undefined,
        gasUsed,
        synthesizedPoC: testSource || undefined,
        summary,
        traceSteps,
        executionLogs: [
          ...checks.map((c) => `[VERIFIER] ${c.passed ? 'PASS' : 'FAIL'} ${c.id}${c.detail ? `: ${c.detail}` : ''}`),
          ...runs.map((r) => `[VERIFIER] run ${r.run}: exit=${r.exitCode} passed=${r.passed} ${r.durationMs}ms`),
          `[VERIFIER] ${VERIFIER_VERSION} final=${status} reasons=${reasons.join(',') || 'none'}`,
          ...(status === 'INCONCLUSIVE' && lastOutput ? [lastOutput.slice(-4000)] : []),
        ],
        verification,
      };
    };
    const fail = (code: string, detail?: string) => {
      checks.push({ id: code, passed: false, detail });
      reasons.push(code);
    };

    // ── 1. Source integrity (always checked first; applies to every claim) ──
    const hashedFiles = Object.keys(sourceHashes);
    if (hashedFiles.length > 0) {
      integrityMethod = 'sha256';
      const mismatched: string[] = [];
      for (const f of hashedFiles) {
        try {
          if (sha256(await executor.readFile(f)) !== sourceHashes[f]) mismatched.push(f);
        } catch {
          mismatched.push(`${f} (missing)`);
        }
      }
      if (mismatched.length > 0) {
        fail('SOURCE_MUTATED', mismatched.join(', '));
        return finish('INCONCLUSIVE', `Anti-tamper violation: original source changed during investigation (${mismatched.join(', ')}). Evidence rejected.`);
      }
      checks.push({ id: 'SOURCE_INTEGRITY', passed: true, detail: `${hashedFiles.length} file(s) match bootstrap hashes` });
    } else if (originalFiles.length > 0) {
      // Legacy fallback (no hashes supplied): git status.
      const diff = await executor.exec('git status --porcelain');
      if (diff.exitCode === 0) {
        integrityMethod = 'git-status';
        const modified = diff.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.replace(/^[MADRCU?! ]+\s+/, ''))
          .filter((f) => originalFiles.includes(f));
        if (modified.length > 0) {
          fail('SOURCE_MUTATED', modified.join(', '));
          return finish('INCONCLUSIVE', `Anti-tamper violation: original source was modified (${modified.join(', ')}). Evidence rejected.`);
        }
        checks.push({ id: 'SOURCE_INTEGRITY', passed: true, detail: 'git status clean for original files' });
      }
    }
    if (integrityMethod === 'none') {
      fail('INTEGRITY_UNVERIFIABLE', 'no source hashes or git baseline available');
      return finish('INCONCLUSIVE', 'Source integrity could not be established; no result can be proven.');
    }

    // ── 2. Claim-level preconditions ──
    if (claimed === 'INCONCLUSIVE') {
      reasons.push('AGENT_REPORTED_INCONCLUSIVE');
      return finish('INCONCLUSIVE', `Investigation inconclusive: ${submission.reasoning}`);
    }
    const testFile = submission.testFile || '';
    const testFn = submission.testFunction || '';
    if (!TEST_FILE_RE.test(path.posix.normalize(testFile))) {
      fail('INVALID_TEST_PATH', testFile || '(none)');
      return finish('INCONCLUSIVE', 'Submitted test file is not a test/zyron/*.t.sol artifact.');
    }
    if (!TEST_FN_RE.test(testFn)) {
      fail('INVALID_TEST_FUNCTION', testFn || '(none)');
      return finish('INCONCLUSIVE', 'Submitted test function name is invalid.');
    }
    const isCounterFn = COUNTER_FN_RE.test(testFn);
    if (claimed === 'PROVEN_EXPLOIT' && isCounterFn) {
      fail('CLAIM_TEST_MISMATCH', 'exploit claims cannot use a test_counter* function');
      return finish('INCONCLUSIVE', 'Exploit claim submitted with a counterevidence test.');
    }
    if (claimed === 'PROVEN_FALSE_POSITIVE' && !isCounterFn) {
      fail('CLAIM_TEST_MISMATCH', 'false-positive claims require a test_counter* function');
      return finish('INCONCLUSIVE', 'A failed or passing exploit test alone is not counterevidence.');
    }

    // ── 3. Static rules on the test artifact ──
    if (!(await executor.fileExists(testFile))) {
      fail('TEST_FILE_MISSING', testFile);
      return finish('INCONCLUSIVE', `Test file not found: ${testFile}`);
    }
    testSource = await executor.readFile(testFile);
    const code = stripComments(testSource);
    const fnEsc = testFn.replace(/[$]/g, '\\$');
    if (!new RegExp(`function\\s+${fnEsc}\\s*\\(`).test(code)) fail('TEST_FUNCTION_NOT_DECLARED', testFn);
    const banned = code.match(BANNED_CHEATCODES);
    if (banned) fail('BANNED_CHEATCODE', banned[0]);
    if (!ASSERTION_RE.test(code)) fail('NO_ASSERTION', 'test must contain assert*/vm.expectRevert');

    const originals = new Set([...hashedFiles, ...originalFiles].filter((f) => f.endsWith('.sol')));
    const imports = [...code.matchAll(/import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g)].map((m) => m[1]);
    const importsTarget = imports.some((imp) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), imp));
      return [...originals].some((o) => o === resolved || o === imp || imp.endsWith(`/${o}`) || resolved.endsWith(`/${o}`));
    });
    if (!importsTarget) fail('TARGET_NOT_IMPORTED', 'test must import an original target source file');
    if (reasons.length > 0) return finish('INCONCLUSIVE', `Test artifact violates verification rules: ${reasons.join(', ')}`);
    checks.push({ id: 'STATIC_TEST_RULES', passed: true, detail: 'function declared, assertions present, target imported, no banned cheatcodes' });

    // False-positive: positive counterevidence must exist verbatim in the ORIGINAL target (hash-verified above).
    if (claimed === 'PROVEN_FALSE_POSITIVE') {
      const guard = (submission.counterevidenceGuard || '').trim();
      if (guard.replace(/\s/g, '').length < 3) {
        fail('MISSING_COUNTEREVIDENCE_GUARD');
        return finish('INCONCLUSIVE', 'False-positive claim lacks a cited guard in the target source.');
      }
      let found = false;
      for (const f of originals) {
        try {
          if ((await executor.readFile(f)).includes(guard)) {
            found = true;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (!found) {
        fail('GUARD_NOT_IN_SOURCE', guard.slice(0, 120));
        return finish('INCONCLUSIVE', 'Cited guard does not appear in the original target source.');
      }
      checks.push({ id: 'COUNTEREVIDENCE_GUARD_PRESENT', passed: true, detail: guard.slice(0, 120) });
    }

    // ── 4. Two independent executions inside the sandbox ──
    const cmd = forgeTestCommand(testFile, testFn);
    for (let i = 1; i <= 2; i++) {
      const r = await executor.exec(cmd, { timeoutMs: options.testTimeoutMs ?? 120_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      lastOutput = out;
      const outcome = parseTestOutcome(out, testFn);
      const env = outcome === 'PASS' ? null : isEnvironmentalFailure(out, r.exitCode);
      const parsed = ForgeTraceParser.parse(out, testFn);
      if (i === 1) {
        traceSteps = parsed.traceSteps;
        gasUsed = parsed.gasUsed || undefined;
      }
      runs.push({ run: i, exitCode: r.exitCode, passed: outcome === 'PASS' && r.exitCode === 0, durationMs: r.durationMs, gasUsed: parsed.gasUsed || undefined, outputSha256: sha256(out) });

      if (env) {
        fail(env, `run ${i}`);
        return finish('INCONCLUSIVE', `Execution environment prevented verification (${env}).`);
      }
      if (outcome !== 'PASS' || r.exitCode !== 0) {
        fail(i === 1 ? 'TEST_DID_NOT_PASS' : 'NON_DETERMINISTIC', `run ${i}: ${outcome}, exit ${r.exitCode}`);
        return finish(
          'INCONCLUSIVE',
          i === 1 ? `Independent re-run of ${testFn}() did not pass; the claim is not demonstrated.` : `${testFn}() passed once and failed on re-run (non-deterministic).`,
        );
      }
    }
    checks.push({ id: 'REPRODUCIBLE_EXECUTION', passed: true, detail: '2/2 independent runs passed' });

    return claimed === 'PROVEN_EXPLOIT'
      ? finish('PROVEN_EXPLOIT', `Exploit reproduced twice by ${testFn}() against the unmodified target. ${submission.reasoning}`.slice(0, 2000))
      : finish('PROVEN_FALSE_POSITIVE', `Counterevidence ${testFn}() passed twice and guard "${submission.counterevidenceGuard}" is present in the unmodified target. ${submission.reasoning}`.slice(0, 2000));
  }
}
