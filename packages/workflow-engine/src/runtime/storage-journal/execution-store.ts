import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AiAdapterRetryAccounting } from '../provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  acceptAttemptResult,
  assertAttemptRecord,
  assertAttemptResult,
  assertJobRecord,
  assertWorkflowRecord,
  createReplacementAttempt,
  createAttemptResult,
  decideRetry,
  executionPolicyChangedFields,
  projectExecutionFailureState,
  projectProviderInvocationExecution,
  requireExecutionJobMandateBinding,
  type AttemptRecord,
  type AttemptResult,
  type JobRecord,
  type ProviderInvocationProjection,
  type RetryDecision,
  type RetryMode,
  type RetryPolicy,
  type WorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import { createExecutionBudgetGrantRequest } from '../../modules/authority/execution-governance.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import type {
  ProviderInvocationRecord,
  ProviderRetryAccountingSnapshot,
} from './provider-invocation-store.ts';
import {
  readProviderRepairLineage,
  type ProviderRepairLineage,
} from '../provider-execution/provider-execution-governance.ts';
import {
  MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
  assertProviderExecutionAdmissionAuthority,
  createProviderExecutionAdmissionAuthority,
  providerExecutionAdmissionAuthorityPath,
  type ProviderExecutionAdmissionAuthority,
} from './provider-execution-admission-authority.ts';

export { providerExecutionAdmissionAuthorityPath } from './provider-execution-admission-authority.ts';

const EXECUTION_JOB_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UNPREFIXED_DIGEST = /^[0-9a-f]{64}$/;
const MAX_PROVIDER_ATTEMPTS = 1_000;
const EXECUTION_STATE_FILE = /^[0-9a-f]{64}\.json$/;

export type ProviderExecutionEntry = Readonly<{
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  retryAccounting: ProviderRetryAccountingSnapshot;
  retryReplacement?: Readonly<{
    attemptId: string;
    retryMode: Exclude<RetryMode, 'none' | 'new-context'>;
    strategyChanges: readonly string[];
    environmentDigest: string;
    executionGrantId: string | null;
    authorizationNodeId: string;
    reservationNodeId: string;
  }> | null;
}>;

export function providerRetryPolicyFromAccounting(
  accounting: AiAdapterRetryAccounting,
  createdAt: string,
): RetryPolicy {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw executionProjectionConflict(
      'Provider retry accounting has an invalid Job creation timestamp.',
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

export function decideProviderExecutionFailure(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  attempts: readonly AttemptRecord[];
}): RetryDecision {
  const failure = input.attempt.failure;
  if (failure === null) {
    throw executionProjectionConflict(
      'A durable retry decision requires a failed Attempt.',
    );
  }
  const sameFingerprintCount = input.attempts.filter(
    ({ failureFingerprint }) =>
      failureFingerprint !== null && failureFingerprint === failure.fingerprint,
  ).length;
  const decision = decideRetry({
    workflow: input.workflow,
    job: input.job,
    attempt: input.attempt,
    failure,
    sameFingerprintCount,
    currentExecutionPolicy: input.attempt.policySnapshot,
    now: input.attempt.updatedAt,
  });
  if (
    ![
      'REPEATED_FAILURE',
      // A changed strategy has no automatic executor, so the boundary is
      // offered the same bounded-grant exit as an exhausted ladder.
      'REPEATED_FAILURE_STRATEGY_CHANGE',
      'RETRY_BUDGET_EXHAUSTED',
    ].includes(decision.reasonCode) ||
    input.job.mandateBinding === undefined
  ) {
    return decision;
  }
  const requestedChanges = [
    {
      path: '/retryPolicy/maxAttempts',
      from: input.job.retryPolicy.maxAttempts,
      to: input.job.retryPolicy.maxAttempts + 1,
    },
    ...(sameFingerprintCount > input.job.retryPolicy.maxSameFailureFingerprint
      ? [
          {
            path: '/retryPolicy/maxSameFailureFingerprint',
            from: input.job.retryPolicy.maxSameFailureFingerprint,
            to: input.job.retryPolicy.maxSameFailureFingerprint + 1,
          },
        ]
      : []),
  ];
  const requiredGrant = createExecutionBudgetGrantRequest({
    requestId: deterministicUuid({
      kind: 'provider-execution-budget-request.v1',
      jobId: input.job.jobId,
      attemptId: input.attempt.attemptId,
      failureFingerprint: failure.fingerprint,
    }),
    workflowId: input.job.workflowId,
    epoch: input.job.epoch,
    jobId: input.job.jobId,
    mandateBinding: requireExecutionJobMandateBinding(input.job),
    requestedChanges,
    rationale:
      'Automatic retry budget is exhausted; authorize one bounded replacement Attempt with the same semantic context.',
    expiresAfterAttempts: 1,
    createdAt: new Date(input.attempt.updatedAt),
  });
  return decideRetry({
    workflow: input.workflow,
    job: input.job,
    attempt: input.attempt,
    failure,
    sameFingerprintCount,
    boundedGrantRequest: requiredGrant,
    currentExecutionPolicy: input.attempt.policySnapshot,
    now: input.attempt.updatedAt,
  });
}

export type DurableExecutionJobState = Readonly<{
  schemaVersion: 1;
  revision: number;
  workflow: WorkflowRecord;
  job: JobRecord;
  attempts: AttemptRecord[];
  results: AttemptResult[];
  reconciliationReceipts: ExecutionReconciliationReceipt[];
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

export type ExecutionReconciliationReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-execution-reconciliation.v1';
  receiptId: string;
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedInvocationRevision: number;
  resultingExecutionRevision: number;
  beforeStateDigest: string;
  afterProjectionDigest: string;
  acceptedAttemptId: string | null;
  reconciledInvocationIds: string[];
  recordedAt: string;
}>;

export type DurableAttemptResultAcceptance = Readonly<{
  state: DurableExecutionJobState;
  accepted: boolean;
  result: AttemptResult;
}>;

export type DurableExecutionReconciliation = Readonly<{
  state: DurableExecutionJobState;
  receipt: ExecutionReconciliationReceipt;
  replayed: boolean;
}>;

export function executionStorePaths(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'execution');
  return {
    root,
    jobs: path.join(root, 'jobs'),
    admissionAuthorities: path.join(root, 'admission-authorities'),
  };
}

export function executionJobStatePath(
  paths: InvestigationRuntimePaths,
  requestedJobId: string,
): string {
  const jobId = assertExecutionJobId(requestedJobId);
  return path.join(
    executionStorePaths(paths).jobs,
    `${sha256Text(jobId)}.json`,
  );
}

export function readExecutionJobState(
  paths: InvestigationRuntimePaths,
  requestedJobId: string,
): DurableExecutionJobState | null {
  const jobId = assertExecutionJobId(requestedJobId);
  return readExecutionJobStateUnlocked(paths, jobId);
}

/**
 * Publish the immutable pre-launch Job bytes addressed by the exact acceptance
 * binding. Content-addressed publication is create-only and exact replay is
 * idempotent; a divergent collision is never repaired in place.
 */
export function publishProviderExecutionAdmissionAuthority(
  paths: InvestigationRuntimePaths,
  binding: ProviderInvocationAcceptanceBinding,
  executionState: DurableExecutionJobState,
): ProviderExecutionAdmissionAuthority {
  const authority = createProviderExecutionAdmissionAuthority(
    binding,
    executionState,
    executionAdmissionAuthorityUnsafe,
  );
  const authorityPath = providerExecutionAdmissionAuthorityPath(
    paths,
    authority.acceptanceBinding,
  );
  createPrivateCanonicalJson(
    paths,
    authorityPath,
    authority,
    executionAdmissionAuthorityUnsafe,
    'EXECUTION_ADMISSION_AUTHORITY_COLLISION',
    MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
  );
  const stored = assertProviderExecutionAdmissionAuthority(
    readPrivateCanonicalJson(
      paths,
      authorityPath,
      executionAdmissionAuthorityUnsafe,
      MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
    ),
    executionAdmissionAuthorityUnsafe,
  );
  if (canonicalJson(stored) !== canonicalJson(authority)) {
    throw executionAdmissionAuthorityUnsafe();
  }
  return stored;
}

/**
 * Re-read one durable Job and execute one short synchronous operation while
 * holding the exact lock used by every Job writer. The callback receives no
 * lock primitive and must not start asynchronous work.
 */
export function withExecutionJobStateSnapshot<T>(
  paths: InvestigationRuntimePaths,
  requestedJobId: string,
  operation: (snapshot: DurableExecutionJobState | null) => T,
): T {
  const jobId = assertExecutionJobId(requestedJobId);
  if (typeof operation !== 'function') {
    throw executionSnapshotCallbackInvalid();
  }
  return withExecutionJobLock(paths, jobId, () => {
    let callbackCount = 0;
    const snapshot = readExecutionJobStateUnlocked(paths, jobId);
    callbackCount += 1;
    const result = operation(snapshot);
    if (callbackCount !== 1 || isPromiseLike(result)) {
      throw executionSnapshotCallbackInvalid();
    }
    return result;
  });
}

export function listExecutionJobStates(
  paths: InvestigationRuntimePaths,
): DurableExecutionJobState[] {
  const stores = executionStorePaths(paths);
  const root = fs.lstatSync(stores.root, { throwIfNoEntry: false });
  if (root === undefined) return [];
  try {
    assertPrivateInvestigationDirectory(
      paths,
      stores.root,
      executionStoreUnsafe,
    );
    const jobs = fs.lstatSync(stores.jobs, { throwIfNoEntry: false });
    if (jobs === undefined) return [];
    assertPrivateInvestigationDirectory(
      paths,
      stores.jobs,
      executionStoreUnsafe,
    );
    const states = fs
      .readdirSync(stores.jobs, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !EXECUTION_STATE_FILE.test(entry.name)
        ) {
          throw executionStoreUnsafe();
        }
        const value = assertDurableExecutionJobState(
          readPrivateCanonicalJson(
            paths,
            path.join(stores.jobs, entry.name),
            executionStoreUnsafe,
          ),
        );
        if (`${sha256Text(value.job.jobId)}.json` !== entry.name) {
          throw executionStoreUnsafe();
        }
        return value;
      });
    const jobIds = states.map(({ job }) => job.jobId);
    if (new Set(jobIds).size !== jobIds.length) throw executionStoreUnsafe();
    return deepFreeze(
      states.sort((left, right) =>
        left.job.jobId.localeCompare(right.job.jobId),
      ),
    );
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw executionStoreUnsafe(error);
  }
}

/** Materialize all current provider invocations for one semantic Job. */
export function materializeProviderExecutionJob(
  paths: InvestigationRuntimePaths,
  entries: readonly ProviderExecutionEntry[],
  options: { expectedRevision?: number | null } = {},
): DurableExecutionJobState {
  const prepared = prepareProviderEntries(paths, entries);
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    assertExpectedRevision(current, options.expectedRevision);
    const candidate = buildProviderExecutionState(prepared, current);
    return persistExecutionJobState(paths, current, candidate);
  });
}

/**
 * Submit a fenced provider Attempt result against the durable Job aggregate.
 * The winner changes beneath the same lock; a later result is a late duplicate.
 */
export function acceptProviderAttemptResult(
  paths: InvestigationRuntimePaths,
  input: {
    entries: readonly ProviderExecutionEntry[];
    attemptId: string;
    leaseGeneration: number;
    leaseToken: string;
    outputDigest: string;
    completedAt: string;
    expectedRevision?: number;
  },
): DurableAttemptResultAcceptance {
  const prepared = prepareProviderEntries(paths, input.entries);
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    assertExpectedRevision(current, input.expectedRevision);
    const materialized = buildProviderExecutionState(prepared, current);
    const attemptIndex = materialized.attempts.findIndex(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (attemptIndex < 0) {
      throw executionProjectionConflict(
        'The submitted provider Attempt is not part of the projected Job.',
      );
    }
    const outputDigest = normalizeDigest(input.outputDigest);
    const existingResult = materialized.results.find(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (existingResult !== undefined) {
      if (existingResult.outputDigest !== outputDigest) {
        throw workflowError(
          'EXECUTION_STORE_RESULT_CONFLICT',
          'The durable Attempt already has a different result digest.',
          ExitCode.conflict,
        );
      }
      const state = persistExecutionJobState(paths, current, materialized);
      return deepFreeze({
        state,
        accepted: existingResult.acceptance === 'accepted',
        result: existingResult,
      });
    }
    const outcome = acceptAttemptResult({
      workflow: materialized.workflow,
      job: materialized.job,
      attempt: materialized.attempts[attemptIndex]!,
      expectedAcceptedAttemptId: materialized.job.acceptedAttemptId,
      leaseGeneration: input.leaseGeneration,
      leaseToken: input.leaseToken,
      outputDigest,
      completedAt: input.completedAt,
    });
    const attempts = [...materialized.attempts];
    attempts[attemptIndex] = outcome.attempt;
    const results = [...materialized.results, outcome.result].sort(
      (left, right) =>
        attemptNumber(attempts, left.attemptId) -
        attemptNumber(attempts, right.attemptId),
    );
    const candidate = assertDurableExecutionJobState({
      ...materialized,
      job: {
        ...outcome.job,
        // Provider Attempts are charged conservatively when their durable
        // reservation is materialized. Result acceptance must not charge the
        // same reservation a second time.
        cumulativeRuntimeMs: materialized.job.cumulativeRuntimeMs,
        providerCostMicros: materialized.job.providerCostMicros,
        providerTokens: materialized.job.providerTokens,
      },
      attempts,
      results,
    });
    const state = persistExecutionJobState(paths, current, candidate);
    return deepFreeze({
      state,
      accepted: outcome.accepted,
      result: outcome.result,
    });
  });
}

/**
 * Recover one durable Attempt result from an already-persisted completion
 * candidate. This boundary accepts only the candidate's lease-token digest;
 * ordinary result submission must continue to prove possession of the raw
 * lease token through acceptProviderAttemptResult.
 */
export function recoverProviderAttemptResultFromCandidate(
  paths: InvestigationRuntimePaths,
  input: {
    entries: readonly ProviderExecutionEntry[];
    attemptId: string;
    leaseGeneration: number;
    leaseTokenDigest: string;
    outputDigest: string;
    completedAt: string;
    expectedRevision?: number;
  },
): DurableAttemptResultAcceptance {
  const prepared = prepareProviderEntries(paths, input.entries);
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    assertExpectedRevision(current, input.expectedRevision);
    if (current === null) throw executionResultRecoveryConflict();

    const projected = prepared.entries.find(
      ({ projection }) => projection.attempt.attemptId === input.attemptId,
    )?.projection;
    const currentAttempt = current.attempts.find(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (projected === undefined || currentAttempt === undefined) {
      throw executionResultRecoveryConflict();
    }

    const materialized = buildProviderExecutionState(prepared, current);
    const materializedAttempt = materialized.attempts.find(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (
      materializedAttempt === undefined ||
      canonicalJson(materialized) !== canonicalJson(current) ||
      canonicalJson(
        providerAttemptRecoveryProjectionBinding(projected.attempt),
      ) !==
        canonicalJson(
          providerAttemptRecoveryProjectionBinding(currentAttempt),
        ) ||
      canonicalJson(
        providerWorkflowRecoveryBinding(
          prepared.entries[0]!.projection.workflow,
        ),
      ) !== canonicalJson(providerWorkflowRecoveryBinding(current.workflow)) ||
      canonicalJson(
        providerJobRecoveryBinding(prepared.entries[0]!.projection.job),
      ) !== canonicalJson(providerJobRecoveryBinding(current.job))
    ) {
      throw executionResultRecoveryConflict();
    }

    const leaseTokenDigest = normalizeRecoveryDigest(input.leaseTokenDigest);
    const outputDigest = normalizeRecoveryDigest(input.outputDigest);
    if (!isExactTimestamp(input.completedAt)) {
      throw executionResultRecoveryConflict();
    }
    assertCandidateRecoveryLease(
      projected.attempt,
      input.leaseGeneration,
      leaseTokenDigest,
      input.completedAt,
    );
    assertCandidateRecoveryLease(
      currentAttempt,
      input.leaseGeneration,
      leaseTokenDigest,
      input.completedAt,
    );
    assertCandidateRecoveryLease(
      materializedAttempt,
      input.leaseGeneration,
      leaseTokenDigest,
      input.completedAt,
    );

    const existingResult = current.results.find(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    if (existingResult !== undefined) {
      const exactReplay = createAttemptResult(
        currentAttempt,
        outputDigest,
        existingResult.acceptance,
        input.completedAt,
      );
      if (canonicalJson(exactReplay) !== canonicalJson(existingResult)) {
        throw executionResultRecoveryConflict();
      }
      return deepFreeze({
        state: current,
        accepted: existingResult.acceptance === 'accepted',
        result: existingResult,
      });
    }
    if (!['leased', 'running'].includes(currentAttempt.status)) {
      throw executionResultRecoveryConflict();
    }

    const accepted = current.job.acceptedAttemptId === null;
    const recoveredAttempt = assertAttemptRecord({
      ...currentAttempt,
      status: accepted ? 'succeeded' : 'late-duplicate',
      retention: accepted ? currentAttempt.retention : 'debug',
      updatedAt: input.completedAt,
    });
    const result = createAttemptResult(
      recoveredAttempt,
      outputDigest,
      accepted ? 'accepted' : 'late-duplicate',
      input.completedAt,
    );
    const attempts = [...current.attempts];
    const attemptIndex = attempts.findIndex(
      ({ attemptId }) => attemptId === input.attemptId,
    );
    attempts[attemptIndex] = recoveredAttempt;
    const results = [...current.results, result].sort(
      (left, right) =>
        attemptNumber(attempts, left.attemptId) -
        attemptNumber(attempts, right.attemptId),
    );
    const candidate = assertDurableExecutionJobState({
      ...current,
      job: accepted
        ? {
            ...current.job,
            status: 'succeeded',
            acceptedAttemptId: currentAttempt.attemptId,
            updatedAt: latestTimestamp(
              current.job.updatedAt,
              input.completedAt,
            ),
          }
        : current.job,
      attempts,
      results,
    });
    const state = persistExecutionJobState(paths, current, candidate);
    return deepFreeze({ state, accepted, result });
  });
}

export function reconcileProviderExecutionJob(
  paths: InvestigationRuntimePaths,
  input: {
    entries: readonly ProviderExecutionEntry[];
    triggerInvocationId: string;
    expectedExecutionRevision: number;
    expectedInvocationRevision: number;
  },
): DurableExecutionReconciliation {
  const prepared = prepareProviderEntries(paths, input.entries);
  const trigger = prepared.entries.find(
    ({ record }) => record.invocationId === input.triggerInvocationId,
  );
  if (
    trigger === undefined ||
    !Number.isSafeInteger(input.expectedInvocationRevision) ||
    input.expectedInvocationRevision < 0 ||
    trigger.record.revision !== input.expectedInvocationRevision
  ) {
    throw workflowError(
      'EXECUTION_RECONCILIATION_INVOCATION_REVISION_MISMATCH',
      'The trigger invocation does not have the expected revision.',
      ExitCode.staleState,
      {
        details: {
          expectedInvocationRevision: input.expectedInvocationRevision,
          observedInvocationRevision: trigger?.record.revision ?? null,
        },
      },
    );
  }
  const receiptId = reconciliationReceiptId({
    jobId: prepared.jobId,
    triggerInvocationId: input.triggerInvocationId,
    expectedExecutionRevision: input.expectedExecutionRevision,
    expectedInvocationRevision: input.expectedInvocationRevision,
  });
  return withExecutionJobLock(paths, prepared.jobId, () => {
    const current = readExecutionJobStateUnlocked(paths, prepared.jobId);
    if (current === null) {
      throw workflowError(
        'EXECUTION_RECONCILIATION_STATE_MISSING',
        'Reconciliation requires an existing durable execution aggregate.',
        ExitCode.staleState,
      );
    }
    const replay = current.reconciliationReceipts.find(
      (receipt) => receipt.receiptId === receiptId,
    );
    if (replay !== undefined) {
      assertReconciliationReplay(current, prepared, replay);
      return deepFreeze({ state: current, receipt: replay, replayed: true });
    }
    assertExpectedRevision(current, input.expectedExecutionRevision);
    const materialized = buildProviderExecutionState(prepared, current);
    if (materialized.job.acceptedAttemptId !== current.job.acceptedAttemptId) {
      throw workflowError(
        'EXECUTION_RECONCILIATION_WINNER_CHANGE_REJECTED',
        'Reconciliation cannot select or replace the accepted Attempt.',
        ExitCode.guard,
      );
    }
    const currentSources = new Map(
      current.invocationProjection.invocations.map((source) => [
        source.invocationId,
        source.invocationRevision,
      ]),
    );
    const reconciledInvocationIds =
      materialized.invocationProjection.invocations
        .filter(
          (source) =>
            currentSources.get(source.invocationId) !==
            source.invocationRevision,
        )
        .map(({ invocationId }) => invocationId)
        .sort();
    const resultingExecutionRevision = current.revision + 1;
    const receipt = assertExecutionReconciliationReceipt(
      {
        schemaVersion: 1,
        kind: 'provider-execution-reconciliation.v1',
        receiptId,
        jobId: prepared.jobId,
        triggerInvocationId: input.triggerInvocationId,
        expectedExecutionRevision: input.expectedExecutionRevision,
        expectedInvocationRevision: input.expectedInvocationRevision,
        resultingExecutionRevision,
        beforeStateDigest: durableExecutionStateDigest(current),
        afterProjectionDigest: durableExecutionProjectionDigest(materialized),
        acceptedAttemptId: current.job.acceptedAttemptId,
        reconciledInvocationIds,
        recordedAt: prepared.entries
          .map(({ record }) => record.updatedAt)
          .reduce(latestTimestamp),
      },
      prepared.jobId,
    );
    const candidate = assertDurableExecutionJobState({
      ...materialized,
      revision: resultingExecutionRevision,
      reconciliationReceipts: [
        ...materialized.reconciliationReceipts,
        receipt,
      ].sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    });
    const state = persistExecutionJobState(paths, current, candidate);
    if (state.revision !== resultingExecutionRevision) {
      throw executionStoreUnsafe();
    }
    return deepFreeze({ state, receipt, replayed: false });
  });
}

type PreparedProviderEntries = Readonly<{
  jobId: string;
  entries: Array<
    ProviderExecutionEntry & {
      projection: ProviderInvocationProjection;
      repairLineage: ProviderRepairLineage | null;
      retryAccounting: ProviderRetryAccountingSnapshot;
    }
  >;
}>;

function prepareProviderEntries(
  paths: InvestigationRuntimePaths,
  input: readonly ProviderExecutionEntry[],
): PreparedProviderEntries {
  if (input.length < 1 || input.length > MAX_PROVIDER_ATTEMPTS) {
    throw executionProjectionConflict(
      'Provider execution materialization requires a bounded non-empty history.',
    );
  }
  if (input.some(({ retryAccounting }) => retryAccounting == null)) {
    throw executionProjectionConflict(
      'Provider execution materialization requires exact retry accounting for every Attempt.',
    );
  }
  let entries: PreparedProviderEntries['entries'];
  try {
    entries = input
      .map(({ record, request, retryAccounting, retryReplacement = null }) => ({
        record,
        request,
        projection: projectProviderInvocationExecution({ record, request }),
        repairLineage: readProviderRepairLineage(paths, record, request),
        retryAccounting,
        retryReplacement,
      }))
      .sort(
        (left, right) =>
          left.record.attempt - right.record.attempt ||
          left.record.invocationId.localeCompare(right.record.invocationId),
      );
  } catch (error) {
    throw executionProjectionConflict(
      'Provider invocation history cannot be projected into execution records.',
      error,
    );
  }
  const first = entries[0]!;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (
      (index > 0 &&
        entry.record.attempt <= entries[index - 1]!.record.attempt) ||
      entry.projection.job.jobId !== first.projection.job.jobId ||
      entry.projection.workflow.workflowId !==
        first.projection.workflow.workflowId ||
      entry.projection.workflow.currentEpoch !==
        first.projection.workflow.currentEpoch ||
      entry.projection.workflow.contextDigest !==
        first.projection.workflow.contextDigest ||
      canonicalJson(entry.projection.job.semanticSpec) !==
        canonicalJson(first.projection.job.semanticSpec) ||
      canonicalJson(entry.projection.job.mandateBinding ?? null) !==
        canonicalJson(first.projection.job.mandateBinding ?? null) ||
      entry.projection.job.requestDigest !== first.projection.job.requestDigest
    ) {
      throw executionProjectionConflict(
        'Provider invocation history has duplicate Attempts or conflicting semantic identity.',
      );
    }
  }
  return deepFreeze({
    jobId: first.projection.job.jobId,
    entries,
  });
}

function buildProviderExecutionState(
  prepared: PreparedProviderEntries,
  current: DurableExecutionJobState | null,
): DurableExecutionJobState {
  const firstEntry = prepared.entries[0]!;
  const first = firstEntry.projection;
  if (
    current !== null &&
    (current.job.jobId !== prepared.jobId ||
      current.workflow.workflowId !== first.workflow.workflowId ||
      current.workflow.currentEpoch !== first.workflow.currentEpoch ||
      current.workflow.contextDigest !== first.workflow.contextDigest ||
      canonicalJson(current.job.semanticSpec) !==
        canonicalJson(first.job.semanticSpec) ||
      canonicalJson(current.job.mandateBinding ?? null) !==
        canonicalJson(first.job.mandateBinding ?? null) ||
      current.job.requestDigest !== first.job.requestDigest)
  ) {
    throw executionProjectionConflict(
      'Durable execution state conflicts with the provider semantic identity.',
    );
  }
  assertInvocationProjectionMonotonic(prepared, current);
  const frozenRetryPolicy = providerRetryPolicyFromAccounting(
    firstEntry.retryAccounting.retryPolicy,
    firstEntry.record.createdAt,
  );

  const currentResults = new Map(
    (current?.results ?? []).map((result) => [result.attemptId, result]),
  );
  let acceptedAttemptId = current?.job.acceptedAttemptId ?? null;
  if (acceptedAttemptId === null) {
    const firstSuccess = [...prepared.entries]
      .filter(({ record }) => record.state === 'succeeded')
      .sort(
        (left, right) =>
          Date.parse(left.record.updatedAt) -
            Date.parse(right.record.updatedAt) ||
          left.record.invocationId.localeCompare(right.record.invocationId),
      )[0];
    acceptedAttemptId = firstSuccess?.projection.attempt.attemptId ?? null;
  }

  const attempts: AttemptRecord[] = [];
  for (let index = 0; index < prepared.entries.length; index += 1) {
    const entry = prepared.entries[index]!;
    const projected = entry.projection.attempt;
    const chargedProjection = assertAttemptRecord({
      ...projected,
      runtimeMs: entry.retryAccounting.attemptReservation.runtimeMs,
      providerCostMicros:
        entry.retryAccounting.attemptReservation.providerCostMicros,
      providerTokens: entry.retryAccounting.attemptReservation.providerTokens,
    });
    const previous = attempts.at(-1);
    const previousEntry = prepared.entries[index - 1];
    const hasAdjacentPrevious =
      previous !== undefined &&
      previousEntry !== undefined &&
      entry.record.attempt === previousEntry.record.attempt + 1;
    const result = currentResults.get(projected.attemptId);
    // A missing ordinal prevents a direct retryOf edge, but it does not erase
    // an observable policy difference from the last retained Attempt.
    const changedFields =
      previous === undefined
        ? []
        : executionPolicyChangedFields(
            previous.policySnapshot,
            projected.policySnapshot,
          );
    const acceptance = result?.acceptance;
    const projectedAcceptance =
      entry.record.state !== 'succeeded'
        ? null
        : projected.attemptId === acceptedAttemptId
          ? 'accepted'
          : 'late-duplicate';
    const effectiveAcceptance = acceptance ?? projectedAcceptance;
    if (
      hasAdjacentPrevious &&
      previous!.failure?.retryClass === 'repairable' &&
      entry.repairLineage === null
    ) {
      throw workflowError(
        'PROVIDER_REPAIR_LINEAGE_REQUIRED',
        'A repairable predecessor requires durable repair lineage before materialization.',
        ExitCode.guard,
      );
    }
    let baseAttempt = chargedProjection;
    if (entry.repairLineage !== null) {
      const lineage = entry.repairLineage;
      if (
        !hasAdjacentPrevious ||
        previous!.failure?.retryClass !== 'repairable' ||
        lineage.failedAttemptId !== previous!.attemptId ||
        lineage.failureFingerprint !== previous!.failure.fingerprint ||
        lineage.replacementAttemptId !== projected.attemptId ||
        lineage.jobId !== first.job.jobId ||
        lineage.workflowId !== first.workflow.workflowId ||
        lineage.epoch !== first.job.epoch ||
        lineage.contextDigest !== first.job.contextDigest
      ) {
        throw executionProjectionConflict(
          'Durable repair lineage does not bind adjacent provider Attempts.',
        );
      }
      const priorRepairCount = attempts.filter(
        ({ retryMode }) => retryMode === 'repair',
      ).length;
      const replacement = createReplacementAttempt({
        workflow: current?.workflow ?? first.workflow,
        job: assertJobRecord({
          ...(current?.job ?? first.job),
          status: 'waiting-retry',
          acceptedAttemptId: null,
          attemptCount: previous!.attemptNumber,
          repairAttemptCount: priorRepairCount,
          retryPolicy: frozenRetryPolicy,
          updatedAt: previous!.updatedAt,
        }),
        previousAttempt: previous!,
        attemptId: projected.attemptId,
        retryMode: 'repair',
        currentExecutionPolicy: projected.policySnapshot,
        repairContext: lineage.repairContext,
        environmentDigest: projected.environmentDigest,
        createdAt: projected.createdAt,
      });
      if (
        replacement.attempt.attemptNumber !== projected.attemptNumber ||
        replacement.job.repairAttemptCount !== priorRepairCount + 1
      ) {
        throw executionProjectionConflict(
          'Repair Attempt does not preserve the projected attempt number.',
        );
      }
      baseAttempt = assertAttemptRecord({
        ...replacement.attempt,
        status: projected.status,
        leaseGeneration: projected.leaseGeneration,
        lease: projected.lease,
        failure: projected.failure,
        failureFingerprint: projected.failureFingerprint,
        runtimeMs: chargedProjection.runtimeMs,
        providerCostMicros: chargedProjection.providerCostMicros,
        providerTokens: chargedProjection.providerTokens,
        retention: projected.retention,
        providerInvocation: projected.providerInvocation,
        createdAt: projected.createdAt,
        updatedAt: projected.updatedAt,
      });
    } else if (entry.retryReplacement != null) {
      const replacementBinding = entry.retryReplacement;
      if (
        !hasAdjacentPrevious ||
        replacementBinding.attemptId !== projected.attemptId ||
        replacementBinding.environmentDigest !== projected.environmentDigest
      ) {
        throw executionProjectionConflict(
          'Durable retry replacement does not bind adjacent provider Attempts.',
        );
      }
      const replacement = createReplacementAttempt({
        workflow: current?.workflow ?? first.workflow,
        job: assertJobRecord({
          ...(current?.job ?? first.job),
          status: 'waiting-retry',
          acceptedAttemptId: null,
          attemptCount: previous!.attemptNumber,
          repairAttemptCount: attempts.filter(
            ({ retryMode }) => retryMode === 'repair',
          ).length,
          retryPolicy: frozenRetryPolicy,
          updatedAt: previous!.updatedAt,
        }),
        previousAttempt: previous!,
        attemptId: replacementBinding.attemptId,
        retryMode: replacementBinding.retryMode,
        currentExecutionPolicy: projected.policySnapshot,
        strategyChanges: [...replacementBinding.strategyChanges],
        ...(replacementBinding.executionGrantId === null
          ? {}
          : { grantId: replacementBinding.executionGrantId }),
        environmentDigest: replacementBinding.environmentDigest,
        createdAt: projected.createdAt,
      });
      if (
        replacement.attempt.attemptNumber !== projected.attemptNumber ||
        replacement.attempt.retryOf !== previous!.attemptId ||
        replacement.attempt.retryMode !== replacementBinding.retryMode
      ) {
        throw executionProjectionConflict(
          'Retry replacement does not preserve the authorized attempt semantics.',
        );
      }
      baseAttempt = assertAttemptRecord({
        ...replacement.attempt,
        status: projected.status,
        leaseGeneration: projected.leaseGeneration,
        lease: projected.lease,
        failure: projected.failure,
        failureFingerprint: projected.failureFingerprint,
        runtimeMs: chargedProjection.runtimeMs,
        providerCostMicros: chargedProjection.providerCostMicros,
        providerTokens: chargedProjection.providerTokens,
        retention: projected.retention,
        providerInvocation: projected.providerInvocation,
        createdAt: projected.createdAt,
        updatedAt: projected.updatedAt,
      });
    }
    attempts.push(
      assertAttemptRecord({
        ...baseAttempt,
        retryOf: hasAdjacentPrevious ? previous!.attemptId : null,
        retryMode:
          entry.repairLineage !== null
            ? 'repair'
            : entry.retryReplacement != null
              ? baseAttempt.retryMode
              : index === 0
                ? projected.retryMode
                : changedFields.length === 0
                  ? 'same-input'
                  : 'execution-policy-change',
        changedFields:
          entry.repairLineage === null && entry.retryReplacement == null
            ? changedFields
            : baseAttempt.changedFields,
        status:
          effectiveAcceptance === 'accepted'
            ? 'succeeded'
            : effectiveAcceptance === 'late-duplicate'
              ? 'late-duplicate'
              : effectiveAcceptance === 'stale'
                ? 'stale'
                : projected.status,
        retention:
          effectiveAcceptance === 'late-duplicate' ||
          effectiveAcceptance === 'stale'
            ? 'debug'
            : projected.retention,
        updatedAt:
          result === undefined
            ? projected.updatedAt
            : latestTimestamp(projected.updatedAt, result.completedAt),
      }),
    );
  }

  const results = new Map(currentResults);
  for (const [index, entry] of prepared.entries.entries()) {
    if (entry.record.state !== 'succeeded' || entry.record.result === null) {
      continue;
    }
    const attempt = attempts[index]!;
    const providerOutputDigest = normalizeDigest(
      entry.record.result.outputDigest,
    );
    const existingResult = results.get(attempt.attemptId);
    if (existingResult !== undefined) {
      if (existingResult.outputDigest !== providerOutputDigest) {
        throw executionProjectionConflict(
          'Provider invocation and durable Attempt result digests diverge.',
        );
      }
      continue;
    }
    results.set(
      attempt.attemptId,
      createAttemptResult(
        attempt,
        providerOutputDigest,
        attempt.attemptId === acceptedAttemptId ? 'accepted' : 'late-duplicate',
        entry.record.updatedAt,
      ),
    );
  }
  const orderedResults = [...results.values()].sort(
    (left, right) =>
      attemptNumber(attempts, left.attemptId) -
      attemptNumber(attempts, right.attemptId),
  );
  const latestProjection = prepared.entries.at(-1)!.projection;
  const updatedAt = [
    ...attempts.map(({ updatedAt }) => updatedAt),
    ...orderedResults.map(({ completedAt }) => completedAt),
  ].reduce(latestTimestamp);
  const cumulativeRuntimeMs = sumAttemptAccounting(attempts, 'runtimeMs');
  const providerCostMicros = sumAttemptAccounting(
    attempts,
    'providerCostMicros',
  );
  const providerTokens = sumAttemptAccounting(attempts, 'providerTokens');
  let workflow = current?.workflow ?? first.workflow;
  let job = assertJobRecord({
    ...(current?.job ?? first.job),
    status:
      acceptedAttemptId === null ? latestProjection.job.status : 'succeeded',
    acceptedAttemptId,
    attemptCount: attempts.at(-1)!.attemptNumber,
    cumulativeRuntimeMs,
    providerCostMicros,
    providerTokens,
    repairAttemptCount: attempts.filter(
      ({ retryMode }) => retryMode === 'repair',
    ).length,
    retryPolicy: frozenRetryPolicy,
    createdAt: attempts[0]!.createdAt,
    updatedAt,
  });
  const latestAttempt = attempts.at(-1)!;
  if (acceptedAttemptId === null && latestAttempt.failure !== null) {
    const projected = projectExecutionFailureState({
      workflow,
      job,
      attempt: latestAttempt,
      failure: latestAttempt.failure,
      decision: decideProviderExecutionFailure({
        workflow,
        job,
        attempt: latestAttempt,
        attempts,
      }),
    });
    workflow = projected.workflow;
    job = projected.job;
  } else if (workflow.blocker?.jobId === job.jobId) {
    workflow = assertWorkflowRecord({ ...workflow, blocker: null });
  }
  return assertDurableExecutionJobState({
    schemaVersion: 1,
    revision: current?.revision ?? 0,
    workflow,
    job,
    attempts,
    results: orderedResults,
    reconciliationReceipts: current?.reconciliationReceipts ?? [],
    invocationProjection: {
      kind: 'provider-invocation-projection.v1',
      completeHistory: attempts.every(
        ({ attemptNumber }, index) => attemptNumber === index + 1,
      ),
      invocations: prepared.entries.map(({ record, projection }) => ({
        invocationId: record.invocationId,
        invocationRevision: record.revision,
        attemptId: projection.attempt.attemptId,
      })),
    },
  });
}

function assertInvocationProjectionMonotonic(
  prepared: PreparedProviderEntries,
  current: DurableExecutionJobState | null,
): void {
  if (current === null) return;
  const incoming = new Map(
    prepared.entries.map(({ record }) => [
      record.invocationId,
      record.revision,
    ]),
  );
  for (const prior of current.invocationProjection.invocations) {
    const nextRevision = incoming.get(prior.invocationId);
    if (nextRevision === undefined || nextRevision < prior.invocationRevision) {
      throw executionProjectionConflict(
        'Provider invocation projection is missing history or moved backwards.',
      );
    }
  }
}

function persistExecutionJobState(
  paths: InvestigationRuntimePaths,
  current: DurableExecutionJobState | null,
  input: DurableExecutionJobState,
): DurableExecutionJobState {
  const candidate = assertDurableExecutionJobState(input);
  if (
    current !== null &&
    canonicalStateIgnoringRevision(current) ===
      canonicalStateIgnoringRevision(candidate)
  ) {
    return current;
  }
  const next = assertDurableExecutionJobState({
    ...candidate,
    revision: current === null ? 0 : current.revision + 1,
  });
  const statePath = executionJobStatePath(paths, next.job.jobId);
  if (current === null) {
    createPrivateCanonicalJson(
      paths,
      statePath,
      next,
      executionStoreUnsafe,
      'EXECUTION_STORE_COLLISION',
    );
  } else {
    writePrivateCanonicalJsonAtomic(
      paths,
      statePath,
      next,
      executionStoreUnsafe,
    );
  }
  const stored = readExecutionJobStateUnlocked(paths, next.job.jobId);
  if (stored === null) throw executionStoreUnsafe();
  return stored;
}

function readExecutionJobStateUnlocked(
  paths: InvestigationRuntimePaths,
  jobId: string,
): DurableExecutionJobState | null {
  const statePath = executionJobStatePath(paths, jobId);
  try {
    if (!privatePathExists(paths, statePath, executionStoreUnsafe)) return null;
    const state = assertDurableExecutionJobState(
      readPrivateCanonicalJson(paths, statePath, executionStoreUnsafe),
    );
    if (state.job.jobId !== jobId) throw executionStoreUnsafe();
    return state;
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw executionStoreUnsafe(error);
  }
}

function assertDurableExecutionJobState(
  value: unknown,
): DurableExecutionJobState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempts',
      'job',
      'invocationProjection',
      'reconciliationReceipts',
      'results',
      'revision',
      'schemaVersion',
      'workflow',
    ]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > MAX_PROVIDER_ATTEMPTS ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.reconciliationReceipts) ||
    !isRecord(value.invocationProjection) ||
    !hasExactKeys(value.invocationProjection, [
      'completeHistory',
      'invocations',
      'kind',
    ]) ||
    value.invocationProjection.kind !== 'provider-invocation-projection.v1' ||
    typeof value.invocationProjection.completeHistory !== 'boolean' ||
    !Array.isArray(value.invocationProjection.invocations)
  ) {
    throw executionStoreUnsafe();
  }
  let workflow: WorkflowRecord;
  let job: JobRecord;
  let attempts: AttemptRecord[];
  let results: AttemptResult[];
  let reconciliationReceipts: ExecutionReconciliationReceipt[];
  try {
    workflow = assertWorkflowRecord(value.workflow);
    job = assertJobRecord(value.job);
    attempts = value.attempts.map(assertAttemptRecord);
    results = value.results.map(assertAttemptResult);
    reconciliationReceipts = value.reconciliationReceipts.map((receipt) =>
      assertExecutionReconciliationReceipt(receipt, job.jobId),
    );
  } catch (error) {
    throw executionStoreUnsafe(error);
  }
  if (
    job.workflowId !== workflow.workflowId ||
    job.epoch !== workflow.currentEpoch ||
    job.contextDigest !== workflow.contextDigest ||
    job.attemptCount !== attempts.at(-1)!.attemptNumber ||
    value.invocationProjection.invocations.length !== attempts.length
  ) {
    throw executionStoreUnsafe();
  }
  const attemptIds = new Set<string>();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const source = value.invocationProjection.invocations[index];
    if (
      attemptIds.has(attempt.attemptId) ||
      (index > 0 &&
        attempt.attemptNumber <= attempts[index - 1]!.attemptNumber) ||
      attempt.jobId !== job.jobId ||
      attempt.workflowId !== workflow.workflowId ||
      attempt.epoch !== job.epoch ||
      attempt.contextDigest !== job.contextDigest ||
      attempt.retryOf !==
        (index > 0 &&
        attempt.attemptNumber === attempts[index - 1]!.attemptNumber + 1
          ? attempts[index - 1]!.attemptId
          : null) ||
      !isRecord(source) ||
      !hasExactKeys(source, [
        'attemptId',
        'invocationId',
        'invocationRevision',
      ]) ||
      source.attemptId !== attempt.attemptId ||
      source.invocationId !== attempt.providerInvocation?.invocationId ||
      source.invocationRevision !==
        attempt.providerInvocation?.invocationRevision ||
      !Number.isSafeInteger(source.invocationRevision) ||
      (source.invocationRevision as number) < 0
    ) {
      throw executionStoreUnsafe();
    }
    attemptIds.add(attempt.attemptId);
  }
  const resultAttempts = new Set<string>();
  let acceptedResult: AttemptResult | null = null;
  let priorAttemptNumber = 0;
  for (const result of results) {
    const attempt = attempts.find(
      ({ attemptId }) => attemptId === result.attemptId,
    );
    if (
      attempt === undefined ||
      resultAttempts.has(result.attemptId) ||
      result.workflowId !== workflow.workflowId ||
      result.epoch !== workflow.currentEpoch ||
      result.contextDigest !== workflow.contextDigest ||
      result.jobId !== job.jobId ||
      attempt.attemptNumber <= priorAttemptNumber ||
      (result.acceptance === 'accepted' && attempt.status !== 'succeeded') ||
      (result.acceptance === 'late-duplicate' &&
        attempt.status !== 'late-duplicate') ||
      (result.acceptance === 'stale' && attempt.status !== 'stale')
    ) {
      throw executionStoreUnsafe();
    }
    if (result.acceptance === 'accepted') {
      if (acceptedResult !== null) throw executionStoreUnsafe();
      acceptedResult = result;
    }
    resultAttempts.add(result.attemptId);
    priorAttemptNumber = attempt.attemptNumber;
  }
  for (const attempt of attempts) {
    if (
      ['succeeded', 'late-duplicate'].includes(attempt.status) !==
      resultAttempts.has(attempt.attemptId)
    ) {
      throw executionStoreUnsafe();
    }
  }
  if (
    reconciliationReceipts.some(
      (receipt, index) =>
        receipt.resultingExecutionRevision > (value.revision as number) ||
        (index > 0 &&
          receipt.receiptId <= reconciliationReceipts[index - 1]!.receiptId),
    ) ||
    value.invocationProjection.completeHistory !==
      attempts.every(
        ({ attemptNumber }, index) => attemptNumber === index + 1,
      ) ||
    (job.acceptedAttemptId === null) !== (acceptedResult === null) ||
    (acceptedResult !== null &&
      acceptedResult.attemptId !== job.acceptedAttemptId)
  ) {
    throw executionStoreUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    revision: value.revision as number,
    workflow,
    job,
    attempts,
    results,
    reconciliationReceipts,
    invocationProjection: {
      kind: 'provider-invocation-projection.v1',
      completeHistory: value.invocationProjection.completeHistory,
      invocations: value.invocationProjection.invocations.map((source) => ({
        invocationId: String((source as Record<string, unknown>).invocationId),
        invocationRevision: Number(
          (source as Record<string, unknown>).invocationRevision,
        ),
        attemptId: String((source as Record<string, unknown>).attemptId),
      })),
    },
  });
}

function withExecutionJobLock<T>(
  paths: InvestigationRuntimePaths,
  jobId: string,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `execution-job-${sha256Text(jobId)}.lock`),
    operation,
    'EXECUTION_STORE_OPERATION_CONFLICT',
    executionStoreUnsafe,
  );
}

function assertExpectedRevision(
  current: DurableExecutionJobState | null,
  expectedRevision: number | null | undefined,
): void {
  if (expectedRevision === undefined) return;
  if (
    (expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
    (expectedRevision === null
      ? current !== null
      : current?.revision !== expectedRevision)
  ) {
    throw workflowError(
      'EXECUTION_STORE_CAS_MISMATCH',
      'The durable execution aggregate revision changed.',
      ExitCode.staleState,
      {
        details: {
          expectedRevision,
          observedRevision: current?.revision ?? null,
        },
      },
    );
  }
}

function assertExecutionReconciliationReceipt(
  value: unknown,
  expectedJobId: string,
): ExecutionReconciliationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'acceptedAttemptId',
      'afterProjectionDigest',
      'beforeStateDigest',
      'expectedExecutionRevision',
      'expectedInvocationRevision',
      'jobId',
      'kind',
      'receiptId',
      'reconciledInvocationIds',
      'recordedAt',
      'resultingExecutionRevision',
      'schemaVersion',
      'triggerInvocationId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-execution-reconciliation.v1' ||
    value.jobId !== expectedJobId ||
    typeof value.receiptId !== 'string' ||
    !DIGEST.test(value.receiptId) ||
    typeof value.triggerInvocationId !== 'string' ||
    !EXECUTION_JOB_ID.test(value.triggerInvocationId) ||
    !Number.isSafeInteger(value.expectedExecutionRevision) ||
    (value.expectedExecutionRevision as number) < 0 ||
    !Number.isSafeInteger(value.expectedInvocationRevision) ||
    (value.expectedInvocationRevision as number) < 0 ||
    !Number.isSafeInteger(value.resultingExecutionRevision) ||
    value.resultingExecutionRevision !==
      (value.expectedExecutionRevision as number) + 1 ||
    typeof value.beforeStateDigest !== 'string' ||
    !DIGEST.test(value.beforeStateDigest) ||
    typeof value.afterProjectionDigest !== 'string' ||
    !DIGEST.test(value.afterProjectionDigest) ||
    (value.acceptedAttemptId !== null &&
      (typeof value.acceptedAttemptId !== 'string' ||
        !EXECUTION_JOB_ID.test(value.acceptedAttemptId))) ||
    !Array.isArray(value.reconciledInvocationIds) ||
    value.reconciledInvocationIds.some(
      (invocationId) =>
        typeof invocationId !== 'string' ||
        !EXECUTION_JOB_ID.test(invocationId),
    ) ||
    canonicalJson(value.reconciledInvocationIds) !==
      canonicalJson(
        [...new Set(value.reconciledInvocationIds as string[])].sort(),
      ) ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw executionStoreUnsafe();
  }
  const expectedReceiptId = reconciliationReceiptId({
    jobId: expectedJobId,
    triggerInvocationId: value.triggerInvocationId,
    expectedExecutionRevision: value.expectedExecutionRevision as number,
    expectedInvocationRevision: value.expectedInvocationRevision as number,
  });
  if (value.receiptId !== expectedReceiptId) throw executionStoreUnsafe();
  return deepFreeze(structuredClone(value) as ExecutionReconciliationReceipt);
}

function reconciliationReceiptId(input: {
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedInvocationRevision: number;
}): string {
  return digestCanonical({
    schemaVersion: 1,
    kind: 'provider-execution-reconciliation-request.v1',
    ...input,
  });
}

function assertReconciliationReplay(
  current: DurableExecutionJobState,
  prepared: PreparedProviderEntries,
  receipt: ExecutionReconciliationReceipt,
): void {
  const materialized = buildProviderExecutionState(prepared, current);
  if (
    current.revision < receipt.resultingExecutionRevision ||
    current.job.acceptedAttemptId !== receipt.acceptedAttemptId ||
    durableExecutionProjectionDigest(materialized) !==
      receipt.afterProjectionDigest
  ) {
    throw workflowError(
      'EXECUTION_RECONCILIATION_RECEIPT_STALE',
      'The existing reconciliation receipt no longer matches durable state.',
      ExitCode.staleState,
    );
  }
}

function durableExecutionStateDigest(state: DurableExecutionJobState): string {
  return digestCanonical(state);
}

function durableExecutionProjectionDigest(
  state: DurableExecutionJobState,
): string {
  return digestCanonical({
    workflow: state.workflow,
    job: state.job,
    attempts: state.attempts,
    results: state.results,
    invocationProjection: state.invocationProjection,
  });
}

function canonicalStateIgnoringRevision(
  state: DurableExecutionJobState,
): string {
  return canonicalJson({ ...state, revision: 0 });
}

function digestCanonical(value: unknown): string {
  return `sha256:${sha256Text(canonicalJson(value))}`;
}

function deterministicUuid(value: unknown): string {
  const hex = sha256Text(canonicalJson(value));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function attemptNumber(attempts: AttemptRecord[], attemptId: string): number {
  const attempt = attempts.find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (attempt === undefined) throw executionStoreUnsafe();
  return attempt.attemptNumber;
}

function sumAttemptAccounting(
  attempts: readonly AttemptRecord[],
  field: 'runtimeMs' | 'providerCostMicros' | 'providerTokens',
): number {
  let total = 0;
  for (const attempt of attempts) {
    total += attempt[field];
    if (!Number.isSafeInteger(total)) {
      throw executionProjectionConflict(
        'Provider retry accounting exceeds the durable integer range.',
      );
    }
  }
  return total;
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function providerAttemptRecoveryProjectionBinding(attempt: AttemptRecord) {
  return {
    schemaVersion: attempt.schemaVersion,
    attemptId: attempt.attemptId,
    jobId: attempt.jobId,
    workflowId: attempt.workflowId,
    epoch: attempt.epoch,
    attemptNumber: attempt.attemptNumber,
    provider: attempt.provider,
    inputDigest: attempt.inputDigest,
    requestDigest: attempt.requestDigest,
    contextDigest: attempt.contextDigest,
    environmentDigest: attempt.environmentDigest,
    policySnapshot: attempt.policySnapshot,
    providerInvocation: attempt.providerInvocation,
    createdAt: attempt.createdAt,
  };
}

function providerWorkflowRecoveryBinding(workflow: WorkflowRecord) {
  return {
    schemaVersion: workflow.schemaVersion,
    workflowId: workflow.workflowId,
    currentEpoch: workflow.currentEpoch,
    contractVersion: workflow.contractVersion,
    contextDigest: workflow.contextDigest,
    checkpoint: workflow.checkpoint,
    status: workflow.status,
    engineBinding: workflow.engineBinding,
  };
}

function providerJobRecoveryBinding(job: JobRecord) {
  return {
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    workflowId: job.workflowId,
    epoch: job.epoch,
    mandateBinding: job.mandateBinding ?? null,
    stage: job.stage,
    contextDigest: job.contextDigest,
    requestDigest: job.requestDigest,
    semanticSpec: job.semanticSpec,
    createdAt: job.createdAt,
  };
}

function assertCandidateRecoveryLease(
  attempt: AttemptRecord,
  leaseGeneration: number,
  leaseTokenDigest: string,
  completedAt: string,
): void {
  if (
    attempt.lease === null ||
    !Number.isSafeInteger(leaseGeneration) ||
    leaseGeneration < 1 ||
    attempt.leaseGeneration !== leaseGeneration ||
    attempt.lease.generation !== leaseGeneration ||
    attempt.lease.tokenDigest !== leaseTokenDigest ||
    Date.parse(completedAt) < Date.parse(attempt.lease.acquiredAt) ||
    Date.parse(completedAt) > Date.parse(attempt.lease.expiresAt)
  ) {
    throw executionResultRecoveryConflict();
  }
}

function assertExecutionJobId(value: string): string {
  if (typeof value !== 'string' || !EXECUTION_JOB_ID.test(value)) {
    throw workflowError(
      'EXECUTION_STORE_JOB_ID_INVALID',
      'The durable execution Job identifier is invalid.',
      ExitCode.usage,
    );
  }
  return value;
}

function normalizeDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  if (UNPREFIXED_DIGEST.test(value)) return `sha256:${value}`;
  throw executionProjectionConflict('Provider result digest is invalid.');
}

function normalizeRecoveryDigest(value: string): string {
  if (typeof value === 'string' && DIGEST.test(value)) return value;
  if (typeof value === 'string' && UNPREFIXED_DIGEST.test(value)) {
    return `sha256:${value}`;
  }
  throw executionResultRecoveryConflict();
}

function isPromiseLike(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function executionSnapshotCallbackInvalid(): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_SNAPSHOT_CALLBACK_INVALID',
    'Execution Job snapshots require one short synchronous callback.',
    ExitCode.usage,
  );
}

function executionProjectionConflict(
  message: string,
  cause?: unknown,
): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_PROJECTION_CONFLICT',
    message,
    ExitCode.guard,
    cause === undefined ? {} : { details: { cause: errorMessage(cause) } },
  );
}

function executionResultRecoveryConflict(): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_RESULT_RECOVERY_CONFLICT',
    'The completion candidate does not exactly bind the current durable Attempt.',
    ExitCode.staleState,
  );
}

function executionStoreUnsafe(cause?: unknown): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_UNSAFE',
    'The private durable execution store is malformed or unsafe.',
    ExitCode.unsafeEnvironment,
    cause === undefined ? {} : { details: { cause: errorMessage(cause) } },
  );
}

function executionAdmissionAuthorityUnsafe(): WorkflowError {
  return workflowError(
    'EXECUTION_ADMISSION_AUTHORITY_UNSAFE',
    'The immutable provider execution admission authority is missing, malformed, or divergent.',
    ExitCode.unsafeEnvironment,
  );
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
