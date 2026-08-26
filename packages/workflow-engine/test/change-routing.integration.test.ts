import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyChangeRoutingReview,
  applyManagedChangeRoutingReview,
  assertChangeRoutingAdmission,
  inspectChangeRouting,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import {
  changeRoutingGrantTransitionDefinitions,
  createChangeRoutingContinuationGrantRequest,
} from '../src/modules/lifecycle/change-routing-grant.ts';
import { dispatchChangeRoutingCommand } from '../src/entrypoints/cli/change-routing-cli.ts';
import { runRepositoryHook } from '../src/entrypoints/hooks/hooks.ts';
import { validateRepositoryStateAtCommit } from '../src/composition-root/repository-validation.ts';
import { validateCiRouteCommit } from '../src/entrypoints/ci/ci-routing.ts';
import { listRangeCommits } from '../src/entrypoints/ci/ci-git.ts';
import { openTask } from '../src/application/execute-task/open-task.ts';
import {
  projectHandoffForTaskProjection,
  renderHandoff,
  renderHandoffForChange,
  validateHandoff,
  validateHandoffForChange,
} from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  codeOwnedApprovalModuleRegistry,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { grantStorePaths } from '../src/runtime/storage-journal/grant-store.ts';

test('managed routing projects mixed repository state and recovers idempotently', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'blocked-change', false);
    writeChange(repository, 'completed-change', true);
    writeChange(repository, 'resume-change', false);
    writeReadyV3ExemptChange(repository);

    const blocked = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'blocked-change',
        taskId: '1.1',
        reason: 'Waiting for the external API decision.',
        blocker: {
          kind: 'external',
          id: 'upstream-api',
          resumeCondition: 'manual',
        },
      },
    });
    assert.equal(applyChangeRoutingReview(repository, blocked).replayed, false);

    const resumeAvailable = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'resume-change',
        taskId: '1.1',
        reason: 'Wait until the dependency is complete.',
        blocker: {
          kind: 'change',
          id: 'completed-change',
          resumeCondition: 'done',
        },
      },
    });
    applyChangeRoutingReview(repository, resumeAvailable);

    const focused = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    assert.deepEqual(focused.nextSource.concurrentChangeIds, []);
    assert.equal(applyChangeRoutingReview(repository, focused).replayed, false);
    assert.equal(applyChangeRoutingReview(repository, focused).replayed, true);

    const inspection = inspectChangeRouting(repository);
    assert.deepEqual(
      inspection.changes.map(({ changeId, state }) => [changeId, state]),
      [
        ['blocked-change', 'blocked'],
        ['completed-change', 'completed-awaiting-archive'],
        ['demo-change', 'primary'],
        ['resume-change', 'resume-available'],
      ],
    );
    assert.doesNotThrow(() =>
      assertChangeRoutingAdmission(repository, 'demo-change'),
    );
    assert.throws(
      () => assertChangeRoutingAdmission(repository, 'blocked-change'),
      { code: 'CHANGE_ROUTING_REQUIRED' },
    );

    const handoff = renderHandoff(repository);
    assert.match(handoff, /## Current Work\n\n`demo-change`/);
    assert.match(handoff, /## Blocked Changes[\s\S]*`blocked-change`/);
    assert.match(handoff, /## Pending Archival[\s\S]*`completed-change`/);
    assert.match(handoff, /## Ready to Resume[\s\S]*`resume-change`/);
    validateHandoff(repository);

    const archiveRoot = path.join(repository, 'openspec/changes/archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.renameSync(
      path.join(repository, 'openspec/changes/completed-change'),
      path.join(archiveRoot, '2026-08-24-completed-change'),
    );
    const archived = inspectChangeRouting(repository);
    assert.equal(
      archived.changes.find(({ changeId }) => changeId === 'completed-change')
        ?.state,
      'archived',
    );
    assert.equal(
      archived.changes.find(({ changeId }) => changeId === 'demo-change')
        ?.state,
      'primary',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routing never auto-focuses and focus consumes current Manifest v3 plus separate PlanReview', () => {
  const repository = createFixtureRepository();
  try {
    const historical = inspectChangeRouting(repository);
    assert.equal(historical.primaryChangeId, null);
    assert.equal(historical.changes[0]?.state, 'recovery-required');
    assert.throws(
      () =>
        prepareChangeRoutingReview(repository, {
          schemaVersion: 1,
          action: { kind: 'focus', changeId: 'demo-change' },
        }),
      { code: 'OPENSPEC_MANAGED_SCHEMA_REQUIRED' },
    );

    writeReadyV3ExemptChange(repository);
    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    assert.equal(review.schemaVersion, 3);
    assert.equal(review.kind, 'jigwright.change-routing-review.v3');
    assert.equal(review.authorityFacts.length, 1);
    assert.equal(review.authorityFacts[0]?.changeId, 'demo-change');
    assert.match(
      review.authorityFacts[0]?.manifestDigest ?? '',
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      review.authorityFacts[0]?.reviewNodeId ?? '',
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      review.authorityFacts[0]?.planningGenerationId ?? '',
      /^[0-9a-f]{64}$/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('manual or parked continuation requires one exact completed Central Grant transition', async () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const blocked = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'demo-change',
        taskId: '1.1',
        reason: 'Manual review is pending.',
        blocker: {
          kind: 'external',
          id: 'manual-review',
          resumeCondition: 'manual',
        },
      },
    });
    applyChangeRoutingReview(repository, blocked);
    assert.throws(
      () =>
        prepareChangeRoutingReview(repository, {
          schemaVersion: 1,
          action: { kind: 'resume', changeId: 'demo-change' },
        }),
      { code: 'CHANGE_ROUTING_GRANT_REQUIRED' },
    );

    const registry = createTransitionRegistry(
      changeRoutingGrantTransitionDefinitions(repository),
    );
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(runtimeRoot(repository)),
      registry,
      policy: routingGrantPolicy(),
      now: () => new Date('2026-08-24T00:00:00.000Z'),
      randomUUID: () => ids.shift()!,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'manual-continuation-reviewed',
              reason: 'The exact manual continuation was reviewed.',
              approvalMethod: 'human-presence' as const,
              sessionNonce: 'nonce-55555555555555555555555555555555',
            };
          },
          async authenticate({ approvalSubjectDigest }) {
            return [
              {
                moduleId: 'human-gate-macos',
                version: '1',
                claims: ['fresh-local-device-owner'] as const,
                approvalSubjectDigest,
                proofDigest: `sha256:${'4'.repeat(64)}` as const,
                verifiedAt: '2026-08-24T00:00:00.000Z',
                identity: null,
              },
            ];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    const requested = await coordinator.requestGrant(
      createChangeRoutingContinuationGrantRequest(
        repository,
        'demo-change',
        'Continue after the reviewed external decision.',
      ),
    );
    await coordinator.resolveChallenge(requested.challengeId);

    const resumed = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'resume',
        changeId: 'demo-change',
        grantChallengeId: requested.challengeId,
      },
    });
    assert.equal(
      resumed.continuationAuthority?.challengeId,
      requested.challengeId,
    );
    applyChangeRoutingReview(repository, resumed);
    const inspection = inspectChangeRouting(repository);
    assert.equal(inspection.primaryChangeId, null);
    assert.equal(inspection.changes[0]?.state, 'ready');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed routing declares exactly one concurrent writer and projects the workset', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'repair-change', false);
    writeChange(repository, 'undeclared-change', false);
    writeReadyV3ExemptChange(repository);
    writeReadyV3ExemptChange(repository, 'repair-change');

    const focused = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    applyChangeRoutingReview(repository, focused);

    const concurrent = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'set-concurrent', changeId: 'repair-change' },
    });
    assert.deepEqual(concurrent.nextSource.concurrentChangeIds, [
      'repair-change',
    ]);
    applyChangeRoutingReview(repository, concurrent);

    const inspection = inspectChangeRouting(repository);
    assert.deepEqual(inspection.concurrentChangeIds, ['repair-change']);
    assert.equal(
      inspection.changes.find(({ changeId }) => changeId === 'repair-change')
        ?.state,
      'concurrent',
    );
    assert.equal(
      assertChangeRoutingAdmission(repository, 'demo-change').role,
      'primary',
    );
    assert.equal(
      assertChangeRoutingAdmission(repository, 'repair-change').role,
      'concurrent',
    );
    assert.throws(
      () => assertChangeRoutingAdmission(repository, 'undeclared-change'),
      { code: 'CHANGE_ROUTING_REQUIRED' },
    );

    const handoff = renderHandoff(repository);
    assert.match(handoff, /## Concurrent Work\n\n- `repair-change`/);

    const cleared = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'clear-concurrent' },
    });
    assert.deepEqual(cleared.nextSource.concurrentChangeIds, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed routing rejects the primary change as its own concurrent writer', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    applyChangeRoutingReview(
      repository,
      prepareChangeRoutingReview(repository, {
        schemaVersion: 1,
        action: { kind: 'focus', changeId: 'demo-change' },
      }),
    );
    assert.throws(
      () =>
        prepareChangeRoutingReview(repository, {
          schemaVersion: 1,
          action: { kind: 'set-concurrent', changeId: 'demo-change' },
        }),
      { code: 'CHANGE_ROUTING_INVALID' },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('stale routing review fails before mutation and resume never auto-focuses', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'other-change', false);
    writeChange(repository, 'completed-change', true);
    writeReadyV3ExemptChange(repository);
    writeReadyV3ExemptChange(repository, 'other-change');
    const focusDemo = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    const parkOther = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'park',
        changeId: 'other-change',
        reason: 'Defer until the current product task completes.',
      },
    });
    applyChangeRoutingReview(repository, focusDemo);
    assert.throws(() => openTask(repository, 'other-change', '1.1'), {
      code: 'CHANGE_ROUTING_REQUIRED',
    });
    assert.throws(() => applyChangeRoutingReview(repository, parkOther), {
      code: 'CHANGE_ROUTING_REVIEW_STALE',
    });

    const blocked = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'other-change',
        taskId: '1.1',
        reason: 'The dependent change must complete first.',
        blocker: {
          kind: 'change',
          id: 'completed-change',
          resumeCondition: 'done',
        },
      },
    });
    applyChangeRoutingReview(repository, blocked);
    const resumed = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'resume', changeId: 'other-change' },
    });
    applyChangeRoutingReview(repository, resumed);

    const inspection = inspectChangeRouting(repository);
    assert.equal(inspection.primaryChangeId, 'demo-change');
    assert.equal(
      inspection.changes.find(({ changeId }) => changeId === 'other-change')
        ?.state,
      'ready',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('route CLI writes an exact review and apply refreshes the handoff', () => {
  const repository = createFixtureRepository();
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'route-review-'));
  try {
    writeReadyV3ExemptChange(repository);
    commitFixtureState(repository);
    const intentPath = path.join(outputRoot, 'route-intent.json');
    const reviewPath = path.join(outputRoot, 'route-review.json');
    fs.writeFileSync(
      intentPath,
      `${JSON.stringify({
        schemaVersion: 1,
        action: { kind: 'focus', changeId: 'demo-change' },
      })}\n`,
    );

    const prepared = dispatchChangeRoutingCommand(
      ['prepare', '--intent', intentPath, '--output', reviewPath],
      repository,
    );
    assert.equal(prepared.action, 'prepare');
    assert.equal(fs.existsSync(reviewPath), true);
    const baseline = git(repository, ['rev-parse', 'HEAD']).trim();
    const applied = dispatchChangeRoutingCommand(
      ['apply', reviewPath],
      repository,
    );
    assert.equal(applied.action, 'apply');
    assert.notEqual(applied.commitHash, baseline);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      applied.commitHash,
    );
    assert.equal(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']).trim(),
      [
        'Route managed changes',
        '',
        'Transition: route',
        `Routing-Review: ${applied.reviewDigest}`,
      ].join('\n'),
    );
    assert.equal(
      fs.existsSync(path.join(repository, applied.reportPath)),
      true,
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
    const commits = listRangeCommits(repository, baseline, applied.commitHash);
    assert.equal(commits.length, 1);
    const routeCommit = commits[0]!;
    const routeTrailers = routeCommit.trailers;
    assert.equal(routeTrailers?.kind, 'route');
    if (routeTrailers?.kind !== 'route') {
      assert.fail('expected a managed route commit');
    }
    assert.doesNotThrow(() =>
      validateCiRouteCommit(repository, {
        ...routeCommit,
        trailers: routeTrailers,
      }),
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      /## Current Work\n\n`demo-change`/,
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed routing commits and replays the handoff path from repository configuration', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      documents: { handoffPath: string };
    };
    consumer.documents.handoffPath = 'notebook/handoff.md';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'poisoned default handoff\n',
    );
    commitFixtureState(repository);

    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    const baseline = git(repository, ['rev-parse', 'HEAD']).trim();
    const applied = applyManagedChangeRoutingReview(repository, review);
    const [routeCommit] = listRangeCommits(
      repository,
      baseline,
      applied.commitHash,
    );
    assert.ok(routeCommit);
    const routeTrailers = routeCommit.trailers;
    assert.equal(routeTrailers?.kind, 'route');
    if (routeTrailers?.kind !== 'route') {
      assert.fail('expected a managed route commit');
    }
    assert.deepEqual(
      git(repository, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        applied.commitHash,
      ])
        .trim()
        .split('\n')
        .sort(),
      [
        'notebook/handoff.md',
        'openspec/change-lifecycle.json',
        applied.reportPath,
      ].sort(),
    );
    assert.equal(
      fs.readFileSync(
        path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      'poisoned default handoff\n',
    );
    assert.match(
      fs.readFileSync(path.join(repository, 'notebook/handoff.md'), 'utf8'),
      /## Current Work\n\n`demo-change`/,
    );
    assert.doesNotThrow(() =>
      validateCiRouteCommit(repository, {
        ...routeCommit,
        trailers: routeTrailers,
      }),
    );

    consumer.documents.handoffPath = 'docs/CURRENT_AND_NEXT_STEPS.md';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    assert.doesNotThrow(() =>
      validateCiRouteCommit(repository, {
        ...routeCommit,
        trailers: routeTrailers,
      }),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('pre-commit rejects even an exact hand-staged routing projection', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    applyChangeRoutingReview(repository, review);
    renderHandoff(repository);
    git(repository, [
      'add',
      '--',
      'openspec/change-lifecycle.json',
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ]);
    assert.throws(() => runRepositoryHook(repository, 'pre-commit', []), {
      code: 'CHANGE_ROUTING_COMMIT_UNAUTHORIZED',
    });

    const sourcePath = path.join(repository, 'openspec/change-lifecycle.json');
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as Record<
      string,
      unknown
    >;
    source.primaryChangeId = null;
    fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    renderHandoff(repository);
    git(repository, [
      'add',
      '--',
      'openspec/change-lifecycle.json',
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ]);
    assert.throws(() => runRepositoryHook(repository, 'pre-commit', []), {
      code: 'CHANGE_ROUTING_COMMIT_UNAUTHORIZED',
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed route apply recovers the exact commit object without duplicating the transition', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    commitFixtureState(repository);
    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    const baseline = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        applyManagedChangeRoutingReview(repository, review, {
          crashAfterCommitObject: true,
        }),
      /simulated route crash after commit object/,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baseline);

    const recovered = applyManagedChangeRoutingReview(repository, review);
    assert.equal(recovered.replayed, true);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      recovered.commitHash,
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
    const replayed = applyManagedChangeRoutingReview(repository, review);
    assert.equal(replayed.commitHash, recovered.commitHash);
    assert.equal(replayed.replayed, true);
    assert.equal(
      git(repository, ['rev-list', '--count', `${baseline}..HEAD`]).trim(),
      '1',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed routing and handoff replay without private runtime', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    applyChangeRoutingReview(repository, review);
    renderHandoff(repository);
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Record managed routing projection']);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    assert.deepEqual(validateRepositoryStateAtCommit(repository, commit), {
      repositoryRoot: fs.realpathSync(repository),
      changes: ['demo-change'],
      documents: [],
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routing inventory remains authoritative across planning and completion projections', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    applyChangeRoutingReview(repository, review);
    renderHandoff(repository);

    const planningProjection = renderHandoffForChange(
      repository,
      'demo-change',
    );
    assert.match(planningProjection, /## Current Work\n\n`demo-change`/u);
    assert.doesNotMatch(planningProjection, /## Current Change/u);
    assert.doesNotThrow(() =>
      validateHandoffForChange(repository, 'demo-change'),
    );

    const completionProjection = projectHandoffForTaskProjection(
      repository,
      'demo-change',
      '# Tasks\n\n- [x] 1.1 Demo task\n',
    );
    assert.match(
      completionProjection,
      /## Current Work\n\nNone — no managed primary focus\./u,
    );
    assert.match(
      completionProjection,
      /## Pending Archival[\s\S]*`demo-change`/u,
    );
    assert.doesNotMatch(completionProjection, /## Current Change/u);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion projection wakes blockers that depend on the projected change', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'blocked-change', false);
    writeReadyV3ExemptChange(repository);
    const blocked = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'blocked-change',
        taskId: '1.1',
        reason: 'Wait until the focused change is complete.',
        blocker: {
          kind: 'change',
          id: 'demo-change',
          resumeCondition: 'done',
        },
      },
    });
    applyChangeRoutingReview(repository, blocked);
    const focused = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    applyChangeRoutingReview(repository, focused);

    const completedTasks = '# Tasks\n\n- [x] 1.1 Demo task\n';
    const projected = projectHandoffForTaskProjection(
      repository,
      'demo-change',
      completedTasks,
    );
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/tasks.md'),
      completedTasks,
    );
    const realized = renderHandoff(repository);

    assert.equal(projected, realized);
    assert.match(projected, /## Ready to Resume[\s\S]*`blocked-change`/u);
    assert.doesNotMatch(
      projected,
      /## Blocked Changes[\s\S]*`blocked-change`/u,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routing review is stale when exact planning authority facts change', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const review = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    });
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '# Proposal\n\nChanged after routing review.\n',
    );
    assert.throws(() => applyChangeRoutingReview(repository, review), {
      code: 'CHANGE_ROUTING_REVIEW_STALE',
    });
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/change-lifecycle.json')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('change blocker dependency cycles fail closed during prepare', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'change-b', false);
    const blockDemo = prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'demo-change',
        taskId: '1.1',
        reason: 'Wait for the dependent change.',
        blocker: {
          kind: 'change',
          id: 'change-b',
          resumeCondition: 'done',
        },
      },
    });
    applyChangeRoutingReview(repository, blockDemo);
    assert.throws(
      () =>
        prepareChangeRoutingReview(repository, {
          schemaVersion: 1,
          action: {
            kind: 'block',
            changeId: 'change-b',
            taskId: '1.1',
            reason: 'Wait for the original change.',
            blocker: {
              kind: 'change',
              id: 'demo-change',
              resumeCondition: 'done',
            },
          },
        }),
      { code: 'CHANGE_ROUTING_INVALID' },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function writeChange(
  repository: string,
  changeId: string,
  completed: boolean,
): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.cpSync(path.join(repository, 'openspec/changes/demo-change'), directory, {
    recursive: true,
  });
  const guardPath = path.join(directory, 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
  };
  guard.changeId = changeId;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  const providerPath = path.join(
    repository,
    'workflow/change-providers',
    `${changeId}.json`,
  );
  fs.writeFileSync(
    providerPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        providerId: 'openspec',
        adapterContractVersion: 1,
        providerRequirement: {
          package: '@fission-ai/openspec',
          version: '1.6.0',
        },
        planningRoot: `openspec/changes/${changeId}`,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    `# Tasks\n\n- [${completed ? 'x' : ' '}] 1.1 Example task\n`,
  );
}

function commitFixtureState(repository: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Prepare current routing authority']);
}

function routingGrantPolicy() {
  return parseGrantPolicyV2(
    {
      schemaVersion: 2,
      defaultProfile: 'local-presence',
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
      },
      approvalModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          allowedClaims: ['fresh-local-device-owner'],
          configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
        },
      ],
      legacyVerification: { maintainerPolicyV1: 'read-only' },
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );
}
