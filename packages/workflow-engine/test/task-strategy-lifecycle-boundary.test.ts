import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const application = 'packages/workflow-engine/src/application/execute-task/';
const entry = `${application}task-strategy-lifecycle.ts`;
const operations = `${application}task-strategy-lifecycle-operations.ts`;
const helper = `${application}task-strategy-implementation-context.ts`;

function closure(injection?: { file: string; source: string }) {
  const reader = readRepositoryDependencies(root);
  const visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.doesNotMatch(
      file,
      /^packages\/workflow-engine\/src\/(runtime|composition-root|adapters|entrypoints)\//,
      `Concrete dependency: ${file}`,
    );
    const read = reader.read(
      path.join(root, file),
      injection?.file === file ? injection.source : '',
    );
    assert.equal(read.effects.length, 0, `Effect import: ${file}`);
    assert.deepEqual(read.problems, [], `Dependency rule: ${file}`);
    if (file === operations)
      assert.equal(
        read.edges.some((edge) => edge.to === entry),
        false,
        'Operations must not depend back on outer lifecycle',
      );
    for (const edge of read.edges) visit(edge.to);
  }
  visit(entry);
  return visited;
}

test('actual inspect/resume factory has a complete value and type closure without concrete operators', () => {
  const files = closure();
  for (const required of [
    operations,
    helper,
    'packages/workflow-engine/src/modules/assurance/task-strategy-evidence.ts',
    'packages/workflow-engine/src/modules/assurance/task-strategy-correction-round-record.ts',
    'packages/workflow-engine/src/modules/lifecycle/managed-workflow-state-contract.ts',
  ])
    assert.ok(files.has(required), required);
});

for (const [name, file, source] of [
  [
    'helper value import',
    helper,
    "\nimport { getSession } from '../../runtime/repository-observation/workflow-session-context.ts';",
  ],
  [
    'operations nested import type',
    operations,
    "\ntype Hidden = { request: import('../../runtime/storage-journal/task-strategy-red-revision-store.ts').TaskStrategyRedRevisionRequest };",
  ],
  [
    'operations nested typeof',
    operations,
    "\ntype Hidden = { factory: typeof import('./task-mechanical-transform-lifecycle.ts').inspectTaskMechanicalTransformLifecycle };",
  ],
  [
    'dynamic production fallback',
    helper,
    "\nvoid import('../../composition-root/task-strategy-production.ts');",
  ],
  ['filesystem effect', operations, "\nimport fs from 'node:fs';"],
] as const) {
  test(`inspect/resume closure rejects ${name}`, () => {
    assert.throws(
      () => closure({ file, source }),
      /Concrete dependency|Effect import|Dependency rule/,
    );
  });
}
