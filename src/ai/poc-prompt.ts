import { FindingToProve } from '../types';

export function buildPoCSynthesisPrompt(
  contractFileName: string,
  sourceCode: string,
  finding: FindingToProve,
): string {
  return `
You are Zyron Sentinel, an autonomous AI Exploit Synthesizer and Security Prover.
Your mission is to synthesize an executable Solidity Proof-of-Concept (PoC) test contract to mathematically verify or disprove the following candidate vulnerability:

Target Contract: ${contractFileName}
Vulnerability Title: ${finding.title}
Severity: ${finding.severity}
Location: ${finding.location || 'Unknown'}
Description: ${finding.description}
${finding.pocScenario ? `Hypothesized Attack Scenario: ${finding.pocScenario}` : ''}

Target Source Code:
\`\`\`solidity
${sourceCode}
\`\`\`

Generate a clean, standalone Solidity Proof-of-Concept test contract matching this structure:
1. Target interface or mock.
2. Exploit helper contract (e.g. Attacker contract with fallback / reentrancy logic).
3. Test runner contract (named 'ExploitTest') containing a 'function test_exploit()' that:
   - Sets up initial protocol state and funds the target with 100 ether.
   - Deploys the attacker contract with 1 ether.
   - Executes the attack sequence.
   - Asserts whether the target balance was drained or if the attack reverted safely.

Output strictly valid Solidity code inside \`\`\`solidity ... \`\`\` code fences. Do not include extraneous conversational text.
`;
}
