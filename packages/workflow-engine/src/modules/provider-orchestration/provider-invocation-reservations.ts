/** Canonical provider invocation reservations DTOs; field and wire semantics are unchanged. */
import type { BlindSurveyManifest } from '../investigation/manifest/blind-survey-manifest.ts';
import type { ProviderExecutionPolicySnapshotCurrent } from './provider-execution-policy-snapshot.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import type { RetryMode } from './execution-record-types.ts';
import type { TaskMandateBinding } from '../authority/task-mandate-contract.ts';

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
