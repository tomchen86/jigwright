import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readImportDependencies,
  sourceDigest,
} from '../src/modules/source/import-dependencies.ts';
import type { SystemDescriptionSnapshot } from '../src/modules/source/spec-ownership.ts';
import {
  createLedgerEntry,
  semanticFileSubjectId,
} from '../src/modules/why-knowledge/semantic-ledger.ts';
import {
  assessSemanticFreshness,
  observeLedgerSource,
} from '../src/modules/why-knowledge/semantic-freshness.ts';
import { planSemanticReuse } from '../src/modules/why-knowledge/semantic-reuse.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const CHANGED = `sha256:${'b'.repeat(64)}`;

function snapshot(files: Record<string, string>): SystemDescriptionSnapshot {
  return {
    listPaths: () => Object.keys(files),
    readText: (file) => files[file],
  };
}

function entry(file: string, dependencies: string[] = []) {
  return createLedgerEntry({
    schemaVersion: 2,
    kind: 'semantic-ledger-entry',
    subject: {
      subjectId: semanticFileSubjectId(file),
      kind: 'file',
      path: file,
    },
    binding: {
      baselineCommit: 'a'.repeat(40),
      blobDigest: DIGEST,
      sourceDigest: DIGEST,
      semanticDigest: DIGEST,
      extractorVersion: 'exact-source.v1',
    },
    semanticDependencies: dependencies.map((dependency) => ({
      relation: 'imports',
      subjectId: semanticFileSubjectId(dependency),
      path: dependency,
      sourceDigest: DIGEST,
    })),
    policyDigest: DIGEST,
    provenance: { changeId: 'binding-index', createdAtCommit: 'a'.repeat(40) },
    supersedes: null,
    status: 'current',
  });
}

test('semantic ledger is a binding index without a second copy of header prose', () => {
  const value = entry('src/a.ts');
  assert.equal(Object.hasOwn(value, 'why'), false);
  assert.equal(value.subject.path, 'src/a.ts');
});

test('literal imports resolve against the supplied snapshot including workspace exports', () => {
  const files = snapshot({
    'src/a.ts': [
      "import type { B } from './b.js';",
      "export { B } from './b.js';",
      "const module = import('@demo/core/value');",
      "const c = require('./c');",
      "// import './comment.ts';",
      "const text = `import './template.ts';`;",
      "const pattern = /import('fake')/;",
      "const x = a / b; import './b.js'; const y = c / d;",
      "import('./c', { with: { type: 'json' } });",
    ].join('\n'),
    'src/b.ts': 'export type B = string;',
    'src/c/index.js': 'module.exports = 1;',
    'packages/core/package.json': JSON.stringify({
      name: '@demo/core',
      exports: { './value': './src/value.ts' },
    }),
    'packages/core/src/value.ts': 'export const value = 1;',
  });
  assert.deepEqual(
    readImportDependencies(files, 'src/a.ts').map(({ path }) => path),
    ['packages/core/src/value.ts', 'src/b.ts', 'src/c/index.js'],
  );
});

test('missing dependencies stay stale and changes propagate through reverse import edges', () => {
  const provider = entry('src/provider.ts');
  const consumer = entry('src/consumer.ts', ['src/provider.ts']);
  const caller = entry('src/caller.ts', ['src/consumer.ts']);
  const observe = (value: ReturnType<typeof entry>) => ({
    present: true,
    sourceDigest: DIGEST,
    semanticDigest: DIGEST,
    currentPolicyDigest: DIGEST,
    currentDependencySourceDigests: Object.fromEntries(
      value.semanticDependencies.map((dependency) => [
        dependency.subjectId,
        DIGEST,
      ]),
    ),
  });
  assert.equal(
    assessSemanticFreshness(consumer, {
      ...observe(consumer),
      currentDependencySourceDigests: {},
    }).state,
    'dependency-changed',
  );
  const entries = new Map(
    [provider, consumer, caller].map((value) => [
      value.subject.subjectId,
      value,
    ]),
  );
  const observations = new Map(
    [provider, consumer, caller].map((value) => [
      value.subject.subjectId,
      observe(value),
    ]),
  );
  observations.set(provider.subject.subjectId, {
    ...observe(provider),
    sourceDigest: CHANGED,
    semanticDigest: CHANGED,
  });
  const resolutions = planSemanticReuse(
    [...entries.keys()],
    entries,
    observations,
  ).resolutions;
  assert.equal(
    resolutions.find(
      ({ subjectId }) => subjectId === provider.subject.subjectId,
    )?.state,
    'subject-changed',
  );
  for (const value of [consumer, caller]) {
    assert.equal(
      resolutions.find(({ subjectId }) => subjectId === value.subject.subjectId)
        ?.state,
      'dependency-changed',
    );
  }
});

test('import options, division, and export condition order retain the actual dependency', () => {
  for (const source of [
    "import('./dep.ts', { with: { type: 'json' } });",
    "const v = a / b; import './dep.ts'; const w = c / d;",
  ]) {
    assert.deepEqual(
      readImportDependencies(
        snapshot({
          'src/a.ts': source,
          'src/dep.ts': 'export const value = 1;',
        }),
        'src/a.ts',
      ).map(({ path }) => path),
      ['src/dep.ts'],
    );
  }
  const files = {
    'src/a.ts': "import '@demo/core';",
    'packages/core/package.json': JSON.stringify({
      name: '@demo/core',
      exports: { node: './node.ts', import: './import.ts' },
    }),
    'packages/core/node.ts': 'export const value = 1;',
    'packages/core/import.ts': 'export const value = 2;',
  };
  const before = snapshot(files);
  const dependencies = readImportDependencies(before, 'src/a.ts');
  assert.deepEqual(
    dependencies.map(({ path }) => path),
    ['packages/core/node.ts'],
  );
  const {
    entryId: _id,
    dependencySetDigest: _dependencies,
    ...input
  } = entry('src/a.ts');
  const digest = sourceDigest(files['src/a.ts']);
  const bound = createLedgerEntry({
    ...input,
    binding: {
      ...input.binding,
      blobDigest: digest,
      sourceDigest: digest,
      semanticDigest: digest,
    },
    semanticDependencies: dependencies,
  });
  const after = snapshot({
    ...files,
    'packages/core/package.json': JSON.stringify({
      name: '@demo/core',
      exports: './import.ts',
    }),
  });
  assert.equal(
    assessSemanticFreshness(bound, observeLedgerSource(bound, after)).state,
    'dependency-changed',
  );
});
