import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Executor, ExecOptions, ExecResult } from './executor';

export interface DockerExecutorOptions {
  jobId: string;
  workspaceDir: string;
  imageName?: string;
  memoryLimit?: string;
  cpuLimit?: string;
}

export class DockerExecutor implements Executor {
  readonly workspaceDir: string;
  readonly jobId: string;
  readonly containerName: string;
  private readonly imageName: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private isRunning = false;

  constructor(options: DockerExecutorOptions) {
    this.jobId = options.jobId;
    this.workspaceDir = options.workspaceDir;
    this.containerName = `zyron-job-${options.jobId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    this.imageName = options.imageName || 'zyron-sandbox:latest';
    this.memoryLimit = options.memoryLimit || '2g';
    this.cpuLimit = options.cpuLimit || '2.0';

    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  async startSession(): Promise<void> {
    // 1. Check if the image exists locally before running (avoids hanging while Docker attempts remote pull)
    const inspectRes = await this.runHostCommand('docker', ['image', 'inspect', this.imageName], { timeoutMs: 5000 });
    if (inspectRes.exitCode !== 0) {
      if (inspectRes.stderr.includes('ENOENT') || inspectRes.stderr.includes('not recognized')) {
        throw new Error(
          'Docker is not installed or not in system PATH. Please ensure Docker Desktop is running.'
        );
      }
      throw new Error(
        `Docker image "${this.imageName}" was not found locally. Please build it first with:\n  docker build -t ${this.imageName} -f docker/Dockerfile.sandbox .`
      );
    }

    // 2. Remove any leftover container with the same name if previously crashed
    await this.runHostCommand('docker', ['rm', '-f', this.containerName], { timeoutMs: 5000 });

    const absWorkspace = path.resolve(this.workspaceDir);
    const args = [
      'run',
      '-d',
      '--rm',
      '--name',
      this.containerName,
      `--memory=${this.memoryLimit}`,
      `--memory-swap=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      '--pids-limit=200',
      '-v',
      `${absWorkspace}:/workspace`,
      '-w',
      '/workspace',
      this.imageName,
      'tail',
      '-f',
      '/dev/null',
    ];

    const result = await this.runHostCommand('docker', args, { timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start Docker sandbox container: ${result.stderr || result.stdout}`);
    }

    this.isRunning = true;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.isRunning) {
      throw new Error(`Cannot execute command: Docker session ${this.containerName} is not running.`);
    }

    const targetCwd = options.cwd ? `/workspace/${options.cwd.replace(/^\/+/, '')}` : '/workspace';
    const timeoutMs = options.timeoutMs ?? 120000;

    const args = [
      'exec',
      '-u',
      'zyron',
      '-w',
      targetCwd,
      this.containerName,
      'bash',
      '-lc',
      command,
    ];

    return this.runHostCommand('docker', args, { timeoutMs });
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = path.resolve(this.workspaceDir, relativePath);
    if (!fullPath.startsWith(path.resolve(this.workspaceDir))) {
      throw new Error('Access denied: Path traversal outside workspace');
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    return fs.readFileSync(fullPath, 'utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.resolve(this.workspaceDir, relativePath);
    if (!fullPath.startsWith(path.resolve(this.workspaceDir))) {
      throw new Error('Access denied: Path traversal outside workspace');
    }

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const fullPath = path.resolve(this.workspaceDir, relativePath);
    if (!fullPath.startsWith(path.resolve(this.workspaceDir))) {
      return false;
    }
    return fs.existsSync(fullPath);
  }

  async endSession(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.runHostCommand('docker', ['stop', '-t', '2', this.containerName], { timeoutMs: 10000 });
    } catch (err: any) {
      console.warn(`[DockerExecutor] Warning stopping container ${this.containerName}: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private runHostCommand(
    cmd: string,
    args: string[],
    options: { timeoutMs: number }
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(cmd, args, { shell: false });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, options.timeoutMs);

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: `${stderr}\n${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          stderr += `\n[Command timed out after ${options.timeoutMs}ms]`;
        }
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 124 : (code ?? 0),
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}
