import * as fs from 'fs';
import * as path from 'path';
import { Executor, ExecOptions, ExecResult } from './executor';

export class MockExecutor implements Executor {
  readonly workspaceDir: string;
  readonly commandHistory: string[] = [];
  private readonly mockResponses: Map<string, Partial<ExecResult>> = new Map();
  private isRunning = false;

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir || path.join(process.cwd(), 'data', 'test-workspace');
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  registerResponse(commandSubstring: string, response: Partial<ExecResult>): void {
    this.mockResponses.set(commandSubstring, response);
  }

  async startSession(): Promise<void> {
    this.isRunning = true;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.isRunning) {
      throw new Error('MockExecutor session is not active');
    }

    this.commandHistory.push(command);

    for (const [key, resp] of this.mockResponses.entries()) {
      if (command.includes(key)) {
        return {
          stdout: resp.stdout ?? '',
          stderr: resp.stderr ?? '',
          exitCode: resp.exitCode ?? 0,
          durationMs: resp.durationMs ?? 10,
        };
      }
    }

    return {
      stdout: `[Mock stdout for: ${command}]`,
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    };
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = path.resolve(this.workspaceDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fs.readFileSync(fullPath, 'utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.resolve(this.workspaceDir, relativePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  async fileExists(relativePath: string): Promise<boolean> {
    return fs.existsSync(path.resolve(this.workspaceDir, relativePath));
  }

  async endSession(): Promise<void> {
    this.isRunning = false;
  }
}
