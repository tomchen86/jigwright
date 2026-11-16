import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

for (const name of ['record', 'authority', 'content']) {
  const entry = path.resolve(
    import.meta.dirname,
    `../src/modules/assurance/task-diff-external-${name}.ts`,
  );
  test(`external ${name} protocol has a pure transitive source and type closure`, () => {
    assertPureDependencyClosure(entry);
  });
  test(`external ${name} protocol rejects injected runtime types and filesystem effects`, () => {
    for (const source of [
      "\nimport type { InvestigationRuntimePaths } from '../../runtime/paths/runtime-paths.ts';\n",
      "\nimport fs from 'node:fs';\n",
    ]) {
      assert.throws(
        () => assertPureDependencyClosure(entry, source),
        /Outward pure dependency|Effect import/,
      );
    }
  });
}
