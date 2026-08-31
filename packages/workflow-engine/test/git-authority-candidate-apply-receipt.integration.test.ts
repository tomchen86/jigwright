import assert from 'node:assert/strict';
import test from 'node:test';

import { gitAuthorityCandidateApplyReceiptTagRef } from '../src/modules/authority/git-authority-candidate-apply-receipt.ts';

test('Central Apply receipt tag identity is challenge-bound', () => {
  assert.equal(
    gitAuthorityCandidateApplyReceiptTagRef(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
    'refs/tags/workflow-central-grant/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
});
