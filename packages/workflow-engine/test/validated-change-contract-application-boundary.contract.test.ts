import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const APPLICATION_ROOT = path.resolve(
  import.meta.dirname,
  '../src/application',
);
const MANAGED_CHANGE_CONTRACT =
  'adapters/planning/openspec/documents/managed-change-contract.ts';

test('application code derives the validated contract at its composition boundary', () => {
  const directImports: string[] = [];
  visit(APPLICATION_ROOT);

  assert.deepEqual(directImports, []);

  function visit(directory: string): void {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const source = fs.readFileSync(entryPath, 'utf8');
      const importsManagedChangeContract = [
        ...source.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g),
      ].some((match) => match[1]?.endsWith(MANAGED_CHANGE_CONTRACT));
      if (importsManagedChangeContract) {
        directImports.push(path.relative(APPLICATION_ROOT, entryPath));
      }
    }
  }
});
