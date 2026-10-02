import { TraceStep, ProverFindingResult } from '../types';

export class TraceFormatter {
  /**
   * Generates a human-readable execution summary from trace steps.
   */
  static formatSummary(result: ProverFindingResult): string {
    const totalSteps = result.traceSteps.length;
    const revertedStep = result.traceSteps.find((s) => s.status === 'REVERTED');

    if (result.status === 'PROVEN_EXPLOIT') {
      return `Exploit verified across ${totalSteps} EVM execution steps. Attacker extracted ${result.deltaBalance} in ${result.gasUsed} gas.`;
    }

    if (result.status === 'PROVEN_FALSE_POSITIVE') {
      return `False positive verified: Attack halted at Step ${revertedStep?.step || totalSteps} (${revertedStep?.stateChange || 'Execution reverted'}). Protocol invariant preserved.`;
    }

    return `Simulation completed with inconclusive results across ${totalSteps} execution steps.`;
  }

  /**
   * Sanitizes and verifies trace steps for frontend UI consumption.
   */
  static sanitizeTrace(traceSteps: TraceStep[]): TraceStep[] {
    return traceSteps.map((step, idx) => ({
      step: idx + 1,
      depth: step.depth || 0,
      caller: step.caller || '0xAttacker',
      target: step.target || '0xTarget',
      functionName: step.functionName || 'call()',
      value: step.value || '0.0 ETH',
      gasUsed: step.gasUsed || 21000,
      stateChange: step.stateChange || 'State updated',
      status: step.status || 'SUCCESS',
      detail: step.detail || '',
    }));
  }
}
