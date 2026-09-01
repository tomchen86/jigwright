import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  READ_ONLY_PROBE_CONTRACT_VERSION,
  READ_ONLY_PROBE_KINDS_V1,
  ReadOnlyProbeCodecError,
  assertReadOnlyProbeRequestV1,
} from '../src/read-only-probe.ts';

test('core publishes the exact current read-only probe vocabulary', () => {
  assert.equal(
    READ_ONLY_PROBE_CONTRACT_VERSION,
    'jigwright.read-only-probe.v1',
  );
  assert.deepEqual(READ_ONLY_PROBE_KINDS_V1, [
    'repository-head',
    'repository-dirty-state',
    'runtime-version',
    'adapter-version',
    'binary-exists',
    'file-read',
    'validator-error',
    'execution-limits',
    'lease-state',
    'attempt-lineage',
    'dependency-availability',
  ]);

  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./read-only-probe'],
    './src/read-only-probe.ts',
  );
});

test('read-only probe codec preserves target shape and deep-freezes admission', () => {
  const targetless = assertReadOnlyProbeRequestV1({
    kind: 'repository-head',
    timeoutMs: 1,
  });
  assert.deepEqual(targetless, {
    kind: 'repository-head',
    timeoutMs: 1,
  });
  assert.equal(Object.isFrozen(targetless), true);

  for (const candidate of [
    { kind: 'binary-exists', target: 'rg', timeoutMs: 30_000 },
    { kind: 'file-read', target: 'src/index.ts', timeoutMs: 1_000 },
    { kind: 'validator-error', target: 'SCHEMA_INVALID', timeoutMs: 1_000 },
    {
      kind: 'dependency-availability',
      target: '@jigwright/core/read-only-probe',
      timeoutMs: 1_000,
    },
  ]) {
    const admitted = assertReadOnlyProbeRequestV1(candidate);
    assert.deepEqual(admitted, candidate);
    assert.equal(Object.isFrozen(admitted), true);
  }
});

test('read-only probe codec fails closed on shape, bounds, and unsafe targets', () => {
  for (const candidate of [
    null,
    {},
    { kind: 'repository-head', timeoutMs: 1_000, unknown: true },
    { kind: 'repository-head', target: 'unexpected', timeoutMs: 1_000 },
    { kind: 'binary-exists', timeoutMs: 1_000 },
    { kind: 'run-command', target: 'rm', timeoutMs: 1_000 },
    { kind: 'repository-head', timeoutMs: 0 },
    { kind: 'repository-head', timeoutMs: 30_001 },
    { kind: 'repository-head', timeoutMs: 1.5 },
    { kind: 'file-read', target: '../secret', timeoutMs: 1_000 },
    { kind: 'file-read', target: '/absolute', timeoutMs: 1_000 },
    { kind: 'file-read', target: 'src//index.ts', timeoutMs: 1_000 },
    { kind: 'file-read', target: 'src\\index.ts', timeoutMs: 1_000 },
    { kind: 'file-read', target: 'e\u0301/file.ts', timeoutMs: 1_000 },
    { kind: 'binary-exists', target: 'rg --version', timeoutMs: 1_000 },
    { kind: 'validator-error', target: 'invalid-code', timeoutMs: 1_000 },
    {
      kind: 'dependency-availability',
      target: 'file:///etc/passwd',
      timeoutMs: 1_000,
    },
  ]) {
    assert.throws(
      () => assertReadOnlyProbeRequestV1(candidate),
      (error) =>
        error instanceof ReadOnlyProbeCodecError &&
        error.code === 'READ_ONLY_PROBE_INVALID',
      JSON.stringify(candidate),
    );
  }
});

test('read-only probe codec remains a pure consumer-neutral admission boundary', () => {
  const source = fs.readFileSync(
    new URL('../src/read-only-probe.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /workflowError|ExitCode|provider|class .*Store|writeFile|renameSync|compare-and-swap/i,
  );
});
