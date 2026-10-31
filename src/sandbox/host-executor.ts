import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Executor, ExecOptions, ExecResult } from './executor';

export interface HostExecutorOptions {
  jobId: string;
  workspaceDir: string;
}

export class HostExecutor implements Executor {
  readonly workspaceDir: string;
  readonly jobId: string;
  private isRunning = false;

  constructor(options: HostExecutorOptions) {
    this.jobId = options.jobId;
    this.workspaceDir = path.resolve(options.workspaceDir);

    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  async startSession(): Promise<void> {
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
    this.isRunning = true;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.isRunning) {
      throw new Error(`Cannot execute command: Host session ${this.jobId} is not running.`);
    }

    const targetCwd = options.cwd
      ? path.resolve(this.workspaceDir, options.cwd.replace(/^\/+/, ''))
      : this.workspaceDir;

    if (!fs.existsSync(targetCwd)) {
      fs.mkdirSync(targetCwd, { recursive: true });
    }

    const timeoutMs = options.timeoutMs ?? 120000;
    const startTime = Date.now();

    const homeDir = process.env.HOME || '/Users/basil';
    const foundryBin = path.join(homeDir, '.foundry', 'bin');
    const customPath = [
      foundryBin,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      process.env.PATH || '',
    ].filter(Boolean).join(':');

    const env = {
      ...process.env,
      ...options.env,
      PATH: customPath,
      FOUNDRY_DIR: path.join(homeDir, '.foundry'),
    };

    return new Promise<ExecResult>((resolve) => {
      const proc = spawn('bash', ['-lc', command], {
        cwd: targetCwd,
        env,
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
          durationMs,
        });
      });

      proc.on('error', (err) => {
        const durationMs = Date.now() - startTime;
        resolve({
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
          exitCode: 1,
          durationMs,
        });
      });
    });
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
