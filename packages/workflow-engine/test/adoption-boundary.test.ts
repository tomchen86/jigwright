import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function adoptionClosure(
  entry: string,
  replace: (file: string, source: string) => string = (_file, source) => source,
) {
  const seen = new Set<string>();
  function visit(file: string) {
    assert.ok(
      !/\/(runtime|composition-root|adapters|entrypoints)\//.test(file),
      `Adoption policy depends outward: ${file}`,
    );
    if (seen.has(file)) return;
    seen.add(file);
    const source = replace(file, fs.readFileSync(file, 'utf8'));
    for (const { fileName } of ts.preProcessFile(source, true, true)
      .importedFiles) {
      if (fileName.startsWith('node:')) {
        assert.ok(
          ['node:crypto', 'node:path'].includes(fileName),
          `Adoption policy imports effect: ${fileName}`,
        );
      } else if (fileName.startsWith('.'))
        visit(path.resolve(path.dirname(file), fileName));
      else {
        assert.ok(
          fileName.startsWith('@jigwright/core/'),
          `Adoption policy imports external implementation: ${fileName}`,
        );
        visit(fileURLToPath(import.meta.resolve(fileName)));
      }
    }
  }
  visit(path.join(sourceRoot, entry));
  return seen;
}

test('adoption policy and use cases have an effect-free, type-inclusive dependency closure', () => {
  for (const entry of [
    'modules/adoption/agent-guidance.ts',
    'modules/adoption/setup-questions.ts',
    'application/adoption/agent-guidance.ts',
    'application/adoption/consumer-setup.ts',
  ]) {
    assert.ok(adoptionClosure(entry).size > 1);
  }
  assert.throws(
    () =>
      adoptionClosure('modules/adoption/agent-guidance.ts', (file, source) =>
        file.endsWith('/modules/projection/projection-service.ts')
          ? `${source}\nimport fs from 'node:fs';`
          : source,
      ),
    /imports effect/,
  );
  assert.throws(
    () =>
      adoptionClosure(
        'modules/adoption/setup-questions.ts',
        (_file, source) =>
          `${source}\nimport type { X } from '@jigwright/agent-runtime';`,
      ),
    /external implementation/,
  );
});

test('source and installed init bootstrap resolve the CLI owner rather than domain policy', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../bootstrap/jigwright-init.mjs'),
    'utf8',
  );
  assert.ok(source.includes('../src/entrypoints/cli/consumer-setup-cli.ts'));
  assert.ok(
    source.includes('../dist/runtime/entrypoints/cli/consumer-setup-cli.js'),
  );
  assert.ok(!source.includes('modules/adoption/setup-questions'));
});
