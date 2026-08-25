import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('markdown parsing has neutral ownership and a fixture-adapter consumer', () => {
  const coreManifest = readJson('packages/core/package.json') as {
    exports?: Record<string, string>;
  };
  const fixtureManifest = readJson('packages/fixture-adapter/package.json') as {
    exports?: Record<string, string>;
  };
  const facade = readSource(
    'packages/workflow-engine/src/runtime/managed-documents/contracts/markdown-sections.ts',
  );
  const projection = readSource(
    'packages/workflow-engine/src/modules/projection/investigation-design-projection.ts',
  );
  const fixtureConsumer = readSource(
    'packages/fixture-adapter/src/fixture-markdown-outline.ts',
  );

  assert.equal(
    coreManifest.exports?.['./markdown-sections'],
    './src/markdown-sections.ts',
  );
  assert.equal(
    fixtureManifest.exports?.['./markdown-outline'],
    './src/fixture-markdown-outline.ts',
  );
  assert.match(facade, /from '@jigwright\/core\/markdown-sections'/u);
  assert.doesNotMatch(facade, /function markdown(?:Headings|Lines)\(/u);
  assert.match(projection, /from '@jigwright\/core\/markdown-sections'/u);
  assert.doesNotMatch(
    projection,
    /runtime\/managed-documents\/contracts\/markdown-sections/u,
  );
  assert.match(fixtureConsumer, /from '@jigwright\/core\/markdown-sections'/u);
});

function readJson(filePath: string): unknown {
  return JSON.parse(readSource(filePath)) as unknown;
}

function readSource(filePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8');
}
