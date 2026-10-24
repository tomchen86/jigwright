import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readModuleReferences } from './support/dependency-graph.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function readClosure(
  entry: string,
  replace: (file: string, source: string) => string = (_file, source) => source,
) {
  const seen = new Set<string>();
  function visit(file: string) {
    assert.ok(
      !/\/(runtime|composition-root|adapters|entrypoints)\//.test(file),
      `Implementation term floor policy depends outward: ${file}`,
    );
    if (seen.has(file)) return;
    seen.add(file);
    const source = replace(file, fs.readFileSync(file, 'utf8'));
    for (const { specifier: fileName } of readModuleReferences(file, source)) {
      assert.notEqual(
        fileName,
        null,
        `Unresolved computed dependency: ${file}`,
      );
      if (fileName === null) throw new Error('Unresolved computed dependency');
      if (fileName.startsWith('node:')) {
        assert.ok(
          ['node:crypto', 'node:path'].includes(fileName),
          `Implementation term floor policy imports effect: ${fileName}`,
        );
      } else if (fileName.startsWith('.'))
        visit(path.resolve(path.dirname(file), fileName));
      else {
        assert.ok(
          fileName.startsWith('@jigwright/core/'),
          `Implementation term floor policy imports external implementation: ${fileName}`,
        );
        visit(fileURLToPath(import.meta.resolve(fileName)));
      }
    }
  }
  visit(path.join(sourceRoot, entry));
  return seen;
}

test('Implementation term floor policy and use cases have an effect-free, type-inclusive dependency closure', () => {
  for (const entry of [
    'modules/assurance/implementation-term-floor.ts',
    'application/reconciliation/implementation-term-floor.ts',
  ]) {
    assert.ok(readClosure(entry).size > 1);
  }
  assert.throws(
    () =>
      readClosure(
        'application/reconciliation/implementation-term-floor.ts',
        (file, source) =>
          file.endsWith('/modules/investigation/domain/investigation-terms.ts')
            ? `${source}\nimport fs from 'node:fs';`
            : source,
      ),
    /imports effect/,
  );
  assert.throws(
    () =>
      readClosure(
        'modules/assurance/implementation-term-floor.ts',
        (file, source) =>
          file.endsWith('/modules/assurance/implementation-term-floor.ts')
            ? `${source}\nimport type { ImplementationTermFloorInput } from '../../composition-root/implementation-term-floor-production.ts';`
            : source,
      ),
    /depends outward/,
  );
});
