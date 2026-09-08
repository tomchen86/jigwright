import test from 'node:test';
import { createFixtureRepository, isWorkflowError } from './fixture.ts';
import assert from 'node:assert/strict';
import { blindSurveyIntentDigest } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import fs from 'node:fs';
import { createManifest } from './blind-survey-manifest-fixture.ts';

test('blind survey intent requires the exact current sourceRefs key', () => {
  const repository = createFixtureRepository();
  try {
    const manifest = createManifest(repository, 'investigation-source-refs');
    const normalizedIntent = {
      ...manifest.normalizedIntent,
      sourceRefs: [],
    } as Record<string, unknown>;
    delete normalizedIntent.sourceRefs;
    const missingSourceRefs = {
      ...manifest,
      normalizedIntent,
    };

    assert.throws(
      () => blindSurveyIntentDigest(missingSourceRefs as never),
      (error) => isWorkflowError(error, 'BLIND_MANIFEST_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
