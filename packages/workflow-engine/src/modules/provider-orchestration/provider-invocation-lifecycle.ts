/** Canonical provider invocation lifecycle DTOs; field and wire semantics are unchanged. */
import type {
  AgentRuntimeCompletionReceipt,
  ProviderInvocationAcceptanceBinding,
  AgentRuntimeProcessProgressProjection,
} from './agent-runtime-port.ts';
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';
import type {
  ProviderProcessResult,
  ProviderRunnerReport,
} from './provider-contracts.ts';

import type {
  AttemptRecord,
  FailureDescriptor,
  JobRecord,
  RetryDecision,
  WorkflowRecord,
} from './execution-record-types.ts';

export type ProviderCompletionCandidate = Readonly<{
  schemaVersion: 1;
  kind: 'provider-completion-candidate';
  invocationId: string;
  requestDigest: string;
  expectedInvocationRevision: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  result: ProviderProcessResult;
  runtimeReceipt?: AgentRuntimeCompletionReceipt;
  completedAt: string;
  candidateDigest: string;
}>;

export type ProviderWorkerClaimInput = {
  workerId: string;
  leaseDurationMs: number;
  expectedRevision?: number;
  now?: string;
};

export type ProviderLeaseClaim = {
  record: ProviderInvocationRecord;
  leaseToken: string;
};

export type ProviderWorkerLeaseClaim = ProviderLeaseClaim & {
  workerFenceToken: string;
};

export type ProviderCompletionRecovery = Readonly<{
  record: ProviderInvocationRecord;
  repaired: boolean;
  candidateDigest: string | null;
}>;

export type ProviderOutputSchemaGeneration = 'code-owned';

export type ProviderResidualsGeneration = Readonly<{
  generation: 'current';
  missing: readonly [];
}>;

/** Input shared by ordinary, claim-fenced and held-lock completion. */
export type ProviderInvocationCompletionInput = {
  expectedRevision: number;
  leaseGeneration: number;
  leaseToken: string;
  report: ProviderRunnerReport;
  acceptanceBinding: ProviderInvocationAcceptanceBinding;
  runtimeProgress?: AgentRuntimeProcessProgressProjection;
  now?: string;
  simulateCrashAfterExecutionAcceptance?: boolean;
  simulateCrashAfterProviderStateWriteBeforeContinuationAuthority?: boolean;
};

export type ExecutionResultView = {
  attemptId: string;
  invocationId: string;
  acceptance: 'accepted' | 'late-duplicate';
  outputDigest: string;
  outputSchema: ProviderOutputSchemaGeneration;
  residuals: ProviderResidualsGeneration | null;
};

export type ExecutionFailureView = {
  attemptId: string;
  failure: FailureDescriptor;
  decision: RetryDecision;
};

export type ExecutionJobInspection = {
  schemaVersion: 1;
  /** Stable public AgentRuntime lifecycle projected from the durable Job. */
  runtimeStatus: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  workflow: WorkflowRecord;
  job: JobRecord;
  attemptNumbering: 'recorded';
  attempts: AttemptRecord[];
  acceptedAttemptId: string | null;
  results: ExecutionResultView[];
  latestFailure: ExecutionFailureView | null;
};
