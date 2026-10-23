import { productionChangeContract } from '../../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../src/foundation/canonical-json/canonical-json.ts';
import { commitSession } from '../../src/application/finalize/lifecycle.ts';
import { finalizeTask } from './session-lifecycle-host.ts';
import { startSession } from '../../src/application/execute-task/session.ts';
import {
  beginTaskDiffReview,
  reconcileTaskDiffReview,
} from '../../src/composition-root/task-diff-review-production.ts';
import { runProviderWorker } from '../../src/entrypoints/worker/provider-worker.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../../src/modules/assurance/task-diff-review.ts';
import { taskDiffReviewProviderSubmission } from '../../src/modules/assurance/task-diff-review-artifact.ts';
import type { TaskDiffReviewSubmission } from '../../src/modules/assurance/task-diff-review-artifact-record.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../../src/runtime/provider-execution/provider-runner.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
  git,
  isWorkflowError,
} from '../fixture.ts';

export function commitCurrentFixtureTask(
  repository: string,
  options: {
    changeId?: string;
    taskId?: string;
    implementationPath?: string;
    implementation?: string;
    message?: string;
  } = {},
): string {
  const changeId = options.changeId ?? 'demo-change';
  const taskId = options.taskId ?? '1.1';
  const implementationPath = options.implementationPath ?? 'src/feature.ts';
  const session = startSession(
    productionChangeContract,
    repository,
    changeId,
    taskId,
  );
  const target = path.join(repository, implementationPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sourceRevision = git(repository, [
    'rev-parse',
    '--short=12',
    'HEAD',
  ]).trim();
  fs.writeFileSync(
    target,
    options.implementation ??
      `export const fixtureExecution = '${sourceRevision}';\n`,
  );
  assert.throws(
    () => finalizeTask(repository, session.sessionId),
    (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
  );
  satisfyCurrentTaskDiffReview(
    repository,
    session.sessionId,
    implementationPath,
  );
  finalizeTask(repository, session.sessionId);
  return commitSession(
    productionChangeContract,
    repository,
    session.sessionId,
    options.message ?? 'Complete demo execution',
  ).commitHash;
}

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
  // A provider writes the authored wire form, so the bytes, the reported
  // output, and the digest over it are all reduced once, together.
  const providerSubmission = taskDiffReviewProviderSubmission(submission);
  const worker = runProviderWorker(repository, prepared.invocationId, {
    runner(input) {
      writeFixtureProviderRuntime(
        input.invocationDirectory,
        providerSubmission,
      );
      return {
        invocationId: prepared.invocationId,
        providerId: input.providerId,
        purpose: 'task-diff-review',
        requestDigest: input.request.requestDigest,
        semanticOutput: providerSubmission,
        semanticOutputDigest: crypto
          .createHash('sha256')
          .update(canonicalJson(providerSubmission))
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
