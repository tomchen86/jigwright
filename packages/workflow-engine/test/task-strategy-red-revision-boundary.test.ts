import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const application = 'packages/workflow-engine/src/application/execute-task/';
const entry = `${application}task-strategy-red-revision.ts`;
const operations = `${application}task-strategy-red-revision-operations.ts`;
const helper =
  'packages/workflow-engine/src/modules/assurance/task-strategy-red-revision-contract.ts';

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
        'Operations must not depend back on RED revision factory',
      );
    for (const edge of read.edges) visit(edge.to);
  }
  visit(entry);
  return visited;
}

test('actual RED revision factory has a complete value and type closure without concrete operators', () => {
  const files = closure();
  for (const required of [
    operations,
    helper,
    'packages/workflow-engine/src/modules/assurance/task-strategy-evidence.ts',
    'packages/workflow-engine/src/modules/assurance/task-strategy-current-ref.ts',
    'packages/workflow-engine/src/modules/assurance/task-strategy-transaction.ts',
    'packages/workflow-engine/src/modules/assurance/task-strategy-red-revision-values.ts',
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
    "\ntype Hidden = { factory: typeof import('../../composition-root/task-strategy-patch-production.ts').validateTaskStrategyPatch };",
  ],
  [
    'dynamic production fallback',
    helper,
    "\nvoid import('../../composition-root/task-strategy-production.ts');",
  ],
  ['filesystem effect', operations, "\nimport fs from 'node:fs';"],
  ['child process effect', helper, "\nimport cp from 'node:child_process';"],
  [
    'mixed current-ref re-export',
    helper,
    "\nexport { parseTaskStrategyCurrentRef } from '../../runtime/storage-journal/task-strategy-current-ref.ts';",
  ],
  [
    'mixed transaction re-export',
    helper,
    "\nexport { parseTaskStrategyTransaction } from '../../runtime/storage-journal/task-strategy-transactions.ts';",
  ],
  [
    'operations back edge',
    operations,
    "\nimport type { TaskStrategyRedRevisionResult } from './task-strategy-red-revision.ts';",
  ],
] as const) {
  test(`RED revision closure rejects ${name}`, () => {
    assert.throws(
      () => closure({ file, source }),
      /Concrete dependency|Effect import|Dependency rule|Operations must not depend back/,
    );
  });
}
