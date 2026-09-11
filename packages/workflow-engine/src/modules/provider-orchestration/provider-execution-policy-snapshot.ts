/** Canonical provider execution policy snapshot DTOs; field and wire semantics are unchanged. */
import type { DataAuthorizationRetryAccounting } from '@jigwright/core/data-authorization-policy-port';
import type { ProviderAttemptBudgetReservation } from './provider-retry-accounting.ts';
import type { ProviderExecutionBudgetAuthority } from './provider-execution-budget-authority.ts';
import type { ProviderId } from './provider-registry.ts';

export type ProviderExecutionPolicySnapshotV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-execution-policy-snapshot';
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  policyDocument: string;
  retryAccounting: DataAuthorizationRetryAccounting<ProviderId>;
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
  retryAccounting: DataAuthorizationRetryAccounting<ProviderId>;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
  authority: ProviderExecutionBudgetAuthority;
}>;

export type ProviderExecutionPolicySnapshotCurrent =
  ProviderExecutionPolicySnapshotV2 | ProviderExecutionPolicySnapshotV3;
