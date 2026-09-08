/**
 * Supplies execution state identifiers, digests, accounting totals, and stable errors.
 *
 * Invariants:
 * - Digest normalization and attempt accounting preserve existing accepted values and bounds.
 * - Workflow errors and deterministic identifiers remain compatible with durable records.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import { type AttemptRecord } from '../../modules/provider-orchestration/execution-core.ts';

export const EXECUTION_JOB_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/;

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

const UNPREFIXED_DIGEST = /^[0-9a-f]{64}$/;

export const MAX_PROVIDER_ATTEMPTS = 1_000;

export const EXECUTION_STATE_FILE = /^[0-9a-f]{64}\.json$/;

export function digestCanonical(value: unknown): string {
  return `sha256:${sha256Text(canonicalJson(value))}`;
}

export function deterministicUuid(value: unknown): string {
  const hex = sha256Text(canonicalJson(value));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function attemptNumber(
  attempts: AttemptRecord[],
  attemptId: string,
): number {
  const attempt = attempts.find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (attempt === undefined) throw executionStoreUnsafe();
  return attempt.attemptNumber;
}

export function sumAttemptAccounting(
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

export function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function assertExecutionJobId(value: string): string {
  if (typeof value !== 'string' || !EXECUTION_JOB_ID.test(value)) {
    throw workflowError(
      'EXECUTION_STORE_JOB_ID_INVALID',
      'The durable execution Job identifier is invalid.',
      ExitCode.usage,
    );
  }
  return value;
}

export function normalizeDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  if (UNPREFIXED_DIGEST.test(value)) return `sha256:${value}`;
  throw executionProjectionConflict('Provider result digest is invalid.');
}

export function normalizeRecoveryDigest(value: string): string {
  if (typeof value === 'string' && DIGEST.test(value)) return value;
  if (typeof value === 'string' && UNPREFIXED_DIGEST.test(value)) {
    return `sha256:${value}`;
  }
  throw executionResultRecoveryConflict();
}

export function isPromiseLike(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function executionSnapshotCallbackInvalid(): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_SNAPSHOT_CALLBACK_INVALID',
    'Execution Job snapshots require one short synchronous callback.',
    ExitCode.usage,
  );
}

export function executionProjectionConflict(
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

export function executionResultRecoveryConflict(): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_RESULT_RECOVERY_CONFLICT',
    'The completion candidate does not exactly bind the current durable Attempt.',
    ExitCode.staleState,
  );
}

export function executionStoreUnsafe(cause?: unknown): WorkflowError {
  return workflowError(
    'EXECUTION_STORE_UNSAFE',
    'The private durable execution store is malformed or unsafe.',
    ExitCode.unsafeEnvironment,
    cause === undefined ? {} : { details: { cause: errorMessage(cause) } },
  );
}

export function executionAdmissionAuthorityUnsafe(): WorkflowError {
  return workflowError(
    'EXECUTION_ADMISSION_AUTHORITY_UNSAFE',
    'The immutable provider execution admission authority is missing, malformed, or divergent.',
    ExitCode.unsafeEnvironment,
  );
}

export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
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
