/** Shared human-resolution scalar validation and stable refusal errors. */
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import { isRecord } from './investigation-store-values.ts';

export function assertHumanResolutionGrantId(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw humanResolutionGrantUnsafe();
  }
  return value;
}

export function exactResolutionTimestamp(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw humanResolutionInvalid('Human resolution timestamp is invalid.');
  }
  return new Date(time).toISOString();
}

export function isBoundedResolutionText(
  value: unknown,
  maxBytes: number,
): boolean {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

export function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

export function isSortedUniqueStrings(values: string[]): boolean {
  const sorted = [...new Set(values)].sort();
  return (
    values.length === sorted.length &&
    values.every((value, index) => value === sorted[index])
  );
}

export function humanResolutionInvalid(message: string) {
  return workflowError('HUMAN_RESOLUTION_INVALID', message, ExitCode.guard);
}

export function humanResolutionObjectUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_NODE_UNSAFE',
    'Human resolution overlay storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionGrantUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_UNSAFE',
    'Human resolution grant storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionGrantNotFound(grantId: string) {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_NOT_FOUND',
    `Human resolution grant ${grantId} does not exist.`,
    ExitCode.conflict,
  );
}
