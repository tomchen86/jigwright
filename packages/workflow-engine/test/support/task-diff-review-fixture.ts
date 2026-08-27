import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../src/foundation/canonical-json/canonical-json.ts';
import {
  beginTaskDiffReview,
  reconcileTaskDiffReview,
} from '../../src/application/finalize/task-diff-review-lifecycle.ts';
import { runProviderWorker } from '../../src/entrypoints/worker/provider-worker.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../../src/modules/assurance/task-diff-review.ts';
import type { TaskDiffReviewSubmission } from '../../src/modules/assurance/task-diff-review-artifact.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../../src/runtime/provider-execution/provider-runner.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from '../fixture.ts';

export function satisfyCurrentTaskDiffReview(
  repository: string,
  sessionId: string,
  reviewedPath = 'src/feature.ts',
): void {
  const prepared = beginTaskDiffReview(repository, sessionId, {
    explicitActor: 'codex',
    environment: {
      ...process.env,
      WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
    },
  });
  assert.equal(prepared.state, 'waiting-for-provider');
  if (!('invocationId' in prepared)) {
    assert.fail('expected a provider TaskDiffReview reservation');
  }
  assert.equal(prepared.subject.documentationRequirement?.required, true);
  const reviewedBlobObjectId = prepared.subject.transitions.find(
    ({ path: changedPath }) => changedPath === reviewedPath,
  )?.after?.objectId;
  assert.ok(reviewedBlobObjectId);
  const submission: TaskDiffReviewSubmission = {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: reviewedPath,
          line: 1,
          blobObjectId: reviewedBlobObjectId,
          observation:
            'The exact candidate remains within the reviewed fixture task scope.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: prepared.subject.reviewRequirement.riskPaths.map(
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge',
      }),
    ),
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact checked fixture candidate.',
    documentationAssessment: {
      decision: 'no-impact',
      notes:
        'The synthetic implementation changes no public or operator documentation contract.',
    },
  };
  const worker = runProviderWorker(repository, prepared.invocationId, {
    runner(input) {
      writeFixtureProviderRuntime(input.invocationDirectory, submission);
      return {
        invocationId: prepared.invocationId,
        providerId: input.providerId,
        purpose: 'task-diff-review',
        requestDigest: input.request.requestDigest,
        semanticOutput: submission,
        semanticOutputDigest: crypto
          .createHash('sha256')
          .update(canonicalJson(submission))
          .digest('hex'),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: prepared.subject.subjectDigest,
          afterDigest: prepared.subject.subjectDigest,
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: builtInProviderExecutableIdentityForTest(input.providerId),
        elapsedMs: 7,
        providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
          input.providerId,
        ),
      };
    },
  });
  assert.equal(worker.state, 'succeeded', JSON.stringify(worker.failure));
  assert.equal(
    reconcileTaskDiffReview(repository, sessionId).state,
    'satisfied',
  );
}

function writeFixtureProviderRuntime(
  invocationDirectory: string,
  semanticOutput: unknown,
): void {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
}
