import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { finalizeTask } from './support/session-lifecycle-host.ts';
import {
  readFinalizeTransaction,
  removeFinalizeTransaction,
} from '../src/runtime/storage-journal/finalize-transaction.ts';
import { restoreFinalizeTransactionProjection } from '../src/application/finalize/projected-finalization.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  reconcileTaskDiffReview,
} from '../src/composition-root/task-diff-review-production.ts';
import {
  createTaskDiffReviewRecord,
  taskDiffReviewProviderSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  listTaskDiffReviewLineageSupersessions,
  taskDiffReviewLineageSupersessionPath,
} from '../src/runtime/storage-journal/task-diff-review-store.ts';
import {
  runtimeRoot,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';
import {
  createReviewFixture,
  investigationRuntime,
  validTaskDiffSubmission,
  writeFixtureProviderRuntime,
  snapshotTree,
  sha256,
  runCli,
  hasCode,
} from './task-diff-review-inspection-fixture.ts';

test('a corrected ordinary candidate recovers one exact common supersession after a durable-result crash', () => {
  const { repository } = createReviewFixture({
    forceDiffReviewRequired: true,
    configurePathRoles(registry) {
      registry.roles.ordinary.unshift('src/**');
    },
  });
  try {
    const session = startSession(
      productionChangeContract,
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
    const firstBlob = first.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(firstBlob);
    const firstSubmission = validTaskDiffSubmission(firstBlob, first.subject);
    const firstProviderSubmission =
      taskDiffReviewProviderSubmission(firstSubmission);
    assert.equal(
      runProviderWorker(repository, first.invocationId, {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            firstProviderSubmission,
          );
          return {
            invocationId: first.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: firstProviderSubmission,
            semanticOutputDigest: sha256(
              canonicalJson(firstProviderSubmission),
            ),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: first.subject.subjectDigest,
              afterDigest: first.subject.subjectDigest,
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
    const firstResult = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(firstResult.state, 'satisfied');
    if (!('review' in firstResult)) throw new Error('review required');

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
    const manifest = readProviderInvocationManifest(
      investigationRuntime(repository),
      second.invocationId,
    ) as unknown as {
      reviewScope: {
        mode: string;
        reviewedPaths: string[];
        predecessor: {
          subjectDigest: string;
          reviewRecordDigest: string;
          finalAssuranceCommitmentDigest: string | null;
        } | null;
      };
    };
    assert.equal(manifest.reviewScope.mode, 'delta');
    assert.deepEqual(manifest.reviewScope.reviewedPaths, ['src/feature.ts']);
    assert.deepEqual(manifest.reviewScope.predecessor, {
      subjectDigest: first.subject.subjectDigest,
      reviewRecordDigest: firstResult.review.recordDigest,
      finalAssuranceCommitmentDigest: null,
    });

    const secondBlob = second.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(secondBlob);
    const secondSubmission = validTaskDiffSubmission(
      secondBlob,
      second.subject,
    );
    const secondProviderSubmission =
      taskDiffReviewProviderSubmission(secondSubmission);
    assert.equal(
      runProviderWorker(repository, second.invocationId, {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            secondProviderSubmission,
          );
          return {
            invocationId: second.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: secondProviderSubmission,
            semanticOutputDigest: sha256(
              canonicalJson(secondProviderSubmission),
            ),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: second.subject.subjectDigest,
              afterDigest: second.subject.subjectDigest,
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
    assert.throws(
      () =>
        reconcileTaskDiffReview(repository, session.sessionId, {
          testCrashAfter: 'result-binding-persisted',
        }),
      /Simulated TaskDiffReview interruption after result binding persistence/,
    );
    const runtime = investigationRuntime(repository);
    assert.deepEqual(listTaskDiffReviewLineageSupersessions(runtime), []);
    const crashGapSnapshot = snapshotTree(runtimeRoot(repository));
    assert.throws(
      () => inspectTaskDiffReviewStatus(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED'),
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), crashGapSnapshot);
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED'),
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), crashGapSnapshot);

    const recovered = runCli(repository, [
      'review-diff',
      'reconcile',
      session.sessionId,
      '--json',
    ]);
    assert.equal(recovered.status, 0, recovered.stderr);
    const secondResult = (
      JSON.parse(recovered.stdout) as {
        result: ReturnType<typeof reconcileTaskDiffReview>;
      }
    ).result;
    assert.equal(secondResult.state, 'satisfied');
    if (!('review' in secondResult)) throw new Error('review required');
    const commonSupersessions = listTaskDiffReviewLineageSupersessions(runtime);
    assert.equal(commonSupersessions.length, 1);
    const commonSupersession = commonSupersessions[0]!;
    assert.equal(
      commonSupersession.predecessorReviewRecordDigest,
      firstResult.review.recordDigest,
    );
    assert.equal(
      commonSupersession.successorReviewRecordDigest,
      secondResult.review.recordDigest,
    );
    assert.deepEqual(
      commonSupersession.successorReviewScope.predecessor,
      secondResult.review.reviewScope.predecessor,
    );
    const commonPath = taskDiffReviewLineageSupersessionPath(
      runtime,
      firstResult.review.recordDigest,
    );
    const commonBytes = fs.readFileSync(commonPath, 'utf8');
    const commonMtime = fs.statSync(commonPath).mtimeMs;
    const beforeExactReplay = snapshotTree(runtimeRoot(repository));
    assert.deepEqual(
      reconcileTaskDiffReview(repository, session.sessionId),
      secondResult,
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), beforeExactReplay);
    assert.equal(fs.readFileSync(commonPath, 'utf8'), commonBytes);
    assert.equal(fs.statSync(commonPath).mtimeMs, commonMtime);

    const tampered = JSON.parse(commonBytes) as Record<string, unknown>;
    tampered.supersessionDigest = 'f'.repeat(64);
    fs.writeFileSync(commonPath, `${canonicalJson(tampered)}\n`);
    assert.throws(
      () => inspectTaskDiffReviewStatus(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_STORE_UNSAFE'),
    );
    fs.writeFileSync(commonPath, commonBytes);

    const successorAssignment = secondResult.review.assignment;
    if (successorAssignment.reviewerProviderId === null) {
      assert.fail('expected a provider successor assignment');
    }
    const forkReview = createTaskDiffReviewRecord({
      subject: secondResult.review.subject,
      reviewScope: secondResult.review.reviewScope,
      assignment: {
        ...successorAssignment,
        reviewerSessionId: `${successorAssignment.reviewerSessionId}-fork`,
      },
      submission: secondSubmission,
    });
    const forkBody = {
      schemaVersion: 1 as const,
      kind: 'task-diff-review-lineage-supersession.v1' as const,
      predecessorSubject: commonSupersession.predecessorSubject,
      predecessorSubjectDigest:
        commonSupersession.predecessorSubject.subjectDigest,
      predecessorReview: commonSupersession.predecessorReview,
      predecessorReviewRecordDigest:
        commonSupersession.predecessorReview.recordDigest,
      successorSubject: forkReview.subject,
      successorSubjectDigest: forkReview.subject.subjectDigest,
      successorReview: forkReview,
      successorReviewRecordDigest: forkReview.recordDigest,
      successorReviewScope: forkReview.reviewScope,
      successorReviewScopeDigest: forkReview.reviewScope.scopeDigest,
    };
    fs.writeFileSync(
      commonPath,
      `${canonicalJson({
        ...forkBody,
        supersessionDigest: sha256(canonicalJson(forkBody)),
      })}\n`,
    );
    assert.throws(
      () => inspectTaskDiffReviewStatus(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_LINEAGE_CONFLICT'),
    );
    fs.writeFileSync(commonPath, commonBytes);

    assert.equal(
      fs.existsSync(
        path.join(
          runtime.refs,
          'task-diff-reviews',
          session.sessionId,
          'supersessions',
        ),
      ),
      false,
    );

    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = 3;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('FINALIZE_TRANSACTION_DIVERGED'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const third = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(third.state, 'waiting-for-provider');
    const thirdManifest = readProviderInvocationManifest(
      investigationRuntime(repository),
      third.invocationId,
    ) as unknown as {
      reviewScope: {
        mode: string;
        reviewedPaths: string[];
        predecessor: { reviewRecordDigest: string } | null;
      };
    };
    assert.equal(thirdManifest.reviewScope.mode, 'delta');
    assert.deepEqual(thirdManifest.reviewScope.reviewedPaths, [
      'src/feature.ts',
    ]);
    assert.equal(
      thirdManifest.reviewScope.predecessor?.reviewRecordDigest,
      secondResult.review.recordDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an unchanged candidate reuses its review across fresh check evidence without another provider ceremony', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeContract,
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
    if (prepared.state !== 'waiting-for-provider') {
      assert.fail('expected TaskDiffReview provider work');
    }
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
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'satisfied');
    if (!('review' in reviewed)) throw new Error('review required');

    const firstTransaction = readFinalizeTransaction(
      runtimeRoot(repository),
      session.sessionId,
    );
    assert.ok(firstTransaction);
    restoreFinalizeTransactionProjection(
      repository,
      firstTransaction,
      new Error('fixture rechecks the same candidate'),
    );
    removeFinalizeTransaction(runtimeRoot(repository), firstTransaction);

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
      prepared.subject.candidateTree,
    );
    assert.equal(refreshedSubject.patchDigest, prepared.subject.patchDigest);
    assert.notEqual(
      refreshedSubject.checkEvidenceDigest,
      prepared.subject.checkEvidenceDigest,
    );
    assert.notEqual(
      refreshedSubject.subjectDigest,
      prepared.subject.subjectDigest,
    );

    const replay = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(replay.state, 'satisfied');
    if (replay.state !== 'satisfied' || !('invocationId' in replay)) {
      assert.fail('expected exact candidate review reuse');
    }
    assert.equal(replay.invocationId, prepared.invocationId);
    assert.equal(replay.review.recordDigest, reviewed.review.recordDigest);
    assert.equal(replay.subject.subjectDigest, refreshedSubject.subjectDigest);
    assert.equal(replay.sessionId, session.sessionId);

    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff CLI resumes the durable happy path from ready through fixed-runner reconciliation', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeContract,
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

    const ready = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(
      (JSON.parse(ready.stdout) as { result: { state: string } }).result.state,
      'ready',
    );

    const started = runCli(
      repository,
      ['review-diff', session.sessionId, '--actor', 'codex', '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(started.status, 0, started.stderr);
    const startedResult = (
      JSON.parse(started.stdout) as {
        result: {
          state: string;
          invocationId: string;
          subject: { subjectDigest: string; transitions: unknown[] };
        };
      }
    ).result;
    assert.equal(startedResult.state, 'waiting-for-provider');
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        startedResult.invocationId,
      ).state,
      'prepared',
    );

    const reviewedBlobObjectId = (
      startedResult.subject.transitions as Array<{
        path: string;
        after: { objectId: string } | null;
      }>
    ).find(({ path: changedPath }) => changedPath === 'src/feature.ts')?.after
      ?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(
      reviewedBlobObjectId,
      inspectTaskDiffReviewStatus(repository, session.sessionId).subject,
    );
    const providerSubmission = taskDiffReviewProviderSubmission(submission);
    assert.equal(
      runProviderWorker(repository, startedResult.invocationId, {
        runner(input) {
          return {
            invocationId: startedResult.invocationId,
            providerId: input.providerId,
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: providerSubmission,
            semanticOutputDigest: sha256(canonicalJson(providerSubmission)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: startedResult.subject.subjectDigest,
              afterDigest: startedResult.subject.subjectDigest,
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

    const awaiting = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(awaiting.status, 0, awaiting.stderr);
    assert.equal(
      (JSON.parse(awaiting.stdout) as { result: { state: string } }).result
        .state,
      'provider-succeeded-awaiting-reconciliation',
    );
    const resumed = runCli(repository, [
      'review-diff',
      session.sessionId,
      '--actor',
      'codex',
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      (JSON.parse(resumed.stdout) as { result: { state: string } }).result
        .state,
      'satisfied',
    );
    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
