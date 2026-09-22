/** Canonical provider invocation lifecycle DTOs; field and wire semantics are unchanged. */
import type { AgentRuntimeCompletionReceipt } from './agent-runtime-port.ts';
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';
import type { ProviderProcessResult } from './provider-contracts.ts';

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
