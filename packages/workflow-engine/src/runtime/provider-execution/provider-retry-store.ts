/**
 * Persist exact retry schedules and reconcile bounded probe or replacement attempt receipts.
 *
 * Invariants:
 * - Receipt creation, completion, schedule reconciliation, and lock identities stay unchanged.
 * - Replays validate the same immutable request and attempt bindings before writes.
 */

import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertReadOnlyProbe,
  type ReadOnlyProbeRequest,
} from '../../modules/provider-orchestration/execution-core.ts';
import { readExecutionJobState } from '../storage-journal/execution-store.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from '../storage-journal/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { type ProviderInvocationRecord } from '../storage-journal/provider-invocation-store.ts';
import {
  type ProviderAutomaticRetrySchedule,
  type ProviderRetryScheduleReceipt,
  providerRetryScheduleUnsafe,
  digestCanonical,
  assertProviderRetryScheduleReceipt,
  assertProviderAutomaticRetrySchedule,
  PROBE_MAX_BACKOFF_MS,
  PROBE_MIN_BACKOFF_MS,
  PROBE_MAX_ATTEMPTS,
  isDigest,
  sha256Text,
} from './provider-retry-record.ts';

export function startScheduleReceipt(
  paths: InvestigationRuntimePaths,
  schedule: ProviderAutomaticRetrySchedule,
  now: string,
): ProviderRetryScheduleReceipt {
  const attemptNumber =
    schedule.route === 'provider-replacement'
      ? 1
      : schedule.probeAttemptsCompleted + 1;
  if (
    attemptNumber < 1 ||
    (schedule.route === 'environment-probe' &&
      attemptNumber > schedule.probeMaxAttempts)
  ) {
    throw providerRetryScheduleUnsafe();
  }
  const identity = {
    kind: 'provider-retry-schedule-receipt',
    scheduleId: schedule.scheduleId,
    route: schedule.route,
    attemptNumber,
  };
  const receiptId = digestCanonical(identity);
  const requestDigest = scheduleReceiptRequestDigest(schedule);
  const receiptPath = providerRetryReceiptPath(paths, receiptId);
  if (privatePathExists(paths, receiptPath, providerRetryScheduleUnsafe)) {
    const existing = assertProviderRetryScheduleReceipt(
      readPrivateCanonicalJson(paths, receiptPath, providerRetryScheduleUnsafe),
    );
    if (
      existing.receiptId !== receiptId ||
      existing.scheduleId !== schedule.scheduleId ||
      existing.route !== schedule.route ||
      existing.attemptNumber !== attemptNumber ||
      existing.requestDigest !== requestDigest ||
      canonicalJson(existing.probe) !== canonicalJson(schedule.probe)
    ) {
      throw providerRetryScheduleUnsafe();
    }
    return existing;
  }
  const receipt = assertProviderRetryScheduleReceipt({
    schemaVersion: 1,
    kind: 'provider-retry-schedule-receipt',
    receiptId,
    scheduleId: schedule.scheduleId,
    route: schedule.route,
    attemptNumber,
    state: 'started',
    requestDigest,
    probe: schedule.probe,
    outcomeCode: null,
    observationDigest: null,
    startedAt: now,
    completedAt: null,
    nextNotBefore: null,
  });
  const root = providerRetryReceiptRoot(paths);
  ensurePrivateInvestigationDirectory(paths, root, providerRetryScheduleUnsafe);
  createPrivateCanonicalJson(
    paths,
    receiptPath,
    receipt,
    providerRetryScheduleUnsafe,
    'PROVIDER_RETRY_SCHEDULE_RECEIPT_CONFLICT',
  );
  return assertProviderRetryScheduleReceipt(
    readPrivateCanonicalJson(paths, receiptPath, providerRetryScheduleUnsafe),
  );
}

export function finishScheduleReceipt(
  paths: InvestigationRuntimePaths,
  started: ProviderRetryScheduleReceipt,
  completion: Pick<
    ProviderRetryScheduleReceipt,
    | 'state'
    | 'outcomeCode'
    | 'observationDigest'
    | 'completedAt'
    | 'nextNotBefore'
  >,
): ProviderRetryScheduleReceipt {
  if (started.state !== 'started') return started;
  const updated = assertProviderRetryScheduleReceipt({
    ...started,
    ...completion,
  });
  writePrivateCanonicalJsonAtomic(
    paths,
    providerRetryReceiptPath(paths, started.receiptId),
    updated,
    providerRetryScheduleUnsafe,
  );
  return assertProviderRetryScheduleReceipt(
    readPrivateCanonicalJson(
      paths,
      providerRetryReceiptPath(paths, started.receiptId),
      providerRetryScheduleUnsafe,
    ),
  );
}

export function reconcileScheduleFromReceipt(
  paths: InvestigationRuntimePaths,
  schedule: ProviderAutomaticRetrySchedule,
  receipt: ProviderRetryScheduleReceipt,
): ProviderAutomaticRetrySchedule {
  if (
    receipt.state === 'started' ||
    receipt.scheduleId !== schedule.scheduleId ||
    receipt.route !== schedule.route ||
    receipt.completedAt === null
  ) {
    throw providerRetryScheduleUnsafe();
  }
  const expectedAttemptNumber =
    schedule.route === 'provider-replacement'
      ? 1
      : schedule.probeAttemptsCompleted + 1;
  if (
    receipt.attemptNumber !== expectedAttemptNumber ||
    receipt.requestDigest !== scheduleReceiptRequestDigest(schedule) ||
    canonicalJson(receipt.probe) !== canonicalJson(schedule.probe)
  ) {
    throw providerRetryScheduleUnsafe();
  }
  let updated: ProviderAutomaticRetrySchedule;
  if (receipt.state === 'dispatch-issued') {
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'dispatch-issued',
      dispatchedAt: receipt.completedAt,
      completedAt: receipt.completedAt,
      nextAction: 'none',
      updatedAt: receipt.completedAt,
    });
  } else if (receipt.state === 'probe-retry-scheduled') {
    if (receipt.nextNotBefore === null) throw providerRetryScheduleUnsafe();
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'scheduled',
      probeAttemptsCompleted: receipt.attemptNumber,
      notBefore: receipt.nextNotBefore,
      completedAt: null,
      nextAction: 'wait-until-due',
      updatedAt: receipt.completedAt,
    });
  } else if (receipt.state === 'probe-succeeded') {
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'probe-succeeded',
      probeAttemptsCompleted: receipt.attemptNumber,
      completedAt: receipt.completedAt,
      nextAction: 'none',
      updatedAt: receipt.completedAt,
    });
  } else {
    updated = assertProviderAutomaticRetrySchedule({
      ...schedule,
      state: 'probe-failed-terminal',
      probeAttemptsCompleted: receipt.attemptNumber,
      completedAt: receipt.completedAt,
      nextAction: 'inspect-environment-before-new-provider-attempt',
      updatedAt: receipt.completedAt,
    });
  }
  writePrivateCanonicalJsonAtomic(
    paths,
    providerRetrySchedulePath(paths, schedule.failedInvocationId),
    updated,
    providerRetryScheduleUnsafe,
  );
  return readProviderAutomaticRetryScheduleFromPaths(
    paths,
    schedule.failedInvocationId,
  );
}

function scheduleReceiptRequestDigest(
  schedule: ProviderAutomaticRetrySchedule,
): string {
  return schedule.route === 'environment-probe'
    ? digestCanonical(assertReadOnlyProbe(schedule.probe))
    : digestCanonical({
        replacementAttemptId: schedule.replacementAttemptId,
        replacementInvocationId: schedule.replacementInvocationId,
      });
}

export function probeBackoffForAttempt(
  schedule: ProviderAutomaticRetrySchedule,
  attemptNumber: number,
): number {
  return Math.min(
    PROBE_MAX_BACKOFF_MS,
    schedule.probeBackoffMs * 2 ** Math.max(0, attemptNumber - 1),
  );
}

export function persistSchedule(
  paths: InvestigationRuntimePaths,
  input: {
    failed: ProviderInvocationRecord;
    state: NonNullable<ReturnType<typeof readExecutionJobState>>;
    failedAttemptId: string;
    replacementAttemptId: string | null;
    replacementInvocationId: string | null;
    route: ProviderAutomaticRetrySchedule['route'];
    retryMode: ProviderAutomaticRetrySchedule['retryMode'];
    probe: Readonly<ReadOnlyProbeRequest> | null;
    retryAfterMs: number;
    createdAt: string;
  },
): ProviderAutomaticRetrySchedule {
  const failureDigest = digestCanonical(input.failed.failure);
  const notBefore = new Date(
    Date.parse(input.failed.updatedAt) + input.retryAfterMs,
  ).toISOString();
  const identity = {
    kind: 'provider-automatic-retry-schedule',
    failedInvocationId: input.failed.invocationId,
    failedInvocationRevision: input.failed.revision,
    failureDigest,
    route: input.route,
    replacementInvocationId: input.replacementInvocationId,
    probe: input.probe,
    notBefore,
  };
  const probeBackoffMs =
    input.route === 'environment-probe'
      ? Math.min(
          PROBE_MAX_BACKOFF_MS,
          Math.max(PROBE_MIN_BACKOFF_MS, input.retryAfterMs),
        )
      : 0;
  const schedule = assertProviderAutomaticRetrySchedule({
    schemaVersion: 2,
    kind: 'provider-automatic-retry-schedule',
    scheduleId: digestCanonical(identity),
    state: 'scheduled',
    route: input.route,
    workflowId: input.state.workflow.workflowId,
    epoch: input.state.job.epoch,
    contextDigest: input.state.job.contextDigest,
    executionJobId: input.state.job.jobId,
    failedAttemptId: input.failedAttemptId,
    failedInvocationId: input.failed.invocationId,
    failedInvocationRevision: input.failed.revision,
    failureDigest,
    failureCode: input.failed.failure!.code,
    replacementAttemptId: input.replacementAttemptId,
    replacementInvocationId: input.replacementInvocationId,
    retryMode: input.retryMode,
    probe: input.probe,
    probeAttemptsCompleted: 0,
    probeMaxAttempts:
      input.route === 'environment-probe' ? PROBE_MAX_ATTEMPTS : 0,
    probeBackoffMs,
    retryAfterMs: input.retryAfterMs,
    notBefore,
    createdAt: input.createdAt,
    dispatchedAt: null,
    completedAt: null,
    nextAction:
      Date.parse(notBefore) > Date.parse(input.createdAt)
        ? 'wait-until-due'
        : input.route === 'provider-replacement'
          ? 'dispatch-replacement'
          : 'wait-until-due',
    updatedAt: input.createdAt,
  });
  const root = providerRetryScheduleRoot(paths);
  ensurePrivateInvestigationDirectory(paths, root, providerRetryScheduleUnsafe);
  createPrivateCanonicalJson(
    paths,
    providerRetrySchedulePath(paths, input.failed.invocationId),
    schedule,
    providerRetryScheduleUnsafe,
    'PROVIDER_RETRY_SCHEDULE_CONFLICT',
  );
  const durable = readProviderAutomaticRetryScheduleFromPaths(
    paths,
    input.failed.invocationId,
  );
  if (canonicalJson(durable) !== canonicalJson(schedule)) {
    throw providerRetryScheduleUnsafe();
  }
  return durable;
}

export function providerRetryScheduleRoot(
  paths: InvestigationRuntimePaths,
): string {
  return path.join(paths.root, 'provider-retry-schedules');
}

export function providerRetryReceiptRoot(
  paths: InvestigationRuntimePaths,
): string {
  return path.join(paths.root, 'provider-retry-schedule-receipts');
}

function providerRetryReceiptPath(
  paths: InvestigationRuntimePaths,
  receiptId: string,
): string {
  if (!isDigest(receiptId)) throw providerRetryScheduleUnsafe();
  return path.join(
    providerRetryReceiptRoot(paths),
    `${receiptId.slice('sha256:'.length)}.json`,
  );
}

export function providerRetryScheduleLockPath(
  paths: InvestigationRuntimePaths,
  failedInvocationId: string,
): string {
  return path.join(paths.locks, `${sha256Text(failedInvocationId)}.retry.lock`);
}

export function providerRetrySchedulePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    providerRetryScheduleRoot(paths),
    `${sha256Text(invocationId)}.json`,
  );
}

export function readProviderAutomaticRetryScheduleFromPaths(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): ProviderAutomaticRetrySchedule {
  const schedule = assertProviderAutomaticRetrySchedule(
    readPrivateCanonicalJson(
      paths,
      providerRetrySchedulePath(paths, invocationId),
      providerRetryScheduleUnsafe,
    ),
  );
  if (schedule.failedInvocationId !== invocationId) {
    throw providerRetryScheduleUnsafe();
  }
  return schedule;
}
