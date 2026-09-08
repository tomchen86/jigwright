/**
 * Define persisted provider invocation, reservation, policy, and completion record shapes.
 *
 * Invariants:
 * - Schema versions, field names, unions, and optional fields retain their wire meaning.
 * - Public types remain available through provider-invocation-store.
 *
 * Depends on: provider contracts, execution policy authority, and agent runtime receipts.
 * Failure modes: Shape drift rejects durable records or misrepresents their authority.
 */

import { type AiAdapterRetryAccounting } from '../provider-execution/ai-adapter-policy.ts';
import {
  type RetryMode,
  type ExecutionFailureKind,
  type ReadOnlyProbeRequest,
} from '../../modules/provider-orchestration/execution-core.ts';
import { type ProviderExecutionBudgetAuthority } from '../provider-execution/provider-execution-policy-authority.ts';
import {
  type ProviderInvocationRequest,
  type ProviderProcessResult,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type { AgentRuntimeCompletionReceipt } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import type {
  ProviderId,
  CapabilityPurpose,
} from '../../modules/provider-orchestration/provider-registry.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';
import { type ProviderInvocationSupersessionCrashPhase } from '../provider-execution/provider-invocation-supersession.ts';
import {
  type PlanReviewSubject,
  type PlanReviewTargetSnapshot,
} from '../../modules/assurance/plan-review.ts';
import {
  type TaskDiffReviewRecord,
  type TaskDiffReviewChallengeResponseRecord,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  type TaskDiffReviewSubject,
  type TaskDiffReviewScope,
} from '../../modules/assurance/task-diff-review.ts';
import { type TaskStrategyImplementationManifest } from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';

export type NormalizedChangeIntent = {
  schemaVersion: 1;
  summary: string;
  sourceRefs: `SRC-${string}`[];
  explicitPaths: string[];
  explicitSymbols: string[];
  explicitConfigKeys: string[];
  renamePairs: Array<{
    from: string;
    to: string;
  }>;
};

export type BlindSurveyManifest = {
  schemaVersion: 1;
  kind: 'blind-survey-manifest';
  changeId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  normalizedIntent: NormalizedChangeIntent;
  architectureQuestion: string;
  capabilityProfile: 'repository-read-only';
};

export type PlanReviewManifest = {
  schemaVersion: 1;
  kind: 'plan-review-manifest';
  changeId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  subject: PlanReviewSubject;
  planningTarget?: PlanReviewTargetSnapshot;
  capabilityProfile: 'repository-read-only';
};

export type TaskDiffReviewManifest = {
  schemaVersion: 1;
  kind: 'task-diff-review-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  reviewScope: TaskDiffReviewScope;
  capabilityProfile: 'repository-read-only';
};

export type TaskDiffReviewContinuationManifest = {
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  capabilityProfile: 'repository-read-only';
};

export type ProviderInvocationManifest =
  | BlindSurveyManifest
  | PlanReviewManifest
  | TaskDiffReviewManifest
  | TaskDiffReviewContinuationManifest
  | TaskStrategyImplementationManifest;

export type InvestigationStartReservation = {
  schemaVersion: 1;
  kind: 'investigation-start-reservation';
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  investigationId: string;
  invocationId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string | null;
  baseline: {
    head: string;
    tree: string;
  };
  manifestDigest: string;
  requestDigest: string;
  manifest: BlindSurveyManifest;
  request: ProviderInvocationRequest;
  createdAt: string;
};

export type InvestigationStartReservationSnapshot = Readonly<{
  rawDocument: string | null;
  digest: string | null;
  reservation: InvestigationStartReservation | null;
}>;

export type ProviderRetryDecisionBinding = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-decision-binding';
  executionJobId: string;
  executionRevision: number;
  failedAttemptId: string;
  evidenceDigest: string;
  evaluatedAt: string;
}>;

export type ProviderRetryReservationV2 = {
  schemaVersion: 2;
  kind: 'provider-retry-reservation';
  investigationId: string;
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  attempt: number;
  previousInvocationId: string;
  invocationId: string;
  manifestDigest: string;
  requestDigest: string;
  request: ProviderInvocationRequest;
  retryDecision: ProviderRetryDecisionBinding;
  executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent;
  createdAt: string;
};

export type ProviderRetryReplacementBinding = Readonly<{
  attemptId: string;
  retryMode: Exclude<RetryMode, 'none' | 'new-context'>;
  strategyChanges: readonly string[];
  environmentDigest: string;
  executionGrantId: string | null;
  authorizationNodeId: string;
  reservationNodeId: string;
}>;

export type ProviderRetryReservationV3 = Omit<
  ProviderRetryReservationV2,
  'schemaVersion'
> & {
  schemaVersion: 3;
  replacement: ProviderRetryReplacementBinding;
};

export type ProviderRetryReservationCurrent =
  ProviderRetryReservationV2 | ProviderRetryReservationV3;

export type ProviderInvocationFailure = {
  kind: 'retryable' | 'repository-reconciliation-required';
  code: string;
  message: string;
  executionKind?: ExecutionFailureKind;
  retryAfterMs?: number;
  probe?: Readonly<ReadOnlyProbeRequest>;
};

export type ProviderInvocationLease = {
  generation: number;
  workerId: string;
  tokenDigest: string;
  acquiredAt: string;
  expiresAt: string;
};

export type ProviderInvocationRecord = {
  schemaVersion: 1;
  invocationId: string;
  investigationId: string;
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  attempt: number;
  revision: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  providerId: ProviderId;
  purpose: CapabilityPurpose;
  requestDigest: string;
  manifestDigest: string;
  leaseGeneration: number;
  lease: ProviderInvocationLease | null;
  result: ProviderProcessResult | null;
  failure: ProviderInvocationFailure | null;
  /** Absent on historical and synchronous single-shot invocation records. */
  runtimeReceipt?: AgentRuntimeCompletionReceipt;
  createdAt: string;
  updatedAt: string;
};

export type ProviderAttemptBudgetReservation = Readonly<{
  runtimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
}>;

export type ProviderRetryAccountingSnapshot = Readonly<{
  retryPolicy: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
}>;

export type ProviderExecutionPolicySnapshotV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-execution-policy-snapshot';
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  policyDocument: string;
  retryAccounting: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
}>;

export type ProviderExecutionPolicySnapshotV3 = Readonly<{
  schemaVersion: 3;
  kind: 'provider-execution-policy-snapshot';
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  policyDocument: string;
  retryAccounting: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
  authority: ProviderExecutionBudgetAuthority;
}>;

export type ProviderExecutionPolicySnapshotCurrent =
  ProviderExecutionPolicySnapshotV2 | ProviderExecutionPolicySnapshotV3;

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

export type PlanReviewSnapshotRuntime = {
  root: string;
  files: Array<{ id: string; path: string }>;
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
