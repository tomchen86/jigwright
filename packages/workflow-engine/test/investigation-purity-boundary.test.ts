import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function closure(entry: string, inject = '') {
  return assertPureDependencyClosure(path.join(sourceRoot, entry), inject);
}

test('investigation scanner, materialized view, Manifest validator and builder have a pure complete dependency closure', () => {
  for (const entry of [
    'modules/investigation/domain/investigation-scanner.ts',
    'modules/investigation/domain/investigation-floor.ts',
    'modules/investigation/domain/investigation-full-blob.ts',
    'modules/investigation/manifest/investigation-materializer.ts',
    'modules/investigation/manifest/investigation-manifest.ts',
    'modules/investigation/manifest/investigation-manifest-builder.ts',
  ])
    assert.ok(closure(entry).size > 1);
});

test('investigation purity guard includes type edges, computed dependencies and CommonJS aliases', () => {
  const entry = 'modules/investigation/domain/investigation-scanner.ts';
  assert.throws(
    () =>
      closure(
        entry,
        "\nimport type {X} from '../../../runtime/repository-transaction/git.ts';",
      ),
    /Outward pure dependency/,
  );
  assert.throws(
    () => closure(entry, '\nimport(suppliedModuleName);'),
    /Unresolved computed dependency/,
  );
  assert.throws(
    () => closure(entry, "\nconst load = require; load('node:perf_hooks');"),
    /Effect import/,
  );
});
