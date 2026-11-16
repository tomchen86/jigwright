import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createFixtureTrackedObjectReaderPort } from '../../fixture-adapter/src/fixture-tracked-object-reader.ts';
import { ExitCode } from '../src/foundation/errors/errors.ts';
import {
  derivePinnedDiffPathFacts,
  type PinnedPathDiffRequest,
  type ReadPinnedPathDiff,
} from '../src/modules/investigation/domain/investigation-floor.ts';
import { deriveInvestigationFullBlobFacts } from '../src/modules/investigation/domain/investigation-full-blob.ts';
import type { ScanTreeSnapshot } from '../src/modules/investigation/domain/investigation-scanner.ts';
import type { InvestigationV3WhyRequirement } from '../src/modules/investigation/manifest/investigation-why-domain.ts';

const request: PinnedPathDiffRequest = {
  repositoryRoot: '/no/git/repository',
  baseCommit: 'a'.repeat(40),
  targetCommit: 'b'.repeat(40),
};

test('pinned diff rejects symbolic identities before observing repository bytes', () => {
  let reads = 0;
  const reader: ReadPinnedPathDiff = () => {
    reads += 1;
    return Buffer.alloc(0);
  };
  for (const invalid of [{ baseCommit: 'HEAD' }, { targetCommit: 'main' }]) {
    assert.throws(
      () => derivePinnedDiffPathFacts(reader, { ...request, ...invalid }),
      { code: 'PINNED_DIFF_INVALID', exitCode: ExitCode.usage },
    );
  }
  assert.equal(reads, 0);
});

test('pinned diff observes every call and preserves NUL-safe paths and raw byte ordering', () => {
  const reads: PinnedPathDiffRequest[] = [];
  const reader: ReadPinnedPathDiff = (input) => {
    reads.push(input);
    return Buffer.from(
      reads.length === 1
        ? 'D\0é.ts\0R100\0z\nold.ts\0new\tname.ts\0'
        : 'D\0changed.ts\0',
    );
  };
  assert.deepEqual(derivePinnedDiffPathFacts(reader, request), [
    {
      change: 'renamed',
      before: 'z\nold.ts',
      after: 'new\tname.ts',
      reference: `${request.baseCommit}..${request.targetCommit}:R:z\nold.ts:new\tname.ts`,
    },
    {
      change: 'removed',
      before: 'é.ts',
      reference: `${request.baseCommit}..${request.targetCommit}:D:é.ts`,
    },
  ]);
  assert.equal(
    derivePinnedDiffPathFacts(reader, request)[0]?.before,
    'changed.ts',
  );
  assert.deepEqual(reads, [request, request]);
});

test('pinned diff preserves observation failure identity and retries the same pinned request', () => {
  const failure = new Error('missing commit object');
  let reads = 0;
  const reader: ReadPinnedPathDiff = () => {
    if (++reads === 1) throw failure;
    return Buffer.alloc(0);
  };
  assert.throws(
    () => derivePinnedDiffPathFacts(reader, request),
    (error) => error === failure,
  );
  assert.deepEqual(derivePinnedDiffPathFacts(reader, request), []);
  assert.equal(reads, 2);
});

for (const [label, output, message] of [
  [
    'unterminated',
    Buffer.from('D\0path.ts'),
    'Pinned diff output is not NUL-terminated.',
  ],
  [
    'truncated rename',
    Buffer.from('R100\0old.ts\0'),
    'Truncated rename record in pinned diff.',
  ],
  [
    'truncated removal',
    Buffer.from('D\0'),
    'Truncated delete record in pinned diff.',
  ],
  [
    'unexpected status',
    Buffer.from('A\0new.ts\0'),
    'Unexpected diff status: A',
  ],
  [
    'invalid UTF-8',
    Buffer.from([0x44, 0, 0xff, 0]),
    'Invalid UTF-8 path in pinned diff record.',
  ],
] as const) {
  test(`pinned diff rejects ${label} bytes without replacing or retrying them`, () => {
    let reads = 0;
    assert.throws(
      () =>
        derivePinnedDiffPathFacts(() => {
          reads += 1;
          return output;
        }, request),
      { code: 'PINNED_DIFF_INVALID', message, exitCode: ExitCode.usage },
    );
    assert.equal(reads, 1);
  });
}

function blobInput() {
  const reader = createFixtureTrackedObjectReaderPort([
    {
      kind: 'jigwright.fixture-tracked-tree.v1',
      treeOid: 'c'.repeat(40),
      files: { 'src/source.ts': 'first line\nsecond line\n' },
    },
  ]);
  const wire = reader.readPinnedTree({
    repositoryRoot: '/no/git/repository',
    treeOid: 'c'.repeat(40),
  });
  const snapshot: ScanTreeSnapshot = {
    ...wire,
    entries: wire.entries.map(({ content, ...entry }) => ({
      ...entry,
      ...(content === undefined ? {} : { content: Buffer.from(content) }),
    })),
  };
  const entry = snapshot.entries[0]!;
  const requirement: InvestigationV3WhyRequirement = {
    sourceKey: 'd'.repeat(64),
    pathIdentity: { ...entry.path },
    blobOid: entry.objectId,
    contentSha256: entry.contentSha256!,
    groupRefs: [],
    hits: [
      { hitKey: 'hit-1', termId: 'term-1', byteRange: { start: 0, end: 5 } },
    ],
  };
  return { snapshot, requirements: [requirement], dispositions: [] };
}

test('full-blob facts use supplied canonical tracked snapshots and keep exact byte identities', () => {
  const input = blobInput();
  const first = deriveInvestigationFullBlobFacts(input)[0]!;
  assert.equal(
    first.blob.contentBase64,
    Buffer.from('first line\nsecond line\n').toString('base64'),
  );
  assert.equal(
    first.blob.contentSha256,
    crypto
      .createHash('sha256')
      .update('first line\nsecond line\n')
      .digest('hex'),
  );
  assert.equal(first.blob.lineCount, 3);
  input.requirements[0]!.hits = [
    {
      hitKey: 'other-hit',
      termId: 'other-term',
      byteRange: { start: 11, end: 17 },
    },
  ];
  const second = deriveInvestigationFullBlobFacts(input)[0]!;
  assert.equal(second.manifestEntryId, first.manifestEntryId);
  assert.deepEqual(second.blob, first.blob);
  assert.notDeepEqual(second.relevantLocations, first.relevantLocations);
});

test('full-blob derivation revalidates supplied bytes instead of reusing a previous successful result', () => {
  const input = blobInput();
  const first = deriveInvestigationFullBlobFacts(input)[0]!;
  input.snapshot.entries[0]!.content![0] = 0x78;
  assert.throws(() => deriveInvestigationFullBlobFacts(input), {
    code: 'SEMANTIC_COMPLETENESS_FAILURE',
    message:
      'A current load-bearing source has no matching readable pinned blob.',
    exitCode: ExitCode.guard,
  });
  assert.equal(
    Buffer.from(first.blob.contentBase64, 'base64').toString(),
    'first line\nsecond line\n',
  );
});

for (const missing of ['entry', 'content', 'digest', 'skipped'] as const) {
  test(`full-blob derivation rejects a ${missing} source before disposition admission`, () => {
    const input = blobInput();
    input.requirements[0]!.groupRefs = [
      { index: 0, key: 'missing-group', leafDigest: 'e'.repeat(64) },
    ];
    if (missing === 'entry') input.snapshot.entries = [];
    else if (missing === 'content') delete input.snapshot.entries[0]!.content;
    else if (missing === 'digest') {
      const { contentSha256, ...entry } = input.snapshot.entries[0]!;
      input.snapshot.entries[0] = entry;
    } else {
      input.snapshot.entries[0] = {
        ...input.snapshot.entries[0]!,
        skipReason: 'sensitive-path',
      };
    }
    assert.throws(() => deriveInvestigationFullBlobFacts(input), {
      code: 'SEMANTIC_COMPLETENESS_FAILURE',
      message:
        'A current load-bearing source has no matching readable pinned blob.',
      exitCode: ExitCode.guard,
    });
  });
}
