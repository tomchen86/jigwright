/**
 * Defines the exact accounting facts needed by retry policy and derives the frozen Job budget.
 *
 * Invariants:
 * - Collection supplies explicit Job state and per-invocation accounting, never an admission flag.
 * - The Job deadline and provider limits retain their original canonical derivation.
 */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';
import type { DataAuthorizationRetryAccounting } from '@jigwright/core/data-authorization-policy-port';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import type {
  AttemptRecord,
  JobRecord,
  RetryPolicy,
  WorkflowRecord,
} from './execution-record-types.ts';
import { deepFreeze } from './execution-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type ProviderAttemptBudgetReservation = Readonly<{
  runtimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
}>;

export type ProviderRetryAccountingSnapshot = Readonly<{
  retryPolicy: DataAuthorizationRetryAccounting<
    ProviderInvocationRequest['providerId']
  >;
  attemptReservation: ProviderAttemptBudgetReservation;
  accountingDigest: string;
}>;

/** The domain view of a persisted Job; runtime may retain additional replay records. */
export type ProviderRetryJobState = Readonly<{
  revision: number;
  workflow: WorkflowRecord;
  job: JobRecord;
  attempts: AttemptRecord[];
  invocationProjection: {
    kind: 'provider-invocation-projection.v1';
    completeHistory: boolean;
    invocations: Array<{
      invocationId: string;
      invocationRevision: number;
      attemptId: string;
    }>;
  };
}>;

export type ProviderRetryAccountingEvidence = Readonly<{
  state: ProviderRetryJobState | null;
  invocations: readonly Readonly<{
    invocationId: string;
    request: ProviderInvocationRequest;
    accounting: ProviderRetryAccountingSnapshot | null;
  }>[];
}>;

export function providerRetryPolicyFromAccounting(
  accounting: DataAuthorizationRetryAccounting<
    ProviderInvocationRequest['providerId']
  >,
  createdAt: string,
): RetryPolicy {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw workflowError(
      'EXECUTION_STORE_PROJECTION_CONFLICT',
      'Provider retry accounting has an invalid Job creation timestamp.',
      ExitCode.guard,
    );
  }
  return deepFreeze({
    maxAttempts: accounting.maxAttempts,
    maxCumulativeRuntimeMs: accounting.maxCumulativeRuntimeMs,
    maxProviderCostMicros: accounting.maxProviderCostMicros,
    maxProviderTokens: accounting.maxProviderTokens,
    maxSameFailureFingerprint: accounting.maxSameFailureFingerprint,
    maxRepairAttempts: accounting.maxRepairAttempts,
    deadline: new Date(createdAtMs + accounting.deadlineMs).toISOString(),
    providerLimits: Object.fromEntries(
      Object.entries(accounting.providerLimits).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

/** A required observation capability; composition supplies the durable implementation. */
export type ProviderRetryAccountingReader = (
  paths: InvestigationRuntimePaths,
  failed: ProviderInvocationRecord,
  failedRequest: ProviderInvocationRequest,
) => ProviderRetryAccountingEvidence;
