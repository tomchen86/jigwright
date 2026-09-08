/**
 * Define and validate durable retry schedule and receipt records with exact bounded values.
 *
 * Invariants:
 * - Schema fields, digest inputs, timestamp checks, and retry limits stay unchanged.
 * - Unknown states and malformed receipt bindings remain rejected.
 *
 * Depends on: execution retry contracts, canonical JSON, and workflow errors.
 * Failure modes: Corrupt records can be treated as due work or canonical identities can drift.
 */

import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type RetryMode,
  type ReadOnlyProbeRequest,
  assertReadOnlyProbe,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';

export const PROBE_MAX_ATTEMPTS = 3;

export const PROBE_MIN_BACKOFF_MS = 1_000;

export const PROBE_MAX_BACKOFF_MS = 86_400_000;

export type ProviderRetryScheduleState =
  'scheduled' | 'dispatch-issued' | 'probe-succeeded' | 'probe-failed-terminal';

export type ProviderRetryScheduleNextAction =
  | 'wait-until-due'
  | 'dispatch-replacement'
  | 'none'
  | 'inspect-environment-before-new-provider-attempt';

export type ProviderAutomaticRetrySchedule = Readonly<{
  schemaVersion: 2;
  kind: 'provider-automatic-retry-schedule';
  scheduleId: string;
  state: ProviderRetryScheduleState;
  route: 'provider-replacement' | 'environment-probe';
  workflowId: string;
  epoch: number;
  contextDigest: string;
  executionJobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureDigest: string;
  failureCode: string;
  replacementAttemptId: string | null;
  replacementInvocationId: string | null;
  retryMode: RetryMode | 'probe-only';
  probe: Readonly<ReadOnlyProbeRequest> | null;
  probeAttemptsCompleted: number;
  probeMaxAttempts: number;
  probeBackoffMs: number;
  retryAfterMs: number;
  notBefore: string;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  nextAction: ProviderRetryScheduleNextAction;
  updatedAt: string;
}>;

export type ProviderRetryScheduleReceiptState =
  | 'started'
  | 'dispatch-issued'
  | 'probe-succeeded'
  | 'probe-retry-scheduled'
  | 'probe-failed-terminal';

export type ProviderRetryScheduleReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-schedule-receipt';
  receiptId: string;
  scheduleId: string;
  route: ProviderAutomaticRetrySchedule['route'];
  attemptNumber: number;
  state: ProviderRetryScheduleReceiptState;
  requestDigest: string;
  probe: Readonly<ReadOnlyProbeRequest> | null;
  outcomeCode: string | null;
  observationDigest: string | null;
  startedAt: string;
  completedAt: string | null;
  nextNotBefore: string | null;
}>;

export function assertProviderRetryScheduleReceipt(
  value: unknown,
): ProviderRetryScheduleReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'receiptId',
      'scheduleId',
      'route',
      'attemptNumber',
      'state',
      'requestDigest',
      'probe',
      'outcomeCode',
      'observationDigest',
      'startedAt',
      'completedAt',
      'nextNotBefore',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-schedule-receipt' ||
    !isDigest(value.receiptId) ||
    !isDigest(value.scheduleId) ||
    (value.route !== 'provider-replacement' &&
      value.route !== 'environment-probe') ||
    !Number.isSafeInteger(value.attemptNumber) ||
    (value.attemptNumber as number) < 1 ||
    value.receiptId !==
      digestCanonical({
        kind: 'provider-retry-schedule-receipt',
        scheduleId: value.scheduleId,
        route: value.route,
        attemptNumber: value.attemptNumber,
      }) ||
    ![
      'started',
      'dispatch-issued',
      'probe-succeeded',
      'probe-retry-scheduled',
      'probe-failed-terminal',
    ].includes(String(value.state)) ||
    !isDigest(value.requestDigest) ||
    (value.probe !== null && !isReadOnlyProbe(value.probe)) ||
    !nullableErrorCode(value.outcomeCode) ||
    !nullableDigest(value.observationDigest) ||
    !isTimestamp(value.startedAt) ||
    !nullableTimestamp(value.completedAt) ||
    !nullableTimestamp(value.nextNotBefore) ||
    (value.route === 'provider-replacement' &&
      (value.probe !== null ||
        (value.state !== 'started' && value.state !== 'dispatch-issued'))) ||
    (value.route === 'environment-probe' &&
      (value.probe === null || value.state === 'dispatch-issued')) ||
    (value.state === 'started' &&
      (value.outcomeCode !== null ||
        value.observationDigest !== null ||
        value.completedAt !== null ||
        value.nextNotBefore !== null)) ||
    (value.state !== 'started' &&
      (value.outcomeCode === null ||
        value.observationDigest === null ||
        value.completedAt === null)) ||
    (value.state === 'probe-retry-scheduled' && value.nextNotBefore === null) ||
    (value.state !== 'probe-retry-scheduled' && value.nextNotBefore !== null) ||
    (value.completedAt !== null &&
      Date.parse(value.completedAt as string) <
        Date.parse(value.startedAt as string)) ||
    (value.nextNotBefore !== null &&
      value.completedAt !== null &&
      Date.parse(value.nextNotBefore as string) <=
        Date.parse(value.completedAt as string))
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderRetryScheduleReceipt,
  );
}

export function assertProviderAutomaticRetrySchedule(
  value: unknown,
): ProviderAutomaticRetrySchedule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scheduleId',
      'state',
      'route',
      'workflowId',
      'epoch',
      'contextDigest',
      'executionJobId',
      'failedAttemptId',
      'failedInvocationId',
      'failedInvocationRevision',
      'failureDigest',
      'failureCode',
      'replacementAttemptId',
      'replacementInvocationId',
      'retryMode',
      'probe',
      'probeAttemptsCompleted',
      'probeMaxAttempts',
      'probeBackoffMs',
      'retryAfterMs',
      'notBefore',
      'createdAt',
      'dispatchedAt',
      'completedAt',
      'nextAction',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-automatic-retry-schedule' ||
    !isDigest(value.scheduleId) ||
    ![
      'scheduled',
      'dispatch-issued',
      'probe-succeeded',
      'probe-failed-terminal',
    ].includes(String(value.state)) ||
    (value.route !== 'provider-replacement' &&
      value.route !== 'environment-probe') ||
    typeof value.workflowId !== 'string' ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !isDigest(value.contextDigest) ||
    typeof value.executionJobId !== 'string' ||
    typeof value.failedAttemptId !== 'string' ||
    typeof value.failedInvocationId !== 'string' ||
    !Number.isSafeInteger(value.failedInvocationRevision) ||
    (value.failedInvocationRevision as number) < 1 ||
    !isDigest(value.failureDigest) ||
    typeof value.failureCode !== 'string' ||
    !nullableString(value.replacementAttemptId) ||
    !nullableString(value.replacementInvocationId) ||
    ![
      'same-input',
      'execution-policy-change',
      'repair',
      'strategy-change',
      'new-context',
      'none',
      'probe-only',
    ].includes(String(value.retryMode)) ||
    (value.probe !== null && !isReadOnlyProbe(value.probe)) ||
    !Number.isSafeInteger(value.probeAttemptsCompleted) ||
    (value.probeAttemptsCompleted as number) < 0 ||
    !Number.isSafeInteger(value.probeMaxAttempts) ||
    (value.probeMaxAttempts as number) < 0 ||
    (value.probeMaxAttempts as number) > 10 ||
    !Number.isSafeInteger(value.probeBackoffMs) ||
    (value.probeBackoffMs as number) < 0 ||
    (value.probeBackoffMs as number) > PROBE_MAX_BACKOFF_MS ||
    !Number.isSafeInteger(value.retryAfterMs) ||
    (value.retryAfterMs as number) < 0 ||
    (value.retryAfterMs as number) > 86_400_000 ||
    !isTimestamp(value.notBefore) ||
    !isTimestamp(value.createdAt) ||
    !nullableTimestamp(value.dispatchedAt) ||
    !nullableTimestamp(value.completedAt) ||
    ![
      'wait-until-due',
      'dispatch-replacement',
      'none',
      'inspect-environment-before-new-provider-attempt',
    ].includes(String(value.nextAction)) ||
    !isTimestamp(value.updatedAt) ||
    (value.route === 'provider-replacement' &&
      (value.replacementAttemptId === null ||
        value.replacementInvocationId === null ||
        value.retryMode === 'probe-only' ||
        value.probe !== null ||
        value.probeAttemptsCompleted !== 0 ||
        value.probeMaxAttempts !== 0 ||
        value.probeBackoffMs !== 0 ||
        (value.state !== 'scheduled' && value.state !== 'dispatch-issued'))) ||
    (value.route === 'environment-probe' &&
      (value.replacementAttemptId !== null ||
        value.replacementInvocationId !== null ||
        value.retryMode !== 'probe-only' ||
        value.probe === null ||
        value.probeMaxAttempts !== PROBE_MAX_ATTEMPTS ||
        (value.probeBackoffMs as number) < PROBE_MIN_BACKOFF_MS ||
        (value.probeAttemptsCompleted as number) >
          (value.probeMaxAttempts as number) ||
        value.state === 'dispatch-issued')) ||
    (value.state === 'scheduled' &&
      (value.dispatchedAt !== null ||
        value.completedAt !== null ||
        (value.nextAction !== 'wait-until-due' &&
          value.nextAction !== 'dispatch-replacement') ||
        (value.route === 'environment-probe' &&
          value.nextAction !== 'wait-until-due') ||
        (value.route === 'environment-probe' &&
          value.probeAttemptsCompleted === value.probeMaxAttempts))) ||
    (value.state === 'dispatch-issued' &&
      (value.dispatchedAt === null ||
        value.completedAt === null ||
        value.nextAction !== 'none')) ||
    (value.state === 'probe-succeeded' &&
      (value.route !== 'environment-probe' ||
        value.dispatchedAt !== null ||
        value.completedAt === null ||
        (value.probeAttemptsCompleted as number) < 1 ||
        value.nextAction !== 'none')) ||
    (value.state === 'probe-failed-terminal' &&
      (value.route !== 'environment-probe' ||
        value.dispatchedAt !== null ||
        value.completedAt === null ||
        value.probeAttemptsCompleted !== value.probeMaxAttempts ||
        value.nextAction !==
          'inspect-environment-before-new-provider-attempt')) ||
    Date.parse(value.updatedAt as string) <
      Date.parse(value.createdAt as string) ||
    (value.completedAt !== null &&
      Date.parse(value.completedAt as string) <
        Date.parse(value.createdAt as string))
  ) {
    throw providerRetryScheduleUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderAutomaticRetrySchedule,
  );
}

export function exactTimestamp(value: string): string {
  if (!isTimestamp(value)) throw providerRetryScheduleUnsafe();
  return value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function nullableErrorCode(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value))
  );
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isReadOnlyProbe(value: unknown): value is ReadOnlyProbeRequest {
  try {
    assertReadOnlyProbe(value);
    return true;
  } catch {
    return false;
  }
}

export function digestCanonical(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort())
  );
}

export function providerRetryScheduleUnsafe(cause?: unknown): WorkflowError {
  return workflowError(
    'PROVIDER_RETRY_SCHEDULE_UNSAFE',
    'The durable provider retry schedule is malformed, stale, or ambiguous.',
    ExitCode.staleState,
    cause === undefined ? {} : { details: { cause: String(cause) } },
  );
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
