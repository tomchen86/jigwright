/**
 * Defines exact correction-round value checks, canonical comparison, and stable errors.
 *
 * Invariants:
 * - Digest, timestamp, and round acceptance rules retain their original bounds.
 * - Canonical comparison omits only the caller-specified audit fields.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { DEFAULT_TASK_STRATEGY_CORRECTION_POLICY } from './task-strategy-correction-store.ts';
import crypto from 'node:crypto';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

const DIGEST = /^[0-9a-f]{64}$/u;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const INVESTIGATION_ID = /^investigation-[a-zA-Z0-9-]+$/u;

export const INVOCATION_ID = /^invocation-[a-zA-Z0-9-]+$/u;

export const ROUND_DIRECTORY = /^([0-9]{4})$/u;

export function sameExceptAudit(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  omittedKeys: readonly string[],
): boolean {
  const omit = new Set(omittedKeys);
  return (
    canonicalJson(
      Object.fromEntries(
        Object.entries(left).filter(([key]) => !omit.has(key)),
      ),
    ) ===
    canonicalJson(
      Object.fromEntries(
        Object.entries(right).filter(([key]) => !omit.has(key)),
      ),
    )
  );
}

export function assertRound(value: number): number {
  if (
    !isPositiveInteger(value) ||
    value > DEFAULT_TASK_STRATEGY_CORRECTION_POLICY.maxRepairAttempts
  ) {
    throw correctionRoundStateInvalid();
  }
  return value;
}

export function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw correctionRoundStateInvalid();
  return value;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function correctionRoundStateInvalid() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_STATE_INVALID',
    'Task-strategy correction-round state is invalid, stale, or unsafe.',
    ExitCode.staleState,
  );
}

export function correctionRoundSequenceInvalid() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_SEQUENCE_INVALID',
    'Task-strategy correction rounds must be contiguous and each prior round must have an exact import receipt.',
    ExitCode.guard,
  );
}

export function correctionRoundExhausted() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_EXHAUSTED',
    'The bounded task-strategy correction policy is exhausted.',
    ExitCode.guard,
  );
}

export function correctionRoundReservationConflict() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_RESERVATION_CONFLICT',
    'A different immutable reservation already exists for this correction round.',
    ExitCode.conflict,
  );
}

export function correctionRoundResultConflict() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_RESULT_CONFLICT',
    'A different immutable provider result already exists for this correction round.',
    ExitCode.conflict,
  );
}

export function correctionRoundImportConflict() {
  return workflowError(
    'TASK_STRATEGY_CORRECTION_ROUND_IMPORT_CONFLICT',
    'A different immutable import receipt already exists for this correction round.',
    ExitCode.conflict,
  );
}
