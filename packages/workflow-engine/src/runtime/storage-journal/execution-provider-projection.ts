/**
 * Rebuilds execution workflow, job, and attempt state from ordered provider entries.
 *
 * Invariants:
 * - Attempt history, retry accounting, policy changes, and accepted results retain their existing order.
 * - Projection rejects non-monotonic entries and preserves exact failure and retry decisions.
 */
import { executionRetryBudgetChanges } from '../../modules/provider-orchestration/execution-retry.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { createExecutionBudgetGrantRequest } from '../../modules/authority/execution-governance.ts';
import {
  type AttemptRecord,
  type JobRecord,
  type ProviderInvocationProjection,
  type RetryDecision,
  type RetryPolicy,
  type WorkflowRecord,
  assertAttemptRecord,
  assertJobRecord,
  assertWorkflowRecord,
  createAttemptResult,
  createReplacementAttempt,
  decideRetry,
  executionPolicyChangedFields,
  projectExecutionFailureState,
  projectProviderInvocationExecution,
  requireExecutionJobMandateBinding,
} from '../../modules/provider-orchestration/execution-core.ts';
import { type AiAdapterRetryAccounting } from '../provider-execution/ai-adapter-policy.ts';
import {
  type ProviderRepairLineage,
  readProviderRepairLineage,
} from '../provider-execution/provider-repair-governance.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  type DurableExecutionJobState,
  type ProviderExecutionEntry,
  assertDurableExecutionJobState,
} from './execution-state-contract.ts';
import {
  MAX_PROVIDER_ATTEMPTS,
  attemptNumber,
  deepFreeze,
  deterministicUuid,
  executionProjectionConflict,
  latestTimestamp,
  normalizeDigest,
  sumAttemptAccounting,
} from './execution-state-values.ts';
import { type ProviderRetryAccountingSnapshot } from './provider-invocation-store.ts';

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
  const budgetInput = {
    job: input.job,
    attempt: input.attempt,
    failure,
    providerAttemptCount: input.attempts.filter(
      ({ provider }) => provider === input.attempt.provider,
    ).length,
    nextRuntimeMs: input.attempt.policySnapshot.timeoutMs,
    nextProviderCostMicros: input.attempt.providerCostMicros,
    nextProviderTokens: input.attempt.providerTokens,
    now: input.attempt.updatedAt,
  };
  const decision = decideRetry({
    ...budgetInput,
    workflow: input.workflow,
    sameFingerprintCount,
    currentExecutionPolicy: input.attempt.policySnapshot,
  });
  if (
    decision.reasonCode !== 'RETRY_BUDGET_EXHAUSTED' ||
    input.job.mandateBinding === undefined
  )
    return decision;
  const requestedChanges = executionRetryBudgetChanges(budgetInput);
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
    ...budgetInput,
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

export type PreparedProviderEntries = Readonly<{
  jobId: string;
  entries: Array<
    ProviderExecutionEntry & {
      projection: ProviderInvocationProjection;
      repairLineage: ProviderRepairLineage | null;
      retryAccounting: ProviderRetryAccountingSnapshot;
    }
  >;
}>;

export function prepareProviderEntries(
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

export function buildProviderExecutionState(
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
