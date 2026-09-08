/**
 * Coordinates durable execution job admission, acceptance, and recovery transactions.
 *
 * Invariants:
 * - Expected revisions and result candidates are checked under the same job lock before publication.
 * - Acceptance and reconciliation preserve exact policy, lease, and receipt bindings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { type ProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import {
  acceptAttemptResult,
  assertAttemptRecord,
  createAttemptResult,
  type AttemptRecord,
  type JobRecord,
  type WorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  buildProviderExecutionState,
  prepareProviderEntries,
  type PreparedProviderEntries,
} from './execution-provider-projection.ts';
import {
  assertDurableExecutionJobState,
  assertExecutionReconciliationReceipt,
  durableExecutionProjectionDigest,
  durableExecutionStateDigest,
  reconciliationReceiptId,
  type DurableAttemptResultAcceptance,
  type DurableExecutionJobState,
  type DurableExecutionReconciliation,
  type ExecutionReconciliationReceipt,
  type ProviderExecutionEntry,
} from './execution-state-contract.ts';
import {
  executionStorePaths,
  persistExecutionJobState,
  readExecutionJobStateUnlocked,
  withExecutionJobLock,
} from './execution-state-files.ts';
import {
  EXECUTION_STATE_FILE,
  assertExecutionJobId,
  attemptNumber,
  deepFreeze,
  executionAdmissionAuthorityUnsafe,
  executionProjectionConflict,
  executionResultRecoveryConflict,
  executionSnapshotCallbackInvalid,
  executionStoreUnsafe,
  isExactTimestamp,
  isPromiseLike,
  latestTimestamp,
  normalizeDigest,
  normalizeRecoveryDigest,
  sha256Text,
} from './execution-state-values.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import {
  MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
  assertProviderExecutionAdmissionAuthority,
  createProviderExecutionAdmissionAuthority,
  providerExecutionAdmissionAuthorityPath,
  type ProviderExecutionAdmissionAuthority,
} from './provider-execution-admission-authority.ts';

export {
  decideProviderExecutionFailure,
  providerRetryPolicyFromAccounting,
} from './execution-provider-projection.ts';
export type {
  DurableAttemptResultAcceptance,
  DurableExecutionJobState,
  DurableExecutionReconciliation,
  ExecutionReconciliationReceipt,
  ProviderExecutionEntry,
} from './execution-state-contract.ts';
export {
  executionJobStatePath,
  executionStorePaths,
} from './execution-state-files.ts';
export { providerExecutionAdmissionAuthorityPath } from './provider-execution-admission-authority.ts';

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
