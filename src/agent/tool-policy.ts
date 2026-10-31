import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition } from '../llm/types';

export const MAX_TOOL_OUTPUT_CHARS = 12_000;
export const TEST_FILE_RE = /^test\/zyron\/[A-Za-z0-9_.\-/]+\.t\.sol$/;
export const WRITE_FILE_RE = /^test\/zyron\/[A-Za-z0-9_.\-/]+\.sol$/;
export const TEST_FN_RE = /^test[A-Za-z0-9_]{0,95}$/;

const DENIED_SEGMENTS = new Set(['.git', 'node_modules']);
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'cache', 'lib', 'broadcast']);
const SEARCH_EXTS = new Set(['.sol', '.vy', '.md', '.toml', '.txt', '.json', '.js', '.ts', '.yul', '.huff']);
const MAX_SEARCH_FILES = 3000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 256 * 1024;

export class ToolPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

export function truncateOutput(s: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.6));
  const tail = s.slice(s.length - Math.floor(max * 0.35));
  return `${head}\n...[truncated ${s.length - head.length - tail.length} chars]...\n${tail}`;
}

/** Validates tool arguments against the declared JSON schema (types, required, enum, maxLength, no extra keys). */
export function validateToolArgs(def: ToolDefinition, args: unknown): Record<string, any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolPolicyError(`${def.name}: arguments must be a JSON object`);
  }
  const a = args as Record<string, any>;
  const props = def.parameters.properties;
  for (const key of Object.keys(a)) {
    if (!(key in props)) throw new ToolPolicyError(`${def.name}: unknown argument "${key}"`);
  }
  for (const req of def.parameters.required || []) {
    if (a[req] === undefined || a[req] === null) throw new ToolPolicyError(`${def.name}: missing required argument "${req}"`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    const ok =
      spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'integer' ? Number.isInteger(v)
      : spec.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'array' ? Array.isArray(v)
      : false;
    if (!ok) throw new ToolPolicyError(`${def.name}: "${key}" must be of type ${spec.type}`);
    if (spec.enum && !spec.enum.includes(v)) throw new ToolPolicyError(`${def.name}: "${key}" must be one of ${spec.enum.join(', ')}`);
    if (spec.maxLength && typeof v === 'string' && v.length > spec.maxLength) {
      throw new ToolPolicyError(`${def.name}: "${key}" exceeds ${spec.maxLength} characters`);
    }
  }
  return a;
}

/** Normalizes a model-supplied workspace path; rejects absolute paths, traversal, and denied segments. */
export function normalizeWorkspacePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new ToolPolicyError('Path must be a non-empty string');
  if (p.includes('\0')) throw new ToolPolicyError('Path contains a null byte');
  if (path.posix.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\')) {
    throw new ToolPolicyError('Absolute paths are not allowed');
  }
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm === '..' || norm.startsWith('../')) throw new ToolPolicyError('Path escapes the workspace');
  const segments = norm.split('/');
  for (const seg of segments) {
    if (DENIED_SEGMENTS.has(seg)) throw new ToolPolicyError(`Access to "${seg}" is not allowed`);
    if (/^\.env(\..*)?$/.test(seg)) throw new ToolPolicyError('Access to environment files is not allowed');
  }
  return norm === '' ? '.' : norm;
}

/** Resolves inside the workspace and refuses symlink escapes. */
export function resolveInWorkspace(workspaceDir: string, rel: string): string {
  const root = fs.realpathSync(path.resolve(workspaceDir));
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new ToolPolicyError('Path escapes the workspace');
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    if (real !== root && !real.startsWith(root + path.sep)) throw new ToolPolicyError('Symlink escapes the workspace');
  }
  return full;
}

export function assertWritablePath(rel: string): string {
  const norm = normalizeWorkspacePath(rel);
  if (!WRITE_FILE_RE.test(norm)) {
    throw new ToolPolicyError('Writes are only allowed to Solidity files under test/zyron/ (original sources are immutable)');
  }
  return norm;
}

export function assertTestFile(rel: string): string {
  const norm = normalizeWorkspacePath(rel);
  if (!TEST_FILE_RE.test(norm)) throw new ToolPolicyError('testFile must be under test/zyron/ and end with .t.sol');
  return norm;
}

export function assertTestFunction(fn: string): string {
  if (!TEST_FN_RE.test(fn)) throw new ToolPolicyError('testFunction must match ^test[A-Za-z0-9_]*$');
  return fn;
}

export function readWorkspaceFile(workspaceDir: string, rel: string): string {
  const norm = normalizeWorkspacePath(rel);
  const full = resolveInWorkspace(workspaceDir, norm);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ToolPolicyError(`File not found: ${norm}`);
  const size = fs.statSync(full).size;
  if (size > MAX_READ_BYTES) throw new ToolPolicyError(`File too large to read (${size} bytes)`);
  return fs.readFileSync(full, 'utf8');
}

export function listWorkspaceDir(workspaceDir: string, rel = '.'): string {
  const norm = normalizeWorkspacePath(rel);
  const full = resolveInWorkspace(workspaceDir, norm);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new ToolPolicyError(`Directory not found: ${norm}`);
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((d) => !DENIED_SEGMENTS.has(d.name) && !/^\.env/.test(d.name))
    .map((d) => `${d.isDirectory() ? 'dir ' : 'file'}  ${d.name}`)
    .sort()
    .join('\n');
}

/** In-process search: no shell, bounded file count/size/results. */
export function searchWorkspace(workspaceDir: string, query: string, pathPrefix = '.', isRegex = false): string {
  const norm = normalizeWorkspacePath(pathPrefix);
  const start = resolveInWorkspace(workspaceDir, norm);
  let matcher: (line: string) => boolean;
  if (isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query);
    } catch {
      throw new ToolPolicyError('Invalid regular expression');
    }
    matcher = (l) => re.test(l);
  } else {
    matcher = (l) => l.includes(query);
  }

  const root = path.resolve(workspaceDir);
  const results: string[] = [];
  let scanned = 0;
  const stack = [start];
  while (stack.length > 0 && results.length < 50 && scanned < MAX_SEARCH_FILES) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const name = path.basename(cur);
      if (cur !== start && SEARCH_SKIP_DIRS.has(name)) continue;
      for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
      continue;
    }
    if (!SEARCH_EXTS.has(path.extname(cur)) || st.size > MAX_SEARCH_FILE_BYTES || /^\.env/.test(path.basename(cur))) continue;
    scanned++;
    const lines = fs.readFileSync(cur, 'utf8').split('\n');
    const rel = path.relative(root, cur).split(path.sep).join('/');
    for (let i = 0; i < lines.length && results.length < 50; i++) {
      if (matcher(lines[i])) results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  return results.length > 0 ? results.join('\n') : 'No matches found.';
}

export function forgeTestCommand(testFile: string, testFunction?: string): string {
  const file = assertTestFile(testFile);
  const fnPart = testFunction ? ` --match-test '^${assertTestFunction(testFunction)}$'` : '';
  // Inputs are regex-validated to [A-Za-z0-9_/.-], so single-quoting is safe.
  return `FOUNDRY_OFFLINE=true forge test --match-path '${file}'${fnPart} -vvv`;
}

export const FORGE_BUILD_COMMAND = 'FOUNDRY_OFFLINE=true forge build';
