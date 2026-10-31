export type ProverStatus =
  | 'PROVEN_EXPLOIT'
  | 'PROVEN_FALSE_POSITIVE'
  | 'CANNOT_REPRODUCE'
  | 'COMPILATION_FAILED'
  | 'INCONCLUSIVE';

export interface TraceStep {
  step: number;
  depth: number;
  caller: string;
  target: string;
  functionName: string;
  value?: string;
  gasUsed?: number;
  stateChange?: string;
  status: 'SUCCESS' | 'REVERTED';
  detail?: string;
}

export interface FindingToProve {
  id: string;
  ruleId?: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  location?: string;
  description: string;
  pocScenario?: string;
  vulnerableCode?: string;
}

export interface ProverJobInput {
  jobId: string;
  auditId: string;
  callbackUrl?: string;
  contractFileName: string;
  sourceCode: string;
  forkNetwork?: string; // 'monad' | 'mainnet' | 'arbitrum' | 'sepolia'
  findingsToProve: FindingToProve[];
}

export interface VerificationCheck {
  id: string;
  passed: boolean;
  detail?: string;
}

export interface VerificationRun {
  run: number;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  gasUsed?: number;
  outputSha256: string;
}

/** Deterministic verifier output. This - not the model - determines the final status. */
export interface VerificationRecord {
  verifierVersion: string;
  claimedVerdict: string;
  finalStatus: 'PROVEN_EXPLOIT' | 'PROVEN_FALSE_POSITIVE' | 'INCONCLUSIVE';
  reasonCodes: string[];
  checks: VerificationCheck[];
  integrityMethod: 'sha256' | 'git-status' | 'none';
  sourceHashes: Record<string, string>;
  testFile?: string;
  testFunction?: string;
  testArtifactSha256?: string;
  counterevidenceGuard?: string;
  runs: VerificationRun[];
  verifiedAt: string;
}

/** Auditable record of one tool invocation (no hidden model reasoning is stored). */
export interface InvestigationStep {
  turn: number;
  tool: string;
  arguments: Record<string, any>;
  ok: boolean;
  outputPreview: string;
  outputSha256: string;
  rejectedReason?: string;
}

export interface ProverFindingResult {
  findingId: string;
  ruleId?: string;
  status: ProverStatus;
  verdict?: ProverStatus;
  fundsDrainedEth?: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  synthesizedPoC?: string;
  deltaBalance?: string;
  gasUsed?: number;
  traceSteps: TraceStep[];
  executionLogs: string[];
  verification?: VerificationRecord;
  investigation?: InvestigationStep[];
  model?: { provider: string; model: string; turns: number; totalTokens?: number };
}

export interface ProverJobResult {
  jobId: string;
  auditId: string;
  status: 'COMPLETED' | 'FAILED';
  durationMs: number;
  results: ProverFindingResult[];
  error?: string;
}
