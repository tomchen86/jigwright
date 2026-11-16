import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  assertPureDependencyClosure,
  assertPureApplicationDependencyClosure,
} from './support/pure-dependency-closure.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
const owners = [
  'application/session-inspection/task-status.ts',
  'modules/lifecycle/open-task-status.ts',
];

function statusClosure(owner: string, additionalSource = '') {
  const entry = path.join(sourceRoot, owner);
  return owner === owners[0]
    ? assertPureApplicationDependencyClosure(entry, additionalSource)
    : assertPureDependencyClosure(entry, additionalSource);
}

test('task status query and canonical open-task status have pure value and type closures', () => {
  const closure = statusClosure(owners[0]!);
  for (const dependency of [
    owners[0]!,
    owners[1]!,
    'modules/lifecycle/workflow-session-contract.ts',
    'modules/governance-intake/intake-summary.ts',
    'modules/assurance/task-execution-evidence.ts',
  ])
    assert.ok(closure.has(path.join(sourceRoot, dependency)), dependency);
  assert.equal(statusClosure(owners[1]!).size, 1);
});

for (const owner of owners) {
  test(`${owner} rejects introduced physical, adapter, production and computed dependencies`, () => {
    assert.doesNotThrow(() => statusClosure(owner));
    for (const injected of [
      "import fs from 'node:fs';",
      "import type { Stats } from 'node:fs';",
      "import type { Unknown } from 'external-task-status-implementation';",
      "export { discoverRepository } from '../../runtime/repository-transaction/git.ts';",
      "import type { queryTaskStatus } from '../../composition-root/task-status-production.ts';",
      "import type { diagnoseOpenSpec } from '../../adapters/planning/openspec/documents/openspec-doctor.ts';",
      "import type { OpenTaskJournal } from '../../application/execute-task/open-task.ts';",
      "const delayed = () => import('../../runtime/repository-transaction/git.ts');",
      'const computed = (name: string) => import(name);',
    ]) {
      assert.throws(
        () => statusClosure(owner, `\n${injected}`),
        /Effect import|Implementation dependency|Outward pure dependency|Unresolved computed dependency/,
        injected,
      );
    }
  });
}
