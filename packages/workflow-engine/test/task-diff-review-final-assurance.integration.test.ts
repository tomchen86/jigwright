import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  completeTask,
  finalizeTask,
} from '../src/composition-root/finalization-production.ts';
import {
  readFinalizeTransaction,
  removeFinalizeTransaction,
} from '../src/runtime/repository-transaction/finalize-transaction.ts';
import { restoreFinalizeTransactionProjection } from '../src/application/finalize/projected-finalization.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  checkSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReviewContinuation,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  reconcileTaskDiffReviewContinuation,
  reconcileTaskDiffReview,
} from '../src/composition-root/task-diff-review-production.ts';
import {
  createTaskDiffReviewChallengeResponse,
  taskDiffReviewProviderSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  runtimeRoot,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';
import {
  createReviewFixture,
  challengedTaskDiffSubmission,
  writeFixtureProviderRuntime,
  sha256,
  runCli,
  hasCode,
} from './task-diff-review-inspection-fixture.ts';

test('advisory dispositions cannot close a challenge until the shared verifier mints Final Assurance', () => {
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
    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    const blobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(blobObjectId);
    const challenged = challengedTaskDiffSubmission(
      blobObjectId,
      prepared.subject,
    );
    const challengedProviderSubmission =
      taskDiffReviewProviderSubmission(challenged);
    assert.equal(
      runProviderWorker(repository, prepared.invocationId, {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            challengedProviderSubmission,
          );
          return {
            invocationId: prepared.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: challengedProviderSubmission,
            semanticOutputDigest: sha256(
              canonicalJson(challengedProviderSubmission),
            ),
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
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'challenge-response-required');
    assert.equal(reviewed.review.challenges.length, 1);
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );
    const refusedFinalize = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete reviewed task',
      '--json',
    ]);
    assert.equal(refusedFinalize.status, 13, refusedFinalize.stderr);
    const refusal = (
      JSON.parse(refusedFinalize.stderr) as {
        error: { code: string; recovery: string };
      }
    ).error;
    assert.equal(refusal.code, 'TASK_DIFF_REVIEW_CHALLENGE_OPEN');
    assert.equal(
      refusal.recovery,
      `pnpm workflow review-diff ${session.sessionId} --json`,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const reviewedTransaction = readFinalizeTransaction(
      runtimeRoot(repository),
      session.sessionId,
    );
    assert.ok(reviewedTransaction);
    restoreFinalizeTransactionProjection(
      repository,
      reviewedTransaction,
      new Error('fixture refreshes evidence for the challenged candidate'),
    );
    removeFinalizeTransaction(runtimeRoot(repository), reviewedTransaction);
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    const refreshedSubject = inspectTaskDiffReviewSubject(
      repository,
      session.sessionId,
    );
    assert.equal(
      refreshedSubject.candidateTree,
      reviewed.subject.candidateTree,
    );
    assert.equal(refreshedSubject.patchDigest, reviewed.subject.patchDigest);
    assert.notEqual(
      refreshedSubject.subjectDigest,
      reviewed.subject.subjectDigest,
    );

    const response = createTaskDiffReviewChallengeResponse({
      review: reviewed.review,
      responses: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        rationale:
          'The exact checked candidate and passing check evidence answer the challenge.',
        evidence: [challenge.evidence[0]!],
      })),
    });
    const continuation = beginTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
    );
    assert.equal(continuation.state, 'waiting-for-provider');
    assert.equal(continuation.assignment.providerId, 'claude');
    assert.notEqual(
      continuation.assignment.sessionId,
      reviewed.assignment.sessionId,
    );
    const semanticOutput = {
      schemaVersion: 1 as const,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        decision: 'rebutted' as const,
        rationale:
          'The bound response and candidate evidence rebut the challenge.',
        supersededBy: null,
      })),
    };
    const continuationResult = runProviderWorker(
      repository,
      continuation.invocationId,
      {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            semanticOutput,
          );
          return {
            invocationId: continuation.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
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
      },
    );
    assert.equal(
      continuationResult.state,
      'succeeded',
      JSON.stringify(continuationResult.failure),
    );
    assert.throws(
      () =>
        reconcileTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response.responseDigest,
          { testCrashAfter: 'advisory-result-persisted' },
        ),
      /Simulated TaskDiffReview continuation interruption/,
    );
    const closureStatus = inspectTaskDiffReviewStatus(
      repository,
      session.sessionId,
    );
    assert.equal(closureStatus.state, 'challenge-closure-required');
    assert.ok('response' in closureStatus, JSON.stringify(closureStatus));
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );

    const reconciled = runCli(repository, [
      'review-diff',
      'reconcile',
      session.sessionId,
      '--json',
    ]);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    const closed = (
      JSON.parse(reconciled.stdout) as {
        result: ReturnType<typeof reconcileTaskDiffReviewContinuation>;
      }
    ).result;
    assert.equal(closed.state, 'satisfied');
    assert.equal(closed.invocationId, continuation.invocationId);
    assert.equal(closed.response.responseDigest, response.responseDigest);
    assert.equal(closed.finalAssurance?.verdict, 'satisfied');
    assert.equal(
      closed.finalAssurance?.subjectDigest,
      reviewed.subject.subjectDigest,
    );
    assert.equal(
      inspectTaskDiffReviewStatus(repository, session.sessionId).subject
        .subjectDigest,
      refreshedSubject.subjectDigest,
    );
    assert.equal(
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId)
        ?.recordDigest,
      reviewed.review.recordDigest,
    );
    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an accepted continuation decision requires a new candidate and never satisfies finalize', () => {
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
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    const blobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(blobObjectId);
    const challenged = challengedTaskDiffSubmission(
      blobObjectId,
      prepared.subject,
    );
    const challengedProviderSubmission =
      taskDiffReviewProviderSubmission(challenged);
    runProviderWorker(repository, prepared.invocationId, {
      runner(input) {
        writeFixtureProviderRuntime(
          input.invocationDirectory,
          challengedProviderSubmission,
        );
        return {
          invocationId: prepared.invocationId,
          providerId: input.providerId,
          purpose: 'task-diff-review',
          requestDigest: input.request.requestDigest,
          semanticOutput: challengedProviderSubmission,
          semanticOutputDigest: sha256(
            canonicalJson(challengedProviderSubmission),
          ),
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
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    if (!('review' in reviewed)) throw new Error('review required');
    const response = createTaskDiffReviewChallengeResponse({
      review: reviewed.review,
      responses: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        rationale: 'The challenge is accepted and the candidate must change.',
        evidence: [challenge.evidence[0]!],
      })),
    });
    const continuation = beginTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
    );
    const semanticOutput = {
      schemaVersion: 1 as const,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        decision: 'accepted' as const,
        rationale: 'The candidate must change before completion.',
        supersededBy: null,
      })),
    };
    const continuationResult = runProviderWorker(
      repository,
      continuation.invocationId,
      {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            semanticOutput,
          );
          return {
            invocationId: continuation.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
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
      },
    );
    assert.equal(
      continuationResult.state,
      'succeeded',
      JSON.stringify(continuationResult.failure),
    );
    assert.equal(
      reconcileTaskDiffReviewContinuation(
        repository,
        session.sessionId,
        response.responseDigest,
      ).state,
      'changes-required',
    );
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHANGES_REQUIRED'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHANGES_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy complete-task refuses a review-required candidate instead of bypassing Final Assurance', () => {
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
    checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
    );
    assert.throws(
      () => completeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('compatibility completion refuses a review-triggering projection without a checked finalize transaction', () => {
  const { repository } = createReviewFixture({
    configurePathRoles(registry) {
      registry.roles.ordinary.unshift('src/**');
      registry.roles['contract-surface'].push(
        'openspec/changes/demo-change/tasks.md',
      );
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
    checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
    );
    assert.throws(
      () => completeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_NOT_READY'),
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[ \] 1\.1/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
