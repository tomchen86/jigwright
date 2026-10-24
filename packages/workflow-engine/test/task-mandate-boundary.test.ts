import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const owner = (name: string) =>
  fileURLToPath(
    new URL(`../src/modules/authority/${name}.ts`, import.meta.url),
  );

test('mandate record and provider rules do not depend on the operation coordinator', () => {
  for (const name of ['task-mandate-records', 'task-mandate-policy']) {
    const closure = assertPureDependencyClosure(owner(name));
    assert.ok(
      !closure.has(owner('task-mandate')),
      `${name} imports the coordinator`,
    );
    assert.ok(
      !closure.has(owner('task-mandate-services')),
      `${name} imports effect services`,
    );
  }
});

test('all mandate domain owners reject outward value and type dependencies', () => {
  for (const name of [
    'task-mandate-values',
    'task-mandate-contract',
    'task-mandate-access-contract',
    'task-mandate-services',
    'task-mandate-records',
    'task-mandate-policy',
    'task-mandate',
    'task-mandate-audit',
  ]) {
    const entry = owner(name);
    assertPureDependencyClosure(entry);
    for (const source of [
      "import type { ContentRecord } from '../../runtime/storage-journal/content-record-store.ts';",
      "import { readContentRecord } from '../../runtime/storage-journal/content-record-store.ts';",
    ])
      assert.throws(
        () => assertPureDependencyClosure(entry, source),
        /Outward pure dependency/,
      );
  }
});
