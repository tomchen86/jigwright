/**
 * Shares canonical value validation and error preservation across execution governance.
 *
 * Invariants:
 * - Digest prefixes, size bounds, canonical ordering, and error identities retain exact bytes.
 * - Validators reject malformed values without coercing their persisted representation.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';

export const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;

export const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;

export const MAX_DOCUMENT_BYTES = 1_048_576;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function cloneJson<T extends JsonValue>(
  value: T,
  invalid: (message: string) => WorkflowError = invalidRepairContext,
): T {
  assertJsonValue(value, invalid);
  return JSON.parse(canonicalJson(value)) as T;
}

export function assertJsonValue(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): asserts value is JsonValue {
  try {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 262_144) {
      throw invalid('JSON value exceeds its size bound.');
    }
  } catch (error) {
    if (isWorkflowError(error) && error.code !== 'CANONICAL_JSON_INVALID') {
      throw error;
    }
    throw invalid('Value is not finite JSON data.');
  }
}

export function sortedUniqueIdentities(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
  assertAlreadySorted = false,
): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw invalid(`${label} list is invalid.`);
  }
  const identities = value.map((item) => {
    assertIdentity(item, invalid, label);
    return item;
  });
  const sorted = [...identities].sort();
  if (
    new Set(identities).size !== identities.length ||
    (assertAlreadySorted &&
      identities.some((identity, index) => identity !== sorted[index]))
  ) {
    throw invalid(`${label} list must be sorted and unique.`);
  }
  return sorted;
}

export function isSorted<T>(
  value: T[],
  compare: (left: T, right: T) => number,
): boolean {
  return value.every(
    (item, index) => index === 0 || compare(value[index - 1]!, item) < 0,
  );
}

export function parseDocument(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) {
    throw new Error('document size');
  }
  return JSON.parse(raw) as unknown;
}

export function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function exactDate(value: Date, errorCode: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(errorCode, 'Timestamp is invalid.', ExitCode.usage);
  }
  return value.toISOString();
}

export function assertTimestamp(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): string {
  if (typeof value !== 'string') throw invalid(`${label} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalid(`${label} must be an exact ISO timestamp.`);
  }
  return value;
}

export function assertUuid(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw invalid('Identifier must be a lower-case UUID v4.');
  }
  return value;
}

export function assertIdentity(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
}

export function assertDigest(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw invalid(`${label} is not a sha256 digest.`);
  }
}

export function assertPositiveInteger(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is number {
  assertBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, invalid, label);
}

export function assertBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw invalid(`${label} is outside its bound.`);
  }
}

export function assertReason(
  value: unknown,
  invalid: (message: string) => WorkflowError,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 16 ||
    value.length > 1_000 ||
    value.includes('\0')
  ) {
    throw invalid(`${label} must be a concrete bounded explanation.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length &&
    observed.every((key, index) => key === expected[index])
  );
}

export function hasKeysEither(
  value: Record<string, unknown>,
  variants: string[][],
): boolean {
  return variants.some((keys) => hasExactKeys(value, keys));
}

export function isWorkflowError(error: unknown): error is WorkflowError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    'exitCode' in error
  );
}

export function normalizeInvalid(
  error: unknown,
  code: string,
  message: string,
): WorkflowError {
  if (isWorkflowError(error) && error.code === code) return error;
  return workflowError(code, message, ExitCode.usage);
}

export function invalidRepairContext(message: string): WorkflowError {
  return workflowError('REPAIR_CONTEXT_INVALID', message, ExitCode.usage);
}
