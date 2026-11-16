/**
 * Defines exact collaboration store values, canonical records, and stable error codes.
 *
 * Invariants:
 * - Serialization retains its existing JSON byte order and trailing newline.
 * - Digest, timestamp, and error validation retain their original acceptance rules.
 */
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

export const STATE_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || raw !== `${JSON.stringify(value)}\n`) {
      throw new Error('not canonical');
    }
    return value;
  } catch {
    throw unsafeStore();
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((entry, index) => entry === sorted[index])
  );
}

export function exactDigest(value: string, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw workflowError(
      'COLLABORATION_GRANT_USE_INVALID',
      `Collaboration grant ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

export function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw invalidUse();
  }
  return date;
}

export function isExactTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function nonEmpty(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 500
  ) {
    throw workflowError(
      'COLLABORATION_GRANT_USE_INVALID',
      `Collaboration grant ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function invalidUse() {
  return workflowError(
    'COLLABORATION_GRANT_USE_INVALID',
    'Collaboration grant use requires exact role assignment and structured content.',
    ExitCode.guard,
  );
}

export function bindingMismatch() {
  return workflowError(
    'COLLABORATION_GRANT_BINDING_MISMATCH',
    'Collaboration reservation facts do not match the exact repository baseline.',
    ExitCode.guard,
  );
}

export function unavailableGrant(grantId: string) {
  return workflowError(
    'COLLABORATION_GRANT_UNAVAILABLE',
    `Collaboration grant ${grantId} is unavailable for this transition.`,
    ExitCode.conflict,
  );
}

export function grantNotFound(grantId: string) {
  return workflowError(
    'COLLABORATION_GRANT_NOT_FOUND',
    `Collaboration grant ${grantId} does not exist in local state.`,
    ExitCode.guard,
  );
}

export function ambiguousGrant(grantId: string) {
  return workflowError(
    'COLLABORATION_GRANT_STATE_AMBIGUOUS',
    `Collaboration grant ${grantId} has ambiguous or malformed local state.`,
    ExitCode.staleState,
  );
}

export function unsafeStore() {
  return workflowError(
    'COLLABORATION_GRANT_STORE_UNSAFE',
    'Collaboration grant storage is malformed or unsafe.',
    ExitCode.staleState,
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
