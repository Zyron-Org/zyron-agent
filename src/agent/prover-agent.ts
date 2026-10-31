import { LlmProvider } from '../llm/provider';
import { Executor } from '../sandbox/executor';
import { FindingToProve, InvestigationStep, ProverFindingResult } from '../types';
import { TranscriptLogger } from '../logging/transcript-logger';
import { AGENT_TOOLS } from './tools';
import { HarnessVerifier, VerdictSubmission, sha256 } from './verifier';
import { LlmMessage, LlmResponse, ToolCall, ToolResult } from '../llm/types';
import {
  FORGE_BUILD_COMMAND,
  ToolPolicyError,
  assertWritablePath,
  forgeTestCommand,
  listWorkspaceDir,
  readWorkspaceFile,
  searchWorkspace,
  truncateOutput,
  validateToolArgs,
} from './tool-policy';

export interface ProverAgentOptions {
  maxTurns?: number;
  /** Wall-clock budget for the whole investigation of this finding. */
  maxDurationMs?: number;
  /** How many times the model may submit a claim that the verifier rejects for a fixable reason. */
  maxVerdictAttempts?: number;
  initialBuildOutput?: string;
  /** sha256 of original files captured at bootstrap (enables hash-based integrity checks). */
  sourceHashes?: Record<string, string>;
  signal?: AbortSignal;
  forgeTimeoutMs?: number;
}

/** Verifier rejections after which more investigation cannot help. */
const TERMINAL_REASONS = new Set(['SOURCE_MUTATED', 'INTEGRITY_UNVERIFIABLE', 'TOOLCHAIN_UNAVAILABLE', 'AGENT_REPORTED_INCONCLUSIVE']);
const TOOL_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export class ProverAgent {
  /**
   * Evidence-driven investigation loop for one finding. The LLM chooses bounded tools; the sandbox
   * produces execution evidence; HarnessVerifier decides the status. The model cannot declare success.
   */
  static async proveFinding(
    llm: LlmProvider,
    executor: Executor,
    finding: FindingToProve,
    originalFiles: string[],
    logger: TranscriptLogger,
    options: ProverAgentOptions = {},
  ): Promise<ProverFindingResult> {
    const maxTurns = options.maxTurns ?? parseInt(process.env.PROVER_MAX_TURNS || '20', 10);
    const maxDurationMs = options.maxDurationMs ?? parseInt(process.env.PROVER_MAX_DURATION_MS || '900000', 10);
    const maxVerdictAttempts = options.maxVerdictAttempts ?? 3;
    const deadline = Date.now() + maxDurationMs;
    const findingIdClean = finding.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const targetTestPath = `test/zyron/${findingIdClean}.t.sol`;
    const investigation: InvestigationStep[] = [];
    let totalTokens = 0;
    let turns = 0;
    let verdictAttempts = 0;
    let lastVerifierResult: ProverFindingResult | undefined;

    const withMeta = (r: ProverFindingResult): ProverFindingResult => ({
      ...r,
      investigation,
      model: { provider: llm.providerName, model: llm.modelName, turns, totalTokens: totalTokens || undefined },
    });
    const inconclusive = (summary: string, code: string): ProverFindingResult =>
      withMeta({
        ...(lastVerifierResult || {}),
        findingId: finding.id,
        ruleId: finding.ruleId,
        status: 'INCONCLUSIVE',
        verdict: 'INCONCLUSIVE',
        confidence: 'LOW',
        summary,
        executionLogs: [...(lastVerifierResult?.executionLogs || []), `[PROVER] ${code}: ${summary}`],
        traceSteps: lastVerifierResult?.traceSteps || [],
      });

    const systemPrompt = `You are Zyron's autonomous smart-contract security investigator. Your job is to gather EXECUTABLE evidence about one reported finding.

How results are decided: you only submit a CLAIM. A deterministic harness re-runs your Foundry test twice against the unmodified target and applies fixed rules. Persuasive text has no effect.

Rules:
1. Original sources are immutable. You can only write Solidity files under test/zyron/. Write your test at '${targetTestPath}' and use: import "forge-std/Test.sol";
2. Your test must import the target contract from its original path, contain assertions (assert*/vm.expectRevert), and must NOT use vm.etch, vm.store, vm.mockCall, vm.ffi, file or fork cheatcodes.
3. Workflow: read_file / search_code to understand the code -> form a concrete, testable hypothesis -> write_file -> run_forge_test -> fix and repeat.
4. PROVEN_EXPLOIT needs a passing test that demonstrates the violation (e.g. attacker balance increases, invariant broken).
   PROVEN_FALSE_POSITIVE needs a passing test named test_counter... showing the attack path fails, plus counterevidenceGuard = the exact guard snippet from the target source.
   If you cannot obtain such evidence, submit INCONCLUSIVE. That is an acceptable outcome.
5. You have a limited budget of ${maxTurns} turns. The network is disabled in the sandbox.`;

    const userPrompt = `Finding under investigation (scanner candidate, NOT yet verified):
- ID: ${finding.id}
- Rule: ${finding.ruleId || 'N/A'}
- Severity: ${finding.severity}
- Title: ${finding.title}
- Location: ${finding.location || 'Unknown'}
- Description: ${finding.description}
${finding.pocScenario ? `- Scenario: ${finding.pocScenario}` : ''}
Original files: ${originalFiles.slice(0, 50).join(', ') || '(see list_dir)'}
${options.initialBuildOutput ? `\nInitial build output:\n${truncateOutput(options.initialBuildOutput, 1500)}` : ''}

Begin by inspecting the relevant code.`;

    logger.log({ kind: 'SYSTEM', content: systemPrompt, metadata: { provider: llm.providerName, model: llm.modelName } });
    logger.log({ kind: 'USER_PROMPT', content: userPrompt });

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    while (turns < maxTurns) {
      if (options.signal?.aborted) return inconclusive('Investigation cancelled.', 'CANCELLED');
      if (Date.now() > deadline) return inconclusive(`Time budget (${maxDurationMs}ms) exhausted.`, 'BUDGET_EXHAUSTED');
      turns++;

      let response: LlmResponse;
      try {
        response = await llm.chat(messages, AGENT_TOOLS, { signal: options.signal });
      } catch (err: any) {
        logger.log({ kind: 'ERROR', content: `LLM error on turn ${turns}: ${err.message}` });
        if (options.signal?.aborted) return inconclusive('Investigation cancelled.', 'CANCELLED');
        return inconclusive(`Model provider error: ${err.message}`, 'LLM_ERROR');
      }
      totalTokens += response.usage?.totalTokens || 0;

      // Only the model's visible message content is logged; no hidden reasoning is requested or stored.
      if (response.content) logger.log({ kind: 'MODEL_THOUGHT', content: response.content.slice(0, 4000), tokens: response.usage ? { total: response.usage.totalTokens } : undefined });

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, rawParts: response.rawParts });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        messages.push({ role: 'user', content: 'Continue the investigation using the tools, or call submit_verdict.' });
        continue;
      }

      const toolResults: ToolResult[] = [];
      for (const call of response.toolCalls) {
        if (call.name === 'submit_verdict' && !call.invalidArguments) {
          const outcome = await this.handleVerdict(call, executor, finding, originalFiles, options, logger, investigation, turns);
          if (outcome.final) return withMeta(outcome.result);
          lastVerifierResult = outcome.result;
          verdictAttempts++;
          const reasons = outcome.result.verification?.reasonCodes || [];
          if (reasons.some((r) => TERMINAL_REASONS.has(r)) || verdictAttempts >= maxVerdictAttempts) {
            return withMeta(outcome.result);
          }
          toolResults.push({
            callId: call.id,
            name: call.name,
            isError: true,
            output: `Harness verdict: INCONCLUSIVE (${reasons.join(', ')}). ${outcome.result.summary}\nYou may gather more evidence and resubmit (${maxVerdictAttempts - verdictAttempts} attempt(s) left).`,
          });
          continue;
        }
        toolResults.push(await this.runTool(call, executor, options, logger, investigation, turns));
      }
      messages.push({ role: 'tool', toolResults });
    }

    return inconclusive(`Turn budget (${maxTurns}) exhausted without verifiable evidence.`, 'BUDGET_EXHAUSTED');
  }

  private static async handleVerdict(
    call: ToolCall,
    executor: Executor,
    finding: FindingToProve,
    originalFiles: string[],
    options: ProverAgentOptions,
    logger: TranscriptLogger,
    investigation: InvestigationStep[],
    turn: number,
  ): Promise<{ final: boolean; result: ProverFindingResult }> {
    let args: Record<string, any>;
    try {
      args = validateToolArgs(TOOL_BY_NAME.get('submit_verdict')!, call.arguments);
    } catch (e: any) {
      // Legacy alias accepted before validation (older prompts / Gemini transcripts).
      if (call.arguments?.verdict === 'CANNOT_REPRODUCE') {
        args = { ...call.arguments, verdict: 'INCONCLUSIVE' };
        delete args.executionMode;
        delete args.declaredMocks;
      } else {
        const msg = e instanceof ToolPolicyError ? e.message : String(e);
        investigation.push({ turn, tool: 'submit_verdict', arguments: call.arguments, ok: false, outputPreview: '', outputSha256: sha256(''), rejectedReason: msg });
        return {
          final: false,
          result: {
            findingId: finding.id,
            status: 'INCONCLUSIVE',
            confidence: 'LOW',
            summary: `Invalid submit_verdict arguments: ${msg}`,
            traceSteps: [],
            executionLogs: [],
            verification: undefined,
          },
        };
      }
    }
    logger.log({ kind: 'TOOL_CALL', toolCall: { name: 'submit_verdict', arguments: { ...args, reasoning: String(args.reasoning).slice(0, 1000) } } });
    const result = await HarnessVerifier.verify(executor, finding, args as VerdictSubmission, originalFiles, {
      sourceHashes: options.sourceHashes,
      testTimeoutMs: options.forgeTimeoutMs,
    });
    investigation.push({
      turn,
      tool: 'submit_verdict',
      arguments: { verdict: args.verdict, testFile: args.testFile, testFunction: args.testFunction, counterevidenceGuard: args.counterevidenceGuard },
      ok: result.status !== 'INCONCLUSIVE',
      outputPreview: `${result.status}: ${(result.verification?.reasonCodes || []).join(',')}`,
      outputSha256: sha256(JSON.stringify(result.verification || {})),
    });
    logger.log({
      kind: 'VERDICT',
      content: `Claim ${args.verdict} -> verifier ${result.status}`,
      metadata: { reasonCodes: result.verification?.reasonCodes, verifierVersion: result.verification?.verifierVersion },
    });
    return { final: result.status !== 'INCONCLUSIVE' || args.verdict === 'INCONCLUSIVE', result };
  }

  private static async runTool(
    call: ToolCall,
    executor: Executor,
    options: ProverAgentOptions,
    logger: TranscriptLogger,
    investigation: InvestigationStep[],
    turn: number,
  ): Promise<ToolResult> {
    const record = (ok: boolean, output: string, args: Record<string, any>, rejectedReason?: string): ToolResult => {
      const safeArgs = call.name === 'write_file' ? { filePath: args.filePath, contentSha256: sha256(String(args.content || '')), contentLength: String(args.content || '').length } : args;
      investigation.push({ turn, tool: call.name, arguments: safeArgs, ok, outputPreview: output.slice(0, 500), outputSha256: sha256(output), rejectedReason });
      logger.log({ kind: 'TOOL_CALL', toolCall: { name: call.name, arguments: safeArgs } });
      logger.log({ kind: 'TOOL_RESULT', toolResult: { name: call.name, output: output.slice(0, 3000), isError: !ok } });
      return { callId: call.id, name: call.name, output: truncateOutput(output), isError: !ok };
    };

    const def = TOOL_BY_NAME.get(call.name);
    if (!def) return record(false, `Unknown tool "${call.name}". Allowed: ${[...TOOL_BY_NAME.keys()].join(', ')}`, call.arguments || {}, 'UNKNOWN_TOOL');
    if (call.invalidArguments) return record(false, `Rejected: ${call.invalidArguments}`, {}, 'INVALID_JSON');

    let args: Record<string, any>;
    try {
      args = validateToolArgs(def, call.arguments);
    } catch (e: any) {
      return record(false, `Rejected: ${e.message}`, call.arguments || {}, 'SCHEMA_VIOLATION');
    }

    try {
      switch (call.name) {
        case 'read_file':
          return record(true, readWorkspaceFile(executor.workspaceDir, args.filePath), args);
        case 'list_dir':
          return record(true, listWorkspaceDir(executor.workspaceDir, args.dirPath || '.'), args);
        case 'search_code':
          return record(true, searchWorkspace(executor.workspaceDir, args.query, args.pathPrefix || '.', Boolean(args.isRegex)), args);
        case 'write_file': {
          const p = assertWritablePath(args.filePath);
          await executor.writeFile(p, args.content);
          return record(true, `Wrote ${args.content.length} characters to ${p}`, args);
        }
        case 'forge_build': {
          const r = await executor.exec(FORGE_BUILD_COMMAND, { timeoutMs: options.forgeTimeoutMs ?? 180_000 });
          return record(r.exitCode === 0, [r.stdout, r.stderr].filter(Boolean).join('\n') || `[exit ${r.exitCode}]`, args);
        }
        case 'run_forge_test': {
          const cmd = forgeTestCommand(args.testFile, args.testFunction);
          const r = await executor.exec(cmd, { timeoutMs: options.forgeTimeoutMs ?? 180_000 });
          return record(r.exitCode === 0, [r.stdout, r.stderr].filter(Boolean).join('\n') || `[exit ${r.exitCode}]`, args);
        }
        default:
          return record(false, `Tool "${call.name}" is not executable here`, args, 'NOT_EXECUTABLE');
      }
    } catch (e: any) {
      const policy = e instanceof ToolPolicyError;
      return record(false, `${policy ? 'Rejected' : 'Tool error'}: ${e.message}`, args, policy ? 'POLICY_VIOLATION' : 'TOOL_ERROR');
    }
  }
}
