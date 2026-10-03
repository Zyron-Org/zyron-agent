import { Executor } from '../sandbox/executor';
import { StoredJob } from '../queue/file-queue';

export interface BootstrapResult {
  success: boolean;
  originalFiles: string[];
  buildOutput: string;
  hasErrors: boolean;
}

export class WorkspaceBootstrap {
  static async setup(
    executor: Executor,
    job: StoredJob,
    githubToken?: string
  ): Promise<BootstrapResult> {
    const originalFiles: string[] = [];

    // Step 1: Ingest source code or clone repository
    if (job.repo?.url) {
      console.log(`[WorkspaceBootstrap] Cloning repository: ${job.repo.url}...`);
      let cloneUrl = job.repo.url;

      if (githubToken && cloneUrl.includes('github.com')) {
        const cleanUrl = cloneUrl.replace(/^https?:\/\//, '');
        cloneUrl = `https://x-access-token:${githubToken}@${cleanUrl}`;
      }

      const cloneRes = await executor.exec(`git clone --quiet ${cloneUrl} .`);
      if (cloneRes.exitCode !== 0) {
        console.warn(`[WorkspaceBootstrap] Git clone failed: ${cloneRes.stderr}`);
        return {
          success: false,
          originalFiles: [],
          buildOutput: `Git clone error: ${cloneRes.stderr}`,
          hasErrors: true,
        };
      }

      if (job.repo.commit || job.repo.branch) {
        const targetRef = job.repo.commit || job.repo.branch;
        await executor.exec(`git checkout ${targetRef}`);
      }

      await executor.exec('git submodule update --init --recursive');

      // Record original tracked files for tamper verification
      const lsRes = await executor.exec('git ls-files');
      if (lsRes.exitCode === 0) {
        originalFiles.push(
          ...lsRes.stdout
            .split('\n')
            .map((f) => f.trim())
            .filter(Boolean)
        );
      }
    } else if (job.sourceCode) {
      console.log(`[WorkspaceBootstrap] Initializing standalone contract workspace...`);
      const fileName = job.contractFileName || 'Target.sol';
      await executor.writeFile(`src/${fileName}`, job.sourceCode);
      originalFiles.push(`src/${fileName}`);

      // Create standard foundry.toml
      const defaultFoundryToml = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test/zyron"
solc_version = "${job.compilerVersion || '0.8.28'}"
optimizer = true
optimizer_runs = 200
`;
      await executor.writeFile('foundry.toml', defaultFoundryToml);
    }

    // Step 2: Ensure test/zyron directory exists for proof artifacts
    await executor.exec('mkdir -p test/zyron');

    // Step 3: Ensure foundry.toml exists if project is Hardhat/Truffle
    const hasFoundryToml = await executor.fileExists('foundry.toml');
    if (!hasFoundryToml) {
      console.log('[WorkspaceBootstrap] No foundry.toml found. Generating Foundry configuration...');
      const fallbackToml = `[profile.default]
src = "contracts"
test = "test/zyron"
out = "out"
libs = ["node_modules", "lib"]
auto_detect_solc = true
optimizer = true
optimizer_runs = 200
`;
      await executor.writeFile('foundry.toml', fallbackToml);
    }

    // Step 4: Run initial smoke build
    console.log('[WorkspaceBootstrap] Running initial forge build check...');
    const buildRes = await executor.exec('forge build --skip test');

    return {
      success: true,
      originalFiles,
      buildOutput: buildRes.stdout || buildRes.stderr,
      hasErrors: buildRes.exitCode !== 0,
    };
  }
}
