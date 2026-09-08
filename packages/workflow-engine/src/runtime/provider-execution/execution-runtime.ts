/**
 * Inspect, watch, and prepare replacement views for durable provider execution jobs.
 *
 * Invariants:
 * - Context loading, current journal reads, polling cancellation, and public signatures stay exact.
 * - Inspection never publishes a replacement or re-runs provider work.
 *
 * Depends on: execution journals, provider lifecycle projections, and replacement view construction.
 * Failure modes: Callers can observe stale job state or wait past a requested cancellation.
 */

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type FailureDescriptor,
  type RetryDecision,
  type WorkflowRecord,
  type JobRecord,
  type AttemptRecord,
  type ChangedField,
  type ExecutionPolicySnapshot,
  projectProviderInvocationExecution,
} from '../../modules/provider-orchestration/execution-core.ts';
import { readExecutionJobState } from '../storage-journal/execution-store.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { listProviderInvocationLifecycleProjections } from '../storage-journal/provider-invocation-lifecycle.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import {
  type ProviderOutputSchemaGeneration,
  type ProviderResidualsGeneration,
  type ProviderInvocationRecord,
  readProviderInvocationRequest,
  readProviderInvocation,
  providerOutputSchemaGeneration,
  providerResidualsGeneration,
} from '../storage-journal/provider-invocation-store.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type ProviderProjectionEntry,
  runtimeConflict,
  aggregateDurableJob,
  buildProviderReplacementPreview,
  deepFreeze,
  errorMessage,
} from './provider-execution-projection.ts';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

const DEFAULT_JOB_WATCH_POLL_INTERVAL_MS = 1_000;

const MAX_JOB_WATCH_POLL_INTERVAL_MS = 60_000;

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

export type ExecutionJobWatchOptions = Readonly<{
  signal?: AbortSignal;
  pollIntervalMs?: number;
}>;

export type ExecutionJobWatchDependencies = Readonly<{
  inspectJob?: typeof inspectExecutionJob;
  waitForPoll?: (intervalMs: number, signal?: AbortSignal) => Promise<void>;
}>;

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

/**
 * Observe one durable Job without acquiring authority over its lifecycle.
 * Quiet polls emit nothing; only the Job writer can create Attempts or move
 * the terminal state observed here.
 */
export async function* watchExecutionJob(
  cwd: string,
  requestedJobId: string,
  options: ExecutionJobWatchOptions = {},
  dependencies: ExecutionJobWatchDependencies = {},
): AsyncGenerator<ExecutionJobInspection, void, void> {
  const { signal, pollIntervalMs } = assertExecutionJobWatchOptions(options);
  const { inspectJob, waitForPoll } =
    assertExecutionJobWatchDependencies(dependencies);
  if (executionJobWatchAborted(signal)) return;

  let observation = inspectJob(cwd, requestedJobId);
  let observationIdentity = canonicalJson(observation);
  yield observation;
  if (isExecutionRuntimeTerminal(observation.runtimeStatus)) return;

  while (!executionJobWatchAborted(signal)) {
    await waitForPoll(pollIntervalMs, signal);
    if (executionJobWatchAborted(signal)) return;
    const current = inspectJob(cwd, requestedJobId);
    const currentIdentity = canonicalJson(current);
    if (currentIdentity === observationIdentity) continue;
    observation = current;
    observationIdentity = currentIdentity;
    yield observation;
    if (isExecutionRuntimeTerminal(observation.runtimeStatus)) return;
  }
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

function assertExecutionJobWatchOptions(
  options: ExecutionJobWatchOptions,
): Required<Pick<ExecutionJobWatchOptions, 'pollIntervalMs'>> &
  Pick<ExecutionJobWatchOptions, 'signal'> {
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_JOB_WATCH_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > MAX_JOB_WATCH_POLL_INTERVAL_MS ||
    (options.signal !== undefined &&
      (!(options.signal instanceof AbortSignal) ||
        typeof options.signal.aborted !== 'boolean'))
  ) {
    throw executionJobWatchOptionsInvalid();
  }
  return {
    pollIntervalMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function assertExecutionJobWatchDependencies(
  dependencies: ExecutionJobWatchDependencies,
): Required<ExecutionJobWatchDependencies> {
  const inspectJob = dependencies.inspectJob ?? inspectExecutionJob;
  const waitForPoll = dependencies.waitForPoll ?? waitForExecutionJobPoll;
  if (typeof inspectJob !== 'function' || typeof waitForPoll !== 'function') {
    throw executionJobWatchOptionsInvalid();
  }
  return { inspectJob, waitForPoll };
}

function executionJobWatchOptionsInvalid() {
  return workflowError(
    'EXECUTION_RUNTIME_WATCH_OPTIONS_INVALID',
    'Execution Job watch options are invalid.',
    ExitCode.usage,
  );
}

function isExecutionRuntimeTerminal(
  status: ExecutionJobInspection['runtimeStatus'],
): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function executionJobWatchAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function waitForExecutionJobPoll(
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, intervalMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
