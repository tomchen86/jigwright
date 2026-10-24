/** Reuse decisions retain fresh ledger observations without loading repository storage. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { createLedgerEntry } from '../src/modules/why-knowledge/semantic-ledger.ts';
import { applyLedgerToFullBlobManifest } from '../src/modules/why-knowledge/semantic-manifest-reuse.ts';
import type { SemanticLedgerReader } from '../src/modules/why-knowledge/semantic-ledger-reader.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const content =
  '/** Owns an example.\n * Invariants:\n * - Example remains valid.\n */\nexport const value = 1;';
const digest = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
const policy = `sha256:${'1'.repeat(64)}`;
const entry = createLedgerEntry({
  schemaVersion: 2,
  kind: 'semantic-ledger-entry',
  subject: { subjectId: 'file.example', kind: 'file', path: 'src/example.ts' },
  binding: {
    baselineCommit: 'a'.repeat(40),
    blobDigest: digest,
    sourceDigest: digest,
    semanticDigest: digest,
    extractorVersion: 'file-fallback-v1',
  },
  semanticDependencies: [],
  policyDigest: policy,
  provenance: { changeId: 'example', createdAtCommit: 'b'.repeat(40) },
  supersedes: null,
  status: 'current',
});
const manifest = [
  {
    manifestEntryId: 'example',
    path: {
      rawBase64: Buffer.from('src/example.ts').toString('base64'),
      utf8: 'src/example.ts',
    },
    blob: { contentSha256: digest.slice(7) },
  },
];
const snapshot = {
  listPaths: () => ['src/example.ts'],
  readText: (file: string) => (file === 'src/example.ts' ? content : undefined),
};

test('semantic manifest rules have a complete pure value and type closure', () => {
  assert.ok(
    assertPureDependencyClosure(
      path.resolve(
        import.meta.dirname,
        '../src/modules/why-knowledge/semantic-manifest-reuse.ts',
      ),
    ).size > 1,
  );
});

test('an empty ledger never observes entries or the lazy snapshot', () => {
  const reader: SemanticLedgerReader = {
    readLedgerIndex(root) {
      assert.equal(root, '/consumer');
      return { schemaVersion: 1, kind: 'semantic-ledger-index', subjects: {} };
    },
    readLedgerEntry() {
      assert.fail('Empty index must not read entries');
    },
  };
  const reuse = applyLedgerToFullBlobManifest(reader, '/consumer', manifest, {
    get snapshot() {
      return assert.fail('Empty index must not read snapshot');
    },
  });
  assert.deepEqual(reuse.owed, manifest);
  assert.deepEqual(reuse.carried, []);
  assert.equal(reuse.plan, null);
});

test('reuse reads the index and each entry anew before its snapshot, treating missing entries as owed', () => {
  const events: string[] = [];
  let missing = false;
  const reader: SemanticLedgerReader = {
    readLedgerIndex(root) {
      events.push(`index:${root}`);
      return {
        schemaVersion: 1,
        kind: 'semantic-ledger-index',
        subjects: {
          'file.missing': { currentEntryId: 'missing' },
          [entry.subject.subjectId]: { currentEntryId: entry.entryId },
        },
      };
    },
    readLedgerEntry(root, id) {
      events.push(`entry:${root}:${id}`);
      if (id === 'missing' || missing)
        throw new Error('Ledger object unavailable');
      return entry;
    },
  };
  const options = {
    currentPolicyDigest: policy,
    get snapshot() {
      events.push('snapshot');
      return snapshot;
    },
  };
  const reused = applyLedgerToFullBlobManifest(
    reader,
    '/consumer',
    manifest,
    options,
  );
  assert.equal(reused.carried.length, 1);
  assert.deepEqual(events.slice(0, 4), [
    'index:/consumer',
    'entry:/consumer:missing',
    `entry:/consumer:${entry.entryId}`,
    'snapshot',
  ]);
  events.length = 0;
  missing = true;
  const reread = applyLedgerToFullBlobManifest(
    reader,
    '/consumer',
    manifest,
    options,
  );
  assert.deepEqual(reread.owed, manifest);
  assert.deepEqual(reread.carried, []);
  assert.deepEqual(events, [
    'index:/consumer',
    'entry:/consumer:missing',
    `entry:/consumer:${entry.entryId}`,
    'snapshot',
  ]);
});

test('an index failure propagates unchanged before reading entries or snapshot', () => {
  const failure = new Error('Unsafe ledger index');
  const reader: SemanticLedgerReader = {
    readLedgerIndex() {
      throw failure;
    },
    readLedgerEntry() {
      assert.fail('Index refusal must stop entry reads');
    },
  };
  assert.throws(
    () =>
      applyLedgerToFullBlobManifest(reader, '/consumer', manifest, {
        get snapshot() {
          return assert.fail('Index refusal must stop snapshot reads');
        },
      }),
    (error) => error === failure,
  );
});
