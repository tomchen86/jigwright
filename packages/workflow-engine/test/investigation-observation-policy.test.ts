import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureTrackedObjectReaderPort } from '../../fixture-adapter/src/fixture-tracked-object-reader.ts';
import {
  investigationScanLimits,
  scanInvestigationSnapshotFacts,
  type ScanTreeSnapshot,
} from '../src/modules/investigation/domain/investigation-scanner.ts';
import { normalizeInvestigationTerm } from '../src/modules/investigation/domain/investigation-terms.ts';
import { createInvestigationEvidenceReplayer } from '../src/runtime/repository-observation/investigation-replay.ts';
import { createInvestigationTreeScanner } from '../src/runtime/repository-observation/investigation-scanner.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import type { InvestigationReplayAuthoringInput } from '../src/modules/investigation/manifest/investigation-replay-input.ts';

function fixture() {
  const treeOid = 'f'.repeat(40);
  const reader = createFixtureTrackedObjectReaderPort([
    {
      kind: 'jigwright.fixture-tracked-tree.v1',
      treeOid,
      files: {
        'src/file.txt': 'ZXZXZ\n',
        'coverage/copy.txt': 'ZXZXZ\n',
        'src/other.txt': 'ZXZXZ\nunique',
      },
    },
  ]);
  const request = {
    repositoryRoot: '/without/git',
    treeOid,
    terms: [
      {
        ...normalizeInvestigationTerm({
          kind: 'literal-content',
          value: 'ZXZ',
        }),
        provenance: [],
      },
    ],
  };
  const raw = reader.readPinnedTree(request);
  const snapshot: ScanTreeSnapshot = {
    ...raw,
    entries: raw.entries.map(({ content, ...entry }) => ({
      ...entry,
      ...(content === undefined ? {} : { content: Buffer.from(content) }),
    })),
  };
  return { reader, request, snapshot };
}

test('snapshot matching uses no operational clock and abort checkpoints produce no partial evidence', (t) => {
  const { request, snapshot } = fixture();
  const limits = investigationScanLimits(request);
  t.mock.method(process, 'cpuUsage', () => {
    throw new Error('domain observed CPU');
  });
  let checkpoints = 0;
  const actual = scanInvestigationSnapshotFacts(
    { snapshot, terms: request.terms, limits },
    () => {
      checkpoints++;
    },
  );
  assert.equal(actual.outcome, 'ready');
  if (actual.outcome !== 'ready') assert.fail('ready snapshot');
  // Shared generated/source object identity remains suppressed for content scans.
  assert.deepEqual(
    actual.facts.terms[0]!.hits.map((hit) => [
      hit.path.utf8,
      hit.byteOffset,
      hit.contextWindow?.utf8,
    ]),
    [
      ['src/other.txt', 0, 'ZXZXZ'],
      ['src/other.txt', 2, 'ZXZXZ'],
    ],
  );
  assert.equal(
    actual.facts.inventory.skippedObjects[0]!.reason,
    'generated-artifact',
  );
  assert.ok(checkpoints > 0);
  const abort = new Error('operational abort');
  assert.throws(
    () =>
      scanInvestigationSnapshotFacts(
        { snapshot, terms: request.terms, limits },
        () => {
          throw abort;
        },
      ),
    (error) => error === abort,
  );
});

test('invalid scan terms are rejected before the pinned reader and CPU clock start', (t) => {
  const { reader, request } = fixture();
  const unavailableReader = {
    ...reader,
    readPinnedTree() {
      throw new Error('must not read');
    },
  };
  t.mock.method(process, 'cpuUsage', () => {
    throw new Error('must not start CPU');
  });
  assert.throws(
    () =>
      createInvestigationTreeScanner(unavailableReader)({
        ...request,
        terms: [{ ...request.terms[0]!, termId: 'forged' }],
      }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'INVESTIGATION_SCAN_INVALID',
  );
});

test('replay observes the pinned baseline before term admission and reobserves on each call', () => {
  const expected = new Error('baseline unavailable');
  let observations = 0;
  const replay = createInvestigationEvidenceReplayer({
    assertBaseline() {
      observations++;
      throw expected;
    },
    scanInvestigationTreeFacts() {
      assert.fail('baseline failure must precede scanner');
    },
  });
  const input = {
    repositoryRoot: '/without/git',
    authoring: {
      baseline: { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
    } as InvestigationReplayAuthoringInput,
  };
  for (let index = 0; index < 2; index++)
    assert.throws(
      () => replay(input),
      (error) => error === expected,
    );
  assert.equal(observations, 2);
});
