/**
 * Route provider failures and pump bounded due retry schedules through the existing runtime composition.
 *
 * Invariants:
 * - Probe decisions, replacement publication, lock scope, and callback order stay exact.
 * - Context loading and application retry calls remain at this runtime entrypoint.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import {
  type ReadOnlyProbeRequest,
  projectProviderInvocationExecution,
  type ExecutionFailureKind,
  assertReadOnlyProbe,
} from '../../modules/provider-orchestration/execution-core.ts';
import type { GrantRequest } from '../../modules/authority/execution-governance.ts';
import type { ConsumedPlanReviewReplayPort } from '../../modules/assurance/planning-assurance-validator.ts';
import { inspectExecutionJob } from './execution-runtime.ts';
import { readExecutionJobState } from '../storage-journal/execution-store.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  withPrivateRuntimeLock,
} from '../storage-journal/investigation-private-files.ts';
import { readInvestigationSession } from '../storage-journal/investigation-session-records.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import { retryInvestigationProvider } from '../../adapters/planning/investigation/investigation-session.ts';
import {
  getProposeStatus,
  resumePropose,
  createPlanReviewRetryEnvelope,
} from '../../application/propose/propose-orchestrator.ts';
import {
  type ProviderInvocationRequest,
  createProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
  type ProviderInvocationRecord,
  readProviderRetryReservation,
  type ProviderInvocationFailure,
} from '../storage-journal/provider-invocation-store.ts';
import {
  type ProviderReadOnlyProbeExecutionResult,
  executeProviderReadOnlyProbe,
} from './provider-probe-executor.ts';
import {
  type ProviderAutomaticRetrySchedule,
  exactTimestamp,
  deepFreeze,
  providerRetryScheduleUnsafe,
  assertProviderAutomaticRetrySchedule,
  sha256Text,
  type ProviderRetryScheduleReceipt,
  isDigest,
  assertProviderRetryScheduleReceipt,
  digestCanonical,
  isRecord,
  hasExactKeys,
} from './provider-retry-record.ts';
import {
  providerRetrySchedulePath,
  providerRetryScheduleRoot,
  providerRetryReceiptRoot,
  providerRetryScheduleLockPath,
  readProviderAutomaticRetryScheduleFromPaths,
  startScheduleReceipt,
  reconcileScheduleFromReceipt,
  finishScheduleReceipt,
  probeBackoffForAttempt,
  persistSchedule,
} from './provider-retry-store.ts';

export {
  type ProviderRetryScheduleState,
  type ProviderRetryScheduleNextAction,
  type ProviderAutomaticRetrySchedule,
  type ProviderRetryScheduleReceiptState,
  type ProviderRetryScheduleReceipt,
} from './provider-retry-record.ts';

const RETRY_SCHEDULE_FILE = /^[0-9a-f]{64}\.json$/;

const RETRY_RECEIPT_FILE = /^[0-9a-f]{64}\.json$/;

export type ProviderRetrySchedulePumpResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-schedule-pump';
  inspected: number;
  due: number;
  processed: number;
  scheduleIds: readonly string[];
}>;

export type ProviderRetrySchedulePumpOptions = Readonly<{
  limit: number;
  now?: string;
  dispatcher?: (cwd: string, invocationId: string) => unknown;
  probeExecutor?: (
    cwd: string,
    request: Readonly<ReadOnlyProbeRequest>,
    schedule: ProviderAutomaticRetrySchedule,
  ) => ProviderReadOnlyProbeExecutionResult;
  faultInjector?: (
    point: 'after-dispatch' | 'after-probe-execution',
    schedule: ProviderAutomaticRetrySchedule,
  ) => void;
}>;

export type ProviderFailureRetryResult =
  | Readonly<{
      kind: 'replacement-scheduled' | 'replacement-dispatched';
      schedule: ProviderAutomaticRetrySchedule;
    }>
  | Readonly<{
      kind: 'probe-scheduled';
      schedule: ProviderAutomaticRetrySchedule;
    }>
  | Readonly<{
      kind: 'grant-required';
      jobId: string;
      grantRequest: GrantRequest;
    }>
  | Readonly<{
      kind: 'decision-denied' | 'not-retryable';
      jobId: string;
      reasonCode: string;
    }>;

export type ProcessProviderFailureRetryOptions = Readonly<{
  now?: string;
  dispatcher?: (cwd: string, invocationId: string) => unknown;
  consumedRoleResultReplay?: ConsumedPlanReviewReplayPort;
}>;

/**
 * Reconcile one durable failed invocation into its bounded next action. The
 * existing Survey/PlanReview lifecycle remains the publication authority for
 * replacement work; this service only adds a durable due-time/dispatch journal
 * around that exact transition.
 */
export function processProviderFailureRetry(
  cwd: string,
  requestedInvocationId: string,
  options: ProcessProviderFailureRetryOptions = {},
): ProviderFailureRetryResult {
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const existing = readProviderAutomaticRetrySchedule(
    cwd,
    requestedInvocationId,
  );
  if (existing !== null) {
    return continueSchedule(cwd, existing, now, options.dispatcher);
  }

  const context = loadInvestigationRuntimeContext(cwd);
  const failed = readProviderInvocation(context.runtime, requestedInvocationId);
  const failedRequest = readProviderInvocationRequest(
    context.runtime,
    failed.invocationId,
  );
  const projection = projectProviderInvocationExecution({
    record: failed,
    request: failedRequest,
  });
  if (
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable'
  ) {
    return deepFreeze({
      kind: 'not-retryable' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure?.code ?? 'PROVIDER_INVOCATION_NOT_RETRYABLE',
    });
  }
  // TaskDiffReview and task implementation are not owned by the
  // investigation/PlanReview retry state machine. Until their exact
  // WorkflowSession owner publishes a replacement, fail closed instead of
  // routing the invocation through `resumePropose`.
  if (
    failed.purpose === 'task-diff-review' ||
    failed.purpose === 'task-implementation'
  ) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode:
        failed.purpose === 'task-diff-review'
          ? 'TASK_DIFF_REVIEW_RETRY_OWNER_REQUIRED'
          : 'TASK_IMPLEMENTATION_RETRY_OWNER_REQUIRED',
    });
  }
  const strategyDecision = inspectExecutionJob(cwd, projection.job.jobId)
    .latestFailure?.decision;
  if (
    strategyDecision?.retryable === true &&
    strategyDecision.automatic === false &&
    strategyDecision.retryMode === 'strategy-change' &&
    strategyDecision.changedStrategyRequired === true
  ) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: strategyDecision.reasonCode,
    });
  }
  const executionKind = providerExecutionFailureKind(failed.failure);
  if (executionKind === null || executionKind === 'unknown-side-effect') {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure.code,
    });
  }
  if (executionKind === 'probe-transient') {
    return scheduleProbeRetry(cwd, failed, projection.job.jobId, now);
  }
  if (!PROVIDER_REPLACEMENT_FAILURE_KINDS.has(executionKind)) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure.code,
    });
  }

  let replacementInvocationId: string;
  try {
    replacementInvocationId = publishReplacement(
      cwd,
      failed,
      options.consumedRoleResultReplay,
    );
  } catch (error) {
    if (!isExpectedRetryDecisionError(error)) throw error;
    return decisionWithoutReplacement(cwd, projection.job.jobId, error.code);
  }
  const schedule = createReplacementSchedule(
    cwd,
    failed,
    projection.job.jobId,
    replacementInvocationId,
    now,
  );
  return continueSchedule(cwd, schedule, now, options.dispatcher);
}

const PROVIDER_REPLACEMENT_FAILURE_KINDS = new Set<ExecutionFailureKind>([
  'provider-timeout',
  'network',
  'rate-limit',
  'provider-process-crash',
  'worker-crash',
  'lease-expiry',
  'temporary-file-lock',
  'provider-capacity',
  'stdout-truncated',
  'process-nonzero',
  'json-parse',
  'schema-mismatch',
  'missing-required-field',
  'citation-out-of-range',
]);

export function readProviderAutomaticRetrySchedule(
  cwd: string,
  requestedInvocationId: string,
): ProviderAutomaticRetrySchedule | null {
  const context = loadInvestigationRuntimeContext(cwd);
  const schedulePath = providerRetrySchedulePath(
    context.runtime,
    requestedInvocationId,
  );
  if (
    !privatePathExists(
      context.runtime,
      schedulePath,
      providerRetryScheduleUnsafe,
    )
  ) {
    return null;
  }
  const schedule = assertProviderAutomaticRetrySchedule(
    readPrivateCanonicalJson(
      context.runtime,
      schedulePath,
      providerRetryScheduleUnsafe,
    ),
  );
  if (schedule.failedInvocationId !== requestedInvocationId) {
    throw providerRetryScheduleUnsafe();
  }
  return schedule;
}

export function listProviderAutomaticRetrySchedules(
  cwd: string,
): ProviderAutomaticRetrySchedule[] {
  const context = loadInvestigationRuntimeContext(cwd);
  const root = providerRetryScheduleRoot(context.runtime);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  assertPrivateInvestigationDirectory(
    context.runtime,
    root,
    providerRetryScheduleUnsafe,
  );
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !RETRY_SCHEDULE_FILE.test(entry.name)
      ) {
        throw providerRetryScheduleUnsafe();
      }
      const schedule = assertProviderAutomaticRetrySchedule(
        readPrivateCanonicalJson(
          context.runtime,
          path.join(root, entry.name),
          providerRetryScheduleUnsafe,
        ),
      );
      if (`${sha256Text(schedule.failedInvocationId)}.json` !== entry.name) {
        throw providerRetryScheduleUnsafe();
      }
      return schedule;
    });
}

export function listProviderRetryScheduleReceipts(
  cwd: string,
  scheduleId?: string,
): ProviderRetryScheduleReceipt[] {
  if (scheduleId !== undefined && !isDigest(scheduleId)) {
    throw providerRetryScheduleUnsafe();
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const root = providerRetryReceiptRoot(context.runtime);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  assertPrivateInvestigationDirectory(
    context.runtime,
    root,
    providerRetryScheduleUnsafe,
  );
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !RETRY_RECEIPT_FILE.test(entry.name)
      ) {
        throw providerRetryScheduleUnsafe();
      }
      const receipt = assertProviderRetryScheduleReceipt(
        readPrivateCanonicalJson(
          context.runtime,
          path.join(root, entry.name),
          providerRetryScheduleUnsafe,
        ),
      );
      if (`${receipt.receiptId.slice('sha256:'.length)}.json` !== entry.name) {
        throw providerRetryScheduleUnsafe();
      }
      return receipt;
    })
    .filter((receipt) =>
      scheduleId === undefined ? true : receipt.scheduleId === scheduleId,
    )
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.attemptNumber - right.attemptNumber ||
        left.receiptId.localeCompare(right.receiptId),
    );
}

/** Process at most `limit` due retry schedules in one finite sweep. */
export function pumpProviderRetrySchedules(
  cwd: string,
  options: ProviderRetrySchedulePumpOptions,
): ProviderRetrySchedulePumpResult {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw workflowError(
      'PROVIDER_RETRY_PUMP_LIMIT_INVALID',
      'Provider retry pump limit must be an integer from 1 through 100.',
      ExitCode.usage,
    );
  }
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const schedules = listProviderAutomaticRetrySchedules(cwd);
  const due = schedules
    .filter(
      (schedule) =>
        schedule.state === 'scheduled' &&
        Date.parse(schedule.notBefore) <= Date.parse(now) &&
        (schedule.route === 'environment-probe' ||
          options.dispatcher !== undefined),
    )
    .sort(
      (left, right) =>
        left.notBefore.localeCompare(right.notBefore) ||
        left.scheduleId.localeCompare(right.scheduleId),
    );
  const processed: string[] = [];
  for (const schedule of due.slice(0, options.limit)) {
    const updated = processDueSchedule(cwd, schedule, now, options);
    if (
      updated.state !== 'scheduled' ||
      updated.updatedAt !== schedule.updatedAt
    ) {
      processed.push(updated.scheduleId);
    }
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-retry-schedule-pump' as const,
    inspected: schedules.length,
    due: due.length,
    processed: processed.length,
    scheduleIds: processed,
  });
}

function processDueSchedule(
  cwd: string,
  expected: ProviderAutomaticRetrySchedule,
  now: string,
  options: Pick<
    ProviderRetrySchedulePumpOptions,
    'dispatcher' | 'probeExecutor' | 'faultInjector'
  >,
): ProviderAutomaticRetrySchedule {
  const context = loadInvestigationRuntimeContext(cwd);
  return withPrivateRuntimeLock(
    context.runtime,
    providerRetryScheduleLockPath(context.runtime, expected.failedInvocationId),
    () => {
      const current = readProviderAutomaticRetryScheduleFromPaths(
        context.runtime,
        expected.failedInvocationId,
      );
      if (current.scheduleId !== expected.scheduleId) {
        throw providerRetryScheduleUnsafe();
      }
      if (
        current.state !== 'scheduled' ||
        Date.parse(current.notBefore) > Date.parse(now)
      ) {
        return current;
      }
      const receipt = startScheduleReceipt(context.runtime, current, now);
      if (receipt.state !== 'started') {
        return reconcileScheduleFromReceipt(context.runtime, current, receipt);
      }
      if (current.route === 'provider-replacement') {
        if (options.dispatcher === undefined) return current;
        const replacement = readProviderInvocation(
          context.runtime,
          current.replacementInvocationId!,
        );
        if (replacement.state === 'prepared') {
          options.dispatcher(cwd, replacement.invocationId);
        }
        options.faultInjector?.('after-dispatch', current);
        const completed = finishScheduleReceipt(context.runtime, receipt, {
          state: 'dispatch-issued',
          outcomeCode: 'PROVIDER_REPLACEMENT_DISPATCH_ISSUED',
          observationDigest: digestCanonical({
            invocationId: replacement.invocationId,
            observedState: replacement.state,
          }),
          completedAt: now,
          nextNotBefore: null,
        });
        return reconcileScheduleFromReceipt(
          context.runtime,
          current,
          completed,
        );
      }

      const probe = assertReadOnlyProbe(current.probe);
      let result: ProviderReadOnlyProbeExecutionResult;
      try {
        result = assertProviderReadOnlyProbeExecutionResult(
          (options.probeExecutor ?? executeProviderReadOnlyProbe)(
            cwd,
            probe,
            current,
          ),
        );
      } catch (error) {
        result = {
          state: 'failed',
          code:
            error instanceof WorkflowError
              ? error.code
              : 'PROVIDER_PROBE_EXECUTION_FAILED',
          observationDigest: digestCanonical({
            code:
              error instanceof WorkflowError
                ? error.code
                : 'PROVIDER_PROBE_EXECUTION_FAILED',
          }),
          elapsedMs: 0,
        };
      }
      if (result.elapsedMs > probe.timeoutMs) {
        result = {
          state: 'failed',
          code: 'PROVIDER_PROBE_TIMEOUT',
          observationDigest: digestCanonical({
            reportedObservationDigest: result.observationDigest,
            elapsedMs: result.elapsedMs,
            timeoutMs: probe.timeoutMs,
          }),
          elapsedMs: result.elapsedMs,
        };
      }
      options.faultInjector?.('after-probe-execution', current);
      const attemptNumber = receipt.attemptNumber;
      const terminal =
        result.state === 'succeeded' ||
        attemptNumber >= current.probeMaxAttempts;
      const nextNotBefore = terminal
        ? null
        : new Date(
            Date.parse(now) + probeBackoffForAttempt(current, attemptNumber),
          ).toISOString();
      const completed = finishScheduleReceipt(context.runtime, receipt, {
        state:
          result.state === 'succeeded'
            ? 'probe-succeeded'
            : terminal
              ? 'probe-failed-terminal'
              : 'probe-retry-scheduled',
        outcomeCode: result.code,
        observationDigest: result.observationDigest,
        completedAt: now,
        nextNotBefore,
      });
      return reconcileScheduleFromReceipt(context.runtime, current, completed);
    },
    'PROVIDER_RETRY_SCHEDULE_OPERATION_CONFLICT',
    providerRetryScheduleUnsafe,
  );
}

function assertProviderReadOnlyProbeExecutionResult(
  value: unknown,
): ProviderReadOnlyProbeExecutionResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['state', 'code', 'observationDigest', 'elapsedMs']) ||
    (value.state !== 'succeeded' && value.state !== 'failed') ||
    typeof value.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) ||
    !isDigest(value.observationDigest) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    (value.elapsedMs as number) < 0 ||
    (value.elapsedMs as number) > 86_400_000
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderReadOnlyProbeExecutionResult,
  );
}

function scheduleProbeRetry(
  cwd: string,
  failed: ProviderInvocationRecord,
  jobId: string,
  now: string,
): ProviderFailureRetryResult {
  const probe = failed.failure?.probe;
  if (probe === undefined) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId,
      reasonCode: 'ENVIRONMENT_PROBE_REQUEST_MISSING',
    });
  }
  const decision = inspectExecutionJob(cwd, jobId).latestFailure?.decision;
  if (decision?.requiredGrant !== undefined) {
    return deepFreeze({
      kind: 'grant-required' as const,
      jobId,
      grantRequest: decision.requiredGrant,
    });
  }
  if (decision?.automatic !== true || decision.retryable !== true) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId,
      reasonCode: decision?.reasonCode ?? failed.failure!.code,
    });
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const state = readExecutionJobState(context.runtime, jobId);
  const failedAttempt = state?.attempts.find(
    ({ providerInvocation }) =>
      providerInvocation?.invocationId === failed.invocationId,
  );
  if (state === null || state === undefined || failedAttempt === undefined) {
    throw providerRetryScheduleUnsafe();
  }
  const retryAfterMs =
    failed.failure!.retryAfterMs ?? decision.retryAfterMs ?? 0;
  const schedule = persistSchedule(context.runtime, {
    failed,
    state,
    failedAttemptId: failedAttempt.attemptId,
    replacementAttemptId: null,
    replacementInvocationId: null,
    route: 'environment-probe',
    retryMode: 'probe-only',
    probe,
    retryAfterMs,
    createdAt: now,
  });
  return deepFreeze({ kind: 'probe-scheduled' as const, schedule });
}

function publishReplacement(
  cwd: string,
  failed: ProviderInvocationRecord,
  consumedRoleResultReplay?: ConsumedPlanReviewReplayPort,
): string {
  if (failed.purpose === 'survey') {
    return publishSurveyReplacement(cwd, failed);
  }
  const collaborationGrantValidation =
    consumedRoleResultReplay === undefined
      ? undefined
      : {
          consumedRoleResultReplay,
          consumedPlanReviewReplay: consumedRoleResultReplay,
        };
  const output = getProposeStatus(
    cwd,
    failed.investigationId,
    collaborationGrantValidation,
  );
  const retried = resumePropose(
    cwd,
    failed.changeId,
    createPlanReviewRetryEnvelope(cwd, output, {
      acknowledgeProviderCost: true,
    }),
    collaborationGrantValidation === undefined
      ? {}
      : { collaborationGrantValidation },
  );
  const invocationId = retried.planReview?.invocationId;
  if (invocationId === undefined || invocationId === failed.invocationId) {
    throw providerRetryScheduleUnsafe();
  }
  return invocationId;
}

function publishSurveyReplacement(
  cwd: string,
  failed: ProviderInvocationRecord,
): string {
  const context = loadInvestigationRuntimeContext(cwd);
  const existing = readProviderRetryReservation(
    context.runtime,
    failed.investigationId,
    failed.attempt + 1,
  );
  if (existing !== null) {
    if (existing.previousInvocationId !== failed.invocationId) {
      throw providerRetryScheduleUnsafe();
    }
    return existing.invocationId;
  }
  const failedRequest = readProviderInvocationRequest(
    context.runtime,
    failed.invocationId,
  );
  const session = readInvestigationSession(
    context.runtime,
    failed.investigationId,
  );
  const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
  const identity = crypto.randomUUID();
  const replacementRequest = replacementProviderRequest(
    failedRequest,
    policy.digest,
    policy.policy.limits,
    identity,
  );
  const retried = retryInvestigationProvider(cwd, failed.investigationId, {
    expectedRevision: session.revision,
    replacementRequest,
  });
  if (
    retried.providerInvocationId !== replacementRequest.invocationId ||
    retried.provider.attempt !== failed.attempt + 1
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return retried.providerInvocationId;
}

function replacementProviderRequest(
  failed: ProviderInvocationRequest,
  policyDigest: string,
  limits: { timeoutMs: number; aggregateOutputBytes: number },
  identity: string,
): ProviderInvocationRequest {
  return createProviderInvocationRequest({
    invocationId: `invocation-auto-retry-${identity}`,
    nonce: `provider-auto-retry-${identity}`,
    purpose: failed.purpose,
    providerId: failed.providerId,
    roleAssignment: failed.roleAssignment,
    capabilityProfile: failed.capabilityProfile,
    repositoryId: failed.repositoryId,
    baseCommit: failed.baseCommit,
    baseTree: failed.baseTree,
    targetDigest: failed.targetDigest,
    inputManifestDigest: failed.inputManifestDigest,
    authorizationNodeId: failed.authorizationNodeId,
    writeAllowedPaths: [...failed.writeAllowedPaths],
    outputSchema: failed.outputSchema,
    evaluatorVersion: failed.evaluatorVersion,
    policyDigest,
    limits: {
      timeoutMs: limits.timeoutMs,
      aggregateOutputBytes: limits.aggregateOutputBytes,
    },
  });
}

function createReplacementSchedule(
  cwd: string,
  failed: ProviderInvocationRecord,
  jobId: string,
  replacementInvocationId: string,
  now: string,
): ProviderAutomaticRetrySchedule {
  const context = loadInvestigationRuntimeContext(cwd);
  const replacement = readProviderInvocation(
    context.runtime,
    replacementInvocationId,
  );
  const state = readExecutionJobState(context.runtime, jobId);
  const failedAttempt = state?.attempts.find(
    ({ providerInvocation }) =>
      providerInvocation?.invocationId === failed.invocationId,
  );
  const replacementAttempt = state?.attempts.find(
    ({ providerInvocation }) =>
      providerInvocation?.invocationId === replacement.invocationId,
  );
  if (
    state === null ||
    state === undefined ||
    failedAttempt === undefined ||
    replacementAttempt === undefined ||
    replacement.investigationId !== failed.investigationId ||
    replacement.changeId !== failed.changeId ||
    replacement.purpose !== failed.purpose ||
    replacement.attempt !== failed.attempt + 1 ||
    replacementAttempt.retryOf !== failedAttempt.attemptId ||
    replacementAttempt.jobId !== failedAttempt.jobId ||
    replacementAttempt.workflowId !== failedAttempt.workflowId ||
    replacementAttempt.epoch !== failedAttempt.epoch ||
    replacementAttempt.contextDigest !== failedAttempt.contextDigest
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return persistSchedule(context.runtime, {
    failed,
    state,
    failedAttemptId: failedAttempt.attemptId,
    replacementAttemptId: replacementAttempt.attemptId,
    replacementInvocationId: replacement.invocationId,
    route: 'provider-replacement',
    retryMode: replacementAttempt.retryMode,
    probe: null,
    retryAfterMs: failed.failure!.retryAfterMs ?? 0,
    createdAt: now,
  });
}

function continueSchedule(
  cwd: string,
  schedule: ProviderAutomaticRetrySchedule,
  now: string,
  dispatcher: ProcessProviderFailureRetryOptions['dispatcher'],
): ProviderFailureRetryResult {
  if (schedule.route === 'environment-probe') {
    return deepFreeze({ kind: 'probe-scheduled' as const, schedule });
  }
  if (schedule.state === 'dispatch-issued') {
    return deepFreeze({
      kind: 'replacement-dispatched' as const,
      schedule,
    });
  }
  if (Date.parse(now) < Date.parse(schedule.notBefore) || !dispatcher) {
    return deepFreeze({
      kind: 'replacement-scheduled' as const,
      schedule,
    });
  }
  const updated = processDueSchedule(cwd, schedule, now, { dispatcher });
  return deepFreeze({
    kind: 'replacement-dispatched' as const,
    schedule: updated,
  });
}

function decisionWithoutReplacement(
  cwd: string,
  jobId: string,
  fallbackReasonCode: string,
): ProviderFailureRetryResult {
  const decision = inspectExecutionJob(cwd, jobId).latestFailure?.decision;
  if (decision?.requiredGrant !== undefined) {
    return deepFreeze({
      kind: 'grant-required' as const,
      jobId,
      grantRequest: decision.requiredGrant,
    });
  }
  return deepFreeze({
    kind: 'decision-denied' as const,
    jobId,
    reasonCode: decision?.reasonCode ?? fallbackReasonCode,
  });
}

function providerExecutionFailureKind(
  failure: ProviderInvocationFailure,
): ExecutionFailureKind | null {
  if (failure.executionKind !== undefined) return failure.executionKind;
  const code = failure.code;
  if (code === 'PROVIDER_TIMEOUT') return 'provider-timeout';
  if (code === 'NETWORK_TRANSIENT') return 'network';
  if (code === 'PROVIDER_RATE_LIMIT') return 'rate-limit';
  if (code === 'PROVIDER_PROCESS_CRASH') return 'provider-process-crash';
  if (code === 'PROVIDER_INVOCATION_LEASE_EXPIRED') return 'lease-expiry';
  if (code === 'PROVIDER_NATIVE_OUTPUT_INVALID') return 'schema-mismatch';
  if (code === 'ENVIRONMENT_PROBE_TRANSIENT' && failure.probe !== undefined) {
    return 'probe-transient';
  }
  return null;
}

function isExpectedRetryDecisionError(error: unknown): error is WorkflowError {
  return (
    error instanceof WorkflowError &&
    new Set([
      'PROVIDER_RETRY_DECISION_DENIED',
      'PROVIDER_RETRY_GRANT_REQUIRED',
      'PROVIDER_RETRY_STRATEGY_CHANGE_REQUIRED',
      'PLAN_REVIEW_RETRY_DECISION_DENIED',
      'PLAN_REVIEW_RETRY_GRANT_REQUIRED',
      'PLAN_REVIEW_RETRY_STRATEGY_CHANGE_REQUIRED',
    ]).has(error.code)
  );
}
