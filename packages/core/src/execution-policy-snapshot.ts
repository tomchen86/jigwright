/**
 * Validates bounded execution policy snapshots for provider processes.
 *
 * Invariants:
 * - Accepted snapshots are cloned and deeply frozen after exact-key and
 *   resource-bound validation.
 */
import { CanonicalJsonError, canonicalJson } from './canonical-json.ts';

export const EXECUTION_POLICY_SNAPSHOT_CONTRACT_VERSION_V1 =
  'jigwright.execution-policy-snapshot.v1' as const;

type ExecutionPolicyPrimitiveV1 = string | number | boolean | null;

export type ExecutionPolicySnapshotV1 = {
  schemaVersion: 1;
  provider: string;
  timeoutMs: number;
  maxOutputBytes: number;
  workerClass: string;
  backoffMs: number;
  processEnvironment: Readonly<Record<string, string>>;
  concurrency: number;
  transientToolConfig: Readonly<Record<string, ExecutionPolicyPrimitiveV1>>;
};

export type ExecutionPolicySnapshotCodecErrorCode =
  | 'EXECUTION_POLICY_SNAPSHOT_INVALID'
  | 'EXECUTION_POLICY_SNAPSHOT_CANONICAL_JSON_INVALID';

export class ExecutionPolicySnapshotCodecError extends TypeError {
  readonly code: ExecutionPolicySnapshotCodecErrorCode;

  constructor(code: ExecutionPolicySnapshotCodecErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionPolicySnapshotCodecError';
    this.code = code;
  }
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const MAX_STRING_BYTES = 16_384;

/**
 * Admit and snapshot the exact current process-only execution policy value.
 * Aggregate Job/Attempt transitions and presentation-specific error mapping
 * remain owned by their callers.
 */
export function assertExecutionPolicySnapshotV1(
  value: unknown,
): ExecutionPolicySnapshotV1 {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'backoffMs',
      'concurrency',
      'maxOutputBytes',
      'processEnvironment',
      'provider',
      'schemaVersion',
      'timeoutMs',
      'transientToolConfig',
      'workerClass',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw invalid('Execution policy snapshot is invalid.');
  }
  assertIdentifier(value.provider, 'provider');
  assertIdentifier(value.workerClass, 'workerClass');
  assertBoundedPositiveInteger(value.timeoutMs, 'timeoutMs', 3_600_000);
  assertBoundedPositiveInteger(
    value.maxOutputBytes,
    'maxOutputBytes',
    268_435_456,
  );
  assertBoundedNonnegativeInteger(value.backoffMs, 'backoffMs', 86_400_000);
  assertBoundedPositiveInteger(value.concurrency, 'concurrency', 1_024);
  assertStringRecord(value.processEnvironment, 'processEnvironment');
  assertPrimitiveRecord(value.transientToolConfig, 'transientToolConfig');
  return deepFreeze(structuredClone(value) as ExecutionPolicySnapshotV1);
}

function assertStringRecord(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw invalid(`${label} is invalid.`);
  assertSortedObjectKeys(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof entry !== 'string') {
      throw invalid(`${label} is invalid.`);
    }
    assertBoundedString(entry, `${label}.${key}`);
  }
}

function assertPrimitiveRecord(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw invalid(`${label} is invalid.`);
  assertSortedObjectKeys(value, label);
  for (const [key, entry] of Object.entries(value)) {
    assertIdentifier(key, `${label} key`);
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw invalid(`${label} is invalid.`);
    }
    try {
      canonicalJson(entry);
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        throw new ExecutionPolicySnapshotCodecError(
          'EXECUTION_POLICY_SNAPSHOT_CANONICAL_JSON_INVALID',
          error.message,
        );
      }
      throw error;
    }
  }
}

function assertSortedObjectKeys(
  value: Record<string, unknown>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
    throw invalid(`${label} keys are not canonically sorted.`);
  }
}

function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER.test(value) ||
    value !== value.normalize('NFC')
  ) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function assertBoundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(`${label} must be a positive integer.`);
  }
  if ((value as number) > maximum) {
    throw invalid(`${label} exceeds its bound.`);
  }
  return value as number;
}

function assertBoundedNonnegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(`${label} must be a nonnegative integer.`);
  }
  if ((value as number) > maximum) {
    throw invalid(`${label} exceeds its bound.`);
  }
  return value as number;
}

function assertBoundedString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ||
    value !== value.normalize('NFC')
  ) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function invalid(message: string): ExecutionPolicySnapshotCodecError {
  return new ExecutionPolicySnapshotCodecError(
    'EXECUTION_POLICY_SNAPSHOT_INVALID',
    message,
  );
}
