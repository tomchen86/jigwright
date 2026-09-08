/**
 * Supplies shared value checks, digests, and provider-state errors for investigation storage.
 *
 * Invariants:
 * - Accepted scalar shapes and exact-key checks retain their existing contracts.
 * - Digest bytes, recursive freezing, and provider-state error identity stay stable.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

export function isTaskMandateBinding(
  value: unknown,
  changeId: string,
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) &&
    value.schemaVersion === 1 &&
    value.changeId === changeId &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    typeof value.mandateTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    isDigest(value.mandateDigest)
  );
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function providerInvocationUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
    'Referenced provider state is missing, unsafe, or non-canonical.',
    ExitCode.unsafeEnvironment,
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
