import { LlmProvider } from '../llm/provider';
import { Executor } from '../sandbox/executor';
import { FindingToProve, ProverFindingResult } from '../types';
import { TranscriptLogger } from '../logging/transcript-logger';
import { AGENT_TOOLS } from './tools';
import { HarnessVerifier, VerdictSubmission } from './verifier';
import { LlmMessage, ToolCall, ToolResult } from '../llm/types';

export interface ProverAgentOptions {
  maxTurns?: number;
  initialBuildOutput?: string;
}

export class ProverAgent {
  /**
   * Executes the autonomous feedback loop for a single smart contract finding.
   */
  static async proveFinding(
    llm: LlmProvider,
    executor: Executor,
    finding: FindingToProve,
    originalFiles: string[],
    logger: TranscriptLogger,
    options: ProverAgentOptions = {}
  ): Promise<ProverFindingResult> {
    const maxTurns = options.maxTurns ?? 20;
    const findingIdClean = finding.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const targetTestPath = `test/zyron/${findingIdClean}.t.sol`;

    const systemPrompt = `You are Zyron Autonomous Security Prover, an elite smart contract security engineer and invariant testing agent.
Your objective is to mathematically prove or disprove a reported smart contract vulnerability using an executable Foundry test.

CRITICAL RULES:
1. WORKSPACE IMMUTABILITY: You must NEVER edit or modify original contract source files (e.g. in src/ or contracts/). If you modify original protocol code, the harness anti-tamper verifier will instantly reject your proof.
2. TEST ARTIFACT LOCATION: Always write your test contract in '${targetTestPath}'.
3. ITERATIVE FEEDBACK LOOP:
   - Use 'read_file' and 'search_code' to analyze the vulnerable contract logic, state variables, and external calls.
   - Use 'write_file' to create or update your test contract.
   - Use 'run_command' to run: forge test --match-path "${targetTestPath}" -vvvv
   - If the test fails to compile or reverts unexpectedly, inspect the error output, fix the test, and re-run.
4. SUBMITTING VERDICT:
   - Call 'submit_verdict' when you have a clean, passing test proving an exploit or proving a false positive.
   - If after careful investigation the vulnerability cannot be triggered or the invariant cannot be broken, call 'submit_verdict' with verdict 'CANNOT_REPRODUCE'.`;

    const userPrompt = `Target Finding to Prove:
- Finding ID: ${finding.id}
- Rule: ${finding.ruleId || 'N/A'}
- Severity: ${finding.severity}
- Title: ${finding.title}
- Location: ${finding.location || 'Unknown'}
- Description: ${finding.description}
${finding.pocScenario ? `- Scenario: ${finding.pocScenario}` : ''}
${options.initialBuildOutput ? `\nInitial Project Build Status:\n${options.initialBuildOutput.slice(0, 1500)}` : ''}

Please begin by exploring the target contract code and constructing the Foundry proof in '${targetTestPath}'.`;

    logger.log({ kind: 'SYSTEM', content: systemPrompt });
    logger.log({ kind: 'USER_PROMPT', content: userPrompt });

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let turns = 0;

    while (turns < maxTurns) {
      turns++;
      console.log(`[ProverAgent] Turn ${turns}/${maxTurns} for finding ${finding.id}...`);

      let response;
      try {
        response = await llm.chat(messages, AGENT_TOOLS);
      } catch (err: any) {
        logger.log({ kind: 'ERROR', content: `LLM chat error on turn ${turns}: ${err.message}` });
        console.error(`[ProverAgent] LLM API failure: ${err.message}`);
        return {
          findingId: finding.id,
          ruleId: finding.ruleId,
          status: 'INCONCLUSIVE',
          verdict: 'INCONCLUSIVE',
          confidence: 'LOW',
          summary: `LLM service error during verification: ${err.message}`,
          executionLogs: [`[ERROR] ${err.message}`],
          traceSteps: [],
        };
      }

      if (response.content) {
        logger.log({ kind: 'MODEL_THOUGHT', content: response.content });
      }

      // Record assistant message
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
        rawParts: response.rawParts,
      });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Model answered with text only without calling tools; prompt it to proceed
        messages.push({
          role: 'user',
          content: 'Please proceed with writing or executing the Foundry test, or call submit_verdict if finished.',
        });
        continue;
      }

      const toolResults: ToolResult[] = [];

      for (const call of response.toolCalls) {
        logger.log({
          kind: 'TOOL_CALL',
          toolCall: { name: call.name, arguments: call.arguments },
        });

        // Handle submit_verdict tool
        if (call.name === 'submit_verdict') {
          const submission = call.arguments as VerdictSubmission;
          console.log(`[ProverAgent] Model submitted verdict: ${submission.verdict}`);

          const finalResult = await HarnessVerifier.verify(
            executor,
            finding,
            submission,
            originalFiles
          );

          logger.log({
            kind: 'VERDICT',
            content: `Verdict verified: ${finalResult.status}`,
            metadata: {
              confidence: finalResult.confidence,
              gasUsed: finalResult.gasUsed,
              summary: finalResult.summary,
            },
          });

          return finalResult;
        }

        // Handle execution tools
        const result = await this.executeTool(call, executor);

        logger.log({
          kind: 'TOOL_RESULT',
          toolResult: {
            name: call.name,
            output: result.output.slice(0, 3000), // Cap logged output
            isError: result.isError,
          },
        });

        toolResults.push(result);
      }

      // Feed tool results back to conversation
      messages.push({
        role: 'tool',
        toolResults,
      });
    }

    // Turns exhausted
    console.warn(`[ProverAgent] Finding ${finding.id} reached maximum turns (${maxTurns}) without resolution.`);
    return {
      findingId: finding.id,
      ruleId: finding.ruleId,
      status: 'CANNOT_REPRODUCE',
      verdict: 'CANNOT_REPRODUCE',
      confidence: 'LOW',
      summary: `Verification budget exhausted: Agent reached turn limit (${maxTurns}) without proving exploit.`,
      executionLogs: [`[VERIFIER] Max turns reached (${maxTurns}). Finding unresolved.`],
      traceSteps: [],
    };
  }

  private static async executeTool(
    call: ToolCall,
    executor: Executor
  ): Promise<ToolResult> {
    const args = call.arguments || {};

    try {
      if (call.name === 'run_command') {
        const timeoutMs = (args.timeoutSeconds || 60) * 1000;
        const res = await executor.exec(args.command, { timeoutMs });
        const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
        return {
          callId: call.id,
          name: call.name,
          output: combined || `[Command finished with exit code ${res.exitCode}]`,
          isError: res.exitCode !== 0,
        };
      }

      if (call.name === 'read_file') {
        const content = await executor.readFile(args.filePath);
        return {
          callId: call.id,
          name: call.name,
          output: content,
        };
      }

      if (call.name === 'write_file') {
        await executor.writeFile(args.filePath, args.content);
        return {
          callId: call.id,
          name: call.name,
          output: `Successfully wrote ${args.content.length} characters to ${args.filePath}`,
        };
      }

      if (call.name === 'list_dir') {
        const targetDir = args.dirPath || '.';
        const res = await executor.exec(`ls -la "${targetDir}"`);
        return {
          callId: call.id,
          name: call.name,
          output: res.stdout || res.stderr,
          isError: res.exitCode !== 0,
        };
      }

      if (call.name === 'search_code') {
        const prefix = args.pathPrefix || '.';
        const query = args.query;
        const res = await executor.exec(`grep -rnE "${query}" "${prefix}" | head -n 50`);
        return {
          callId: call.id,
          name: call.name,
          output: res.stdout || 'No matching patterns found.',
          isError: res.exitCode !== 0,
        };
      }

      return {
        callId: call.id,
        name: call.name,
        output: `Unknown tool: ${call.name}`,
        isError: true,
      };
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: `Tool execution error: ${err.message}`,
        isError: true,
      };
    }
  }
}
