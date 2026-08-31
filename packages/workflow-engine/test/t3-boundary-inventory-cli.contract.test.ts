import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { sourceRepositoryRoot } from './fixture.ts';

const cliPath = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/src/cli.ts',
);

test('jigwright exposes the machine-checked T3 boundary inventory through production CLI', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cliPath,
      'boundary',
      'inventory',
      '--check',
      '--json',
    ],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = JSON.parse(run.stdout) as {
    command: string;
    ok: boolean;
    result: {
      kind: string;
      status: string;
      recordIdentity: { schema: string; consumerNamespace: string };
      couplingCount: number;
      observations: {
        namespace: { source: { occurrences: number; fileCount: number } };
        workflowJsonReferences: {
          source: { occurrences: number; fileCount: number };
        };
      };
    };
  };
  assert.equal(output.command, 'boundary');
  assert.equal(output.ok, true);
  assert.equal(output.result.kind, 'jigwright.boundary-inventory-check.v1');
  assert.deepEqual(output.result.recordIdentity, {
    schema: 'workflow.t3-boundary-inventory.v1',
    consumerNamespace: 'jigwright',
  });
  assert.equal(output.result.status, 'current');
  assert.equal(output.result.couplingCount, 16);
  assert.equal(output.result.observations.namespace.source.occurrences, 0);
  assert.ok(
    output.result.observations.workflowJsonReferences.source.fileCount > 0,
  );
});

test('boundary inventory command rejects mutation-shaped arguments', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cliPath,
      'boundary',
      'inventory',
      '--write',
      '--json',
    ],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );

  assert.notEqual(run.status, 0);
  const output = JSON.parse(run.stderr) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(output.ok, false);
  assert.equal(output.error.code, 'INVALID_USAGE');
});

test('jigwright verifies the public language-neutral conformance corpus', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cliPath,
      'boundary',
      'vectors',
      '--check',
      '--json',
    ],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = JSON.parse(run.stdout) as {
    result: {
      kind: string;
      status: string;
      domainCount: number;
      vectorSetDigest: string;
    };
  };
  assert.deepEqual(output.result, {
    kind: 'jigwright.conformance-vectors-check.v1',
    status: 'current',
    domainCount: 9,
    vectorSetDigest:
      'sha256:8cfc3ceb27018db1ae2c66622e5ad98c0ee87fbcbab8dabcddd9938847f0c9f0',
  });
});
