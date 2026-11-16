import assert from 'node:assert/strict';
import test from 'node:test';

import { assessSemanticFreshness } from '../src/modules/why-knowledge/semantic-freshness.ts';
import {
  assertLedgerEntry,
  createLedgerEntry,
  dependencySetDigest,
  type LedgerEntryInput,
} from '../src/modules/why-knowledge/semantic-ledger.ts';
import { isWorkflowError } from './fixture.ts';

const POLICY = `sha256:${'1'.repeat(64)}`;

function input(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    schemaVersion: 2,
    kind: 'semantic-ledger-entry',
    subject: {
      subjectId: 'investigation.resume-propose',
      kind: 'symbol',
      path: 'packages/workflow-engine/src/runtime/proposal/propose-operations.ts',
      symbol: 'resumePropose',
    },
    binding: {
      baselineCommit: 'a'.repeat(40),
      blobDigest: `sha256:${'2'.repeat(64)}`,
      sourceDigest: `sha256:${'3'.repeat(64)}`,
      semanticDigest: `sha256:${'4'.repeat(64)}`,
      extractorVersion: 'ts-adapter-v1',
    },

    semanticDependencies: [
      {
        relation: 'validates-against',
        subjectId: 'investigation.checkpoint-envelope',
        path: 'src/investigation.checkpoint-envelope.ts',
        sourceDigest: `sha256:${'5'.repeat(64)}`,
      },
    ],
    policyDigest: POLICY,
    provenance: { changeId: 'demo-change', createdAtCommit: 'b'.repeat(40) },
    supersedes: null,
    status: 'current',
    ...overrides,
  } as LedgerEntryInput;
}

const ENTRY = createLedgerEntry(input());

function observed(overrides: Record<string, unknown> = {}) {
  return {
    present: true,
    sourceDigest: ENTRY.binding.sourceDigest,
    semanticDigest: ENTRY.binding.semanticDigest,
    currentDependencySourceDigests: {
      'investigation.checkpoint-envelope': `sha256:${'5'.repeat(64)}`,
    },
    currentPolicyDigest: POLICY,
    ...overrides,
  };
}

test('the same understanding always has the same identity', () => {
  assert.equal(createLedgerEntry(input()).entryId, ENTRY.entryId);
  const different = createLedgerEntry(
    input({
      binding: {
        ...input().binding,
        semanticDigest: `sha256:${'c'.repeat(64)}`,
      },
    }),
  );
  assert.notEqual(different.entryId, ENTRY.entryId);
});

test('a claimed entry identity is recomputed, never believed', () => {
  assert.throws(
    () => assertLedgerEntry({ ...ENTRY, entryId: `sha256:${'0'.repeat(64)}` }),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
  assert.deepEqual(assertLedgerEntry({ ...ENTRY }), ENTRY);
});

test('entry creation rejects a persisted entry as an input template', () => {
  assert.throws(
    () => createLedgerEntry({ ...ENTRY } as never),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
});

test('dependency order does not change the dependency digest', () => {
  const forward = dependencySetDigest([
    {
      relation: 'a',
      subjectId: 'x',
      path: 'src/x.ts',
      sourceDigest: `sha256:${'6'.repeat(64)}`,
    },
    {
      relation: 'b',
      subjectId: 'y',
      path: 'src/y.ts',
      sourceDigest: `sha256:${'7'.repeat(64)}`,
    },
  ]);
  const reversed = dependencySetDigest([
    {
      relation: 'b',
      subjectId: 'y',
      path: 'src/y.ts',
      sourceDigest: `sha256:${'7'.repeat(64)}`,
    },
    {
      relation: 'a',
      subjectId: 'x',
      path: 'src/x.ts',
      sourceDigest: `sha256:${'6'.repeat(64)}`,
    },
  ]);
  assert.equal(reversed, forward);
});

test('canonical entries reject a duplicated explanation authority', () => {
  assert.throws(
    () =>
      createLedgerEntry({
        ...input(),
        why: { responsibility: 'A duplicate.' },
      } as never),
    (error) => isWorkflowError(error, 'SEMANTIC_LEDGER_INVALID'),
  );
});

test('an unchanged subject is reused', () => {
  const verdict = assessSemanticFreshness(ENTRY, observed());
  assert.equal(verdict.state, 'current');
  assert.equal(verdict.resolution, 'reuse');
});

test('reformatting without meaning change keeps the entry', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ sourceDigest: `sha256:${'9'.repeat(64)}` }),
  );
  assert.equal(verdict.state, 'exact-changed-semantic-same');
  assert.equal(verdict.resolution, 'reuse');
});

test('a changed meaning forces the WHY to be written again', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ semanticDigest: `sha256:${'8'.repeat(64)}` }),
  );
  assert.equal(verdict.state, 'subject-changed');
  assert.equal(verdict.resolution, 'regenerate');
});

test('an untouched consumer whose dependency moved must be revalidated', () => {
  // This is the case a "was the file modified?" check cannot see at all.
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({
      currentDependencySourceDigests: {
        'investigation.checkpoint-envelope': `sha256:${'f'.repeat(64)}`,
      },
    }),
  );
  assert.equal(verdict.state, 'dependency-changed');
  assert.equal(verdict.resolution, 'revalidate');
});

test('unknown dependency state is not treated as stability', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ currentDependencySourceDigests: undefined }),
  );
  assert.equal(verdict.state, 'dependency-changed');
});

test('a raised policy leaves the content standing but the assurance owed', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({ currentPolicyDigest: `sha256:${'c'.repeat(64)}` }),
  );
  assert.equal(verdict.state, 'policy-stale');
  assert.equal(verdict.resolution, 'revalidate');
});

test('an ambiguous identity is resolved before its content is compared', () => {
  const verdict = assessSemanticFreshness(
    ENTRY,
    observed({
      identityAmbiguous: true,
      semanticDigest: `sha256:${'8'.repeat(64)}`,
    }),
  );
  assert.equal(verdict.state, 'identity-ambiguous');
  assert.equal(verdict.resolution, 'regenerate');
});

test('a deleted subject and a superseded entry are never reused', () => {
  assert.equal(
    assessSemanticFreshness(ENTRY, observed({ present: false })).state,
    'subject-deleted',
  );
  assert.equal(
    assessSemanticFreshness(
      createLedgerEntry(input({ status: 'superseded' })),
      observed(),
    ).state,
    'superseded',
  );
});
