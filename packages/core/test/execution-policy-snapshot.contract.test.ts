import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  EXECUTION_POLICY_SNAPSHOT_CONTRACT_VERSION_V1,
  ExecutionPolicySnapshotCodecError,
  assertExecutionPolicySnapshotV1,
  type ExecutionPolicySnapshotV1,
} from '../src/execution-policy-snapshot.ts';

const POLICY: ExecutionPolicySnapshotV1 = {
  schemaVersion: 1,
  provider: 'fixture-provider',
  timeoutMs: 300_000,
  maxOutputBytes: 1_048_576,
  workerClass: 'provider-cli',
  backoffMs: 0,
  processEnvironment: {
    HOME: '/private/runtime',
    PATH: '/usr/bin:/bin',
  },
  concurrency: 1,
  transientToolConfig: {
    'policy-digest': 'sha256:fixture',
    retries: 2,
  },
};

test('core publishes and snapshots the exact current execution policy value', () => {
  assert.equal(
    EXECUTION_POLICY_SNAPSHOT_CONTRACT_VERSION_V1,
    'jigwright.execution-policy-snapshot.v1',
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./execution-policy-snapshot'],
    './src/execution-policy-snapshot.ts',
  );

  const input = structuredClone(POLICY) as {
    processEnvironment: Record<string, string>;
    transientToolConfig: Record<string, string | number | boolean | null>;
  } & ExecutionPolicySnapshotV1;
  const snapshot = assertExecutionPolicySnapshotV1(input);
  input.processEnvironment.PATH = '/poisoned';
  input.transientToolConfig.retries = 99;
  assert.deepEqual(snapshot, POLICY);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.processEnvironment), true);
  assert.equal(Object.isFrozen(snapshot.transientToolConfig), true);
});

test('execution policy codec fails closed on exact keys, identifiers, bounds, and canonical maps', () => {
  for (const candidate of [
    { ...POLICY, schemaVersion: 2 },
    { ...POLICY, unknown: true },
    { ...POLICY, provider: 'Fixture Provider' },
    { ...POLICY, workerClass: 'Provider CLI' },
    { ...POLICY, timeoutMs: 0 },
    { ...POLICY, timeoutMs: 3_600_001 },
    { ...POLICY, maxOutputBytes: 0 },
    { ...POLICY, maxOutputBytes: 268_435_457 },
    { ...POLICY, backoffMs: -1 },
    { ...POLICY, backoffMs: 86_400_001 },
    { ...POLICY, concurrency: 0 },
    { ...POLICY, concurrency: 1.5 },
    { ...POLICY, concurrency: 1_025 },
    {
      ...POLICY,
      processEnvironment: { PATH: '/usr/bin', HOME: '/private/runtime' },
    },
    { ...POLICY, processEnvironment: { lowercase: 'value' } },
    { ...POLICY, processEnvironment: { LANG: '' } },
    { ...POLICY, processEnvironment: { LANG: 'e\u0301' } },
    {
      ...POLICY,
      transientToolConfig: { retries: 2, 'policy-digest': 'sha256:fixture' },
    },
    { ...POLICY, transientToolConfig: { BAD_KEY: true } },
    { ...POLICY, transientToolConfig: { nested: {} } },
  ]) {
    assert.throws(
      () => assertExecutionPolicySnapshotV1(candidate),
      (error) =>
        error instanceof ExecutionPolicySnapshotCodecError &&
        error.code === 'EXECUTION_POLICY_SNAPSHOT_INVALID',
      JSON.stringify(candidate),
    );
  }
});

test('execution policy codec distinguishes non-canonical primitive JSON', () => {
  assert.throws(
    () =>
      assertExecutionPolicySnapshotV1({
        ...POLICY,
        transientToolConfig: { retries: Number.NaN },
      }),
    (error) =>
      error instanceof ExecutionPolicySnapshotCodecError &&
      error.code === 'EXECUTION_POLICY_SNAPSHOT_CANONICAL_JSON_INVALID',
  );
});

test('execution policy codec remains a pure value boundary with no aggregate authority', () => {
  const source = fs.readFileSync(
    new URL('../src/execution-policy-snapshot.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /WorkflowRecord|JobRecord|AttemptRecord|execution-store|workflowError|ExitCode|writeFile|renameSync|compare-and-swap/i,
  );
});
