import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDocumentRefresh,
  proposeDocumentRefresh,
  reviewDocumentRefresh,
} from '../src/application/documents/document-refresh.ts';
import {
  digest,
  parseProposalRecord,
  parseReviewRecord,
  replaceSection,
  type ProposalRecord,
  type ReviewRecord,
} from '../src/modules/projection/document-refresh-policy.ts';
import type { DocumentRefreshStorage } from '../src/modules/projection/document-refresh-storage.ts';

const policy = JSON.stringify({
  schemaVersion: 1,
  enforcementMode: 'enforced',
  documents: {
    'docs/features/**': { mode: 'curated', refresh: 'reviewed-section' },
  },
});
const target = 'docs/features/demo.md';
const original = '# Demo\n\n## Scope\n\nOld.\n\n## Stable\n\nKeep.\n';
const replacement = '## Scope\n\nNew.\n';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

function memoryStorage() {
  const records = new Map<string, ProposalRecord | ReviewRecord>();
  const events: string[] = [];
  let locked = false;
  const state = { policy, text: original, onLock() {} };
  const storage: DocumentRefreshStorage = {
    readRecord(kind, id) {
      events.push(`record:${kind}`);
      return records.get(id);
    },
    writeRecord(record) {
      const id = digest(JSON.stringify(record));
      records.set(id, record);
      return id;
    },
    openTarget(requested) {
      assert.equal(requested, target);
      events.push('open');
      return {
        target,
        readPolicy() {
          events.push(locked ? 'policy:locked' : 'policy');
          return state.policy;
        },
        readText() {
          events.push(locked ? 'text:locked' : 'text');
          return state.text;
        },
        withLock(operation) {
          events.push('lock');
          locked = true;
          state.onLock();
          try {
            return operation((content) => {
              assert.equal(locked, true);
              events.push('commit:locked');
              state.text = content;
            });
          } finally {
            locked = false;
            events.push('unlock');
          }
        },
      };
    },
  };
  const proposal = proposeDocumentRefresh(
    storage,
    target,
    '## Scope',
    replacement,
  );
  const review = reviewDocumentRefresh(
    storage,
    proposal.proposalId,
    'approve',
    'reviewer',
  );
  events.length = 0;
  return { storage, proposal, review, state, events, records };
}

test('pure section replacement retains fenced headings and neighboring sections', () => {
  assert.equal(
    replaceSection(original, '## Scope', '## Scope\n\n```md\n## Quoted\n```\n'),
    '# Demo\n\n## Scope\n\n```md\n## Quoted\n```\n\n## Stable\n\nKeep.\n',
  );
  assert.throws(
    () => replaceSection('## Scope\n## Scope\n', '## Scope', replacement),
    hasCode('DOCUMENT_SECTION_NOT_UNIQUE'),
  );
  assert.throws(
    () => replaceSection(original, '## Scope', '## Scope\n## Escape\n'),
    hasCode('DOCUMENT_REPLACEMENT_ESCAPES_SECTION'),
  );
});

test('pure record validation rejects malformed proposal digests and review decisions', () => {
  const { records, proposal, review } = memoryStorage();
  assert.throws(
    () =>
      parseProposalRecord({
        ...records.get(proposal.proposalId),
        resultDigest: 'wrong',
      }),
    hasCode('DOCUMENT_PROPOSAL_INVALID'),
  );
  assert.throws(
    () =>
      parseReviewRecord({ ...records.get(review.reviewId), decision: 'maybe' }),
    hasCode('DOCUMENT_REVIEW_INVALID'),
  );
});

test('application reads current policy and text and commits only inside the target lock', () => {
  const f = memoryStorage();
  assert.equal(
    applyDocumentRefresh(f.storage, f.proposal.proposalId, f.review.reviewId)
      .resultDigest,
    f.proposal.resultDigest,
  );
  assert.deepEqual(f.events, [
    'record:proposal',
    'record:review',
    'open',
    'lock',
    'policy:locked',
    'text:locked',
    'commit:locked',
    'unlock',
  ]);
  assert.equal(
    f.state.text,
    '# Demo\n\n## Scope\n\nNew.\n\n## Stable\n\nKeep.\n',
  );
});

for (const drift of ['policy', 'text'] as const) {
  test(`application refuses ${drift} drift introduced at lock acquisition without committing`, () => {
    const f = memoryStorage();
    f.state.onLock = () => {
      f.state[drift] += '\n';
    };
    assert.throws(
      () =>
        applyDocumentRefresh(
          f.storage,
          f.proposal.proposalId,
          f.review.reviewId,
        ),
      hasCode(
        drift === 'policy'
          ? 'DOCUMENT_REFRESH_POLICY_CHANGED'
          : 'DOCUMENT_TARGET_STALE',
      ),
    );
    assert.equal(f.events.includes('commit:locked'), false);
    assert.equal(f.events.at(-1), 'unlock');
    if (drift === 'policy')
      assert.equal(f.events.includes('text:locked'), false);
  });
}

test('application refuses an approved record with an incorrect computed result before commit', () => {
  const f = memoryStorage();
  f.records.set(f.proposal.proposalId, {
    ...(f.records.get(f.proposal.proposalId)! as ProposalRecord),
    resultDigest: digest('different'),
  });
  assert.throws(
    () =>
      applyDocumentRefresh(f.storage, f.proposal.proposalId, f.review.reviewId),
    hasCode('DOCUMENT_PROPOSAL_INVALID'),
  );
  assert.equal(f.events.includes('commit:locked'), false);
  assert.equal(f.events.at(-1), 'unlock');
});

test('application rejects a mismatched review before opening or locking a document', () => {
  const f = memoryStorage();
  f.records.set(f.review.reviewId, {
    ...(f.records.get(f.review.reviewId)! as ReviewRecord),
    proposalId: digest('different'),
  });
  assert.throws(
    () =>
      applyDocumentRefresh(f.storage, f.proposal.proposalId, f.review.reviewId),
    hasCode('DOCUMENT_REVIEW_MISMATCH'),
  );
  assert.deepEqual(f.events, ['record:proposal', 'record:review']);
});
