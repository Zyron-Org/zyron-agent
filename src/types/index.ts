export type ProverStatus = 'PROVEN_EXPLOIT' | 'PROVEN_FALSE_POSITIVE' | 'INCONCLUSIVE';

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
  forkNetwork?: string; // 'mainnet' | 'arbitrum' | 'sepolia'
  findingsToProve: FindingToProve[];
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
}

export interface ProverJobResult {
  jobId: string;
  auditId: string;
  status: 'COMPLETED' | 'FAILED';
  durationMs: number;
  results: ProverFindingResult[];
  error?: string;
}
