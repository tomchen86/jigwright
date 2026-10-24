import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
const sourceRoot = path.resolve(import.meta.dirname, '../src');
const closure = (entry: string, inject = '') =>
  assertPureDependencyClosure(path.join(sourceRoot, entry), inject);

test('planning assurance rules, review evidence and role replay have a pure complete dependency closure', () => {
  for (const entry of [
    'modules/assurance/planning-assurance-validator.ts',
    'modules/assurance/planning-assurance-evidence.ts',
    'modules/assurance/planning-assurance-port.ts',
    'modules/assurance/plan-review.ts',
  ])
    assert.ok(closure(entry).size > 1);
});

test('planning assurance purity guard includes type edges, computed dependencies and CommonJS aliases', () => {
  const entry = 'modules/assurance/planning-assurance-validator.ts';
  assert.throws(
    () =>
      closure(
        entry,
        "\nimport type {X} from '../../runtime/repository-transaction/git.ts';",
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
