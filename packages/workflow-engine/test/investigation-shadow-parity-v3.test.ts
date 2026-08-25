import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { sourceRepositoryRoot } from './fixture.ts';

const RETIRED_MODULES = [
  'packages/workflow-engine/src/adapters/compatibility/investigation-v2/investigation-shadow-builder.ts',
  'packages/workflow-engine/src/adapters/compatibility/investigation-v2/investigation-shadow-parity.ts',
  'packages/workflow-engine/src/runtime/storage-journal/investigation-shadow-store.ts',
] as const;

test('Investigation v2 shadow, parity, and store modules remain retired', () => {
  for (const relativePath of RETIRED_MODULES) {
    assert.equal(
      fs.existsSync(path.join(sourceRepositoryRoot, relativePath)),
      false,
      `${relativePath} must not return to the production tree`,
    );
  }

  const productionSources = listTypeScriptFiles(
    path.join(sourceRepositoryRoot, 'packages/workflow-engine/src'),
  );
  for (const sourcePath of productionSources) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    for (const retiredName of [
      'investigation-shadow-builder',
      'investigation-shadow-parity',
      'investigation-shadow-store',
    ]) {
      assert.equal(
        source.includes(retiredName),
        false,
        `${path.relative(sourceRepositoryRoot, sourcePath)} still references ${retiredName}`,
      );
    }
  }
});

function listTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}
