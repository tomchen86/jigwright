import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const prefix = 'packages/workflow-engine/src/application/execute-task/';
const entry = `${prefix}task-strategy-implementation-lifecycle.ts`;
const helpers = [
  'task-strategy-implementation-context.ts',
  'task-strategy-caller-admission.ts',
  'task-strategy-provider-reservations.ts',
  'task-strategy-provider-results.ts',
  'task-strategy-implementation-operations.ts',
];

function closure(injection?: { file: string; source: string }) {
  const reader = readRepositoryDependencies(root);
  const visited = new Set<string>();
  function visit(relative: string) {
    if (visited.has(relative)) return;
    visited.add(relative);
    assert.doesNotMatch(
      relative,
      /^packages\/workflow-engine\/src\/(runtime|composition-root|adapters|entrypoints)\//,
      `Concrete dependency: ${relative}`,
    );
    const read = reader.read(
      path.join(root, relative),
      injection?.file === relative ? injection.source : '',
    );
    assert.equal(read.effects.length, 0, `Effect import: ${relative}`);
    assert.deepEqual(read.problems, [], `Dependency rule: ${relative}`);
    for (const edge of read.edges) visit(edge.to);
  }
  visit(entry);
  return visited;
}

test('complete implementation lifecycle and every helper have no concrete value or type dependency', () => {
  const visited = closure();
  for (const helper of helpers) assert.ok(visited.has(prefix + helper), helper);
  assert.ok(
    visited.has(
      'packages/workflow-engine/src/modules/assurance/task-strategy-implementation-attempt.ts',
    ),
  );
  assert.ok(
    visited.has(
      'packages/workflow-engine/src/modules/assurance/task-strategy-correction-round-record.ts',
    ),
  );
  assert.ok(
    visited.has(
      'packages/workflow-engine/src/modules/assurance/task-strategy-patch-contract.ts',
    ),
  );
  assert.ok(
    visited.has(
      'packages/workflow-engine/src/modules/assurance/provider-invocation-manifest.ts',
    ),
  );
});

for (const [label, file, source] of [
  [
    'helper value import',
    helpers[0],
    "\nimport { loadActiveSessionContext } from '../../runtime/repository-observation/workflow-session-context.ts';",
  ],
  [
    'helper type import',
    helpers[3],
    "\ntype Hidden = import('../../runtime/provider-policy/ai-adapter-policy.ts').LoadedAiAdapterPolicy;",
  ],
  [
    'nested contract field',
    helpers[4],
    "\ntype Hidden = { metadata: { loader: typeof import('../../runtime/repository-observation/workflow-session-context.ts').loadActiveSessionContext } };",
  ],
  [
    'composition fallback',
    helpers[2],
    "\nvoid import('../../composition-root/task-strategy-production.ts');",
  ],
  ['filesystem effect', helpers[1], "\nimport fs from 'node:fs';"],
] as const) {
  test(`complete closure rejects ${label} inside a transitive helper`, () => {
    assert.throws(
      () => closure({ file: prefix + file, source }),
      /Concrete dependency|Effect import|Dependency rule/,
    );
  });
}
