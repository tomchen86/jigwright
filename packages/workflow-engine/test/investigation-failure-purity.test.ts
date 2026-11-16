import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readModuleReferences } from './support/dependency-graph.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function closure(entry: string, inject = '') {
  const seen = new Set<string>();
  const start = path.join(sourceRoot, entry);
  function visit(file: string) {
    assert.doesNotMatch(
      file,
      /\/(runtime|composition-root|adapters|entrypoints|application)\//,
      `Outward investigation dependency: ${file}`,
    );
    if (seen.has(file)) return;
    seen.add(file);
    const source =
      fs.readFileSync(file, 'utf8') + (file === start ? inject : '');
    for (const { specifier } of readModuleReferences(file, source)) {
      assert.notEqual(
        specifier,
        null,
        `Unresolved computed dependency: ${file}`,
      );
      if (specifier === null) throw new Error('Unresolved computed dependency');
      if (specifier.startsWith('node:')) {
        assert.ok(
          ['node:crypto', 'node:path'].includes(specifier),
          `Effect import: ${specifier}`,
        );
      } else if (specifier.startsWith('.')) {
        visit(path.resolve(path.dirname(file), specifier));
      } else {
        assert.ok(
          specifier.startsWith('@jigwright/core/'),
          `Implementation dependency: ${specifier}`,
        );
        visit(fileURLToPath(import.meta.resolve(specifier)));
      }
    }
  }
  visit(start);
  return seen;
}

test('failure source admission, Grant policy and publication contracts have a pure complete dependency closure', () => {
  for (const entry of [
    'modules/investigation/seal/investigation-v3-failure-source.ts',
    'modules/investigation/seal/investigation-v3-failure-record.ts',
    'modules/investigation/seal/investigation-v3-grant.ts',
    'modules/investigation/manifest/investigation-publication-contracts.ts',
    'modules/investigation/manifest/investigation-publication-values.ts',
  ])
    assert.ok(closure(entry).size > 1);
});

test('investigation purity guard includes type edges, computed dependencies and CommonJS aliases', () => {
  const entry = 'modules/investigation/seal/investigation-v3-failure-source.ts';
  assert.throws(
    () =>
      closure(
        entry,
        "\nimport type {X} from '../../../runtime/repository-transaction/git.ts';",
      ),
    /Outward investigation dependency/,
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
