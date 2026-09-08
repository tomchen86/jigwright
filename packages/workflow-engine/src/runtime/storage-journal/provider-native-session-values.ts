/**
 * Provides native session store errors and immutable value operations.
 *
 * Invariants:
 * - Error codes, exit codes, and recursive freezing remain stable.
 */
import crypto from 'node:crypto';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

export function storeInvalid() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_STORE_INVALID',
    'Durable provider-native session state is unsafe, malformed, or stale.',
    ExitCode.staleState,
  );
}

export function storeConflict() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    'A different provider-native session transition already owns this scope.',
    ExitCode.conflict,
  );
}

export function storeOperationConflict() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT',
    'Provider-native session state changed during observation.',
    ExitCode.conflict,
  );
}

export function terminalUnusable() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_TERMINAL_UNUSABLE',
    'The provider-native session chain is terminal and cannot be relaunched.',
    ExitCode.conflict,
  );
}

export function continuationNotAuthorized() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_CONTINUATION_NOT_AUTHORIZED',
    'The provider-native session result is not authorized for continuation.',
    ExitCode.conflict,
  );
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isPromiseLike(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
