import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FileQueue } from '../src/queue/file-queue';
import { TranscriptLogger } from '../src/logging/transcript-logger';
import { GeminiProvider } from '../src/llm/gemini.provider';
import { LlmProvider } from '../src/llm/provider';
import { ToolDefinition } from '../src/llm/types';

describe('Phase 1 Core Infrastructure', () => {
  const testDataDir = path.join(process.cwd(), 'data', 'test-jobs');
  const testLogsDir = path.join(process.cwd(), 'logs', 'test-jobs');

  beforeEach(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
    if (fs.existsSync(testLogsDir)) {
      fs.rmSync(testLogsDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
    if (fs.existsSync(testLogsDir)) {
      fs.rmSync(testLogsDir, { recursive: true, force: true });
    }
  });

  describe('FileQueue (Durable Disk Queue)', () => {
    it('should atomically enqueue and retrieve jobs', () => {
      const queue = new FileQueue(testDataDir);
      const job = queue.enqueue({
        jobId: 'job-101',
        auditId: 'AUDIT-001',
        findings: [
          {
            id: 'F-1',
            title: 'Reentrancy in withdraw()',
            severity: 'CRITICAL',
            description: 'State update happens after transfer.',
          },
        ],
      });

      expect(job.status).toBe('QUEUED');
      expect(job.retryCount).toBe(0);

      const retrieved = queue.getJob('job-101');
      expect(retrieved).toBeDefined();
      expect(retrieved?.jobId).toBe('job-101');
      expect(retrieved?.findings.length).toBe(1);
    });

    it('should pick oldest queued job first', async () => {
      const queue = new FileQueue(testDataDir);

      queue.enqueue({
        jobId: 'job-first',
        auditId: 'AUDIT-A',
        createdAt: 1000,
        findings: [],
      });

      queue.enqueue({
        jobId: 'job-second',
        auditId: 'AUDIT-B',
        createdAt: 2000,
        findings: [],
      });

      const nextJob = queue.getNextQueuedJob();
      expect(nextJob?.jobId).toBe('job-first');
    });

    it('should recover jobs interrupted in RUNNING or DELIVERING status', () => {
      const queue = new FileQueue(testDataDir);

      queue.enqueue({
        jobId: 'job-crashed',
        auditId: 'AUDIT-CRASH',
        status: 'RUNNING',
        findings: [],
      });

      const recovered = queue.recoverCrashedJobs();
      expect(recovered).toBe(1);

      const jobAfterRecovery = queue.getJob('job-crashed');
      expect(jobAfterRecovery?.status).toBe('QUEUED');
      expect(jobAfterRecovery?.retryCount).toBe(1);
    });
  });

  describe('TranscriptLogger (JSONL Streaming & Secret Redaction)', () => {
    it('should stream steps sequentially and redact secrets', () => {
      const logger = new TranscriptLogger('test-job-99', 'finding-01', testLogsDir);

      logger.log({
        kind: 'USER_PROMPT',
        content: 'Analyze contract with token ghp_123456789012345678901234567890123456',
      });

      logger.log({
        kind: 'TOOL_CALL',
        toolCall: {
          name: 'run_command',
          arguments: {
            command: 'git clone https://x-access-token:ghp_123456789012345678901234567890123456@github.com/repo',
          },
        },
      });

      logger.log({
        kind: 'TOOL_RESULT',
        toolResult: {
          name: 'run_command',
          exitCode: 0,
          output: 'PrivateKey 0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d configured',
        },
      });

      const entries = logger.readEntries();
      expect(entries.length).toBe(3);
      expect(entries[0].stepIndex).toBe(1);
      expect(entries[0].content).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(entries[0].content).not.toContain('ghp_1234567890');

      expect(entries[1].toolCall?.arguments.command).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(entries[2].toolResult?.output).toContain('[REDACTED_PRIVATE_KEY]');
      expect(entries[2].toolResult?.output).not.toContain('4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d');
    });
  });

  describe('LlmProvider Contract & Gemini Formatting', () => {
    it('should correctly format tool definitions for function calling', () => {
      const provider = new GeminiProvider({ apiKey: 'test_key', model: 'gemini-2.5-flash' });

      const tools: ToolDefinition[] = [
        {
          name: 'run_command',
          description: 'Executes a command inside the container',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'The shell command to run',
              },
              timeoutSeconds: {
                type: 'integer',
                description: 'Timeout in seconds',
              },
            },
            required: ['command'],
          },
        },
      ];

      // Access private formatTools method for testing schema conversion
      const formatted = (provider as any).formatTools(tools);
      expect(formatted).toBeDefined();
      expect(formatted[0].functionDeclarations).toBeDefined();
      expect(formatted[0].functionDeclarations[0].name).toBe('run_command');
      expect(formatted[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
      expect(formatted[0].functionDeclarations[0].parameters.properties.command.type).toBe('STRING');
      expect(formatted[0].functionDeclarations[0].parameters.properties.timeoutSeconds.type).toBe('INTEGER');
    });

    it('should comply with LlmProvider interface when implemented as mock', async () => {
      class MockLlmProvider implements LlmProvider {
        readonly providerName = 'mock';
        readonly modelName = 'mock-v1';

        async chat() {
          return {
            content: 'I analyzed the contract.',
            toolCalls: [
              {
                id: 'call-1',
                name: 'run_command',
                arguments: { command: 'forge test' },
              },
            ],
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
            },
          };
        }
      }

      const mock = new MockLlmProvider();
      const res = await mock.chat([{ role: 'user', content: 'test' }]);
      expect(res.content).toBe('I analyzed the contract.');
      expect(res.toolCalls.length).toBe(1);
      expect(res.toolCalls[0].name).toBe('run_command');
      expect(res.usage?.totalTokens).toBe(150);
    });
  });
});
