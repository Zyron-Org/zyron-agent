import { ToolDefinition } from '../llm/types';

/**
 * Strict, allowlisted tool surface for the prover model.
 * There is deliberately NO generic shell tool: the model can only read/search the workspace,
 * write Foundry tests under test/zyron/, build, run a single named test, and submit a claim.
 * The claim is evaluated by the deterministic HarnessVerifier, never accepted as-is.
 */
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a text file in the audit workspace (relative path, e.g. "src/Vault.sol").',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', maxLength: 300, description: 'Workspace-relative path.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'list_dir',
    description: 'List entries of a workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', maxLength: 300, description: 'Workspace-relative directory (default ".").' },
      },
    },
  },
  {
    name: 'search_code',
    description: 'Search workspace source files for a literal string (or a regex when isRegex=true). Returns up to 50 "path:line: text" matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Text or regex to find, e.g. "function withdraw".' },
        pathPrefix: { type: 'string', maxLength: 300, description: 'Workspace-relative subdirectory to search (default ".").' },
        isRegex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a Solidity test file. Only paths under test/zyron/ ending in .sol are allowed. Original sources are immutable.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', maxLength: 200, description: 'e.g. "test/zyron/F_001.t.sol".' },
        content: { type: 'string', maxLength: 100000, description: 'Full file content.' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'forge_build',
    description: 'Compile the workspace with Foundry (offline) and return compiler output.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'run_forge_test',
    description: 'Run Foundry tests in one test file (offline, isolated sandbox). Optionally restrict to one test function.',
    parameters: {
      type: 'object',
      properties: {
        testFile: { type: 'string', maxLength: 200, description: 'Path under test/zyron/ ending in .t.sol.' },
        testFunction: { type: 'string', maxLength: 100, description: 'Exact test function name, e.g. "test_exploit".' },
      },
      required: ['testFile'],
    },
  },
  {
    name: 'submit_verdict',
    description:
      'Submit your CLAIM for this finding. The harness independently re-executes your test twice against the unmodified target and applies fixed rules. ' +
      'PROVEN_EXPLOIT: a passing test (not named test_counter*) that demonstrates the security violation. ' +
      'PROVEN_FALSE_POSITIVE: a passing counterevidence test whose name starts with "test_counter" showing the attack path fails/invariant holds, ' +
      'PLUS counterevidenceGuard = an exact code snippet from the original target (e.g. "nonReentrant") that prevents the issue. A failed exploit attempt alone is NOT sufficient. ' +
      'INCONCLUSIVE: evidence is insufficient or the environment prevented testing.',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['PROVEN_EXPLOIT', 'PROVEN_FALSE_POSITIVE', 'INCONCLUSIVE'] },
        testFile: { type: 'string', maxLength: 200, description: 'Test file under test/zyron/ (required unless INCONCLUSIVE).' },
        testFunction: { type: 'string', maxLength: 100, description: 'Test function name (required unless INCONCLUSIVE).' },
        reasoning: { type: 'string', maxLength: 4000, description: 'Concise technical summary of the evidence.' },
        counterevidenceGuard: { type: 'string', maxLength: 300, description: 'Required for PROVEN_FALSE_POSITIVE: verbatim guard snippet from target source.' },
        fundsDrainedEth: { type: 'number', description: 'Amount demonstrated by the test, if applicable.' },
      },
      required: ['verdict', 'reasoning'],
    },
  },
];
