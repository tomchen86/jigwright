import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

test('architecture inventory counts match the current production observation', () => {
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
    result: {
      inventoryDigest: string;
      observations: {
        namespace: { jsonSchemaIds: { hosts: Record<string, number> } };
        workflowJsonReferences: {
          source: { occurrences: number; fileCount: number };
          bootstrap: { occurrences: number; fileCount: number };
          scripts: { occurrences: number; fileCount: number };
          recovery: { occurrences: number; fileCount: number };
          recoverySplit: { occurrences: number; fileCount: number };
          sourceSplit: { occurrences: number; fileCount: number };
          sourceDynamic: { occurrences: number; fileCount: number };
        };
        workflowArtifactPaths: { occurrences: number; fileCount: number };
      };
    };
  };
  const observations = output.result.observations;
  const document = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'docs/architecture/WORKFLOW_ENGINE_BOUNDARY_INVENTORY.md',
    ),
    'utf8',
  );
  const normalizedDocument = document.replace(/\s+/gu, ' ');
  const tableRows = new Set(
    document
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .map((cell) => cell.trim())
          .join('|'),
      ),
  );
  const expectedRows = [
    [
      'Primary workflow JSON literals',
      observations.workflowJsonReferences.source,
    ],
    [
      'Primary split path joins/resolves',
      observations.workflowJsonReferences.sourceSplit,
    ],
    [
      'Primary dynamic workflow-root enumerations',
      observations.workflowJsonReferences.sourceDynamic,
    ],
    [
      'Bootstrap workflow JSON literals',
      observations.workflowJsonReferences.bootstrap,
    ],
    [
      'Root tooling workflow JSON literals',
      observations.workflowJsonReferences.scripts,
    ],
    [
      'Recovery workflow JSON literals',
      observations.workflowJsonReferences.recovery,
    ],
    [
      'Recovery split path joins',
      observations.workflowJsonReferences.recoverySplit,
    ],
    [
      'Workflow artifact package-path leaves',
      observations.workflowArtifactPaths,
    ],
  ] as const;

  assert.ok(
    document.includes(
      'Current production inventory digest: `' +
        output.result.inventoryDigest +
        '`.',
    ),
    'Architecture inventory is missing the current inventory digest.',
  );
  for (const [label, values] of expectedRows) {
    assert.ok(
      tableRows.has(`|${label}|${values.occurrences}|${values.fileCount}|`),
      `Architecture inventory is missing the current ${label} observation.`,
    );
  }
  assert.ok(
    normalizedDocument.includes(
      `The same observation reports **${observations.namespace.jsonSchemaIds.hosts['jigwright.local']}** tracked JSON Schema \`$id\` values using \`jigwright.local\`.`,
    ),
    'Architecture inventory is missing the current neutral JSON Schema count.',
  );
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
