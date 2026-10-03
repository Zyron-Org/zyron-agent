import * as fs from 'fs';
import * as path from 'path';

export interface TranscriptEntry {
  timestamp: string;
  stepIndex: number;
  kind: 'SYSTEM' | 'USER_PROMPT' | 'MODEL_THOUGHT' | 'TOOL_CALL' | 'TOOL_RESULT' | 'VERDICT' | 'ERROR';
  content?: string;
  toolCall?: {
    name: string;
    arguments: Record<string, any>;
  };
  toolResult?: {
    name: string;
    exitCode?: number;
    durationMs?: number;
    output: string;
    isError?: boolean;
  };
  tokens?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
  metadata?: Record<string, any>;
}

export class TranscriptLogger {
  private readonly filePath: string;
  private stepCounter = 0;

  constructor(jobId: string, findingId?: string, baseDir = path.join(process.cwd(), 'logs', 'jobs')) {
    const jobDir = path.join(baseDir, jobId);
    if (!fs.existsSync(jobDir)) {
      fs.mkdirSync(jobDir, { recursive: true });
    }
    const fileName = findingId ? `${findingId}.jsonl` : 'job.jsonl';
    this.filePath = path.join(jobDir, fileName);
  }

  getLogPath(): string {
    return this.filePath;
  }

  log(entry: Omit<TranscriptEntry, 'timestamp' | 'stepIndex'>): TranscriptEntry {
    this.stepCounter++;
    const fullEntry: TranscriptEntry = {
      timestamp: new Date().toISOString(),
      stepIndex: this.stepCounter,
      ...entry,
    };

    const sanitized = this.redactSecrets(fullEntry);
    fs.appendFileSync(this.filePath, JSON.stringify(sanitized) + '\n', 'utf8');
    return sanitized;
  }

  readEntries(): TranscriptEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  /**
   * Redacts sensitive credentials like GitHub tokens, Bearer tokens, and Ethereum private keys.
   */
  private redactSecrets(obj: any): any {
    if (typeof obj === 'string') {
      return obj
        .replace(/ghp_[A-Za-z0-9_]{30,}/g, '[REDACTED_GITHUB_TOKEN]')
        .replace(/github_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED_GITHUB_PAT]')
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED_TOKEN]')
        .replace(/0x[a-fA-F0-9]{64}/g, '[REDACTED_PRIVATE_KEY]')
        .replace(/key=[A-Za-z0-9_\-]{20,}/gi, 'key=[REDACTED_API_KEY]');
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactSecrets(item));
    }

    if (obj !== null && typeof obj === 'object') {
      const sanitized: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/token|secret|password|privatekey|apikey/i.test(k) && typeof v === 'string') {
          sanitized[k] = '[REDACTED]';
        } else {
          sanitized[k] = this.redactSecrets(v);
        }
      }
      return sanitized;
    }

    return obj;
  }
}
