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
      `Work Registry read policy depends outward: ${file}`,
    );
    assert.ok(
      !file.endsWith('/governance-intake/work-registry.ts'),
      `Read policy depends on write hub: ${file}`,
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
          `Work Registry read policy imports effect: ${fileName}`,
        );
      } else if (fileName.startsWith('.'))
        visit(path.resolve(path.dirname(file), fileName));
      else {
        assert.ok(
          fileName.startsWith('@jigwright/core/'),
          `Work Registry read policy imports external implementation: ${fileName}`,
        );
        visit(fileURLToPath(import.meta.resolve(fileName)));
      }
    }
  }
  visit(path.join(sourceRoot, entry));
  return seen;
}

test('Work Registry policy and use cases have an effect-free, type-inclusive dependency closure', () => {
  for (const entry of [
    'modules/governance-intake/work-registry-queries.ts',
    'modules/governance-intake/work-registry-projections.ts',
    'application/work-registry/work-registry-queries.ts',
    'application/work-registry/work-registry-projections.ts',
    'modules/governance-intake/work-registry-policy.ts',
    'modules/governance-intake/work-registry-promotion-policy.ts',
    'application/work-registry/work-registry-grant-policy.ts',
    'application/work-registry/work-registry.ts',
    'application/work-registry/work-registry-promotion-preparation.ts',
    'application/work-registry/work-registry-grant.ts',
  ]) {
    assert.ok(readClosure(entry).size > 1);
  }
  assert.throws(
    () =>
      readClosure(
        'application/work-registry/work-registry-projections.ts',
        (file, source) =>
          file.endsWith('/modules/projection/projection-service.ts')
            ? `${source}\nimport fs from 'node:fs';`
            : source,
      ),
    /imports effect/,
  );
  assert.throws(
    () =>
      readClosure(
        'modules/governance-intake/work-registry-queries.ts',
        (file, source) =>
          file.endsWith('/modules/governance-intake/work-registry-queries.ts')
            ? `${source}\nimport type { WorkRegistryReadTestHooks } from './work-registry.ts';`
            : source,
      ),
    /write hub/,
  );
});
