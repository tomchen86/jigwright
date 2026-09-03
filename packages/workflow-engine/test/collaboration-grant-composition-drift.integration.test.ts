import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import { sourceRepositoryRoot } from './fixture.ts';
import { createSshSignedFixture } from './support/ssh-signed-fixture.ts';
import { createTempEngineClone } from './support/temp-engine-clone.ts';

type AuthoritativeVerifier = Readonly<{
  compositionDigest: string;
  verify(
    payload: string,
    signature: string,
    identity: string,
    namespace: string,
  ): void;
}>;

type CompositionModule = Readonly<{
  createAuthoritativeCollaborationGrantVerifier(
    policy: Readonly<{
      trustedSigners: readonly Readonly<{
        identity: string;
        publicKey: string;
        fingerprint: string;
      }>[];
    }>,
    policyDigests: Readonly<{
      collaborationPolicyDigest: string;
      taskDiffReviewPolicyDigest: string;
    }>,
  ): AuthoritativeVerifier;
  productionConsumedPlanReviewReplayPort: Readonly<{
    verify(input: unknown): unknown;
  }>;
  productionConsumedRoleResultReplayPort: Readonly<{
    verify(input: unknown): unknown;
  }>;
}>;

type CollaborationGrantModule = Readonly<{
  COLLABORATION_GRANT_POLICY_DIGEST: string;
  TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST: string;
  issueCollaborationGrant(
    cwd: string,
    request: unknown,
    options: unknown,
  ): IssuedGrant;
}>;

type CollaborationGrantStoreModule = Readonly<{
  collaborationGrantStorePaths(gitCommonDirectory: string): {
    root: string;
    runtime: { root: string };
    available: string;
    reserved: string;
    terminal: string;
    revocationAuthorizations: string;
  };
  reserveCollaborationGrant(
    cwd: string,
    grantId: string,
    request: unknown,
  ): GrantReservation;
  consumeCollaborationGrant(
    gitCommonDirectory: string,
    grantId: string,
    request: unknown,
  ): GrantInspection;
  readReservedCollaborationGrant(
    gitCommonDirectory: string,
    grantId: string,
  ): GrantReservation;
  readCollaborationGrantInspection(
    gitCommonDirectory: string,
    grantId: string,
  ): GrantInspection | null;
  revokeCollaborationGrant(
    cwd: string,
    grantId: string,
    options: unknown,
  ): GrantInspection;
}>;

type CollaborationGrantCliModule = Readonly<{
  dispatchCollaborationGrantCommand(
    args: string[],
    cwd: string,
  ): Readonly<{ grants: readonly GrantInspection[] }>;
}>;

type RoleSchedulerModule = Readonly<{
  authorizeGrantedOrdinaryRole(input: unknown): unknown;
  admitConsumedRoleResultReplay(input: unknown): Readonly<{
    form: string;
    role: string;
    resultDigest: string;
  }>;
}>;

type GrantEnvelope = Readonly<{
  payload: Readonly<{
    grantId: string;
    repositoryId: string;
    repositoryOrigin: string;
    policyBlob: string;
    collaborationPolicyDigest: string;
    changeId: string;
    taskId: string | null;
    baselineCommit: string;
    baselineTree: string;
    targetDigest: string;
    lifecyclePhase: string;
    rolePair: unknown;
    availableActor: unknown;
    degradedForm: string;
    reason: string;
  }>;
  signature: string;
}>;

type IssuedGrant = Readonly<{
  grantId: string;
  envelope: GrantEnvelope;
}>;

type GrantReservation = Readonly<{
  state: 'reserved';
  transitionDigest: string;
  envelope: GrantEnvelope;
}>;

type GrantInspection = Readonly<{
  state: string;
  use?: Readonly<Record<string, unknown>> | null;
}>;

const SSH_SIGNING = createSshSignedFixture('clone-fixture-maintainer');
const REPLACEMENT_SSH_SIGNING = createSshSignedFixture(
  'clone-fixture-maintainer',
);
after(() => {
  SSH_SIGNING.dispose();
  REPLACEMENT_SSH_SIGNING.dispose();
});
const NOW = new Date('2026-08-21T00:00:00.000Z');
const TARGET_DIGEST = '1'.repeat(64);
const CONTENT_NODE_ID = '2'.repeat(64);
const CONTENT_RESULT_DIGEST = '3'.repeat(64);
const CLONE_POLICY = Object.freeze({
  schemaVersion: 1,
  repository: {
    id: 'github:R_composition_clone',
    origin: 'https://github.com/example/composition-clone.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [
    'packages/workflow-engine/src/**',
    'workflow/maintainer-policy.json',
  ],
  sealedImmutablePaths: ['workflow/maintainer-policy.json'],
  requiredChecks: ['fixture'],
  trustedSigners: [SSH_SIGNING.trustedSigner],
});

test('maintenance retry composition supplies the terminal consumed-role replay port', () => {
  const retryScheduler = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/runtime/provider-execution/provider-retry-scheduler.ts',
    ),
    'utf8',
  );
  const executionReplacement = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/application/control-plane/execution-replacement.ts',
    ),
    'utf8',
  );
  const providerWorker = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/entrypoints/worker/provider-worker.ts',
    ),
    'utf8',
  );
  const cli = fs.readFileSync(
    path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
    'utf8',
  );

  assert.match(
    retryScheduler,
    /ProcessProviderFailureRetryOptions[\s\S]*?consumedRoleResultReplay\?: ConsumedPlanReviewReplayPort/,
  );
  assert.match(
    retryScheduler,
    /publishReplacement\(\s*cwd,\s*failed,\s*options\.consumedRoleResultReplay,?\s*\)/,
  );
  assert.match(
    executionReplacement,
    /ExecuteGrantedReplacementOptions[\s\S]*?consumedRoleResultReplay\?: ConsumedPlanReviewReplayPort/,
  );
  const replacementStatusCalls = [
    ...executionReplacement.matchAll(/getProposeStatus\(([\s\S]*?)\);/g),
  ];
  assert.equal(replacementStatusCalls.length, 3);
  for (const [, args] of replacementStatusCalls) {
    assert.match(
      args!,
      /,\s*(?:collaborationGrantValidation|consumedRoleResultReplayValidation\(options\)),?\s*$/,
    );
  }
  assert.match(
    providerWorker,
    /processProviderFailureRetry\([\s\S]*?consumedRoleResultReplay:\s*productionConsumedPlanReviewReplayPort/,
  );
  assert.match(
    cli,
    /executeGrantedReplacement\([\s\S]*?consumedRoleResultReplay:\s*productionConsumedRoleResultReplayPort/,
  );
});

test('a dynamically loaded engine clone fails closed on drift without blocking terminal replay or human cleanup', async () => {
  const clone = await createTempEngineClone(sourceRepositoryRoot, {
    maintainerPolicy: CLONE_POLICY,
  });
  try {
    const [composition, collaborationGrant, store, roleScheduler, cli] =
      await Promise.all([
        clone.importModule<CompositionModule>(
          'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
        ),
        clone.importModule<CollaborationGrantModule>(
          'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
        ),
        clone.importModule<CollaborationGrantStoreModule>(
          'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
        ),
        clone.importModule<RoleSchedulerModule>(
          'packages/workflow-engine/src/modules/provider-orchestration/role-scheduler.ts',
        ),
        clone.importModule<CollaborationGrantCliModule>(
          'packages/workflow-engine/src/entrypoints/cli/collaboration-grant-cli.ts',
        ),
      ]);
    assert.equal(typeof store.reserveCollaborationGrant, 'function');
    assert.equal(typeof store.consumeCollaborationGrant, 'function');
    assert.equal(typeof store.readCollaborationGrantInspection, 'function');
    assert.equal(typeof store.revokeCollaborationGrant, 'function');

    const namespace = 'workflow.collaboration-grant.v2';
    const payload = 'clone-bound verifier payload\n';
    const mutableVerifierPolicy = {
      trustedSigners: [{ ...SSH_SIGNING.trustedSigner }],
    };
    const verifier = composition.createAuthoritativeCollaborationGrantVerifier(
      mutableVerifierPolicy,
      {
        collaborationPolicyDigest:
          collaborationGrant.COLLABORATION_GRANT_POLICY_DIGEST,
        taskDiffReviewPolicyDigest:
          collaborationGrant.TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
      },
    );
    verifier.verify(
      payload,
      SSH_SIGNING.sign(payload, namespace),
      SSH_SIGNING.trustedSigner.identity,
      namespace,
    );
    Object.assign(
      mutableVerifierPolicy.trustedSigners[0]!,
      REPLACEMENT_SSH_SIGNING.trustedSigner,
    );
    assert.throws(
      () =>
        verifier.verify(
          payload,
          REPLACEMENT_SSH_SIGNING.sign(payload, namespace),
          REPLACEMENT_SSH_SIGNING.trustedSigner.identity,
          namespace,
        ),
      (error) => hasWorkflowErrorCode(error, 'MAINTAINER_SIGNATURE_INVALID'),
    );

    const gitCommonDirectory = fs.realpathSync(
      clone.git(['rev-parse', '--absolute-git-dir']),
    );
    const baselineCommit = clone.git(['rev-parse', 'HEAD']);
    const baselineTree = clone.git(['rev-parse', `${baselineCommit}^{tree}`]);
    const issue = (grantId: string) =>
      collaborationGrant.issueCollaborationGrant(
        clone.repositoryRoot,
        {
          changeId: 'composition-drift',
          taskId: null,
          baselineCommit,
          baselineTree,
          targetDigest: TARGET_DIGEST,
          lifecyclePhase: 'blind-survey',
          rolePair: {
            authorRole: 'investigation-author',
            conflictingRole: 'plan-reviewer',
          },
          availableActor: {
            kind: 'provider',
            providerId: 'codex',
            assurance: 'runtime-hint',
          },
          degradedForm: 'same-provider-fresh-session',
          reason: 'No alternate provider is callable in the clone fixture.',
          ttlMinutes: 30,
          maxUses: 1,
        },
        { now: NOW, grantId, signer: SSH_SIGNING.signer() },
      );
    const available = issue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const reserved = issue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const consumed = issue('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const expectedBinding = (envelope: GrantEnvelope) => {
      const grant = envelope.payload;
      return {
        repositoryId: grant.repositoryId,
        repositoryOrigin: grant.repositoryOrigin,
        policyBlob: grant.policyBlob,
        collaborationPolicyDigest: grant.collaborationPolicyDigest,
        changeId: grant.changeId,
        taskId: grant.taskId,
        baselineCommit: grant.baselineCommit,
        baselineTree: grant.baselineTree,
        targetDigest: grant.targetDigest,
        lifecyclePhase: grant.lifecyclePhase,
        rolePair: grant.rolePair,
        availableActor: grant.availableActor,
        degradedForm: grant.degradedForm,
        reason: grant.reason,
      };
    };
    const reserve = (issued: IssuedGrant, transitionDigest: string) =>
      store.reserveCollaborationGrant(clone.repositoryRoot, issued.grantId, {
        transitionDigest,
        expected: expectedBinding(issued.envelope),
        now: new Date(NOW.getTime() + 60_000),
        verifier,
      });
    const reservedTransition = '4'.repeat(64);
    const consumedTransition = crypto
      .createHash('sha256')
      .update(
        canonicalJsonForTest({
          schemaVersion: 1,
          kind: 'collaboration-role-transition',
          expectedBinding: expectedBinding(consumed.envelope),
        }),
      )
      .digest('hex');
    const reservedRecord = reserve(reserved, reservedTransition);
    const consumedRecord = reserve(consumed, consumedTransition);
    const participant = (sessionId: string) => ({
      providerId: 'codex',
      sessionId,
      principalId: 'fixture-agent',
      identityAssurance: 'runtime-hint',
      engineSpawned: true,
    });
    const assignmentFor = (reservation: GrantReservation) =>
      roleScheduler.authorizeGrantedOrdinaryRole({
        role: 'plan-reviewer',
        author: participant(`author-${reservation.envelope.payload.grantId}`),
        targetDigest: TARGET_DIGEST,
        reservation,
        actualParticipant: participant(
          `worker-${reservation.envelope.payload.grantId}`,
        ),
        callableProviderIds: ['codex'],
      });
    const consumptionRequest = (
      reservation: GrantReservation,
      transitionDigest: string,
    ) => ({
      transitionDigest,
      assignment: assignmentFor(reservation),
      contentAdmission: {
        kind: 'blind-survey',
        nodeId: CONTENT_NODE_ID,
        resultDigest: CONTENT_RESULT_DIGEST,
        current: true,
      },
      now: new Date(NOW.getTime() + 120_000),
      verifier,
    });
    const reservedConsumption = consumptionRequest(
      reservedRecord,
      reservedTransition,
    );
    const consumedConsumption = consumptionRequest(
      consumedRecord,
      consumedTransition,
    );
    const consumedInspection = store.consumeCollaborationGrant(
      gitCommonDirectory,
      consumed.grantId,
      consumedConsumption,
    );
    assert.equal(consumedInspection.state, 'consumed');
    assert.ok(consumedInspection.use);

    const planReviewGrantRequest = {
      changeId: 'composition-drift',
      taskId: null,
      baselineCommit,
      baselineTree,
      targetDigest: TARGET_DIGEST,
      lifecyclePhase: 'plan-review',
      rolePair: {
        authorRole: 'plan-author',
        conflictingRole: 'plan-reviewer',
      },
      availableActor: {
        kind: 'provider',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
      degradedForm: 'same-provider-fresh-session',
      reason: 'Replay one exact consumed PlanReview after composition drift.',
      ttlMinutes: 30,
      maxUses: 1,
    };
    const planReviewGrant = collaborationGrant.issueCollaborationGrant(
      clone.repositoryRoot,
      planReviewGrantRequest,
      {
        now: NOW,
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        signer: SSH_SIGNING.signer(),
      },
    );
    const planReviewBinding = expectedBinding(planReviewGrant.envelope);
    const planReviewTransition = crypto
      .createHash('sha256')
      .update(
        canonicalJsonForTest({
          schemaVersion: 1,
          kind: 'collaboration-role-transition',
          expectedBinding: planReviewBinding,
        }),
      )
      .digest('hex');
    const planReviewReservation = reserve(
      planReviewGrant,
      planReviewTransition,
    );
    const planReviewAuthor = participant('plan-review-author');
    const planReviewParticipant = participant('plan-review-worker');
    const planReviewAssignment = roleScheduler.authorizeGrantedOrdinaryRole({
      role: 'plan-reviewer',
      author: planReviewAuthor,
      targetDigest: TARGET_DIGEST,
      reservation: planReviewReservation,
      actualParticipant: planReviewParticipant,
      callableProviderIds: ['codex'],
    });
    const reservedPlanReviewGrant = collaborationGrant.issueCollaborationGrant(
      clone.repositoryRoot,
      planReviewGrantRequest,
      {
        now: NOW,
        grantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        signer: SSH_SIGNING.signer(),
      },
    );
    const reservedPlanReviewBinding = expectedBinding(
      reservedPlanReviewGrant.envelope,
    );
    const reservedPlanReviewTransition = crypto
      .createHash('sha256')
      .update(
        canonicalJsonForTest({
          schemaVersion: 1,
          kind: 'collaboration-role-transition',
          expectedBinding: reservedPlanReviewBinding,
        }),
      )
      .digest('hex');
    const reservedPlanReviewReservation = reserve(
      reservedPlanReviewGrant,
      reservedPlanReviewTransition,
    );
    const reservedPlanReviewAssignment =
      roleScheduler.authorizeGrantedOrdinaryRole({
        role: 'plan-reviewer',
        author: participant('reserved-plan-review-author'),
        targetDigest: TARGET_DIGEST,
        reservation: reservedPlanReviewReservation,
        actualParticipant: participant('reserved-plan-review-worker'),
        callableProviderIds: ['codex'],
      });
    const planReviewContent = {
      kind: 'plan-review',
      nodeId: CONTENT_NODE_ID,
      resultDigest: CONTENT_RESULT_DIGEST,
      outputSchema: {
        id: 'fixture.plan-review-output.v1',
        version: 1,
        digest: '6'.repeat(64),
      },
      evaluator: 'fixture.plan-review.v1',
      policyDigest: '7'.repeat(64),
      contentDigest: CONTENT_RESULT_DIGEST,
      current: true,
    };
    const planReviewConsumed = store.consumeCollaborationGrant(
      gitCommonDirectory,
      planReviewGrant.grantId,
      {
        transitionDigest: planReviewTransition,
        assignment: planReviewAssignment,
        contentAdmission: {
          kind: planReviewContent.kind,
          nodeId: planReviewContent.nodeId,
          resultDigest: planReviewContent.resultDigest,
          current: true,
        },
        now: new Date(NOW.getTime() + 120_000),
        verifier,
      },
    );
    assert.equal(planReviewConsumed.state, 'consumed');
    assert.ok(planReviewConsumed.use);

    clone.appendCompositionDrift(
      'packages/grants/src/grant-envelope-verifier.ts',
    );
    assert.throws(
      () =>
        verifier.verify(
          `${payload}tampered`,
          'not-an-ssh-signature',
          SSH_SIGNING.trustedSigner.identity,
          namespace,
        ),
      (error) =>
        hasWorkflowErrorCode(
          error,
          'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
        ),
    );

    const grantStoreRoot =
      store.collaborationGrantStorePaths(gitCommonDirectory).root;
    let before = snapshotTree(grantStoreRoot);
    const consumedAuthor = participant(`author-${consumed.grantId}`);
    const consumedParticipant = participant(`worker-${consumed.grantId}`);
    const consumedAssignment = assignmentFor(consumedRecord);
    const blindContent = {
      kind: 'blind-survey',
      nodeId: CONTENT_NODE_ID,
      resultDigest: CONTENT_RESULT_DIGEST,
      outputSchema: {
        id: 'fixture.blind-survey-output.v1',
        version: 1,
        digest: 'a'.repeat(64),
      },
      evaluator: 'fixture.blind-survey.v1',
      policyDigest: 'b'.repeat(64),
      contentDigest: CONTENT_RESULT_DIGEST,
      current: true,
    };
    const blindReplay =
      composition.productionConsumedRoleResultReplayPort.verify({
        repositoryRoot: clone.repositoryRoot,
        expectedBinding: expectedBinding(consumed.envelope),
        grantUse: consumedInspection.use,
        assignment: consumedAssignment,
        content: blindContent,
        directHumanReviewAttestation: null,
      });
    const replayedBlindSurvey = roleScheduler.admitConsumedRoleResultReplay({
      assignment: consumedAssignment,
      author: consumedAuthor,
      participant: consumedParticipant,
      content: blindContent,
      providerInvocation: {
        invocationId: 'fixture-blind-survey-consumed-replay',
        requestDigest: 'c'.repeat(64),
        outputDigest: 'd'.repeat(64),
        providerId: 'codex',
        sessionId: `worker-${consumed.grantId}`,
        targetDigest: TARGET_DIGEST,
        engineSpawned: true,
      },
      replay: blindReplay,
    });
    assert.equal(replayedBlindSurvey.form, 'granted-same-provider');
    assert.equal(replayedBlindSurvey.role, 'plan-reviewer');
    assert.deepEqual(snapshotTree(grantStoreRoot), before);
    const replayInput = {
      repositoryRoot: clone.repositoryRoot,
      expectedBinding: planReviewBinding,
      grantUse: planReviewConsumed.use,
      assignment: planReviewAssignment,
      content: planReviewContent,
      directHumanReviewAttestation: null,
    };
    assert.throws(() =>
      composition.productionConsumedPlanReviewReplayPort.verify({
        repositoryRoot: clone.repositoryRoot,
        expectedBinding: reservedPlanReviewBinding,
        grantUse: {
          grantId: reservedPlanReviewGrant.grantId,
          transitionDigest: reservedPlanReviewTransition,
        },
        assignment: reservedPlanReviewAssignment,
        content: planReviewContent,
        directHumanReviewAttestation: null,
      }),
    );
    assert.deepEqual(snapshotTree(grantStoreRoot), before);
    const replay =
      composition.productionConsumedPlanReviewReplayPort.verify(replayInput);
    const planReviewProviderAssignment = planReviewAssignment as Readonly<{
      providerId: 'codex';
      sessionId: string;
      targetDigest: string;
    }>;
    const replayedRoleResult = roleScheduler.admitConsumedRoleResultReplay({
      assignment: planReviewAssignment,
      author: planReviewAuthor,
      participant: planReviewParticipant,
      content: planReviewContent,
      providerInvocation: {
        invocationId: 'fixture-plan-review-consumed-replay',
        requestDigest: '8'.repeat(64),
        outputDigest: '9'.repeat(64),
        providerId: planReviewProviderAssignment.providerId,
        sessionId: planReviewProviderAssignment.sessionId,
        targetDigest: planReviewProviderAssignment.targetDigest,
        engineSpawned: true,
      },
      replay,
    });
    assert.equal(replayedRoleResult.form, 'granted-same-provider');
    assert.equal(replayedRoleResult.role, 'plan-reviewer');
    assert.deepEqual(snapshotTree(grantStoreRoot), before);
    assert.throws(() =>
      composition.productionConsumedPlanReviewReplayPort.verify({
        ...replayInput,
        expectedBinding: {
          ...planReviewBinding,
          targetDigest: 'f'.repeat(64),
        },
      }),
    );
    assert.deepEqual(snapshotTree(grantStoreRoot), before);

    const planReviewTerminalPath = path.join(
      store.collaborationGrantStorePaths(gitCommonDirectory).terminal,
      `${planReviewGrant.grantId}.json`,
    );
    const authenticTerminal = fs.readFileSync(planReviewTerminalPath, 'utf8');
    const forgedTerminal = JSON.parse(authenticTerminal) as {
      envelope: { signature: string };
      use: { envelope: { signature: string } };
    };
    forgedTerminal.envelope.signature = 'forged-plan-review-signature';
    forgedTerminal.use.envelope.signature = 'forged-plan-review-signature';
    fs.writeFileSync(
      planReviewTerminalPath,
      `${JSON.stringify(forgedTerminal)}\n`,
    );
    assert.throws(() =>
      composition.productionConsumedPlanReviewReplayPort.verify(replayInput),
    );
    fs.writeFileSync(planReviewTerminalPath, authenticTerminal);
    assert.deepEqual(snapshotTree(grantStoreRoot), before);

    assert.throws(
      () => reserve(available, '6'.repeat(64)),
      (error) =>
        hasWorkflowErrorCode(
          error,
          'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
        ),
    );
    assert.deepEqual(snapshotTree(grantStoreRoot), before);

    before = snapshotTree(grantStoreRoot);
    assert.throws(
      () =>
        store.consumeCollaborationGrant(
          gitCommonDirectory,
          reserved.grantId,
          reservedConsumption,
        ),
      (error) =>
        hasWorkflowErrorCode(
          error,
          'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
        ),
    );
    assert.deepEqual(snapshotTree(grantStoreRoot), before);

    assert.equal(
      store.readCollaborationGrantInspection(
        gitCommonDirectory,
        available.grantId,
      )?.state,
      'available',
    );
    assert.equal(
      store.readCollaborationGrantInspection(
        gitCommonDirectory,
        reserved.grantId,
      )?.state,
      'reserved',
    );
    assert.equal(
      store.readCollaborationGrantInspection(
        gitCommonDirectory,
        consumed.grantId,
      )?.state,
      'consumed',
    );

    before = snapshotTree(grantStoreRoot);
    assert.equal(
      store.consumeCollaborationGrant(
        gitCommonDirectory,
        consumed.grantId,
        consumedConsumption,
      ).state,
      'consumed',
    );
    assert.deepEqual(snapshotTree(grantStoreRoot), before);
    assert.throws(
      () => reserve(consumed, consumedTransition),
      (error) => hasWorkflowErrorCode(error, 'COLLABORATION_GRANT_UNAVAILABLE'),
    );
    assert.deepEqual(snapshotTree(grantStoreRoot), before);

    const revoked = store.revokeCollaborationGrant(
      clone.repositoryRoot,
      available.grantId,
      {
        reason: 'Test-only cleanup after verifier composition drift.',
        now: new Date(NOW.getTime() + 180_000),
        signer: SSH_SIGNING.signer(),
      },
    );
    assert.equal(revoked.state, 'revoked');
    assert.equal(
      store.readCollaborationGrantInspection(
        gitCommonDirectory,
        available.grantId,
      )?.state,
      'revoked',
    );

    const invalidLate = issue('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    const invalidPaths = store.collaborationGrantStorePaths(gitCommonDirectory);
    for (const directory of [
      invalidPaths.reserved,
      invalidPaths.terminal,
      invalidPaths.revocationAuthorizations,
    ]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    const beforeInvalidReserve = snapshotTree(invalidPaths.root);
    assert.throws(() =>
      store.reserveCollaborationGrant(
        clone.repositoryRoot,
        invalidLate.grantId,
        {
          transitionDigest: '8'.repeat(64),
          expected: {
            ...expectedBinding(invalidLate.envelope),
            targetDigest: 'f'.repeat(64),
          },
          now: new Date(NOW.getTime() + 240_000),
        },
      ),
    );
    assert.deepEqual(snapshotTree(invalidPaths.root), beforeInvalidReserve);

    const grantStoreRootMissing =
      store.collaborationGrantStorePaths(gitCommonDirectory).root;
    const grantStoreParent = path.dirname(grantStoreRootMissing);
    fs.rmSync(grantStoreRootMissing, { recursive: true, force: true });
    const beforeMissingStore = snapshotTree(grantStoreParent);
    assert.throws(() => reserve(available, '7'.repeat(64)));
    assert.throws(() =>
      store.consumeCollaborationGrant(
        gitCommonDirectory,
        reserved.grantId,
        reservedConsumption,
      ),
    );
    assert.throws(() =>
      store.readReservedCollaborationGrant(
        gitCommonDirectory,
        reserved.grantId,
      ),
    );
    assert.deepEqual(
      cli.dispatchCollaborationGrantCommand(
        ['collaboration-inspect'],
        clone.repositoryRoot,
      ).grants,
      [],
    );
    assert.equal(fs.existsSync(grantStoreRootMissing), false);
    assert.deepEqual(snapshotTree(grantStoreParent), beforeMissingStore);
  } finally {
    clone.dispose();
  }
});

function hasWorkflowErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: unknown }).code === code
  );
}

function canonicalJsonForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`)
    .join(',')}}`;
}

function snapshotTree(root: string): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        visit(target, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(target))
          .digest('hex');
      } else {
        throw new Error('Grant store fixture contains an unsafe path.');
      }
    }
  };
  visit(root, '');
  return Object.freeze(snapshot);
}
