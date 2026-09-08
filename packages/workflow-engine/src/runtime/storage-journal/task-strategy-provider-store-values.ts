/**
 * Defines canonical task implementation value checks, digests, and store errors.
 *
 * Invariants:
 * - Digest acceptance, key equality, and immutable cloning retain their original behavior.
 * - Error codes and canonical digest bytes remain stable across readers and writers.
 *
 * Depends on: canonical JSON values and workflow errors.
 * Failure modes: changed durable identities or inconsistent corruption and stale-authority errors.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import crypto from 'node:crypto';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TASK_ID = /^\d+(?:\.\d+)+$/;

export function withoutDigest<
  T extends Record<string, unknown>,
  K extends keyof T,
>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw stateCorrupt();
  return value;
}

export function isGrantId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function implementationResultStale() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
    'The provider result no longer matches its exact sealed RED subject, assignment, observation, or patch bytes.',
    ExitCode.staleState,
  );
}

export function stateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT',
    'Task strategy implementation reservation is malformed or unsafe.',
    ExitCode.staleState,
  );
}
