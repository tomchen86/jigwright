import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureGovernanceSource } from '../src/composition-root/governance-sources-production.ts';
import {
  createWorkRegistryPromotionGrantRequest,
  createWorkRegistryReviewGrantRequest,
  workRegistryGrantTransitionDefinitions,
} from '../src/composition-root/work-registry-grant-production.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { createWorkRegistryFailGrantResult } from '../src/entrypoints/cli/workflow-cli.ts';
import { createGrantChallenge } from '../src/modules/authority/grant-core.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/storage-journal/grant-store.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  prepareWorkItemPromotionSurvey,
  reconcileArchivedWorkItems,
  showWorkItem,
  workItemDigest,
} from '../src/composition-root/work-registry-production.ts';
import {
  runGitForTest,
  configureRepositoryConsumer,
  workRegistryGrantPolicy,
  hasCode,
} from './governance-intake-fixture.ts';
test('protected intake produces one exact Central Fail-Grant challenge', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-protected-intake-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const item = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Protected intake candidate',
        summary: 'This transition is repository-policy protected.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:48:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000D',
      },
    ).item;
    fs.mkdirSync(path.join(repositoryRoot, 'workflow'), { recursive: true });
    fs.writeFileSync(
      path.join(repositoryRoot, 'workflow/work-registry-policy.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        transitions: {
          intake: 'central-grant',
          prioritize: 'ordinary',
          promote: 'central-grant',
        },
      })}\n`,
    );
    const reviewPath = path.join(repositoryRoot, 'review.json');
    fs.writeFileSync(
      reviewPath,
      `${JSON.stringify({
        action: 'accept',
        expectedDigest: workItemDigest(item),
        summary: item.interpretation.summary,
      })}\n`,
    );

    const args = ['work-item', 'review', item.id, '--input', reviewPath];
    let failure: unknown;
    try {
      dispatchGovernanceIntakeCommand(
        'work-item',
        ['review', item.id, '--input', reviewPath],
        repositoryRoot,
      );
      assert.fail('expected protected Work Registry review to require Grant');
    } catch (error) {
      failure = error;
    }
    assert.ok(hasCode('WORK_REGISTRY_GRANT_REQUIRED')(failure));
    fs.unlinkSync(reviewPath);

    const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const challengeDigest = `sha256:${'b'.repeat(64)}` as const;
    const result = await createWorkRegistryFailGrantResult(
      args,
      repositoryRoot,
      failure,
      {
        async requestReview(cwd, workItemId, review, proposedReason) {
          assert.equal(cwd, repositoryRoot);
          assert.equal(workItemId, item.id);
          assert.deepEqual(review, {
            action: 'accept',
            expectedDigest: workItemDigest(item),
            summary: item.interpretation.summary,
          });
          assert.match(
            proposedReason,
            /exact accept Work Registry transition/u,
          );
          return { challengeId, challengeDigest };
        },
        async requestPromotion() {
          assert.fail('review must not request a promotion Grant');
        },
      },
    );
    assert.deepEqual(result, {
      command: 'work-item',
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'workflow-fail-grant-required.v1',
        workItemId: item.id,
        transition: 'intake',
        state: 'human-action-required',
        nextAction: 'human-action',
        failure: {
          code: 'WORK_REGISTRY_GRANT_REQUIRED',
          message:
            'Repository policy requires Central Grant for the intake transition.',
          details: {
            schemaVersion: 1,
            kind: 'work-registry-grant-required.v1',
            operation: 'review',
            transition: 'intake',
            workItemId: item.id,
            review: {
              action: 'accept',
              expectedDigest: workItemDigest(item),
              summary: item.interpretation.summary,
            },
          },
        },
        grant: { challengeId, challengeDigest },
        transitionAppliesOnDecision: true,
        inputSchema: {
          schemaVersion: 1,
          kind: 'central-grant-resolution.v1',
          inspectCommand: `pnpm workflow grant human inspect ${challengeId} --json`,
          decisionCommand: `pnpm workflow grant human decide ${challengeId} --json`,
          recoveryCommand: `pnpm workflow grant human recover ${challengeId} --json`,
          observeAfterDecision: `pnpm workflow work-item show ${item.id} --json`,
        },
      },
    });
    assert.deepEqual(
      workflowResultNextSteps(result!, args).map(({ command }) => command),
      [
        `pnpm workflow grant human inspect ${challengeId} --json`,
        `pnpm workflow grant human decide ${challengeId} --json`,
        `pnpm workflow work-item show ${item.id} --json`,
      ],
    );
    assert.equal(showWorkItem(repositoryRoot, item.id).stage, 'inbox');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
test('Work Registry Fail-Grant mapper preserves exact transition semantics', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-fail-grant-map-'),
  );
  try {
    const workItemId = 'WORK-01K39R0V00000000000000000F';
    const digest = `sha256:${'c'.repeat(64)}`;
    const challengeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const challengeDigest = `sha256:${'d'.repeat(64)}` as const;
    const calls: unknown[][] = [];
    const dependencies = {
      async requestReview(...values: unknown[]) {
        calls.push(['review', ...values]);
        return { challengeId, challengeDigest };
      },
      async requestPromotion(...values: unknown[]) {
        calls.push(['promote', ...values]);
        return { challengeId, challengeDigest };
      },
    };
    const cases = [
      {
        transition: 'intake',
        args: ['work-item', 'review', workItemId, '--input', 'accept.json'],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: 'intake',
          workItemId,
          review: { action: 'accept', expectedDigest: digest, summary: 'Keep' },
        },
        requestKind: 'review',
      },
      {
        transition: 'intake',
        args: ['work-item', 'review', workItemId, '--input', 'decline.json'],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: 'intake',
          workItemId,
          review: {
            action: 'decline',
            expectedDigest: digest,
            outcome: 'obsolete',
          },
        },
        requestKind: 'review',
      },
      {
        transition: 'prioritize',
        args: ['work-item', 'review', workItemId, '--input', 'prioritize.json'],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: 'prioritize',
          workItemId,
          review: {
            action: 'prioritize',
            expectedDigest: digest,
            lane: 'next',
            blockedBy: [],
          },
        },
        requestKind: 'review',
      },
      {
        transition: 'promote',
        args: [
          'work-item',
          'promote',
          workItemId,
          '--change',
          'promoted-change',
          '--expected',
          digest,
        ],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'promote',
          transition: 'promote',
          workItemId,
          changeId: 'promoted-change',
          expectedDigest: digest,
        },
        requestKind: 'promote',
      },
      {
        transition: 'promote',
        args: ['now', workItemId],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'promote',
          transition: 'promote',
          workItemId,
          changeId: `work-${workItemId.slice('WORK-'.length).toLowerCase()}`,
          expectedDigest: digest,
        },
        requestKind: 'promote',
      },
    ] as const;

    for (const entry of cases) {
      calls.length = 0;
      const result = await createWorkRegistryFailGrantResult(
        entry.args,
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          { details: entry.details },
        ),
        dependencies,
      );
      assert.equal(
        (result?.result as { transition: string }).transition,
        entry.transition,
      );
      assert.equal(result?.command, entry.args[0]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[0], entry.requestKind);
      assert.equal(calls[0]?.[1], repositoryRoot);
      assert.equal(calls[0]?.[2], workItemId);
      if (entry.details.operation === 'review') {
        assert.deepEqual(calls[0]?.[3], entry.details.review);
        assert.match(
          String(calls[0]?.[4]),
          new RegExp(`exact ${entry.details.review.action}`),
        );
      } else {
        assert.equal(calls[0]?.[3], entry.details.changeId);
        assert.equal(calls[0]?.[4], entry.details.expectedDigest);
        assert.match(String(calls[0]?.[5]), /exact Work Registry promotion/u);
      }
    }

    let requestCount = 0;
    const mustNotRequest = {
      async requestReview() {
        requestCount += 1;
        return { challengeId, challengeDigest };
      },
      async requestPromotion() {
        requestCount += 1;
        return { challengeId, challengeDigest };
      },
    };
    assert.equal(
      await createWorkRegistryFailGrantResult(
        ['work-item', 'review', workItemId, '--input', 'review.json'],
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          {
            details: {
              ...cases[0].details,
              unexpected: true,
            },
          },
        ),
        mustNotRequest,
      ),
      null,
    );
    assert.equal(
      await createWorkRegistryFailGrantResult(
        [
          'work-item',
          'promote',
          workItemId,
          '--change',
          'other-change',
          '--expected',
          digest,
        ],
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          { details: cases[3].details },
        ),
        mustNotRequest,
      ),
      null,
    );
    assert.equal(requestCount, 0);

    const sentinel = new Error('policy changed before challenge creation');
    await assert.rejects(
      createWorkRegistryFailGrantResult(
        cases[0].args,
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          { details: cases[0].details },
        ),
        {
          async requestReview() {
            throw sentinel;
          },
          async requestPromotion() {
            assert.fail('review must not request promotion');
          },
        },
      ),
      (error) => error === sentinel,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
test('registered Central Grant review transition applies the exact reviewed item once', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-grant-transition-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const item = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Grant-routed intake candidate',
        summary: 'Central Grant executes only this exact reviewed mutation.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:49:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000E',
      },
    ).item;
    const review = {
      action: 'accept' as const,
      expectedDigest: workItemDigest(item),
      summary: item.interpretation.summary,
    };
    const definitions = workRegistryGrantTransitionDefinitions(
      repositoryRoot,
      () => '2026-08-24T04:50:00.000Z',
    );
    const registry = createTransitionRegistry(definitions);
    const request = createWorkRegistryReviewGrantRequest({
      repositoryRoot,
      workItemId: item.id,
      review,
      proposedReason: 'Approve the exact reviewed intake transition.',
    });
    const challenge = createGrantChallenge(request, registry, {
      challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      now: new Date('2026-08-24T04:49:30.000Z'),
      expiresAt: '2026-08-24T05:09:30.000Z',
    });
    assert.equal(challenge.choices[0]?.transitionId, 'work-registry.review.v1');
    const definition = registry.resolve('work-registry.review.v1');
    const parameters = definition.validateParameters(
      challenge.choices[0]?.parameters,
    );
    const outcome = await definition.execute({
      parameters,
      approvalSubject: {} as never,
      approvalSubjectDigest: `sha256:${'a'.repeat(64)}`,
      challengeId: challenge.challengeId,
      operationId: 'operation-work-registry-review',
      recovered: false,
      assertLifecycleOwned() {},
    });
    assert.equal(outcome.outcome, 'completed');
    assert.equal(showWorkItem(repositoryRoot, item.id).stage, 'backlog');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

function promotionAssertions(repositoryRoot: string) {
  const createPromotionChallenge = (
    workItemId: string,
    changeId: string,
    expectedDigest: string,
    challengeId: string,
    promotedAt: string,
  ) => {
    const registry = createTransitionRegistry(
      workRegistryGrantTransitionDefinitions(repositoryRoot, () => promotedAt),
    );
    const request = createWorkRegistryPromotionGrantRequest({
      repositoryRoot,
      workItemId,
      changeId,
      expectedDigest,
      proposedReason: 'Approve this exact surveyed Work Registry promotion.',
    });
    const challenge = createGrantChallenge(request, registry, {
      challengeId,
      now: new Date('2026-08-24T05:02:00.000Z'),
      expiresAt: '2026-08-24T05:22:00.000Z',
    });
    assert.equal(
      challenge.choices[0]?.transitionId,
      'work-registry.promote.v1',
    );
    const definition = registry.resolve('work-registry.promote.v1');
    return {
      challengeId,
      definition,
      parameters: definition.validateParameters(
        challenge.choices[0]?.parameters,
      ),
    };
  };
  return { createPromotionChallenge };
}

function createPromotionFixture() {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-grant-promotion-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  const cleanup = () =>
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  try {
    const { createPromotionChallenge } = promotionAssertions(repositoryRoot);
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(repositoryRoot, [
      'config',
      'user.email',
      'jigwright@example.test',
    ]);
    const agentSource = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'agent',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:57:30.000Z',
      contextRef: 'session:protected-promotion-survey',
      text: 'Bind protected promotion to current agent survey evidence.\n',
      supersedes: null,
    }).source;
    const prepareCandidate = (
      workItemId: string,
      changeId: string,
      createdAt: string,
      acceptedAt: string,
      sourceRefs: readonly string[] = [agentSource.id],
    ) => {
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Grant promotion for ${changeId}`,
          summary: 'Central Grant applies one exact surveyed promotion.',
          sourceRefs,
        },
        {
          now: () => createdAt,
          createId: () => workItemId,
        },
      );
      const accepted = applyWorkItemReview(
        repositoryRoot,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => acceptedAt,
      );
      const changeDirectory = path.join(
        repositoryRoot,
        'openspec/changes',
        changeId,
      );
      fs.mkdirSync(changeDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(changeDirectory, 'proposal.md'),
        `# ${changeId}\n`,
      );
      return { created, accepted, changeDirectory };
    };
    const executePromotion = (
      transition: ReturnType<typeof createPromotionChallenge>,
      operationId: string,
      recovered = false,
      assertLifecycleOwned: () => void = () => undefined,
    ) =>
      transition.definition.execute({
        parameters: transition.parameters,
        approvalSubject: {} as never,
        approvalSubjectDigest: `sha256:${'a'.repeat(64)}`,
        challengeId: transition.challengeId,
        operationId,
        recovered,
        assertLifecycleOwned,
      });
    const snapshotPromotion = (
      itemPath: string,
      originPath: string,
      surveyPath: string,
    ) => ({
      item: fs.readFileSync(itemPath, 'utf8'),
      origin: fs.existsSync(originPath)
        ? fs.readFileSync(originPath, 'utf8')
        : null,
      survey: fs.existsSync(surveyPath)
        ? fs.readFileSync(surveyPath, 'utf8')
        : null,
      head: runGitForTest(repositoryRoot, ['rev-parse', 'HEAD']),
      refs: runGitForTest(repositoryRoot, ['show-ref']),
      status: runGitForTest(repositoryRoot, ['status', '--porcelain=v1', '-z']),
    });
    const promotionReceiptRoot = path.join(
      repositoryRoot,
      '.git/workflow-engine/work-registry/recovered-promotions',
    );
    const grantRuntimeRoot = path.join(repositoryRoot, '.git/workflow-engine');
    const createCoordinator = (options: {
      challengeId: string;
      operationId: string;
      crashAfterCommit?: Error;
      crashAfterPrepare?: Error;
    }) => {
      const ids = [options.challengeId, options.operationId];
      return createGrantCoordinatorKernel({
        store: createFileGrantRecordStore(grantStorePaths(grantRuntimeRoot)),
        registry: createTransitionRegistry(
          workRegistryGrantTransitionDefinitions(
            repositoryRoot,
            () => '2026-08-24T05:09:00.000Z',
            options.crashAfterCommit
              ? {
                  afterTransactionCommitted() {
                    throw options.crashAfterCommit;
                  },
                }
              : {},
          ),
        ),
        policy: workRegistryGrantPolicy(),
        now: () => new Date('2026-08-24T05:08:30.000Z'),
        randomUUID: () => ids.shift()!,
        openApprovalSession(presentation) {
          return {
            async collectDecision() {
              return {
                choiceId: presentation.choices[0]!.choiceId,
                approvalMethod: 'human-presence' as const,
                reasonCode: 'approve-work-registry-transition',
                reason: 'Approve and recover this exact Work Item promotion.',
                sessionNonce: 'nonce-77777777777777777777777777777777',
              };
            },
            async authenticate({ approvalSubjectDigest }) {
              return [
                {
                  moduleId: 'human-gate-macos',
                  version: '1',
                  claims: ['fresh-local-device-owner'] as const,
                  approvalSubjectDigest,
                  proofDigest: `sha256:${'7'.repeat(64)}` as const,
                  verifiedAt: '2026-08-24T05:08:30.000Z',
                  identity: null,
                  portableEvidence: null,
                },
              ];
            },
            async close() {},
          };
        },
        async withLifecycleOperation(_requestedChallengeId, operation) {
          let assertions = 0;
          return operation(() => {
            assertions += 1;
            if (assertions === 3 && options.crashAfterPrepare) {
              throw options.crashAfterPrepare;
            }
          });
        },
      });
    };
    return {
      repositoryRoot,
      agentSource,
      prepareCandidate,
      executePromotion,
      snapshotPromotion,
      promotionReceiptRoot,
      grantRuntimeRoot,
      createCoordinator,
      createPromotionChallenge,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe('registered Central Grant promotion binds an exact conditional survey decision and rejects replay or stale evidence without mutation', () => {
  test('binds completed promotion receipts and refuses altered replay', async () => {
    const {
      repositoryRoot,
      prepareCandidate,
      executePromotion,
      snapshotPromotion,
      promotionReceiptRoot,
      createPromotionChallenge,
      cleanup,
    } = createPromotionFixture();
    try {
      const current = prepareCandidate(
        'WORK-01K39R0V00000000000000000G',
        'grant-promoted-current',
        '2026-08-24T04:58:00.000Z',
        '2026-08-24T04:59:00.000Z',
        [],
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare current promotion',
      ]);
      const currentTransition = createPromotionChallenge(
        current.accepted.id,
        'grant-promoted-current',
        workItemDigest(current.accepted),
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '2026-08-24T05:03:00.000Z',
      );
      const outcome = await executePromotion(
        currentTransition,
        'operation-work-registry-promotion',
      );
      assert.deepEqual(outcome, {
        outcome: 'completed',
        details: {
          action: 'promote',
          workItemId: current.accepted.id,
          changeId: 'grant-promoted-current',
        },
      });
      const currentItemPath = path.join(
        repositoryRoot,
        current.created.relativePath,
      );
      const currentOriginPath = path.join(
        current.changeDirectory,
        'origin.json',
      );
      const currentSurveyPath = path.join(
        current.changeDirectory,
        'survey.json',
      );
      assert.deepEqual(showWorkItem(repositoryRoot, current.accepted.id), {
        ...current.accepted,
        stage: 'active',
        changeRefs: ['grant-promoted-current'],
        timeline: [
          ...current.accepted.timeline,
          {
            at: '2026-08-24T05:03:00.000Z',
            event: 'promoted',
            changeId: 'grant-promoted-current',
          },
        ],
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(currentOriginPath, 'utf8')), {
        schemaVersion: 1,
        sourceRefs: [],
        workItemRefs: [current.accepted.id],
      });
      const afterCurrentPromotion = snapshotPromotion(
        currentItemPath,
        currentOriginPath,
        currentSurveyPath,
      );
      const [currentReceiptName] = fs.readdirSync(promotionReceiptRoot);
      assert.ok(currentReceiptName);
      const currentReceipt = JSON.parse(
        fs.readFileSync(
          path.join(promotionReceiptRoot, currentReceiptName),
          'utf8',
        ),
      ) as { grantBinding: unknown };
      assert.deepEqual(currentReceipt.grantBinding, {
        schemaVersion: 1,
        challengeId: currentTransition.challengeId,
        operationId: 'operation-work-registry-promotion',
        approvalSubjectDigest: `sha256:${'a'.repeat(64)}`,
        surveyBinding: (
          currentTransition.parameters as {
            preparationBinding: { surveyPreparation: { binding: unknown } };
          }
        ).preparationBinding.surveyPreparation.binding,
      });
      await assert.rejects(
        executePromotion(
          currentTransition,
          'operation-work-registry-promotion-replay',
          true,
        ),
        hasCode('WORK_REGISTRY_GRANT_STALE'),
      );
      await assert.rejects(
        executePromotion(
          {
            ...currentTransition,
            challengeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          },
          'operation-work-registry-promotion',
          true,
        ),
        hasCode('WORK_REGISTRY_GRANT_STALE'),
      );
      await assert.rejects(
        executePromotion(
          {
            ...currentTransition,
            parameters: {
              ...(currentTransition.parameters as Record<string, unknown>),
              preparationBinding: {
                ...(
                  currentTransition.parameters as {
                    preparationBinding: Record<string, unknown>;
                  }
                ).preparationBinding,
                surveyPreparation: {
                  kind: 'not-required',
                  binding: {
                    schemaVersion: 1,
                    kind: 'not-required',
                    reason: 'pure-maintainer-sources',
                    sourceRefsDigest: `sha256:${'9'.repeat(64)}`,
                  },
                },
              },
            },
          },
          'operation-work-registry-promotion',
          true,
        ),
        hasCode('WORK_REGISTRY_GRANT_STALE'),
      );
      assert.deepEqual(
        snapshotPromotion(
          currentItemPath,
          currentOriginPath,
          currentSurveyPath,
        ),
        afterCurrentPromotion,
      );
    } finally {
      cleanup();
    }
  });

  test('refuses a foreign target created after exact Grant approval', async () => {
    const {
      repositoryRoot,
      agentSource,
      executePromotion,
      createPromotionChallenge,
      cleanup,
    } = createPromotionFixture();
    try {
      const foreignTarget = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: 'Reject a foreign change after Grant challenge',
          summary: 'The accepted Grant owns only its exact absent target.',
          sourceRefs: [agentSource.id],
        },
        {
          now: () => '2026-08-24T05:03:10.000Z',
          createId: () => 'WORK-01K39R0V00000000000000000S',
        },
      );
      const foreignAccepted = applyWorkItemReview(
        repositoryRoot,
        foreignTarget.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(foreignTarget.item),
          summary: foreignTarget.item.interpretation.summary,
        },
        () => '2026-08-24T05:03:20.000Z',
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare absent promotion target',
      ]);
      const foreignTransition = createPromotionChallenge(
        foreignAccepted.id,
        'grant-promoted-foreign-target',
        workItemDigest(foreignAccepted),
        'abababab-abab-4bab-8bab-abababababab',
        '2026-08-24T05:03:30.000Z',
      );
      const foreignDirectory = path.join(
        repositoryRoot,
        'openspec/changes/grant-promoted-foreign-target',
      );
      assert.equal(fs.existsSync(foreignDirectory), false);
      fs.mkdirSync(foreignDirectory, { recursive: true });
      const foreignPath = path.join(foreignDirectory, 'proposal.md');
      const foreignBytes = '# Foreign planning state\n';
      fs.writeFileSync(foreignPath, foreignBytes);
      fs.chmodSync(foreignDirectory, 0o700);
      const foreignItemPath = path.join(
        repositoryRoot,
        foreignTarget.relativePath,
      );
      const foreignItemBytes = fs.readFileSync(foreignItemPath, 'utf8');
      await assert.rejects(
        executePromotion(
          foreignTransition,
          'operation-work-registry-promotion-foreign-target',
        ),
        hasCode('WORK_REGISTRY_GRANT_STALE'),
      );
      assert.equal(fs.readFileSync(foreignItemPath, 'utf8'), foreignItemBytes);
      assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreignBytes);
      assert.equal(fs.statSync(foreignDirectory).mode & 0o777, 0o700);
      assert.equal(
        fs.existsSync(path.join(foreignDirectory, 'origin.json')),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(foreignDirectory, 'survey.json')),
        false,
      );
    } finally {
      cleanup();
    }
  });

  test('recovers the exact Grant-owned target preparation', async () => {
    const {
      repositoryRoot,
      agentSource,
      executePromotion,
      createPromotionChallenge,
      cleanup,
    } = createPromotionFixture();
    try {
      const preparedTarget = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: 'Recover exact Grant-owned target preparation',
          summary: 'Only the accepted transition prepares the absent target.',
          sourceRefs: [agentSource.id],
        },
        {
          now: () => '2026-08-24T05:03:40.000Z',
          createId: () => 'WORK-01K39R0V00000000000000000T',
        },
      );
      const preparedAccepted = applyWorkItemReview(
        repositoryRoot,
        preparedTarget.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(preparedTarget.item),
          summary: preparedTarget.item.interpretation.summary,
        },
        () => '2026-08-24T05:03:50.000Z',
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare Grant-owned absent target',
      ]);
      const preparedTransition = createPromotionChallenge(
        preparedAccepted.id,
        'grant-promoted-prepared-target',
        workItemDigest(preparedAccepted),
        'acacacac-acac-4cac-8cac-acacacacacac',
        '2026-08-24T05:04:00.000Z',
      );
      const preparedDirectory = path.join(
        repositoryRoot,
        'openspec/changes/grant-promoted-prepared-target',
      );
      const preparationCrash = new Error('crash after Grant-owned preparation');
      let preparationAssertions = 0;
      await assert.rejects(
        executePromotion(
          preparedTransition,
          'operation-work-registry-prepared-target',
          false,
          () => {
            preparationAssertions += 1;
            if (preparationAssertions === 3) throw preparationCrash;
          },
        ),
        (error) => error === preparationCrash,
      );
      assert.equal(
        showWorkItem(repositoryRoot, preparedAccepted.id).stage,
        'backlog',
      );
      assert.equal(
        fs.existsSync(path.join(preparedDirectory, 'survey.json')),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(preparedDirectory, 'origin.json')),
        false,
      );
      const preparedSurveyBytes = fs.readFileSync(
        path.join(preparedDirectory, 'survey.json'),
        'utf8',
      );
      const preparedOutcome = await executePromotion(
        preparedTransition,
        'operation-work-registry-prepared-target',
        true,
      );
      assert.equal(preparedOutcome.outcome, 'completed');
      assert.equal(
        showWorkItem(repositoryRoot, preparedAccepted.id).stage,
        'active',
      );
      assert.equal(
        fs.readFileSync(path.join(preparedDirectory, 'survey.json'), 'utf8'),
        preparedSurveyBytes,
      );
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(preparedDirectory, 'origin.json'), 'utf8'),
        ),
        {
          schemaVersion: 1,
          sourceRefs: [agentSource.id],
          workItemRefs: [preparedAccepted.id],
        },
      );
    } finally {
      cleanup();
    }
  });

  test('rejects HEAD drift after conditional survey approval', async () => {
    const {
      repositoryRoot,
      prepareCandidate,
      executePromotion,
      snapshotPromotion,
      createPromotionChallenge,
      cleanup,
    } = createPromotionFixture();
    try {
      const stale = prepareCandidate(
        'WORK-01K39R0V00000000000000000H',
        'grant-promoted-stale',
        '2026-08-24T05:04:00.000Z',
        '2026-08-24T05:05:00.000Z',
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare stale promotion',
      ]);
      const staleSurvey = prepareWorkItemPromotionSurvey(
        repositoryRoot,
        stale.accepted.id,
        'grant-promoted-stale',
        {
          schemaVersion: 1,
          symbols: [],
          emptyReason: 'No load-bearing symbols for this stale acceptance.',
        },
      );
      const staleTransition = createPromotionChallenge(
        stale.accepted.id,
        'grant-promoted-stale',
        workItemDigest(stale.accepted),
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '2026-08-24T05:06:00.000Z',
      );
      fs.writeFileSync(
        path.join(repositoryRoot, 'head-advance.txt'),
        'Advance HEAD after the exact survey.\n',
      );
      runGitForTest(repositoryRoot, ['add', 'head-advance.txt']);
      runGitForTest(repositoryRoot, ['commit', '-m', 'Advance after survey']);
      const staleItemPath = path.join(
        repositoryRoot,
        stale.created.relativePath,
      );
      const staleOriginPath = path.join(stale.changeDirectory, 'origin.json');
      const staleSurveyPath = path.join(
        repositoryRoot,
        staleSurvey.relativePath,
      );
      const beforeStaleRefusal = snapshotPromotion(
        staleItemPath,
        staleOriginPath,
        staleSurveyPath,
      );
      await assert.rejects(
        executePromotion(
          staleTransition,
          'operation-work-registry-promotion-stale',
        ),
        hasCode('WORK_REGISTRY_GRANT_STALE'),
      );
      assert.deepEqual(
        snapshotPromotion(staleItemPath, staleOriginPath, staleSurveyPath),
        beforeStaleRefusal,
      );
    } finally {
      cleanup();
    }
  });

  test('rejects survey drift during the exact promotion transition', async () => {
    const {
      repositoryRoot,
      prepareCandidate,
      executePromotion,
      snapshotPromotion,
      createPromotionChallenge,
      cleanup,
    } = createPromotionFixture();
    try {
      const changedSurvey = prepareCandidate(
        'WORK-01K39R0V00000000000000000K',
        'grant-promoted-changed-survey',
        '2026-08-24T05:06:10.000Z',
        '2026-08-24T05:06:20.000Z',
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare survey-binding promotion',
      ]);
      const changedSurveyRecord = prepareWorkItemPromotionSurvey(
        repositoryRoot,
        changedSurvey.accepted.id,
        'grant-promoted-changed-survey',
        {
          schemaVersion: 1,
          symbols: [],
          emptyReason: 'No load-bearing symbols before exact Grant approval.',
        },
      );
      const changedSurveyTransition = createPromotionChallenge(
        changedSurvey.accepted.id,
        'grant-promoted-changed-survey',
        workItemDigest(changedSurvey.accepted),
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        '2026-08-24T05:06:30.000Z',
      );
      const changedSurveyPath = path.join(
        repositoryRoot,
        changedSurveyRecord.relativePath,
      );
      const changedSurveyBytes = JSON.parse(
        fs.readFileSync(changedSurveyPath, 'utf8'),
      ) as Record<string, unknown>;
      changedSurveyBytes.emptyReason =
        'Different canonical survey facts after exact Grant approval.';
      const changedSurveyContent = `${canonicalJson(changedSurveyBytes)}\n`;
      const changedSurveyItemPath = path.join(
        repositoryRoot,
        changedSurvey.created.relativePath,
      );
      const changedSurveyOriginPath = path.join(
        changedSurvey.changeDirectory,
        'origin.json',
      );
      const beforeChangedSurveyRefusal = snapshotPromotion(
        changedSurveyItemPath,
        changedSurveyOriginPath,
        changedSurveyPath,
      );
      let lifecycleAssertions = 0;
      await assert.rejects(
        executePromotion(
          changedSurveyTransition,
          'operation-work-registry-promotion-changed-survey',
          false,
          () => {
            lifecycleAssertions += 1;
            if (lifecycleAssertions === 2) {
              fs.writeFileSync(changedSurveyPath, changedSurveyContent);
            }
          },
        ),
        hasCode('WORK_REGISTRY_GRANT_STALE'),
      );
      assert.deepEqual(
        snapshotPromotion(
          changedSurveyItemPath,
          changedSurveyOriginPath,
          changedSurveyPath,
        ),
        {
          ...beforeChangedSurveyRefusal,
          survey: changedSurveyContent,
        },
      );
    } finally {
      cleanup();
    }
  });

  test('recovers committed promotion after its Work Item is archived', async () => {
    const {
      repositoryRoot,
      prepareCandidate,
      promotionReceiptRoot,
      grantRuntimeRoot,
      createCoordinator,
      cleanup,
    } = createPromotionFixture();
    try {
      const recoverable = prepareCandidate(
        'WORK-01K39R0V00000000000000000J',
        'grant-promoted-recovered',
        '2026-08-24T05:07:00.000Z',
        '2026-08-24T05:08:00.000Z',
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare recoverable promotion',
      ]);
      prepareWorkItemPromotionSurvey(
        repositoryRoot,
        recoverable.accepted.id,
        'grant-promoted-recovered',
        {
          schemaVersion: 1,
          symbols: [],
          emptyReason: 'No load-bearing symbols for this recovery acceptance.',
        },
      );
      const recoverableExpectedDigest = workItemDigest(recoverable.accepted);
      const challengeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const crash = new Error(
        'simulated crash after exact promotion receipt publication',
      );
      const crashingCoordinator = createCoordinator({
        challengeId,
        operationId,
        crashAfterCommit: crash,
      });
      const recoverableGrantRequest = createWorkRegistryPromotionGrantRequest({
        repositoryRoot,
        workItemId: recoverable.accepted.id,
        changeId: 'grant-promoted-recovered',
        expectedDigest: recoverableExpectedDigest,
        proposedReason: 'Approve this exact recoverable promotion.',
      });
      const requested = await crashingCoordinator.requestGrant(
        recoverableGrantRequest,
      );
      assert.equal(requested.challengeId, challengeId);
      await assert.rejects(
        crashingCoordinator.resolveChallenge(challengeId),
        (error) => error === crash,
      );
      assert.equal(
        createFileGrantRecordStore(
          grantStorePaths(grantRuntimeRoot),
        ).readGrantRecord(challengeId).state,
        'prepared',
      );
      assert.equal(
        showWorkItem(repositoryRoot, recoverable.accepted.id).stage,
        'active',
      );
      assert.deepEqual(
        fs.readdirSync(
          path.join(
            repositoryRoot,
            '.git/workflow-engine/work-registry/promotion-journals',
          ),
        ),
        [],
      );
      const recoverableReceipt = (
        fs
          .readdirSync(promotionReceiptRoot)
          .map((entry) =>
            JSON.parse(
              fs.readFileSync(path.join(promotionReceiptRoot, entry), 'utf8'),
            ),
          ) as Array<{
          workItemId: string;
          grantBinding: {
            schemaVersion: number;
            challengeId: string;
            operationId: string;
            approvalSubjectDigest: string;
            surveyBinding: unknown;
          } | null;
        }>
      ).find((entry) => entry.workItemId === recoverable.accepted.id);
      assert.equal(recoverableReceipt?.grantBinding?.schemaVersion, 1);
      assert.equal(recoverableReceipt?.grantBinding?.challengeId, challengeId);
      assert.equal(recoverableReceipt?.grantBinding?.operationId, operationId);
      assert.match(
        recoverableReceipt?.grantBinding?.approvalSubjectDigest ?? '',
        /^sha256:[0-9a-f]{64}$/,
      );
      assert.deepEqual(
        recoverableReceipt?.grantBinding?.surveyBinding,
        (
          recoverableGrantRequest.candidates[0]?.parameters as {
            preparationBinding: { surveyPreparation: { binding: unknown } };
          }
        ).preparationBinding.surveyPreparation.binding,
      );
      const recoverableReceiptBytes = fs
        .readdirSync(promotionReceiptRoot)
        .map((entry) => ({
          entry,
          bytes: fs.readFileSync(
            path.join(promotionReceiptRoot, entry),
            'utf8',
          ),
        }))
        .find(({ bytes }) =>
          bytes.includes(`"workItemId":"${recoverable.accepted.id}"`),
        );
      assert.ok(recoverableReceiptBytes);
      const archivedRecoverableRoot =
        'openspec/changes/archive/2026-08-24-grant-promoted-recovered';
      fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/archive'), {
        recursive: true,
      });
      fs.renameSync(
        recoverable.changeDirectory,
        path.join(repositoryRoot, archivedRecoverableRoot),
      );
      assert.deepEqual(
        reconcileArchivedWorkItems(
          repositoryRoot,
          'grant-promoted-recovered',
          archivedRecoverableRoot,
          '2026-08-24T05:09:30.000Z',
        ).closedItemIds,
        [recoverable.accepted.id],
      );
      assert.equal(
        showWorkItem(repositoryRoot, recoverable.accepted.id).stage,
        'closed',
      );
      const archivedRecoverableDirectory = path.join(
        repositoryRoot,
        archivedRecoverableRoot,
      );
      const archivedRecoverableOriginPath = path.join(
        archivedRecoverableDirectory,
        'origin.json',
      );
      const archivedRecoverableSurveyPath = path.join(
        archivedRecoverableDirectory,
        'survey.json',
      );
      const recoverableItemPath = path.join(
        repositoryRoot,
        recoverable.created.relativePath,
      );
      const laterStateBytes = {
        item: fs.readFileSync(recoverableItemPath, 'utf8'),
        origin: fs.readFileSync(archivedRecoverableOriginPath, 'utf8'),
        survey: fs.readFileSync(archivedRecoverableSurveyPath, 'utf8'),
      };
      const observationRegistry = createTransitionRegistry(
        workRegistryGrantTransitionDefinitions(repositoryRoot),
      );
      const observationDefinition = observationRegistry.resolve(
        'work-registry.promote.v1',
      );
      const actualCurrentPoststate = await observationDefinition.observeState(
        observationDefinition.validateParameters(
          recoverableGrantRequest.candidates[0]?.parameters,
        ),
      );
      const recoveryCoordinator = createCoordinator({
        challengeId,
        operationId,
      });
      const recoveredResult =
        await recoveryCoordinator.recoverChallenge(challengeId);
      assert.equal(recoveredResult.recovered, true);
      assert.equal(recoveredResult.outcome, 'completed');
      assert.equal(
        recoveredResult.poststateDigest,
        actualCurrentPoststate.digest,
      );
      const completedRecoveryRecord = createFileGrantRecordStore(
        grantStorePaths(grantRuntimeRoot),
      ).readGrantRecord(challengeId);
      assert.equal(completedRecoveryRecord.state, 'completed');
      assert.equal(
        completedRecoveryRecord.poststateDigest,
        recoveredResult.poststateDigest,
      );
      assert.equal(
        fs.readFileSync(
          path.join(promotionReceiptRoot, recoverableReceiptBytes.entry),
          'utf8',
        ),
        recoverableReceiptBytes.bytes,
      );
      assert.deepEqual(
        {
          item: fs.readFileSync(recoverableItemPath, 'utf8'),
          origin: fs.readFileSync(archivedRecoverableOriginPath, 'utf8'),
          survey: fs.readFileSync(archivedRecoverableSurveyPath, 'utf8'),
        },
        laterStateBytes,
      );
      assert.equal(fs.existsSync(recoverable.changeDirectory), false);
    } finally {
      cleanup();
    }
  });

  test('terminalizes prepared recovery when the approved survey changes', async () => {
    const {
      repositoryRoot,
      prepareCandidate,
      grantRuntimeRoot,
      createCoordinator,
      cleanup,
    } = createPromotionFixture();
    try {
      const terminal = prepareCandidate(
        'WORK-01K39R0V00000000000000000M',
        'grant-promoted-terminal-drift',
        '2026-08-24T05:10:00.000Z',
        '2026-08-24T05:10:10.000Z',
      );
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, [
        'commit',
        '-m',
        'Prepare terminal survey drift',
      ]);
      const terminalSurvey = prepareWorkItemPromotionSurvey(
        repositoryRoot,
        terminal.accepted.id,
        'grant-promoted-terminal-drift',
        {
          schemaVersion: 1,
          symbols: [],
          emptyReason: 'No load-bearing symbols for the prepared Grant.',
        },
      );
      const terminalChallengeId = '11111111-1111-4111-8111-111111111111';
      const terminalOperationId = '22222222-2222-4222-8222-222222222222';
      const crashAfterPrepare = new Error(
        'simulated crash after durable Grant prepare',
      );
      const terminalCrashingCoordinator = createCoordinator({
        challengeId: terminalChallengeId,
        operationId: terminalOperationId,
        crashAfterPrepare,
      });
      await terminalCrashingCoordinator.requestGrant(
        createWorkRegistryPromotionGrantRequest({
          repositoryRoot,
          workItemId: terminal.accepted.id,
          changeId: 'grant-promoted-terminal-drift',
          expectedDigest: workItemDigest(terminal.accepted),
          proposedReason: 'Approve the exact survey before recovery drift.',
        }),
      );
      await assert.rejects(
        terminalCrashingCoordinator.resolveChallenge(terminalChallengeId),
        (error) => error === crashAfterPrepare,
      );
      assert.equal(
        createFileGrantRecordStore(
          grantStorePaths(grantRuntimeRoot),
        ).readGrantRecord(terminalChallengeId).state,
        'prepared',
      );
      const terminalSurveyPath = path.join(
        repositoryRoot,
        terminalSurvey.relativePath,
      );
      const terminalSurveyValue = JSON.parse(
        fs.readFileSync(terminalSurveyPath, 'utf8'),
      ) as Record<string, unknown>;
      terminalSurveyValue.emptyReason =
        'Different current survey facts before prepared Grant recovery.';
      fs.writeFileSync(
        terminalSurveyPath,
        `${canonicalJson(terminalSurveyValue)}\n`,
      );
      const terminalItemBeforeRecovery = fs.readFileSync(
        path.join(repositoryRoot, terminal.created.relativePath),
        'utf8',
      );
      const terminalOriginPath = path.join(
        terminal.changeDirectory,
        'origin.json',
      );
      const terminalRecoveryCoordinator = createCoordinator({
        challengeId: terminalChallengeId,
        operationId: terminalOperationId,
      });
      const terminalResult =
        await terminalRecoveryCoordinator.recoverChallenge(terminalChallengeId);
      assert.equal(terminalResult.recovered, true);
      assert.equal(terminalResult.outcome, 'failed');
      assert.equal(
        createFileGrantRecordStore(
          grantStorePaths(grantRuntimeRoot),
        ).readGrantRecord(terminalChallengeId).state,
        'failed',
      );
      assert.equal(
        fs.readFileSync(
          path.join(repositoryRoot, terminal.created.relativePath),
          'utf8',
        ),
        terminalItemBeforeRecovery,
      );
      assert.equal(fs.existsSync(terminalOriginPath), false);
    } finally {
      cleanup();
    }
  });
});
