import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const entry = path.resolve(
  import.meta.dirname,
  '../src/modules/source/reviewed-mutation-policy.ts',
);

test('reviewed mutation policy has a pure transitive source and type closure', () => {
  const closure = assertPureDependencyClosure(entry);
  assert.ok(
    closure.has(
      path.resolve(
        import.meta.dirname,
        '../../core/src/tracked-object-reader-port.ts',
      ),
    ),
  );
  assert.ok(
    closure.has(
      path.resolve(
        import.meta.dirname,
        '../src/modules/source/mutation-class-policy.ts',
      ),
    ),
  );
});

test('reviewed mutation policy rejects injected runtime types and filesystem effects', () => {
  for (const source of [
    "\nimport type { TrackedTreeSnapshot } from '../../runtime/repository-transaction/tracked-tree-reader.ts';\n",
    "\nimport fs from 'node:fs';\n",
  ]) {
    assert.throws(
      () => assertPureDependencyClosure(entry, source),
      /Outward pure dependency|Effect import/,
    );
  }
});
