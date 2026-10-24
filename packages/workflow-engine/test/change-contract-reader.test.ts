import { parsePlanReviewArtifact } from '../src/composition-root/plan-review-artifact-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createChangeContractReaders } from '../src/runtime/repository-validation/change-contract-reader.ts';
import {
  createFixtureRepository,
  writeManagedChangeArtifacts,
} from './fixture.ts';

test('current-origin admission precedes missing artifacts and repeats for each live observation', () => {
  const root = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(root);
    fs.unlinkSync(path.join(root, 'openspec/changes/demo-change/proposal.md'));
    const calls: Array<[string, string]> = [];
    const rejectedOrigin = new Error('rejected-current-origin');
    const rejecting = createChangeContractReaders(
      (repositoryRoot, changeId) => {
        calls.push([repositoryRoot, changeId]);
        throw rejectedOrigin;
      },
      parsePlanReviewArtifact,
    );
    assert.throws(
      () => rejecting.loadChangeContract(root, 'demo-change'),
      (error) => error === rejectedOrigin,
    );
    assert.deepEqual(calls, [[root, 'demo-change']]);
    const optionalOrigin = createChangeContractReaders(
      (repositoryRoot, changeId) => {
        calls.push([repositoryRoot, changeId]);
        return null;
      },
      parsePlanReviewArtifact,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => optionalOrigin.loadChangeContract(root, 'demo-change'),
        { code: 'MISSING_CHANGE_ARTIFACT' },
      );
    }
    assert.equal(calls.length, 3);
    assert.throws(
      () =>
        optionalOrigin.loadChangeContract(
          root,
          'demo-change',
          'unselected-schema',
        ),
      { code: 'OPENSPEC_CHANGE_STATE_CHANGED' },
    );
    assert.equal(calls.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
