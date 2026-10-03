import { FindingToProve } from '../types';

export function buildPoCSynthesisPrompt(
  contractFileName: string,
  sourceCode: string,
  finding: FindingToProve,
): string {
  return `
You are Zyron Sentinel, an automated smart contract verification and invariant testing engine.
Your mission is to synthesize a standalone Solidity Foundry unit test contract to verify whether the following finding is reproducible:

Target Contract: ${contractFileName}
Vulnerability Title: ${finding.title}
Severity: ${finding.severity}
Location: ${finding.location || 'Unknown'}
Description: ${finding.description}
${finding.pocScenario ? `Scenario: ${finding.pocScenario}` : ''}

Target Source Code:
\`\`\`solidity
${sourceCode}
\`\`\`

Generate a clean, standalone Solidity test contract to verify the state invariant:
1. Target interface or mock if required.
2. A test receiver or simulation contract if external interaction/callback is needed.
3. Test suite contract named 'ExploitTest' containing a 'function test_exploit()' that:
   - Sets up initial protocol state and funds the target.
   - Executes the interaction sequence.
   - Asserts whether the target invariant holds or is violated.

Output strictly valid Solidity code inside \`\`\`solidity ... \`\`\` code fences. Do not include extraneous conversational text.
`;
}
