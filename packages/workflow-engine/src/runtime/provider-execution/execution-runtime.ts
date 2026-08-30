import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  createReplacementAttempt,
  projectProviderInvocationExecution,
  type AttemptRecord,
  type ChangedField,
  type ExecutionPolicySnapshot,
  type FailureDescriptor,
  type JobRecord,
  type ProviderInvocationProjection,
  type RetryDecision,
  type WorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  decideProviderExecutionFailure,
  readExecutionJobState,
  type DurableExecutionJobState,
} from '../storage-journal/execution-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { listProviderInvocationLifecycleProjections } from '../storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import {
  providerOutputSchemaGeneration,
  providerResidualsGeneration,
  readProviderInvocation,
  readProviderInvocationRequest,
  type ProviderInvocationRecord,
  type ProviderOutputSchemaGeneration,
  type ProviderResidualsGeneration,
} from '../storage-journal/provider-invocation-store.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_PROVIDER_TIMEOUT_MS = 3_600_000;

export type ExecutionResultView = {
  attemptId: string;
  invocationId: string;
  acceptance: 'accepted' | 'late-duplicate';
  outputDigest: string;
  outputSchema: ProviderOutputSchemaGeneration;
  residuals: ProviderResidualsGeneration | null;
};

export type ExecutionFailureView = {
  attemptId: string;
  failure: FailureDescriptor;
  decision: RetryDecision;
};

export type ExecutionJobInspection = {
  schemaVersion: 1;
  /** Stable public AgentRuntime lifecycle projected from the durable Job. */
  runtimeStatus: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  workflow: WorkflowRecord;
  job: JobRecord;
  attemptNumbering: 'recorded';
  attempts: AttemptRecord[];
  acceptedAttemptId: string | null;
  results: ExecutionResultView[];
  latestFailure: ExecutionFailureView | null;
};

export type ProviderReplacementPreview = {
  schemaVersion: 1;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  previousAttemptId: string;
  previewAttemptId: string;
  attemptNumber: number;
  retryMode: 'execution-policy-change';
  changedFields: ChangedField[];
  policySnapshot: ExecutionPolicySnapshot;
  requestDigest: string;
  grantId: string | null;
};

type ProviderProjectionEntry = {
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  outputSchema: ProviderOutputSchemaGeneration;
  residuals: ProviderResidualsGeneration | null;
  projection: ProviderInvocationProjection;
};

export function listExecutionJobs(cwd: string): ExecutionJobInspection[] {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const entries = readProviderProjectionEntries(cwd);
  const grouped = new Map<string, ProviderProjectionEntry[]>();
  for (const entry of entries) {
    const jobId = entry.projection.job.jobId;
    const group = grouped.get(jobId) ?? [];
    group.push(entry);
    grouped.set(jobId, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const jobId = group[0]!.projection.job.jobId;
      const durable = readExecutionJobState(runtime, jobId);
      if (durable === null) {
        throw runtimeConflict(
          'Provider execution state is missing its durable Job aggregate; run execution recovery before inspection.',
        );
      }
      return aggregateDurableJob(durable, group);
    });
}

export function inspectExecutionJob(
  cwd: string,
  requestedJobId: string,
): ExecutionJobInspection {
  const jobId = assertRuntimeJobId(requestedJobId);
  const inspection = listExecutionJobs(cwd).find(
    ({ job }) => job.jobId === jobId,
  );
  if (!inspection) {
    throw workflowError(
      'EXECUTION_RUNTIME_JOB_NOT_FOUND',
      `Execution Job ${jobId} was not found.`,
      ExitCode.staleState,
    );
  }
  return inspection;
}

export function prepareProviderReplacement(
  cwd: string,
  requestedJobId: string,
  input: { timeoutMs: number; now?: string },
): ProviderReplacementPreview {
  const inspection = inspectExecutionJob(cwd, requestedJobId);
  if (inspection.latestFailure?.decision.requiredGrant !== undefined) {
    throw workflowError(
      'EXECUTION_RUNTIME_GRANT_REQUIRED',
      'The replacement requires the concrete execution-budget grant returned by inspection.',
      ExitCode.guard,
      {
        details: {
          grantRequest: inspection.latestFailure.decision.requiredGrant,
        },
      },
    );
  }
  return buildProviderReplacementPreview(inspection, input, null);
}

/** Build the read-only replacement delta used by an exact Grant request. */
export function previewProviderReplacementGrantDelta(
  cwd: string,
  requestedJobId: string,
  input: { timeoutMs: number; now?: string },
): ProviderReplacementPreview {
  return buildProviderReplacementPreview(
    inspectExecutionJob(cwd, requestedJobId),
    input,
    null,
    true,
  );
}

export function inspectProviderExecutionJobSource(
  cwd: string,
  requestedJobId: string,
): ProviderProjectionEntry {
  const jobId = assertRuntimeJobId(requestedJobId);
  const entries = readProviderProjectionEntries(cwd)
    .filter(({ projection }) => projection.job.jobId === jobId)
    .sort((left, right) => left.record.attempt - right.record.attempt);
  const latest = entries.at(-1);
  if (latest === undefined) {
    throw workflowError(
      'EXECUTION_RUNTIME_JOB_NOT_FOUND',
      `Execution Job ${jobId} was not found.`,
      ExitCode.staleState,
    );
  }
  return deepFreeze(structuredClone(latest));
}

function buildProviderReplacementPreview(
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

function readProviderProjectionEntries(cwd: string): ProviderProjectionEntry[] {
  const context = loadInvestigationRuntimeContext(cwd);
  let records: Array<{
    record: ProviderInvocationRecord;
    request: ProviderInvocationRequest;
    outputSchema: ProviderOutputSchemaGeneration;
    residuals: ProviderResidualsGeneration | null;
  }>;
  try {
    const projections = listProviderInvocationLifecycleProjections(
      context.runtime,
    );
    records = projections.map(({ invocationId }) => {
      const request = readProviderInvocationRequest(
        context.runtime,
        invocationId,
      );
      const record = readProviderInvocation(context.runtime, invocationId);
      return {
        record,
        request,
        // Classified here, with the rest of the store read, so a shape no
        // writer of this engine produced still fails the scan closed rather
        // than reaching the projection as if it were merely old.
        outputSchema: providerOutputSchemaGeneration(request),
        residuals: providerResidualsGeneration(record),
      };
    });
  } catch (error) {
    throw workflowError(
      'EXECUTION_RUNTIME_STORE_UNSAFE',
      'Provider invocation state cannot be inspected safely.',
      ExitCode.staleState,
      { details: { cause: errorMessage(error) } },
    );
  }
  return records.map(({ record, request, outputSchema, residuals }) => {
    try {
      const projection = projectProviderInvocationExecution({
        record,
        request,
      });
      return { record, request, outputSchema, residuals, projection };
    } catch (error) {
      throw workflowError(
        'EXECUTION_RUNTIME_PROJECTION_INVALID',
        `Provider invocation ${record.invocationId} cannot be projected.`,
        ExitCode.guard,
        { details: { cause: errorMessage(error) } },
      );
    }
  });
}

function aggregateDurableJob(
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

function assertRuntimeJobId(value: string): string {
  if (typeof value !== 'string' || !JOB_ID.test(value)) {
    throw workflowError(
      'EXECUTION_RUNTIME_JOB_ID_INVALID',
      'Execution Job ID is invalid.',
      ExitCode.usage,
    );
  }
  return value;
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

function runtimeConflict(message: string) {
  return workflowError(
    'EXECUTION_RUNTIME_JOB_CONFLICT',
    message,
    ExitCode.staleState,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
