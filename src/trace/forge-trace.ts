import { TraceStep } from '../types';

export interface ParsedForgeResult {
  success: boolean;
  testFunction: string;
  durationMs: number;
  gasUsed: number;
  traceSteps: TraceStep[];
  revertReason?: string;
  rawOutput: string;
}

export class ForgeTraceParser {
  /**
   * Parses Forge test output (either JSON or formatted text traces) into structured TraceStep items.
   */
  static parse(output: string, testFunctionName = 'test_exploit'): ParsedForgeResult {
    let success = false;
    let gasUsed = 0;
    let durationMs = 0;
    let revertReason: string | undefined = undefined;
    const traceSteps: TraceStep[] = [];

    // Check overall pass/fail status
    if (/\[PASS\]/i.test(output) || output.includes('"status":"Success"') || output.includes('"status": "Success"')) {
      success = true;
    } else if (/\[FAIL/i.test(output) || output.includes('"status":"Failure"') || output.includes('"status": "Failure"')) {
      success = false;
    }

    // Try parsing as JSON first
    try {
      const jsonStart = output.indexOf('{');
      const jsonEnd = output.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = output.substring(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonStr);

        for (const contractSuite of Object.values(parsed)) {
          const testResults = (contractSuite as any)?.testResults;
          if (testResults) {
            for (const [fnName, result] of Object.entries(testResults as any)) {
              if (fnName.includes(testFunctionName) || !testFunctionName) {
                const res = result as any;
                success = res.status === 'Success';
                gasUsed = res.gasUsed || 0;
                if (res.reason) revertReason = res.reason;
                break;
              }
            }
          }
        }
      }
    } catch {
      // Fallback to text parsing
    }

    // Check for explicit revert reason in failure line like: [FAIL. Reason: LOCKED]
    const failReasonMatch = output.match(/\[FAIL(?:\.|\:)\s*(?:Reason:\s*)?([^\]\n]+)\]/i);
    if (failReasonMatch && failReasonMatch[1]) {
      revertReason = failReasonMatch[1].trim();
    }

    // Parse trace lines from -vvvv output
    const lines = output.split('\n');
    let stepNumber = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match Forge trace call lines like:
      // [12345] Target::functionName(args)
      // ├─ [45000] Target::deposit{value: 1000}()
      const traceMatch = line.match(
        /(?:[│├└─\s]*)(?:\[(\d+)\])?\s*([0-9a-zA-Z_]+)::([0-9a-zA-Z_]+)(?:\{.*?\})?\((.*?)\)(?:\s*\[(.*?)\])?/
      );

      if (traceMatch) {
        const gas = traceMatch[1] ? parseInt(traceMatch[1], 10) : undefined;
        const target = traceMatch[2];
        const fnName = traceMatch[3];
        const isRevert = line.toLowerCase().includes('revert');

        // Estimate depth from indentation
        const leadingWhitespace = line.search(/\S|$/);
        const depth = Math.max(0, Math.floor(leadingWhitespace / 2));

        traceSteps.push({
          step: stepNumber++,
          depth,
          caller: depth === 0 ? '0xAttacker_Harness' : '0xCaller',
          target,
          functionName: `${fnName}()`,
          gasUsed: gas,
          status: isRevert ? 'REVERTED' : 'SUCCESS',
          detail: line.trim(),
        });

        if (isRevert && !revertReason) {
          revertReason = line.trim();
        }
      }
    }

    // If no individual call lines found, synthesize a minimal trace entry from execution log
    if (traceSteps.length === 0) {
      traceSteps.push({
        step: 1,
        depth: 0,
        caller: '0xAttacker_Harness',
        target: 'ExploitTest',
        functionName: `${testFunctionName}()`,
        gasUsed: gasUsed || 50000,
        status: success ? 'SUCCESS' : 'REVERTED',
        detail: success ? 'Foundry unit test passed.' : (revertReason || 'Test failed.'),
      });
    }

    return {
      success,
      testFunction: testFunctionName,
      durationMs,
      gasUsed,
      traceSteps,
      revertReason,
      rawOutput: output,
    };
  }
}
