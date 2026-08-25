import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGovernanceSourceV1,
  parseGovernanceSourceV1,
} from '../src/governance-source.ts';

test('governance Source preserves exact wording and recomputable identity', () => {
  const source = createGovernanceSourceV1({
    semanticAuthor: 'maintainer',
    capturedBy: 'jigwright',
    capturedAt: '2026-08-24T03:00:00.000Z',
    contextRef: 'direct-human:thread/turn-42',
    text: 'Use only jigwright as the public product name.\n',
    supersedes: null,
  });

  assert.match(source.id, /^SRC-[0-9a-f]{64}$/);
  assert.match(source.textDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    parseGovernanceSourceV1(JSON.parse(JSON.stringify(source))).text,
    'Use only jigwright as the public product name.\n',
  );

  assert.throws(
    () => parseGovernanceSourceV1({ ...source, text: 'Paraphrased.' }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOVERNANCE_SOURCE_IDENTITY_INVALID',
  );
});

test('maintainer authorship needs a direct-human reference and secrets fail closed', () => {
  assert.throws(
    () =>
      createGovernanceSourceV1({
        semanticAuthor: 'maintainer',
        capturedBy: 'agent',
        capturedAt: '2026-08-24T03:00:00.000Z',
        contextRef: 'session:agent-claim',
        text: 'This was definitely said by the maintainer.',
        supersedes: null,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOVERNANCE_SOURCE_AUTHORSHIP_UNPROVEN',
  );

  assert.throws(
    () =>
      createGovernanceSourceV1({
        semanticAuthor: 'agent',
        capturedBy: 'agent',
        capturedAt: '2026-08-24T03:00:00.000Z',
        contextRef: 'session:investigation-1',
        text: '-----BEGIN PRIVATE KEY-----\nnot-for-storage',
        supersedes: null,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOVERNANCE_SOURCE_SECRET_REJECTED',
  );
});
