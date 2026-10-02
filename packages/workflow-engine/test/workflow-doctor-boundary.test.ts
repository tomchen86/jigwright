import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readModuleDependencies } from './support/dependency-graph.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
const owners = [
  'application/assurance/workflow-doctor.ts',
  'modules/planning-provider/openspec-diagnostics.ts',
];

function doctorClosure(owner: string, additionalSource = '') {
  const entry = path.join(sourceRoot, owner);
  if (owner !== owners[0])
    return assertPureDependencyClosure(entry, additionalSource);

  // The shared helper's pure roots are domain/foundation files. Check the
  // application entry with the same resolver, then delegate every dependency.
  const root = path.resolve(sourceRoot, '../../..');
  const result = readRepositoryDependencies(root).read(entry, additionalSource);
  assert.deepEqual(result.problems, [], 'Outward pure dependency');
  assert.deepEqual(result.effects, [], 'Effect import');
  const resolved = new Set(result.edges.map(({ specifier }) => specifier));
  for (const { specifier } of readModuleDependencies(
    entry,
    fs.readFileSync(entry, 'utf8') + additionalSource,
  )) {
    assert.notEqual(specifier, null, 'Unresolved computed dependency');
    assert.ok(
      specifier !== null &&
        (resolved.has(specifier) ||
          ['crypto', 'node:crypto', 'path', 'node:path'].includes(specifier)),
      `Implementation dependency: ${specifier}`,
    );
  }
  const closure = new Set([entry]);
  for (const edge of result.edges) {
    for (const file of assertPureDependencyClosure(path.join(root, edge.to)))
      closure.add(file);
  }
  return closure;
}

test('doctor use case and provider diagnostic contract have pure value and type closures', () => {
  for (const owner of owners) {
    const closure = doctorClosure(owner);
    assert.ok(closure.has(path.join(sourceRoot, owner)));
    if (owner.startsWith('application/')) {
      assert.ok(closure.has(path.join(sourceRoot, owners[1]!)));
      assert.ok(
        closure.has(
          path.join(sourceRoot, 'modules/source/system-documents.ts'),
        ),
      );
    } else assert.equal(closure.size, 1);
  }
});

for (const owner of owners) {
  test(`${owner} rejects introduced physical, adapter, production and computed dependencies`, () => {
    assert.doesNotThrow(() => doctorClosure(owner));
    for (const injected of [
      "import fs from 'node:fs';",
      "import type { Stats } from 'node:fs';",
      "import type { UnresolvedContract } from 'external-doctor-implementation';",
      "export { discoverRepository } from '../../runtime/repository-transaction/git.ts';",
      "import type { diagnoseWorkflowRepository } from '../../composition-root/workflow-doctor-production.ts';",
      "import type { diagnoseOpenSpec } from '../../adapters/planning/openspec/documents/openspec-doctor.ts';",
      "const delayed = () => import('../../runtime/repository-transaction/git.ts');",
      'const computed = (name: string) => import(name);',
    ]) {
      assert.throws(
        () => doctorClosure(owner, `\n${injected}`),
        /Effect import|Implementation dependency|Outward pure dependency|Unresolved computed dependency/,
        injected,
      );
    }
  });
}
