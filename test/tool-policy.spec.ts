import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_TOOLS } from '../src/agent/tools';
import {
  ToolPolicyError,
  assertTestFile,
  assertTestFunction,
  assertWritablePath,
  forgeTestCommand,
  listWorkspaceDir,
  normalizeWorkspacePath,
  readWorkspaceFile,
  searchWorkspace,
  validateToolArgs,
} from '../src/agent/tool-policy';
import { WorkspaceBootstrap } from '../src/workspace/bootstrap';

describe('Tool Policy & Allowlists', () => {
  const ws = path.join(process.cwd(), 'data', 'test-policy-ws');

  beforeEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'Vault.sol'), 'pragma solidity ^0.8.24;\ncontract Vault { function withdraw() external {} }\n');
    fs.writeFileSync(path.join(ws, '.env'), 'SECRET=123\n');
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('does not expose any generic shell tool (run_command removed)', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).not.toContain('run_command');
    expect(names).toEqual(['read_file', 'list_dir', 'search_code', 'write_file', 'forge_build', 'run_forge_test', 'submit_verdict']);
  });

  it('rejects path traversal, absolute paths, .git, and .env files', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrow(ToolPolicyError);
    expect(() => normalizeWorkspacePath('../../etc/passwd')).toThrow(ToolPolicyError);
    expect(() => normalizeWorkspacePath('src/../../secret')).toThrow(ToolPolicyError);
    expect(() => normalizeWorkspacePath('.git/config')).toThrow(ToolPolicyError);
    expect(() => normalizeWorkspacePath('.env')).toThrow(ToolPolicyError);
    expect(() => normalizeWorkspacePath('sub/.env.local')).toThrow(ToolPolicyError);
  });

  it('allows writes ONLY to Solidity files under test/zyron/', () => {
    expect(assertWritablePath('test/zyron/F_001.t.sol')).toBe('test/zyron/F_001.t.sol');
    expect(() => assertWritablePath('src/Vault.sol')).toThrow(/only allowed to Solidity files under test\/zyron/);
    expect(() => assertWritablePath('foundry.toml')).toThrow(ToolPolicyError);
    expect(() => assertWritablePath('test/zyron/evil.sh')).toThrow(ToolPolicyError);
  });

  it('validates testFile and testFunction strictly before constructing forge command', () => {
    expect(assertTestFile('test/zyron/Exploit.t.sol')).toBe('test/zyron/Exploit.t.sol');
    expect(() => assertTestFile('test/Exploit.t.sol')).toThrow(ToolPolicyError);
    expect(assertTestFunction('test_exploit_1')).toBe('test_exploit_1');
    expect(() => assertTestFunction('test_exploit; rm -rf /')).toThrow(ToolPolicyError);
    expect(forgeTestCommand('test/zyron/Exploit.t.sol', 'test_exploit')).toBe(
      "FOUNDRY_OFFLINE=true forge test --match-path 'test/zyron/Exploit.t.sol' --match-test '^test_exploit$' -vvv"
    );
  });

  it('validates tool arguments against schema and rejects unknown keys or wrong types', () => {
    const readDef = AGENT_TOOLS.find((t) => t.name === 'read_file')!;
    expect(validateToolArgs(readDef, { filePath: 'src/Vault.sol' })).toEqual({ filePath: 'src/Vault.sol' });
    expect(() => validateToolArgs(readDef, {})).toThrow(/missing required/);
    expect(() => validateToolArgs(readDef, { filePath: 123 })).toThrow(/must be of type string/);
    expect(() => validateToolArgs(readDef, { filePath: 'src/Vault.sol', extra: true })).toThrow(/unknown argument/);
  });

  it('searches workspace in-process without invoking a shell and hides .env', () => {
    const out = searchWorkspace(ws, 'function withdraw; $(touch /tmp/pwn)', '.');
    expect(out).toBe('No matches found.');
    const found = searchWorkspace(ws, 'function withdraw', '.');
    expect(found).toContain('src/Vault.sol:2:');
    const secret = searchWorkspace(ws, 'SECRET', '.');
    expect(secret).toBe('No matches found.');
    const listing = listWorkspaceDir(ws, '.');
    expect(listing).not.toContain('.env');
    expect(readWorkspaceFile(ws, 'src/Vault.sol')).toContain('contract Vault');
  });

  it('rejects unsafe Git repository URLs, tokens, and refs in WorkspaceBootstrap before shell execution', async () => {
    const executedCommands: string[] = [];
    const fakeExecutor: any = {
      exec: async (cmd: string) => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      listFiles: async () => [],
      fileExists: async () => true,
      readFile: async () => '',
      writeFile: async () => {},
    };

    // Unsafe repo URL with shell metacharacters
    const badUrlRes = await WorkspaceBootstrap.setup(fakeExecutor, {
      jobId: 'job-bad-url',
      auditId: 'aud-1',
      repo: { url: 'https://github.com/org/repo; touch /tmp/pwn' },
      findings: [],
      callbackUrl: 'http://localhost:3001/cb',
    } as any);
    expect(badUrlRes.success).toBe(false);
    expect(badUrlRes.buildOutput).toContain('Rejected unsafe repository URL');
    expect(executedCommands).toHaveLength(0);

    // Unsafe git ref starting with '-' (git option injection) or containing shell metacharacters
    await WorkspaceBootstrap.setup(fakeExecutor, {
      jobId: 'job-bad-ref',
      auditId: 'aud-1',
      repo: { url: 'https://github.com/Zyron-Org/zyron-test-protocol', branch: '--upload-pack=evil' },
      findings: [],
      callbackUrl: 'http://localhost:3001/cb',
    } as any);
    expect(executedCommands.some((c) => c.includes('git checkout'))).toBe(false);
  });
});
