import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

for (const name of ['binding-record', 'manifest-codec', 'binding-codec']) {
  const entry = path.resolve(
    import.meta.dirname,
    `../src/modules/assurance/task-diff-review-${name}.ts`,
  );
  test(`review ${name} has a pure transitive value and type closure`, () => {
    assert.ok(assertPureDependencyClosure(entry).size > 1);
  });
  test(`review ${name} rejects injected runtime types and filesystem effects`, () => {
    for (const source of [
      "\nimport type { InvestigationRuntimePaths } from '../../runtime/paths/runtime-paths.ts';\n",
      "\nimport fs from 'node:fs';\n",
    ])
      assert.throws(
        () => assertPureDependencyClosure(entry, source),
        /Outward pure dependency|Effect import/,
      );
  });
}
