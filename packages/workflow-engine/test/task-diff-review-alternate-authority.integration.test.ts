import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createDirectHumanReviewAttestation,
  issueCollaborationGrant,
} from '../src/runtime/grants/collaboration-grant-issuance.ts';
import { inspectCollaborationGrants } from '../src/runtime/storage-journal/collaboration-grant-records.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  submitExternalTaskDiffReview,
} from '../src/composition-root/task-diff-review-production.ts';
import { productionConsumedRoleResultReplayPort } from '../src/composition-root/grant-verifier-composition.ts';
import {
  authoritativeCollaborationGrantVerifierForTest,
  consumedCollaborationGrantReplayVerifierForTest,
  git,
} from './fixture.ts';
import {
  createReviewFixture,
  investigationRuntime,
  validTaskDiffSubmission,
  createTaskDiffReviewSigningFixture,
  runCli,
  snapshotRepositoryObservation,
  snapshotFilesUnder,
  externalReviewGrantInput,
  hasCode,
} from './task-diff-review-inspection-fixture.ts';

test('caller-supplied TaskDiffReview consumes exact no-provider authority without creating an invocation', () => {
  const signing = createTaskDiffReviewSigningFixture();
  const { repository } = createReviewFixture({
    configureAdapterPolicy(policy) {
      policy.providers.codex.enabled = false;
      policy.providers.claude.enabled = false;
    },
    configureMaintainerPolicy(policy) {
      policy.trustedSigners = [signing.trustedSigner];
    },
  });
  try {
    const repositoryOrigin = (
      JSON.parse(
        fs.readFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          'utf8',
        ),
      ) as { repository: { origin: string } }
    ).repository.origin;
    git(repository, ['remote', 'add', 'origin', repositoryOrigin]);
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
    const paused = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') {
      assert.fail('expected a no-provider TaskDiffReview pause');
    }
    assert.equal(paused.inputSchema.grantRequest, null);
    assert.deepEqual(paused.inputSchema.allowedDegradedForms, [
      'caller-supplied',
      'direct-human-review',
    ]);
    const now = new Date();
    const grant = issueCollaborationGrant(
      repository,
      {
        changeId: 'demo-change',
        taskId: '1.1',
        baselineCommit: paused.subject.baseCommit,
        baselineTree: paused.subject.baseTree,
        targetDigest: paused.subject.subjectDigest,
        lifecyclePhase: 'task-diff-review',
        rolePair: {
          authorRole: 'task-implementer',
          conflictingRole: 'task-diff-reviewer',
        },
        availableActor: {
          kind: 'caller',
          callerId: 'independent-reviewer',
          assurance: 'self-declared',
        },
        degradedForm: 'caller-supplied',
        reason:
          'No provider-independent TaskDiffReview reviewer is callable for this exact candidate.',
        ttlMinutes: 30,
        maxUses: 1,
      },
      {
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        now,
        signer: signing.signer,
      },
    );
    const reviewedBlobObjectId = paused.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(
      reviewedBlobObjectId,
      paused.subject,
    );
    const input = {
      schemaVersion: 1 as const,
      kind: 'task-diff-review-submission-input.v1' as const,
      subjectDigest: paused.subject.subjectDigest,
      submission,
    };
    const beforeNoGrant = snapshotRepositoryObservation(repository);
    const noGrant = submitExternalTaskDiffReview(
      repository,
      session.sessionId,
      input,
      { explicitActor: 'codex', environment: {} },
    );
    assert.equal(noGrant.state, 'collaboration-grant-required');
    assert.deepEqual(snapshotRepositoryObservation(repository), beforeNoGrant);
    const exactOptions = {
      explicitActor: 'codex',
      environment: {},
      consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      collaborationGrant: {
        grantId: grant.grantId,
        now: new Date(now.getTime() + 60_000),
        verifier: authoritativeCollaborationGrantVerifierForTest(
          signing.signer,
        ),
      },
    };
    const nonIndependent = issueCollaborationGrant(
      repository,
      {
        changeId: 'demo-change',
        taskId: '1.1',
        baselineCommit: paused.subject.baseCommit,
        baselineTree: paused.subject.baseTree,
        targetDigest: paused.subject.subjectDigest,
        lifecyclePhase: 'task-diff-review',
        rolePair: {
          authorRole: 'task-implementer',
          conflictingRole: 'task-diff-reviewer',
        },
        availableActor: {
          kind: 'caller',
          callerId: 'provider:codex',
          assurance: 'self-declared',
        },
        degradedForm: 'caller-supplied',
        reason: 'This grant intentionally names the implementation author.',
        ttlMinutes: 30,
        maxUses: 1,
      },
      {
        grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        now,
        signer: signing.signer,
      },
    );
    const nonIndependentInput = {
      ...input,
      submission: {
        ...input.submission,
        residualRisk:
          'This rejected same-author submission must never become canonical review content.',
      },
    };
    const runtimeBeforeNonIndependentAttempt = {
      external: snapshotFilesUnder(
        path.join(
          investigationRuntime(repository).refs,
          'task-diff-reviews',
          'external-authority',
        ),
      ),
      evidence: snapshotFilesUnder(investigationRuntime(repository).objects),
    };
    assert.throws(
      () =>
        submitExternalTaskDiffReview(
          repository,
          session.sessionId,
          nonIndependentInput,
          {
            explicitActor: 'codex',
            environment: {},
            collaborationGrant: {
              grantId: nonIndependent.grantId,
              now: new Date(now.getTime() + 30_000),
              verifier: authoritativeCollaborationGrantVerifierForTest(
                signing.signer,
              ),
            },
          },
        ),
      hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'),
    );
    assert.equal(
      inspectCollaborationGrants(
        discoverRepository(repository).gitCommonDirectory,
        nonIndependent.grantId,
      )[0]?.state,
      'failed',
    );
    assert.deepEqual(
      {
        external: snapshotFilesUnder(
          path.join(
            investigationRuntime(repository).refs,
            'task-diff-reviews',
            'external-authority',
          ),
        ),
        evidence: snapshotFilesUnder(investigationRuntime(repository).objects),
      },
      runtimeBeforeNonIndependentAttempt,
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReview(repository, session.sessionId, input, {
          ...exactOptions,
          testCrashAfter: 'grant-consumed',
        }),
      /Simulated external TaskDiffReview interruption/,
    );
    const replacement = issueCollaborationGrant(
      repository,
      {
        changeId: 'demo-change',
        taskId: '1.1',
        baselineCommit: paused.subject.baseCommit,
        baselineTree: paused.subject.baseTree,
        targetDigest: paused.subject.subjectDigest,
        lifecyclePhase: 'task-diff-review',
        rolePair: {
          authorRole: 'task-implementer',
          conflictingRole: 'task-diff-reviewer',
        },
        availableActor: {
          kind: 'caller',
          callerId: 'replacement-reviewer',
          assurance: 'self-declared',
        },
        degradedForm: 'caller-supplied',
        reason: 'Replacement authority must not bypass a consumed attempt.',
        ttlMinutes: 30,
        maxUses: 1,
      },
      {
        grantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        now,
        signer: signing.signer,
      },
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReview(repository, session.sessionId, input, {
          explicitActor: 'codex',
          environment: {},
          collaborationGrant: {
            grantId: replacement.grantId,
            now: new Date(now.getTime() + 90_000),
            verifier: authoritativeCollaborationGrantVerifierForTest(
              signing.signer,
            ),
          },
        }),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_ATTEMPT_ACTIVE'),
    );
    const recovered = runCli(repository, [
      'review-diff',
      'reconcile',
      session.sessionId,
      '--json',
    ]);
    assert.equal(recovered.status, 0, recovered.stderr);
    const completed = (
      JSON.parse(recovered.stdout) as {
        result: ReturnType<typeof submitExternalTaskDiffReview>;
      }
    ).result;
    assert.equal(completed.state, 'satisfied');
    assert.equal(
      inspectCollaborationGrants(
        discoverRepository(repository).gitCommonDirectory,
        grant.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      fs.existsSync(investigationRuntime(repository).invocations)
        ? fs.readdirSync(investigationRuntime(repository).invocations).length
        : 0,
      0,
    );
    assert.doesNotThrow(() =>
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId, {
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      }),
    );
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('direct-human TaskDiffReview pauses on exact evidence and resumes by verifying its attestation', () => {
  const signing = createTaskDiffReviewSigningFixture();
  const { repository } = createReviewFixture({
    configureAdapterPolicy(policy) {
      policy.providers.codex.enabled = false;
      policy.providers.claude.enabled = false;
    },
    configureMaintainerPolicy(policy) {
      policy.trustedSigners = [signing.trustedSigner];
    },
  });
  try {
    const repositoryOrigin = (
      JSON.parse(
        fs.readFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          'utf8',
        ),
      ) as { repository: { origin: string } }
    ).repository.origin;
    git(repository, ['remote', 'add', 'origin', repositoryOrigin]);
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
    const subject = inspectTaskDiffReviewSubject(repository, session.sessionId);
    const reviewedBlobObjectId = subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const input = {
      schemaVersion: 1 as const,
      kind: 'task-diff-review-submission-input.v1' as const,
      subjectDigest: subject.subjectDigest,
      submission: validTaskDiffSubmission(reviewedBlobObjectId, subject),
    };
    const now = new Date();
    const grant = issueCollaborationGrant(
      repository,
      {
        changeId: 'demo-change',
        taskId: '1.1',
        baselineCommit: subject.baseCommit,
        baselineTree: subject.baseTree,
        targetDigest: subject.subjectDigest,
        lifecyclePhase: 'task-diff-review',
        rolePair: {
          authorRole: 'task-implementer',
          conflictingRole: 'task-diff-reviewer',
        },
        availableActor: {
          kind: 'direct-human',
          identity: signing.trustedSigner.identity,
          assurance: 'maintainer-signed',
        },
        degradedForm: 'direct-human-review',
        reason:
          'A trusted maintainer directly reviewed this exact TaskDiff subject.',
        ttlMinutes: 30,
        maxUses: 1,
      },
      {
        grantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        now,
        signer: signing.signer,
      },
    );
    const pending = submitExternalTaskDiffReview(
      repository,
      session.sessionId,
      input,
      {
        explicitActor: 'codex',
        environment: {},
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        collaborationGrant: {
          grantId: grant.grantId,
          now: new Date(now.getTime() + 30_000),
          verifier: authoritativeCollaborationGrantVerifierForTest(
            signing.signer,
          ),
        },
      },
    );
    assert.equal(pending.state, 'direct-human-attestation-required');
    if (pending.state !== 'direct-human-attestation-required') {
      assert.fail('expected direct-human attestation pause');
    }
    assert.equal(pending.grantId, grant.grantId);
    assert.match(pending.transitionDigest, /^[0-9a-f]{64}$/);
    assert.match(pending.reviewNodeId, /^[0-9a-f]{64}$/);
    assert.match(pending.reviewResultDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      inspectTaskDiffReviewStatus(repository, session.sessionId),
      pending,
    );
    const grantStatePath = path.join(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
      'collaboration-grants',
      'reserved',
      `${grant.grantId}.json`,
    );
    const exactGrantState = fs.readFileSync(grantStatePath);
    const tamperedGrantState = JSON.parse(exactGrantState.toString()) as {
      envelope: { signature: string };
    };
    const signature = tamperedGrantState.envelope.signature;
    tamperedGrantState.envelope.signature = `${signature.slice(0, -2)}${signature.endsWith('A=') ? 'B=' : 'A='}`;
    fs.writeFileSync(grantStatePath, `${canonicalJson(tamperedGrantState)}\n`);
    let tamperError: unknown;
    try {
      inspectTaskDiffReviewStatus(repository, session.sessionId);
    } catch (error) {
      tamperError = error;
    }
    assert.ok(tamperError instanceof Error);
    fs.writeFileSync(grantStatePath, exactGrantState);
    assert.deepEqual(
      inspectTaskDiffReviewStatus(repository, session.sessionId),
      pending,
    );
    const attestation = createDirectHumanReviewAttestation(
      repository,
      {
        grantEnvelope: grant.envelope,
        transitionDigest: pending.transitionDigest,
        reviewNodeId: pending.reviewNodeId,
        reviewResultDigest: pending.reviewResultDigest,
      },
      {
        now: new Date(now.getTime() + 60_000),
        signer: signing.signer,
      },
    );
    const completed = submitExternalTaskDiffReview(
      repository,
      session.sessionId,
      input,
      {
        explicitActor: 'codex',
        environment: {},
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        collaborationGrant: {
          grantId: grant.grantId,
          now: new Date(now.getTime() + 90_000),
          verifier: authoritativeCollaborationGrantVerifierForTest(
            signing.signer,
          ),
          directHumanReviewAttestation: attestation,
        },
      },
    );
    assert.equal(completed.state, 'satisfied');
    assert.deepEqual(
      submitExternalTaskDiffReview(repository, session.sessionId, input, {
        explicitActor: 'codex',
        environment: {},
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        collaborationGrant: {
          grantId: grant.grantId,
          now: new Date(now.getTime() + 120_000),
          consumedReplayVerifier:
            consumedCollaborationGrantReplayVerifierForTest(
              repository,
              signing.signer,
            ),
          directHumanReviewAttestation: attestation,
        },
      }),
      completed,
    );
    assert.equal(
      fs.existsSync(investigationRuntime(repository).invocations)
        ? fs.readdirSync(investigationRuntime(repository).invocations).length
        : 0,
      0,
    );
    assert.doesNotThrow(() =>
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId, {
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      }),
    );
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an orphaned common grant reservation is read-only visible and only its exact authority may resume', () => {
  const signing = createTaskDiffReviewSigningFixture();
  const { repository } = createReviewFixture({
    configureAdapterPolicy(policy) {
      policy.providers.codex.enabled = false;
      policy.providers.claude.enabled = false;
    },
    configureMaintainerPolicy(policy) {
      policy.trustedSigners = [signing.trustedSigner];
    },
  });
  try {
    const repositoryOrigin = (
      JSON.parse(
        fs.readFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          'utf8',
        ),
      ) as { repository: { origin: string } }
    ).repository.origin;
    git(repository, ['remote', 'add', 'origin', repositoryOrigin]);
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
    const subject = inspectTaskDiffReviewSubject(repository, session.sessionId);
    const blob = subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(blob);
    const input = {
      schemaVersion: 1 as const,
      kind: 'task-diff-review-submission-input.v1' as const,
      subjectDigest: subject.subjectDigest,
      submission: validTaskDiffSubmission(blob, subject),
    };
    const now = new Date();
    const grant = issueCollaborationGrant(
      repository,
      externalReviewGrantInput(subject, 'orphan-reviewer'),
      {
        grantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        now,
        signer: signing.signer,
      },
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReview(repository, session.sessionId, input, {
          explicitActor: 'codex',
          environment: {},
          collaborationGrant: {
            grantId: grant.grantId,
            now: new Date(now.getTime() + 30_000),
            verifier: authoritativeCollaborationGrantVerifierForTest(
              signing.signer,
            ),
          },
          testCrashAfter: 'grant-reserved',
        }),
      /Simulated external TaskDiffReview interruption after grant reservation/,
    );
    const beforeStatus = snapshotRepositoryObservation(repository);
    const status = inspectTaskDiffReviewStatus(repository, session.sessionId);
    assert.equal(status.state, 'external-grant-resume-required');
    if (status.state !== 'external-grant-resume-required') {
      assert.fail('expected exact orphan grant recovery');
    }
    assert.equal(status.grantId, grant.grantId);
    assert.deepEqual(snapshotRepositoryObservation(repository), beforeStatus);

    const replacement = issueCollaborationGrant(
      repository,
      externalReviewGrantInput(subject, 'replacement-reviewer'),
      {
        grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        now,
        signer: signing.signer,
      },
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReview(repository, session.sessionId, input, {
          explicitActor: 'codex',
          environment: {},
          collaborationGrant: {
            grantId: replacement.grantId,
            now: new Date(now.getTime() + 60_000),
            verifier: authoritativeCollaborationGrantVerifierForTest(
              signing.signer,
            ),
          },
        }),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_ATTEMPT_ACTIVE'),
    );
    const completed = submitExternalTaskDiffReview(
      repository,
      session.sessionId,
      input,
      {
        explicitActor: 'codex',
        environment: {},
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        collaborationGrant: {
          grantId: grant.grantId,
          now: new Date(now.getTime() + 60_000),
          verifier: authoritativeCollaborationGrantVerifierForTest(
            signing.signer,
          ),
        },
      },
    );
    assert.equal(completed.state, 'satisfied');
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
