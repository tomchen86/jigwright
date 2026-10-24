import { readModuleReferences } from './support/dependency-graph.ts';
import {
  RISK_PATH_OUTCOMES,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/modules/assurance/task-diff-review-schema.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function readClosure(
  entry: string,
  replace: (file: string, source: string) => string = (_file, source) => source,
) {
  const seen = new Set<string>();
  function visit(file: string) {
    assert.ok(
      !/\/(runtime|composition-root|adapters|entrypoints)\//.test(file),
      `Review/strategy DTO policy depends outward: ${file}`,
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
          `Review/strategy DTO policy imports effect: ${fileName}`,
        );
      } else if (fileName.startsWith('.'))
        visit(path.resolve(path.dirname(file), fileName));
      else {
        assert.ok(
          fileName.startsWith('@jigwright/core/'),
          `Review/strategy DTO policy imports external implementation: ${fileName}`,
        );
        visit(fileURLToPath(import.meta.resolve(fileName)));
      }
    }
  }
  visit(path.join(sourceRoot, entry));
  return seen;
}

test('review/strategy DTOs have an effect-free, type-inclusive dependency closure', () => {
  for (const entry of [
    'modules/assurance/provider-review-manifests.ts',
    'modules/investigation/manifest/blind-survey-manifest.ts',
    'modules/assurance/plan-review-subject.ts',
    'modules/assurance/planning-generation-record.ts',
    'modules/assurance/plan-review-target-snapshot-record.ts',
    'modules/assurance/task-diff-review-artifact-record.ts',
    'modules/provider-orchestration/task-strategy-implementation-manifest.ts',
    'modules/investigation/manifest/investigation-requirement-types.ts',
  ]) {
    assert.ok(readClosure(entry).size > 1);
  }
  assert.throws(
    () =>
      readClosure(
        'modules/assurance/provider-review-manifests.ts',
        (file, source) =>
          file.endsWith('/modules/assurance/plan-review-subject.ts')
            ? `${source}\nimport fs from 'node:fs';`
            : source,
      ),
    /imports effect/,
  );
  assert.throws(
    () =>
      readClosure('modules/assurance/plan-review-subject.ts', (file, source) =>
        file.endsWith('/modules/assurance/plan-review-subject.ts')
          ? `${source}\nimport type { TaskStrategyGreenFailureRecord } from '../../runtime/storage-journal/task-strategy-correction-store.ts';`
          : source,
      ),
    /depends outward/,
  );
});

test('shared review schema collections cannot be mutated by a consumer', () => {
  for (const values of [RISK_PATH_OUTCOMES, TASK_DIFF_REVIEW_COVERAGE]) {
    const before = [...values];
    assert.ok(Object.isFrozen(values));
    assert.equal(Reflect.set(values, 0, 'invalid-new-rule'), false);
    assert.deepEqual(values, before);
  }
});

test('review DTO boundary rejects computed and CommonJS dependencies through the shared scanner', () => {
  const entry = 'modules/assurance/plan-review-subject.ts';
  for (const dependency of [
    "const dependency = 'node:fs'; void import(dependency);",
    "const read = require; read('node:fs');",
    "import dependency = require('node:fs');",
  ]) {
    assert.throws(
      () =>
        readClosure(entry, (file, source) =>
          file.endsWith(entry) ? `${source}\n${dependency}` : source,
        ),
      /Unresolved computed dependency|imports effect/,
    );
  }
});
