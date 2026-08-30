import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  captureGovernanceSource,
  recordGovernanceFinding,
} from '../src/modules/governance-intake/governance-intake.ts';
import {
  createWorkRegistryReviewGrantRequest,
  workRegistryGrantTransitionDefinitions,
} from '../src/modules/governance-intake/work-registry-grant.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { createWorkRegistryFailGrantResult } from '../src/cli.ts';
import { createGrantChallenge } from '../src/modules/authority/grant-core.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  linkSourceToChange,
  inspectWorkRegistry,
  prepareWorkItemPromotionSurvey,
  promoteWorkItem,
  recommendWorkItemPriorities,
  reconcileArchivedWorkItems,
  renderWorkRegistry,
  searchWorkItems,
  showWorkItem,
  traceWorkItem,
  validateWorkRegistry,
  validateWorkRegistryProjections,
  workItemDigest,
} from '../src/modules/governance-intake/work-registry.ts';

test('source capture is content-addressed, append-only, and idempotent', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-ledger-'),
  );
  try {
    const input = {
      semanticAuthor: 'maintainer' as const,
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:10:00.000Z',
      contextRef: 'direct-human:thread/turn-43',
      text: 'Keep every coherent MVP slice committed.\n',
      supersedes: null,
    };

    const first = captureGovernanceSource(repositoryRoot, input);
    const second = captureGovernanceSource(repositoryRoot, input);
    assert.deepEqual(second.source, first.source);
    assert.equal(second.relativePath, first.relativePath);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.match(
      first.relativePath,
      /^workflow\/source-ledger\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/,
    );
    const bytes = fs.readFileSync(
      path.join(repositoryRoot, first.relativePath),
      'utf8',
    );
    assert.equal(`${JSON.stringify(JSON.parse(bytes))}\n`, bytes);
    assert.equal(JSON.parse(bytes).text, input.text);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('finding capture binds active session and Git facts outside task paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-finding-'));
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'git-common', 'workflow-engine');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  try {
    const result = recordGovernanceFinding(
      {
        repositoryRoot,
        runtimeRoot,
        sessionId: 'session-current-task',
        changeId: 'current-change',
        branch: 'work/current-change',
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
      },
      {
        schemaVersion: 1,
        text: 'The current assumption needs re-validation.',
        sourceRefs: [],
      },
      () => '2026-08-24T03:12:00.000Z',
    );

    assert.match(result.finding.id, /^FND-[0-9a-f]{64}$/);
    assert.equal(result.finding.sessionId, 'session-current-task');
    assert.equal(result.finding.changeId, 'current-change');
    assert.equal(result.finding.head, 'a'.repeat(40));
    assert.equal(result.finding.tree, 'b'.repeat(40));
    assert.equal(result.path.startsWith(repositoryRoot), false);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source and finding CLI routes parse exact input envelopes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-intake-cli-'));
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const sourceInput = path.join(root, 'source.json');
  const findingInput = path.join(root, 'finding.json');
  const workItemInput = path.join(root, 'work-item.json');
  fs.writeFileSync(
    sourceInput,
    `${JSON.stringify({
      semanticAuthor: 'agent',
      capturedBy: 'agent',
      capturedAt: '2026-08-24T03:15:00.000Z',
      contextRef: 'session:session-current-task',
      text: 'A bounded implementation finding.',
      supersedes: null,
    })}\n`,
  );
  fs.writeFileSync(
    findingInput,
    `${JSON.stringify({
      schemaVersion: 1,
      text: 'A finding that must survive task-scope rejection.',
      sourceRefs: [],
    })}\n`,
  );
  try {
    const source = dispatchGovernanceIntakeCommand(
      'source',
      ['capture', '--input', sourceInput],
      repositoryRoot,
    );
    assert.equal(source.action, 'capture');
    fs.writeFileSync(
      workItemInput,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'research',
        lane: 'later',
        title: 'Captured CLI work',
        summary: 'Keep the optional registry route small.',
        sourceRefs: [source.sourceId],
      })}\n`,
    );

    const finding = dispatchGovernanceIntakeCommand(
      'finding',
      ['add', '--session', 'session-current-task', '--input', findingInput],
      repositoryRoot,
      {
        now: () => '2026-08-24T03:16:00.000Z',
        resolveSession: () => ({
          repositoryRoot,
          runtimeRoot,
          sessionId: 'session-current-task',
          changeId: 'current-change',
          branch: 'work/current-change',
          head: 'a'.repeat(40),
          tree: 'b'.repeat(40),
        }),
      },
    );
    assert.equal(finding.action, 'add');

    const workItem = dispatchGovernanceIntakeCommand(
      'work-item',
      ['create', '--input', workItemInput],
      repositoryRoot,
      { now: () => '2026-08-24T03:17:00.000Z' },
    );
    assert.equal(workItem.action, 'create');
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'work-item',
        ['validate'],
        repositoryRoot,
      ),
      { action: 'validate', itemCount: 1, sourceCount: 1 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('optional Work Registry creates one stable item and promotes exact provenance', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-registry-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:20:00.000Z',
      contextRef: 'direct-human:thread/turn-44',
      text: 'Make the Work Registry optional.\n',
      supersedes: null,
    }).source;
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Optional Work Registry',
        summary: 'Ship the smallest Git-native registry.',
        sourceRefs: [source.id],
      },
      {
        now: () => '2026-08-24T03:21:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000000',
      },
    );
    assert.equal(created.item.stage, 'inbox');
    assert.equal(created.item.lane, 'next');
    assert.equal(
      created.relativePath,
      'docs/work-registry/items/2026/WORK-01K39R0V000000000000000000.yaml',
    );

    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/registry-mvp'), {
      recursive: true,
    });
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T03:21:30.000Z',
    );
    const promoted = promoteWorkItem(
      repositoryRoot,
      accepted.id,
      'registry-mvp',
      () => '2026-08-24T03:22:00.000Z',
      workItemDigest(accepted),
    );
    assert.equal(promoted.item.stage, 'active');
    assert.deepEqual(promoted.item.changeRefs, ['registry-mvp']);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(
            repositoryRoot,
            'openspec/changes/registry-mvp/origin.json',
          ),
          'utf8',
        ),
      ),
      {
        schemaVersion: 1,
        sourceRefs: [source.id],
        workItemRefs: [created.item.id],
      },
    );
    assert.deepEqual(validateWorkRegistry(repositoryRoot), {
      itemCount: 1,
      sourceCount: 1,
    });
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('a Source can link directly to a change without a parking Work Item', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-change-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:30:00.000Z',
      contextRef: 'direct-human:thread/turn-45',
      text: 'Create this change immediately.\n',
      supersedes: null,
    }).source;
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/direct-change'), {
      recursive: true,
    });

    const first = linkSourceToChange(
      repositoryRoot,
      source.id,
      'direct-change',
    );
    const second = linkSourceToChange(
      repositoryRoot,
      source.id,
      'direct-change',
    );

    assert.deepEqual(second.origin, first.origin);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(first.origin, {
      schemaVersion: 1,
      sourceRefs: [source.id],
      workItemRefs: [],
    });
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['link-change', source.id, '--change', 'direct-change'],
        repositoryRoot,
      ),
      {
        action: 'link-change',
        sourceId: source.id,
        changeId: 'direct-change',
        path: 'openspec/changes/direct-change/origin.json',
        created: false,
      },
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('reviewed intake and priority use exact current Work Item digests', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-review-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'improvement',
        lane: null,
        title: 'Review this intake',
        summary: 'Move the exact reviewed item into the backlog.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:30:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000001',
      },
    ).item;
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created),
        summary: 'Confirmed for the reviewed backlog.',
      },
      () => '2026-08-24T04:31:00.000Z',
    );
    assert.equal(accepted.stage, 'backlog');
    assert.equal(accepted.interpretation.status, 'maintainer-confirmed');

    assert.throws(
      () =>
        applyWorkItemReview(
          repositoryRoot,
          created.id,
          {
            action: 'prioritize',
            expectedDigest: workItemDigest(created),
            lane: 'now',
            blockedBy: [],
          },
          () => '2026-08-24T04:32:00.000Z',
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_STALE',
    );

    const prioritized = applyWorkItemReview(
      repositoryRoot,
      created.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(accepted),
        lane: 'now',
        blockedBy: [],
      },
      () => '2026-08-24T04:33:00.000Z',
    );
    assert.equal(prioritized.lane, 'now');
    assert.equal(prioritized.timeline.at(-1)?.event, 'prioritized');
    assert.deepEqual(showWorkItem(repositoryRoot, created.id), prioritized);
    assert.deepEqual(searchWorkItems(repositoryRoot, 'confirmed'), [
      prioritized,
    ]);
    assert.deepEqual(traceWorkItem(repositoryRoot, created.id), {
      item: prioritized,
      origins: [],
      sources: [],
    });
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('priority recommendations are explainable and inventory exposes current intake facts', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-priority-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const blocker = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: 'next',
        title: 'Resolve the prerequisite',
        summary: 'This item must close before the dependent item can start.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:34:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000007',
      },
    ).item;
    const dependent = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Use the completed prerequisite',
        summary: 'Keep recommendation reasons explicit and replayable.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:35:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000008',
      },
    ).item;
    const acceptedBlocker = applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(blocker),
        summary: blocker.interpretation.summary,
      },
      () => '2026-08-24T04:36:00.000Z',
    );
    const acceptedDependent = applyWorkItemReview(
      repositoryRoot,
      dependent.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(dependent),
        summary: dependent.interpretation.summary,
      },
      () => '2026-08-24T04:37:00.000Z',
    );
    const currentBlocker = applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedBlocker),
        lane: 'now',
        blockedBy: [],
      },
      () => '2026-08-24T04:38:00.000Z',
    );
    const blockedDependent = applyWorkItemReview(
      repositoryRoot,
      dependent.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedDependent),
        lane: 'next',
        blockedBy: [blocker.id],
      },
      () => '2026-08-24T04:39:00.000Z',
    );

    assert.deepEqual(
      recommendWorkItemPriorities(repositoryRoot).find(
        ({ workItemId }) => workItemId === dependent.id,
      ),
      {
        workItemId: dependent.id,
        currentLane: 'next',
        suggestedLane: 'later',
        reasons: [`unresolved-blocker:${blocker.id}`],
      },
    );
    assert.deepEqual(inspectWorkRegistry(repositoryRoot), {
      schemaVersion: 1,
      itemCount: 2,
      sourceCount: 0,
      items: [
        {
          id: blocker.id,
          title: blocker.title,
          stage: 'backlog',
          lane: 'now',
          aliases: [],
          blockedBy: [],
        },
        {
          id: dependent.id,
          title: dependent.title,
          stage: 'backlog',
          lane: 'next',
          aliases: [],
          blockedBy: [blocker.id],
        },
      ],
      stages: { inbox: 0, backlog: 2, active: 0, closed: 0 },
      lanes: { now: 1, next: 1, later: 0, icebox: 0, unprioritized: 0 },
      currentItemIds: [currentBlocker.id],
      blockedItemIds: [blockedDependent.id],
    });

    applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'decline',
        expectedDigest: workItemDigest(currentBlocker),
        outcome: 'obsolete',
      },
      () => '2026-08-24T04:40:00.000Z',
    );
    assert.deepEqual(
      recommendWorkItemPriorities(repositoryRoot).find(
        ({ workItemId }) => workItemId === dependent.id,
      ),
      {
        workItemId: dependent.id,
        currentLane: 'next',
        suggestedLane: 'next',
        reasons: ['maintainer-lane-retained'],
      },
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('promotion requires reviewed backlog priority and satisfied blockers', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-eligibility-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const blocker = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: 'next',
        title: 'Promotion blocker',
        summary: 'Close this item before promotion.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:41:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000009',
      },
    ).item;
    const candidate = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'later',
        title: 'Promotion candidate',
        summary: 'Promotion must consume reviewed current facts.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:42:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000A',
      },
    ).item;
    fs.mkdirSync(
      path.join(repositoryRoot, 'openspec/changes/eligible-change'),
      {
        recursive: true,
      },
    );

    assert.throws(
      () => promoteWorkItem(repositoryRoot, candidate.id, 'eligible-change'),
      hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
    );
    const acceptedCandidate = applyWorkItemReview(
      repositoryRoot,
      candidate.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(candidate),
        summary: candidate.interpretation.summary,
      },
      () => '2026-08-24T04:43:00.000Z',
    );
    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          candidate.id,
          'eligible-change',
          undefined,
          workItemDigest(acceptedCandidate),
        ),
      hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
    );
    const acceptedBlocker = applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(blocker),
        summary: blocker.interpretation.summary,
      },
      () => '2026-08-24T04:44:00.000Z',
    );
    const currentCandidate = applyWorkItemReview(
      repositoryRoot,
      candidate.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedCandidate),
        lane: 'next',
        blockedBy: [blocker.id],
      },
      () => '2026-08-24T04:45:00.000Z',
    );
    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          candidate.id,
          'eligible-change',
          undefined,
          workItemDigest(currentCandidate),
        ),
      hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
    );
    applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'decline',
        expectedDigest: workItemDigest(acceptedBlocker),
        outcome: 'obsolete',
      },
      () => '2026-08-24T04:46:00.000Z',
    );
    assert.equal(
      promoteWorkItem(
        repositoryRoot,
        candidate.id,
        'eligible-change',
        () => '2026-08-24T04:47:00.000Z',
        workItemDigest(currentCandidate),
      ).item.stage,
      'active',
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

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

test('registry render is deterministic and validates blocking cycles', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-render-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:33:00.000Z',
      contextRef: 'direct-human:thread/turn-46',
      text: 'Keep source provenance reachable from the backlog.\n',
      supersedes: null,
    }).source;
    const first = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'First item',
        summary: 'First summary',
        sourceRefs: [source.id],
      },
      {
        now: () => '2026-08-24T04:34:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000002',
      },
    ).item;
    const second = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'later',
        title: 'Second item',
        summary: 'Second summary',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:35:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000003',
      },
    ).item;
    const reviewedFirst = applyWorkItemReview(
      repositoryRoot,
      first.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(first),
        summary: first.interpretation.summary,
      },
      () => '2026-08-24T04:36:00.000Z',
    );
    const reviewedSecond = applyWorkItemReview(
      repositoryRoot,
      second.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(second),
        summary: second.interpretation.summary,
      },
      () => '2026-08-24T04:37:00.000Z',
    );
    applyWorkItemReview(
      repositoryRoot,
      reviewedSecond.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(reviewedSecond),
        lane: 'later',
        blockedBy: [reviewedFirst.id],
      },
      () => '2026-08-24T04:38:00.000Z',
    );
    assert.deepEqual(validateWorkRegistry(repositoryRoot), {
      itemCount: 2,
      sourceCount: 1,
    });
    const rendered = renderWorkRegistry(repositoryRoot);
    const firstBacklog = fs.readFileSync(rendered.backlogPath, 'utf8');
    assert.match(firstBacklog, /First item/);
    assert.match(firstBacklog, /Second item/);
    assert.match(
      firstBacklog,
      new RegExp(
        `\\[${source.id}\\]\\(\\.\\.\\/workflow\\/source-ledger\\/objects\\/sha256\\/${source.id.slice(4, 6)}\\/${source.id.slice(4)}\\.json\\)`,
      ),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(rendered.inventoryPath, 'utf8')),
      inspectWorkRegistry(repositoryRoot),
    );
    assert.deepEqual(renderWorkRegistry(repositoryRoot), rendered);
    assert.equal(fs.readFileSync(rendered.backlogPath, 'utf8'), firstBacklog);
    assert.deepEqual(validateWorkRegistryProjections(repositoryRoot), {
      projectionCount: 2,
    });
    fs.writeFileSync(rendered.backlogPath, `${firstBacklog}\n`);
    assert.throws(
      () => validateWorkRegistryProjections(repositoryRoot),
      hasCode('WORK_REGISTRY_PROJECTION_DRIFT'),
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('archive reconciliation rejects a one-sided Work Item link before mutation', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-archive-invalid-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Keep archive provenance bidirectional',
        summary: 'Reject a change origin that disagrees with its Work Item.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:43:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000006',
      },
    );
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/demo-change'), {
      recursive: true,
    });
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T04:43:30.000Z',
    );
    promoteWorkItem(
      repositoryRoot,
      accepted.id,
      'demo-change',
      () => '2026-08-24T04:44:00.000Z',
      workItemDigest(accepted),
    );
    const archiveRoot = 'openspec/changes/archive/2026-08-24-demo-change';
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/archive'), {
      recursive: true,
    });
    fs.renameSync(
      path.join(repositoryRoot, 'openspec/changes/demo-change'),
      path.join(repositoryRoot, archiveRoot),
    );
    const itemPath = path.join(repositoryRoot, created.relativePath);
    const oneSided = {
      ...JSON.parse(fs.readFileSync(itemPath, 'utf8')),
      changeRefs: [],
    };
    fs.writeFileSync(itemPath, `${JSON.stringify(oneSided)}\n`);
    const before = fs.readFileSync(itemPath, 'utf8');

    assert.throws(
      () =>
        reconcileArchivedWorkItems(
          repositoryRoot,
          'demo-change',
          archiveRoot,
          '2026-08-24T04:45:00.000Z',
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_INVALID',
    );
    assert.equal(fs.readFileSync(itemPath, 'utf8'), before);
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, 'docs/BACKLOG.md')),
      false,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Registry refuses legacy Issue migration and provenance', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-migration-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    fs.mkdirSync(path.join(repositoryRoot, 'docs/issues'), { recursive: true });
    fs.writeFileSync(
      path.join(repositoryRoot, 'docs/issues/issues.yaml'),
      `${JSON.stringify({
        schemaVersion: 1,
        lastUpdated: '2026-08-23',
        issues: [
          {
            id: 'ISS-101',
            category: 'bug',
            title: 'Legacy issue',
            status: 'proposed',
            priority: 'Next',
            requirement: null,
            references: [],
            notes: 'Imported without inventing historical authorship.',
          },
        ],
      })}\n`,
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'work-item',
          ['migrate-issues', '--at', '2026-08-24T04:40:00.000Z'],
          repositoryRoot,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'GOVERNANCE_INTAKE_INVALID',
    );

    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'bug',
        lane: 'next',
        title: 'Current Work Item',
        summary: 'Current provenance remains explicit.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:40:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000099',
        aliases: ['ISS-101'],
      },
    );
    assert.equal(showWorkItem(repositoryRoot, 'ISS-101').id, created.item.id);
    assert.equal(showWorkItem(repositoryRoot, 'ISS-101').lane, 'next');

    const itemPath = path.join(repositoryRoot, created.relativePath);
    const legacy = JSON.parse(fs.readFileSync(itemPath, 'utf8')) as {
      interpretation: { status: string };
    };
    legacy.interpretation.status = 'unsupported';
    fs.writeFileSync(itemPath, `${JSON.stringify(legacy)}\n`);
    assert.throws(
      () => validateWorkRegistry(repositoryRoot),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_INVALID',
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Registry CLI exposes reviewed read and render surfaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-work-cli-'));
  configureRepositoryConsumer(root);
  try {
    const consumerPath = path.join(root, 'workflow/repository-consumer.json');
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      documents: { handoffPath: string };
    };
    consumer.documents.handoffPath = 'notebook/handoff.md';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    const created = createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: null,
        title: 'CLI review surface',
        summary: 'Exercise production registry commands.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:41:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000004',
      },
    ).item;
    const reviewPath = path.join(root, 'review.json');
    fs.writeFileSync(
      reviewPath,
      `${JSON.stringify({
        action: 'accept',
        expectedDigest: workItemDigest(created),
        summary: 'Confirmed from the CLI review route.',
      })}\n`,
    );
    const reviewed = dispatchGovernanceIntakeCommand(
      'work-item',
      ['review', created.id, '--input', reviewPath],
      root,
      { now: () => '2026-08-24T04:42:00.000Z' },
    );
    assert.equal((reviewed.item as { stage: string }).stage, 'backlog');
    assert.equal(
      (
        dispatchGovernanceIntakeCommand('work-item', ['show', created.id], root)
          .item as { id: string }
      ).id,
      created.id,
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand(
          'work-item',
          ['search', 'confirmed'],
          root,
        ).items as unknown[]
      ).length,
      1,
    );
    assert.equal(
      dispatchGovernanceIntakeCommand('work-item', ['trace', created.id], root)
        .action,
      'trace',
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand('work-item', ['recommend'], root)
          .recommendations as unknown[]
      ).length,
      1,
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand('work-item', ['inventory'], root)
          .inventory as { itemCount: number }
      ).itemCount,
      1,
    );
    assert.deepEqual(
      dispatchGovernanceIntakeCommand('work-item', ['render'], root),
      {
        action: 'render',
        backlogPath: 'docs/BACKLOG.md',
        inventoryPath: 'docs/work-registry/inventory.json',
        handoffPath: 'notebook/handoff.md',
        historyPaths: [],
      },
    );
    assert.equal(fs.existsSync(path.join(root, 'notebook/handoff.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('promotion prepare surveys immutable consumers before CLI promotion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-survey-'));
  configureRepositoryConsumer(root);
  try {
    runGitForTest(root, ['init', '-b', 'main']);
    runGitForTest(root, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(root, ['config', 'user.email', 'jigwright@example.test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/first.ts'),
      'export const sharedAuthority = true;\n',
    );
    fs.writeFileSync(
      path.join(root, 'src/second.ts'),
      'import { sharedAuthority } from "./first";\n',
    );
    runGitForTest(root, ['add', 'src']);
    runGitForTest(root, ['commit', '-m', 'Add survey facts']);

    const item = createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'research',
        lane: 'next',
        title: 'Survey current consumers',
        summary: 'Inspect current consumers before promotion.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:43:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000005',
      },
    ).item;
    const accepted = applyWorkItemReview(
      root,
      item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(item),
        summary: item.interpretation.summary,
      },
      () => '2026-08-24T04:43:30.000Z',
    );
    fs.mkdirSync(path.join(root, 'openspec/changes/survey-change'), {
      recursive: true,
    });
    assert.throws(
      () =>
        promoteWorkItem(
          root,
          accepted.id,
          'survey-change',
          () => '2026-08-24T04:44:00.000Z',
          workItemDigest(accepted),
          true,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_SURVEY_REQUIRED',
    );
    const survey = prepareWorkItemPromotionSurvey(
      root,
      accepted.id,
      'survey-change',
      {
        schemaVersion: 1,
        symbols: ['sharedAuthority'],
        emptyReason: null,
      },
    );
    assert.deepEqual(survey.survey.symbols, [
      {
        symbol: 'sharedAuthority',
        consumerPaths: ['src/first.ts', 'src/second.ts'],
      },
    ]);
    const promoted = promoteWorkItem(
      root,
      accepted.id,
      'survey-change',
      () => '2026-08-24T04:44:00.000Z',
      workItemDigest(accepted),
      true,
    );
    assert.equal(promoted.item.stage, 'active');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runGitForTest(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function configureRepositoryConsumer(repositoryRoot: string): void {
  const workflowRoot = path.join(repositoryRoot, 'workflow');
  fs.mkdirSync(workflowRoot, { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workflowRoot, 'config.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      repositoryName: 'fixture',
      changeRoot: 'openspec/changes',
      runtimeDirectory: 'jigwright-runtime',
      protectedBranches: ['main'],
      branchTemplate: 'changes/{changeId}',
    })}\n`,
  );
  fs.writeFileSync(
    path.join(workflowRoot, 'repository-consumer.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      adapterId: 'configured-repository-v1',
      consumerId: 'fixture',
      planning: {
        providerId: 'openspec',
        packageSchemaNames: ['spec-driven'],
        requiredSchemaNames: ['spec-driven', 'fixture'],
        supportedSchemaNames: ['spec-driven', 'fixture'],
        managedSchemaNames: ['fixture'],
        currentSchemaName: 'fixture',
      },
      documents: {
        adapterId: 'filesystem-documents-v1',
        handoffPath: 'docs/CURRENT_AND_NEXT_STEPS.md',
        issueSourcePath: 'docs/issues/issues.yaml',
        issueLogPath: 'docs/ISSUE_LOG.md',
      },
      workRegistry: {
        adapterId: 'filesystem-work-registry-v1',
        itemRoot: 'docs/work-registry/items',
        inventoryPath: 'docs/work-registry/inventory.json',
        backlogPath: 'docs/BACKLOG.md',
        historyRoot: 'docs/work-history',
        sourceRoot: 'workflow/source-ledger/objects/sha256',
        transitionPolicyPath: 'workflow/work-registry-policy.json',
        changeOriginRoot: 'openspec/changes',
      },
      databasePolicy: { adapterId: 'disabled-v1' },
    })}\n`,
  );
}

function hasCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expectedCode;
}
