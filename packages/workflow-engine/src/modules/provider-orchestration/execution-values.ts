/** Shared execution record value checks and canonical digest helpers. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { TaskMandateBinding } from '../authority/task-mandate.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  JOB_STATUSES_V2,
  ATTEMPT_STATUSES_V2,
} from '@jigwright/core/job-attempt-runtime';
import type {
  JsonValue,
  ChangedField,
  JobStatus,
  AttemptStatus,
  RetryMode,
  AttemptRetention,
  FailureSource,
} from './execution-record-types.ts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const UNPREFIXED_DIGEST = /^[0-9a-f]{64}$/;

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;

const MAX_RECORD_BYTES = 1_048_576;

const MAX_STRING_BYTES = 16_384;

export function parseCanonicalRecord<T>(
  raw: string,
  assertRecord: (value: unknown) => T,
): T {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES ||
    !raw.endsWith('\n') ||
    raw.endsWith('\n\n')
  ) {
    throw executionError(
      'EXECUTION_RECORD_NONCANONICAL',
      'Execution record bytes are not canonical.',
      ExitCode.guard,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw executionError(
      'EXECUTION_RECORD_INVALID',
      'Execution record JSON is invalid.',
      ExitCode.guard,
    );
  }
  const record = assertRecord(parsed);
  if (`${canonicalJson(record)}\n` !== raw) {
    throw executionError(
      'EXECUTION_RECORD_NONCANONICAL',
      'Execution record bytes are not canonical.',
      ExitCode.guard,
    );
  }
  return record;
}

export function diffJson(
  before: JsonValue,
  after: JsonValue,
  basePath = '',
  ignored = new Set<string>(),
): ChangedField[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].sort();
    const changes: ChangedField[] = [];
    for (const key of keys) {
      const path = `${basePath}/${escapeJsonPointer(key)}`;
      if (ignored.has(path)) continue;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
        changes.push({
          path,
          from: Object.hasOwn(before, key) ? before[key]! : null,
          to: Object.hasOwn(after, key) ? after[key]! : null,
        });
      } else {
        changes.push(...diffJson(before[key]!, after[key]!, path, ignored));
      }
    }
    return changes;
  }
  return [{ path: basePath || '/', from: before, to: after }];
}

export function normalizeUniqueStrings(
  value: string[],
  label: string,
  requireCanonical = false,
): string[] {
  if (!Array.isArray(value)) throw executionInvalid(`${label} is invalid.`);
  for (const entry of value) assertBoundedString(entry, label);
  const normalized = [...new Set(value)].sort();
  if (requireCanonical && canonicalJson(normalized) !== canonicalJson(value)) {
    throw executionInvalid(`${label} is not sorted and unique.`);
  }
  return deepFreeze(normalized);
}

export function normalizeFailurePaths(value: string[]): string[] {
  if (!Array.isArray(value))
    throw executionInvalid('Failure paths are invalid.');
  const normalized = value.map((entry) => {
    if (entry.startsWith('/')) return assertJsonPointer(entry, 'failure path');
    if (!isSafeFailureRepositoryRelativePath(entry)) {
      throw executionInvalid('Failure path is unsafe.');
    }
    return entry;
  });
  return deepFreeze([...new Set(normalized)].sort());
}

function isSafeFailureRepositoryRelativePath(value: string): boolean {
  return (
    value === value.normalize('NFC') &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

export function assertJsonPointer(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !value.startsWith('/') ||
    /~(?![01])/.test(value) ||
    Buffer.byteLength(value, 'utf8') > 2_048
  ) {
    throw executionInvalid(`${label} is not a canonical JSON pointer.`);
  }
  return value;
}

export function normalizeDigest(value: string): string {
  if (DIGEST.test(value)) return value;
  if (UNPREFIXED_DIGEST.test(value)) return `sha256:${value}`;
  throw executionInvalid('Digest is invalid.');
}

export function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw executionInvalid('Digest is invalid.');
  }
  return value;
}

export function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER.test(value) ||
    value !== value.normalize('NFC')
  ) {
    throw executionInvalid(`${label} is invalid.`);
  }
  return value;
}

export function assertExecutionJobMandateBinding(
  value: unknown,
): TaskMandateBinding {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
    typeof value.mandateId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) ||
    typeof value.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot
  ) {
    throw executionInvalid('Execution Job Task Mandate binding is invalid.');
  }
  return deepFreeze(structuredClone(value) as TaskMandateBinding);
}

export function assertErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) {
    throw executionInvalid('Failure code is invalid.');
  }
  return value;
}

export function assertTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw executionInvalid('Timestamp is invalid.');
  }
  return value;
}

export function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw executionInvalid(`${label} must be a positive integer.`);
  }
  return value as number;
}

export function assertNonnegativeInteger(
  value: unknown,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw executionInvalid(`${label} must be a nonnegative integer.`);
  }
  return value as number;
}

export function assertBoundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const result = assertPositiveInteger(value, label);
  if (result > maximum) throw executionInvalid(`${label} exceeds its bound.`);
  return result;
}

function assertBoundedNonnegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const result = assertNonnegativeInteger(value, label);
  if (result > maximum) throw executionInvalid(`${label} exceeds its bound.`);
  return result;
}

export function assertBoundedString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ||
    value !== value.normalize('NFC')
  ) {
    throw executionInvalid(`${label} is invalid.`);
  }
  return value;
}

export function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

export function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return isPlainObject(value);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return canonicalJson(actual) === canonicalJson(expected);
}

export function hasKeysEither(
  value: Record<string, unknown>,
  variants: string[][],
): boolean {
  return variants.some((keys) => hasExactKeys(value, keys));
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

export function executionInvalid(message: string) {
  return executionError('EXECUTION_RECORD_INVALID', message, ExitCode.guard);
}

export function probeNotAllowed() {
  return executionError(
    'EXECUTION_PROBE_NOT_ALLOWED',
    'The requested environment probe is not on the read-only allowlist.',
    ExitCode.guard,
  );
}

export function executionError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

export const JOB_STATUSES = new Set<JobStatus>(JOB_STATUSES_V2);

export const ATTEMPT_STATUSES = new Set<AttemptStatus>(ATTEMPT_STATUSES_V2);

export const RETRY_MODES = new Set<RetryMode>([
  'same-input',
  'execution-policy-change',
  'repair',
  'strategy-change',
  'new-context',
  'none',
]);

export const ATTEMPT_RETENTION = new Set<AttemptRetention>([
  'active',
  'debug',
  'pinned',
]);

export const FAILURE_SOURCES = new Set<FailureSource>([
  'provider',
  'network',
  'worker',
  'lease',
  'tool',
  'validator',
  'environment',
  'state',
  'effect',
  'policy',
]);
