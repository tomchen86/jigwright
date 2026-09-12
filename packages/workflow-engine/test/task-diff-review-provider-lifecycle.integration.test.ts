import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { finalizeTask } from '../src/composition-root/finalization-production.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  reconcileTaskDiffReview,
} from '../src/composition-root/task-diff-review-production.ts';
import { taskDiffReviewProviderSubmission } from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  git,
  runtimeRoot,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';
import {
  createReviewFixture,
  investigationRuntime,
  validTaskDiffSubmission,
  providerWireResult,
  sha256,
  runCli,
  hasCode,
} from './task-diff-review-inspection-fixture.ts';

test('review-diff lifecycle binds a fresh provider reviewer to the exact WorkflowSession and adopts only its fixed-runner result', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );

    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    assert.equal(prepared.sessionId, session.sessionId);
    assert.equal(prepared.implementationActor.providerId, 'codex');
    assert.equal(
      prepared.implementationActor.identityAssurance,
      'self-declared',
    );
    assert.equal(prepared.assignment.providerId, 'codex');
    assert.notEqual(
      prepared.assignment.sessionId,
      prepared.implementationActor.sessionId,
    );
    assert.equal(
      prepared.assignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(prepared.assignment.role, 'task-diff-reviewer');
    assert.equal(
      prepared.assignment.targetDigest,
      prepared.subject.subjectDigest,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const replay = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.deepEqual(replay, prepared);

    const runtime = investigationRuntime(repository);
    const request = readProviderInvocationRequest(
      runtime,
      prepared.invocationId,
    );
    const manifest = readProviderInvocationManifest(
      runtime,
      prepared.invocationId,
    );
    assert.equal(request.purpose, 'task-diff-review');
    assert.equal(request.writeAllowedPaths.length, 0);
    assert.equal(request.targetDigest, prepared.subject.subjectDigest);
    assert.equal(
      providerInvocationManifestDigest(manifest),
      request.inputManifestDigest,
    );
    assert.equal(
      readProviderInvocation(runtime, prepared.invocationId).state,
      'prepared',
    );

    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(
      reviewedBlobObjectId,
      prepared.subject,
    );
    const providerSubmission = taskDiffReviewProviderSubmission(submission);
    const worker = runProviderWorker(repository, prepared.invocationId, {
      runner(input) {
        return {
          invocationId: prepared.invocationId,
          providerId: input.providerId,
          purpose: 'task-diff-review',
          requestDigest: input.request.requestDigest,
          semanticOutput: providerSubmission,
          semanticOutputDigest: sha256(canonicalJson(providerSubmission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: prepared.subject.subjectDigest,
            afterDigest: prepared.subject.subjectDigest,
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: builtInProviderExecutableIdentityForTest(
            input.providerId,
          ),
          elapsedMs: 7,
          providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
            input.providerId,
          ),
        };
      },
    });
    assert.equal(worker.state, 'succeeded');

    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'satisfied');
    assert.equal(reviewed.review.subjectDigest, prepared.subject.subjectDigest);
    assert.equal(reviewed.review.assignment.implementerProviderId, 'codex');
    assert.equal(reviewed.review.assignment.reviewerProviderId, 'codex');
    assert.deepEqual(
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      reviewed.review,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff refuses an evaluator-only result without a fixed-runner observation', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    const runtime = investigationRuntime(repository);
    const request = readProviderInvocationRequest(
      runtime,
      prepared.invocationId,
    );
    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const claim = claimProviderInvocation(runtime, prepared.invocationId, {
      workerId: 'task-diff-review-evaluator-only',
      leaseDurationMs: 60_000,
    });
    completeProviderInvocation(runtime, prepared.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      outcome: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnErrorCode: null,
        elapsedMs: 1,
        stdout: JSON.stringify(
          providerWireResult(
            request,
            taskDiffReviewProviderSubmission(
              validTaskDiffSubmission(reviewedBlobObjectId, prepared.subject),
            ),
          ),
        ),
        stderr: '',
      },
    });
    assert.throws(
      () => reconcileTaskDiffReview(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_PROVIDER_OBSERVATION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff provider worker refuses a candidate that changed after reservation before claiming it', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    let launched = false;
    assert.throws(
      () =>
        runProviderWorker(repository, prepared.invocationId, {
          runner() {
            launched = true;
            throw new Error('must not launch');
          },
        }),
      hasCode('TASK_DIFF_REVIEW_CANDIDATE_DIVERGED'),
    );
    assert.equal(launched, false);
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        prepared.invocationId,
      ).state,
      'prepared',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('finalize pauses before staging for a required review and resumes without rerunning checks after the exact result is adopted', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const transaction = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { phase: string; previousIndexTree: string };
    assert.equal(transaction.phase, 'checked');
    assert.equal(
      git(repository, ['write-tree']).trim(),
      transaction.previousIndexTree,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(
      reviewedBlobObjectId,
      prepared.subject,
    );
    const providerSubmission = taskDiffReviewProviderSubmission(submission);
    assert.equal(
      runProviderWorker(repository, prepared.invocationId, {
        runner(input) {
          return {
            invocationId: prepared.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: providerSubmission,
            semanticOutputDigest: sha256(canonicalJson(providerSubmission)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: prepared.subject.subjectDigest,
              afterDigest: prepared.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: builtInProviderExecutableIdentityForTest(
              input.providerId,
            ),
            elapsedMs: 7,
            providerDefinitionSnapshot:
              builtInProviderDefinitionSnapshotForTest(input.providerId),
          };
        },
      }).state,
      'succeeded',
    );
    assert.equal(
      reconcileTaskDiffReview(repository, session.sessionId).state,
      'satisfied',
    );

    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a corrected candidate receives a distinct immutable TaskDiffReview generation in the same WorkflowSession', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const first = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(first.state, 'waiting-for-provider');

    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('FINALIZE_TRANSACTION_DIVERGED'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const second = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(second.state, 'waiting-for-provider');
    assert.notEqual(second.subject.subjectDigest, first.subject.subjectDigest);
    assert.notEqual(second.invocationId, first.invocationId);
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        first.invocationId,
      ).state,
      'prepared',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff uses a fresh same-provider Reviewer session without a grant', () => {
  const { repository } = createReviewFixture({
    configureAdapterPolicy(policy) {
      policy.providers.claude.enabled = false;
    },
  });
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const pausedCommand = runCli(
      repository,
      ['review-diff', session.sessionId, '--actor', 'codex', '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(pausedCommand.status, 0, pausedCommand.stderr);
    const paused = (
      JSON.parse(pausedCommand.stdout) as {
        result: ReturnType<typeof beginTaskDiffReview>;
      }
    ).result;
    assert.equal(paused.state, 'waiting-for-provider');
    if (paused.state !== 'waiting-for-provider') {
      assert.fail('expected ordinary TaskDiffReview provider work');
    }
    assert.equal(paused.assignment.providerId, 'codex');
    assert.equal(paused.assignment.requiredIndependence, 'session-independent');
    assert.equal(paused.assignment.achievedIndependence, 'session-independent');
    assert.equal('grantId' in paused.assignment, false);
    assert.equal(
      inspectTaskDiffReviewStatus(repository, session.sessionId).state,
      'waiting-for-provider',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
