import { ToolDefinition } from '../llm/types';

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    description: 'Executes a bash shell command inside the isolated Linux sandbox. Use this to run forge build, forge test, cast, git, or inspect files.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact bash command line string to run.',
        },
        timeoutSeconds: {
          type: 'integer',
          description: 'Maximum time to wait before terminating the command (default: 60s, max: 180s).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Reads the text content of a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file from the workspace root (e.g., "src/Vault.sol" or "test/Exploit.t.sol").',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write_file',
    description: 'Creates or overwrites a file in the workspace. Use this to write Foundry exploit test files in test/zyron/.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to write to (must be inside test/zyron/ for test contracts).',
        },
        content: {
          type: 'string',
          description: 'The full text content to write into the file.',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'Lists files and folders in a workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        dirPath: {
          type: 'string',
          description: 'Relative path to directory (default: "." for workspace root).',
        },
      },
    },
  },
  {
    name: 'search_code',
    description: 'Searches for text or regex patterns across the codebase (using grep/ripgrep).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The string or regex pattern to search for (e.g. "function withdraw" or "modifier lock").',
        },
        pathPrefix: {
          type: 'string',
          description: 'Subdirectory to search inside (default: ".").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'submit_verdict',
    description: 'Submits the final verification result for this finding once an exploit test has been written and proven via forge test, or when determined to be a false positive.',
    parameters: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['PROVEN_EXPLOIT', 'PROVEN_FALSE_POSITIVE', 'CANNOT_REPRODUCE'],
          description: 'PROVEN_EXPLOIT: Test successfully broke invariant / drained funds. PROVEN_FALSE_POSITIVE: Invariant held and exploit reverted. CANNOT_REPRODUCE: Could not construct a working proof.',
        },
        testFile: {
          type: 'string',
          description: 'Path to the finalized Foundry test file (e.g. "test/zyron/FINDING_001.t.sol").',
        },
        testFunction: {
          type: 'string',
          description: 'The specific test function name executed (e.g. "test_exploit").',
        },
        reasoning: {
          type: 'string',
          description: 'Detailed technical rationale explaining the vulnerability root cause or why the finding is a false positive.',
        },
        fundsDrainedEth: {
          type: 'number',
          description: 'Estimated or demonstrated amount of ETH/tokens drained in the proof.',
        },
        executionMode: {
          type: 'string',
          description: 'Execution mode used: "local" or "fork:<network>@<blockNumber>".',
        },
        declaredMocks: {
          type: 'array',
          items: { type: 'string', description: 'Names of mock contracts used, if any.' },
          description: 'List of any mock contracts created for external dependencies.',
        },
      },
      required: ['verdict', 'testFile', 'testFunction', 'reasoning'],
    },
  },
];
