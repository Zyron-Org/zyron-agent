export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface Executor {
  readonly workspaceDir: string;

  /**
   * Initializes the environment session (e.g. starts the container).
   */
  startSession(): Promise<void>;

  /**
   * Runs a shell command inside the sandbox.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Reads a file relative to workspaceDir.
   */
  readFile(relativePath: string): Promise<string>;

  /**
   * Writes a file relative to workspaceDir.
   */
  writeFile(relativePath: string, content: string): Promise<void>;

  /**
   * Checks if a file exists relative to workspaceDir.
   */
  fileExists(relativePath: string): Promise<boolean>;

  /**
   * Tears down the session and releases resources (e.g. stops and removes container).
   */
  endSession(): Promise<void>;
}
