import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  EXECUTION_RETRY_POLICY_CONTRACT_VERSION_V1,
  ExecutionRetryPolicyCodecError,
  assertExecutionRetryPolicyV1,
  type ExecutionRetryPolicyV1,
} from '../src/execution-retry-policy.ts';

const POLICY: ExecutionRetryPolicyV1 = {
  maxAttempts: 4,
  maxCumulativeRuntimeMs: 2_400_000,
  maxProviderCostMicros: 1_000_000,
  maxProviderTokens: 200_000,
  maxSameFailureFingerprint: 2,
  maxRepairAttempts: 2,
  deadline: '2026-08-04T00:00:00.000Z',
  providerLimits: { claude: 2, codex: 2 },
};

test('core publishes and snapshots the exact current execution retry policy', () => {
  assert.equal(
    EXECUTION_RETRY_POLICY_CONTRACT_VERSION_V1,
    'jigwright.execution-retry-policy.v1',
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./execution-retry-policy'],
    './src/execution-retry-policy.ts',
  );

  const input = structuredClone(POLICY) as ExecutionRetryPolicyV1 & {
    providerLimits: Record<string, number>;
  };
  const snapshot = assertExecutionRetryPolicyV1(input);
  input.providerLimits.claude = 99;
  assert.deepEqual(snapshot, POLICY);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.providerLimits), true);
});

test('execution retry policy codec preserves exact bounds, timestamp, and provider map failures', () => {
  const candidates: ReadonlyArray<readonly [unknown, string]> = [
    [
      Object.assign(Object.create({ inherited: true }), POLICY),
      'Retry policy is invalid.',
    ],
    [{ ...POLICY, unknown: true }, 'Retry policy is invalid.'],
    [{ ...POLICY, maxAttempts: 0 }, 'maxAttempts must be a positive integer.'],
    [{ ...POLICY, maxAttempts: 1_001 }, 'maxAttempts exceeds its bound.'],
    [
      { ...POLICY, maxCumulativeRuntimeMs: 0 },
      'maxCumulativeRuntimeMs must be a positive integer.',
    ],
    [
      { ...POLICY, maxCumulativeRuntimeMs: 31_536_000_001 },
      'maxCumulativeRuntimeMs exceeds its bound.',
    ],
    [
      { ...POLICY, maxProviderCostMicros: -1 },
      'maxProviderCostMicros must be a nonnegative integer.',
    ],
    [
      { ...POLICY, maxProviderTokens: Number.NaN },
      'maxProviderTokens must be a nonnegative integer.',
    ],
    [
      { ...POLICY, maxSameFailureFingerprint: 0 },
      'maxSameFailureFingerprint must be a positive integer.',
    ],
    [
      { ...POLICY, maxSameFailureFingerprint: 101 },
      'maxSameFailureFingerprint exceeds its bound.',
    ],
    [
      { ...POLICY, maxRepairAttempts: -1 },
      'maxRepairAttempts must be a nonnegative integer.',
    ],
    [
      { ...POLICY, maxRepairAttempts: 101 },
      'maxRepairAttempts exceeds its bound.',
    ],
    [{ ...POLICY, deadline: '2026-08-04' }, 'Timestamp is invalid.'],
    [{ ...POLICY, providerLimits: [] }, 'providerLimits is invalid.'],
    [
      { ...POLICY, providerLimits: { 'Invalid Provider': 1 } },
      'providerLimits key is invalid.',
    ],
    [
      { ...POLICY, providerLimits: { claude: 0 } },
      'provider limit must be a positive integer.',
    ],
    [
      { ...POLICY, providerLimits: { claude: 1_001 } },
      'provider limit exceeds its bound.',
    ],
    [
      { ...POLICY, providerLimits: { codex: 2, claude: 2 } },
      'providerLimits keys are not canonically sorted.',
    ],
  ];
  for (const [candidate, message] of candidates) {
    assert.throws(
      () => assertExecutionRetryPolicyV1(candidate),
      (error) =>
        error instanceof ExecutionRetryPolicyCodecError &&
        error.code === 'EXECUTION_RETRY_POLICY_INVALID' &&
        error.message === message,
      message,
    );
  }
});

test('execution retry policy codec remains a pure value boundary', () => {
  const source = fs.readFileSync(
    new URL('../src/execution-retry-policy.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /JobRecord|AttemptRecord|execution-store|workflowError|ExitCode|Grant|writeFile|renameSync|compare-and-swap/i,
  );
});
