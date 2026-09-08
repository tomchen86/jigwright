/**
 * Project durable execution journals into exact public job and replacement inspection views.
 *
 * Invariants:
 * - Result precedence, retry classification, replacement digest bytes, and view defaults stay unchanged.
 * - Projection performs no replacement publication or lifecycle mutation.
 *
 * Depends on: execution core records, durable store reads, and public inspection types.
 * Failure modes: A losing result can appear accepted or a replacement preview can bind the wrong attempt.
 */

import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ProviderInvocationProjection,
  createReplacementAttempt,
  type JobRecord,
  type WorkflowRecord,
  type AttemptRecord,
  type RetryDecision,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  type DurableExecutionJobState,
  decideProviderExecutionFailure,
} from '../storage-journal/execution-store.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type ProviderInvocationRecord,
  type ProviderOutputSchemaGeneration,
  type ProviderResidualsGeneration,
} from '../storage-journal/provider-invocation-store.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type ExecutionJobInspection,
  type ProviderReplacementPreview,
  type ExecutionResultView,
} from './execution-runtime.ts';

const MAX_PROVIDER_TIMEOUT_MS = 3_600_000;

export type ProviderProjectionEntry = {
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  outputSchema: ProviderOutputSchemaGeneration;
  residuals: ProviderResidualsGeneration | null;
  projection: ProviderInvocationProjection;
};

export function buildProviderReplacementPreview(
  inspection: ExecutionJobInspection,
  input: { timeoutMs: number; now?: string },
  grantId: string | null,
  pendingGrant = false,
): ProviderReplacementPreview {
  const previous = inspection.attempts.at(-1);
  if (
    previous === undefined ||
    inspection.acceptedAttemptId !== null ||
    !['failed-retryable', 'timed-out'].includes(previous.status) ||
    previous.failure === null
  ) {
    throw workflowError(
      'EXECUTION_RUNTIME_REPLACEMENT_NOT_ALLOWED',
      'The latest provider Attempt is not eligible for replacement.',
      ExitCode.guard,
    );
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > MAX_PROVIDER_TIMEOUT_MS ||
    input.timeoutMs === previous.policySnapshot.timeoutMs
  ) {
    throw workflowError(
      'EXECUTION_RUNTIME_POLICY_CHANGE_INVALID',
      'Replacement timeout must be a different bounded positive value.',
      ExitCode.usage,
    );
  }
  const createdAt = assertExactTimestamp(input.now ?? previous.updatedAt);
  const previewAttemptId = `attempt-preview-${digestCanonical({
    jobId: inspection.job.jobId,
    previousAttemptId: previous.attemptId,
    timeoutMs: input.timeoutMs,
    grantId,
  }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
  const replacement = createReplacementAttempt({
    workflow: inspection.workflow,
    job: inspection.job,
    previousAttempt: previous,
    attemptId: previewAttemptId,
    retryMode: 'execution-policy-change',
    currentExecutionPolicy: previous.policySnapshot,
    policyOverrides: { timeoutMs: input.timeoutMs },
    ...(grantId === null && !pendingGrant
      ? {}
      : { grantId: grantId ?? 'pending-execution-budget-grant' }),
    environmentDigest: previous.environmentDigest,
    createdAt,
  });
  return deepFreeze({
    schemaVersion: 1,
    workflowId: inspection.workflow.workflowId,
    epoch: inspection.job.epoch,
    contextDigest: inspection.job.contextDigest,
    jobId: inspection.job.jobId,
    previousAttemptId: previous.attemptId,
    previewAttemptId: replacement.attempt.attemptId,
    attemptNumber: replacement.attempt.attemptNumber,
    retryMode: 'execution-policy-change',
    changedFields: replacement.attempt.changedFields.map((field) => ({
      ...field,
    })),
    policySnapshot: replacement.attempt.policySnapshot,
    requestDigest: replacement.attempt.requestDigest,
    grantId,
  });
}

export function aggregateDurableJob(
  state: DurableExecutionJobState,
  input: ProviderProjectionEntry[],
): ExecutionJobInspection {
  const entries = [...input].sort(
    (left, right) =>
      left.record.attempt - right.record.attempt ||
      left.record.invocationId.localeCompare(right.record.invocationId),
  );
  if (
    entries.length !== state.invocationProjection.invocations.length ||
    state.job.jobId !== entries[0]?.projection.job.jobId
  ) {
    throw runtimeConflict(
      'Durable execution state does not cover the current provider Job history.',
    );
  }
  const entriesByInvocation = new Map(
    entries.map((entry) => [entry.record.invocationId, entry]),
  );
  for (const source of state.invocationProjection.invocations) {
    const entry = entriesByInvocation.get(source.invocationId);
    if (
      entry === undefined ||
      entry.record.revision !== source.invocationRevision ||
      entry.projection.attempt.attemptId !== source.attemptId ||
      entry.projection.job.jobId !== state.job.jobId ||
      entry.projection.workflow.workflowId !== state.workflow.workflowId ||
      canonicalJson(entry.projection.job.mandateBinding ?? null) !==
        canonicalJson(state.job.mandateBinding ?? null) ||
      canonicalJson(entry.projection.job.semanticSpec) !==
        canonicalJson(state.job.semanticSpec)
    ) {
      throw runtimeConflict(
        'Durable execution state is stale or conflicts with its provider projection.',
      );
    }
  }
  const attemptsById = new Map(
    state.attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const results = state.results.map((result): ExecutionResultView => {
    const attempt = attemptsById.get(result.attemptId);
    if (
      attempt?.providerInvocation === null ||
      attempt?.providerInvocation === undefined ||
      result.acceptance === 'stale'
    ) {
      throw runtimeConflict(
        'Durable provider result is not compatible with its invocation.',
      );
    }
    const entry = entriesByInvocation.get(
      attempt.providerInvocation.invocationId,
    );
    if (entry === undefined) {
      throw runtimeConflict(
        'Durable provider result has no invocation to classify.',
      );
    }
    return {
      attemptId: result.attemptId,
      invocationId: attempt.providerInvocation.invocationId,
      acceptance: result.acceptance,
      outputDigest: result.outputDigest,
      outputSchema: entry.outputSchema,
      residuals: entry.residuals,
    };
  });
  const latestFailedAttempt = [...state.attempts]
    .reverse()
    .find((attempt) => attempt.failure !== null);
  const latestFailure =
    latestFailedAttempt?.failure === null || latestFailedAttempt === undefined
      ? null
      : {
          attemptId: latestFailedAttempt.attemptId,
          failure: latestFailedAttempt.failure,
          decision: retryDecisionForProviderFailure({
            workflow: state.workflow,
            job: state.job,
            attempt: latestFailedAttempt,
            attempts: state.attempts,
          }),
        };
  return deepFreeze({
    schemaVersion: 1,
    runtimeStatus: projectAgentRuntimeStatus(state.job),
    workflow: state.workflow,
    job: state.job,
    // Durable state carries the ordinals the writer assigned, so there is
    // nothing for the reader to renumber.
    attemptNumbering: 'recorded' as const,
    attempts: state.attempts,
    acceptedAttemptId: state.job.acceptedAttemptId,
    results,
    latestFailure,
  });
}

function projectAgentRuntimeStatus(
  job: JobRecord,
): ExecutionJobInspection['runtimeStatus'] {
  if (job.status === 'queued') return 'scheduled';
  if (job.status === 'running') return 'running';
  if (job.status === 'succeeded') return 'completed';
  if (job.status === 'cancelled') return 'cancelled';
  return 'failed';
}

function retryDecisionForProviderFailure(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  attempts: AttemptRecord[];
}): RetryDecision {
  return decideProviderExecutionFailure(input);
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertExactTimestamp(value: string): string {
  const date = new Date(value);
  if (
    typeof value !== 'string' ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value
  ) {
    throw workflowError(
      'EXECUTION_RUNTIME_TIMESTAMP_INVALID',
      'Execution runtime timestamp must be exact ISO time.',
      ExitCode.usage,
    );
  }
  return value;
}

export function runtimeConflict(message: string) {
  return workflowError(
    'EXECUTION_RUNTIME_JOB_CONFLICT',
    message,
    ExitCode.staleState,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
