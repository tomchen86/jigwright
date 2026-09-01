import { canonicalJson } from './canonical-json.ts';

export const EXECUTION_RETRY_POLICY_CONTRACT_VERSION_V1 =
  'jigwright.execution-retry-policy.v1' as const;

export type ExecutionRetryPolicyV1 = {
  maxAttempts: number;
  maxCumulativeRuntimeMs: number;
  maxProviderCostMicros: number;
  maxProviderTokens: number;
  maxSameFailureFingerprint: number;
  maxRepairAttempts: number;
  deadline: string;
  providerLimits: Readonly<Record<string, number>>;
};

export class ExecutionRetryPolicyCodecError extends TypeError {
  readonly code = 'EXECUTION_RETRY_POLICY_INVALID';

  constructor(message = 'Retry policy is invalid.') {
    super(message);
    this.name = 'ExecutionRetryPolicyCodecError';
  }
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;

/** Admit and snapshot the exact bounded retry constraints for execution. */
export function assertExecutionRetryPolicyV1(
  value: unknown,
): ExecutionRetryPolicyV1 {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'deadline',
      'maxAttempts',
      'maxCumulativeRuntimeMs',
      'maxProviderCostMicros',
      'maxProviderTokens',
      'maxRepairAttempts',
      'maxSameFailureFingerprint',
      'providerLimits',
    ])
  ) {
    throw new ExecutionRetryPolicyCodecError();
  }
  assertBoundedPositiveInteger(value.maxAttempts, 'maxAttempts', 1_000);
  assertBoundedPositiveInteger(
    value.maxCumulativeRuntimeMs,
    'maxCumulativeRuntimeMs',
    31_536_000_000,
  );
  assertBoundedNonnegativeInteger(
    value.maxProviderCostMicros,
    'maxProviderCostMicros',
    Number.MAX_SAFE_INTEGER,
  );
  assertBoundedNonnegativeInteger(
    value.maxProviderTokens,
    'maxProviderTokens',
    Number.MAX_SAFE_INTEGER,
  );
  assertBoundedPositiveInteger(
    value.maxSameFailureFingerprint,
    'maxSameFailureFingerprint',
    100,
  );
  assertBoundedNonnegativeInteger(
    value.maxRepairAttempts,
    'maxRepairAttempts',
    100,
  );
  assertTimestamp(value.deadline);
  if (!isPlainObject(value.providerLimits)) {
    throw new ExecutionRetryPolicyCodecError('providerLimits is invalid.');
  }
  for (const [provider, limit] of Object.entries(value.providerLimits)) {
    assertIdentifier(provider, 'providerLimits key');
    assertBoundedPositiveInteger(limit, 'provider limit', 1_000);
  }
  assertSortedObjectKeys(value.providerLimits, 'providerLimits');
  return deepFreeze(structuredClone(value) as ExecutionRetryPolicyV1);
}

function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER.test(value) ||
    value !== value.normalize('NFC')
  ) {
    throw new ExecutionRetryPolicyCodecError(`${label} is invalid.`);
  }
  return value;
}

function assertBoundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExecutionRetryPolicyCodecError(
      `${label} must be a positive integer.`,
    );
  }
  if ((value as number) > maximum) {
    throw new ExecutionRetryPolicyCodecError(`${label} exceeds its bound.`);
  }
  return value as number;
}

function assertBoundedNonnegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ExecutionRetryPolicyCodecError(
      `${label} must be a nonnegative integer.`,
    );
  }
  if ((value as number) > maximum) {
    throw new ExecutionRetryPolicyCodecError(`${label} exceeds its bound.`);
  }
  return value as number;
}

function assertTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ExecutionRetryPolicyCodecError('Timestamp is invalid.');
  }
  return value;
}

function assertSortedObjectKeys(
  value: Record<string, unknown>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
    throw new ExecutionRetryPolicyCodecError(
      `${label} keys are not canonically sorted.`,
    );
  }
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
