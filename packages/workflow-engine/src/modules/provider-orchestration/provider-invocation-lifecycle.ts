/** Canonical provider invocation lifecycle DTOs; field and wire semantics are unchanged. */
import type { AgentRuntimeCompletionReceipt } from './agent-runtime-port.ts';
import type { ProviderInvocationManifest } from './provider-invocation-manifest.ts';
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessResult,
} from './provider-contracts.ts';
import type { TaskMandateBinding } from '../authority/task-mandate-contract.ts';

export type ProviderInvocationSupersessionCrashPhase =
  | 'transaction-written'
  | 'transaction-prepared'
  | 'edge-written'
  | 'predecessor-indexed'
  | 'successor-indexed';

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

export type CreateProviderInvocationInput = {
  investigationId: string;
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  attempt: number;
  manifest: ProviderInvocationManifest;
  request: ProviderInvocationRequest;
  planReviewSnapshotFiles?: Array<{
    snapshotFile: string;
    content: Buffer;
  }>;
  createdAt?: string;
  simulateSupersessionCrashAfter?: ProviderInvocationSupersessionCrashPhase;
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
