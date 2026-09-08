/** Current planning introduction/revision replay through immutable CI and production composition. */
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { validateCiPlanningCommit } from '../src/entrypoints/ci/ci-planning.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { execFileSync } from 'node:child_process';
import { loadHistoricalTaskAuthority } from '../src/entrypoints/ci/ci-historical-contract.ts';
import os from 'node:os';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH } from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import {
  prepareCurrentV3IntroductionRepository,
  writeReadyV3ExemptChange,
  refreshFixturePlanReview,
} from './ci-planning-assurance-fixture.ts';
import {
  createPackageSchemaRepository,
  writePackageSchemaPlanningTree,
  commitPlan,
  CHANGE_ID,
  commit,
  write,
  overrideCentralConfiguration,
  writeOverrideCentralConfiguration,
  writePlanningProviderBindingForChange,
  writeAgentRolePlanV2,
  writeProviderBinding,
  changeDirectory,
  writeCurrentTasksAndGuard,
  mktree,
  replaceTreeEntry,
} from './ci-planning-fixture.ts';

test('CI planning task replay crosses the production planning composition root', () => {
  const ciPlanningSource = fs.readFileSync(
    new URL('../src/entrypoints/ci/ci-planning.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    ciPlanningSource,
    /adapters\/planning\/openspec\/documents\/planning-contract/u,
  );
  for (const helper of [
    'amendmentLeftWorkMarkedDone',
    'assertPlanningTaskHistory',
    'taskStates',
  ]) {
    assert.match(ciPlanningSource, new RegExp(`\\b${helper}\\b`, 'u'));
  }
});

test('CI replays a configured current schema from immutable consumer config', () => {
  const repository = prepareCurrentV3IntroductionRepository({
    currentSchemaName: 'orbit-spec-v1',
  });
  try {
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      planning: {
        requiredSchemaNames: string[];
        supportedSchemaNames: string[];
        managedSchemaNames: string[];
        currentSchemaName: string;
      };
    };
    const plan = commitPlanningTransition(repository, 'demo-change');
    const replay = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      'demo-change',
    );
    assert.equal(replay.schemaName, 'orbit-spec-v1');
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
    );

    consumer.planning.currentSchemaName = 'untrusted-checkout-schema';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    assert.equal(
      validateCiPlanningCommit(repository, plan.commitHash, 'demo-change')
        .schemaName,
      'orbit-spec-v1',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects v3 planning assurance whose baseline is not the exact plan parent tree', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    refreshFixturePlanReview(repository);

    fs.appendFileSync(
      path.join(repository, 'README.md'),
      '\nAdvance parent.\n',
    );
    git(repository, ['add', '--', 'README.md']);
    git(repository, ['commit', '-m', 'Advance planning parent']);

    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const plan = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, 'demo-change'),
      (error) => isWorkflowError(error, 'CI_PLANNING_BASELINE_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI committed v3 replay rejects a stale PlanReview without private-ref fallback', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    refreshFixturePlanReview(repository);
    const planReviewPath = path.join(
      repository,
      'openspec/changes/demo-change/plan-review.json',
    );
    const stalePlanReview = fs.readFileSync(planReviewPath);

    fs.appendFileSync(path.join(repository, 'README.md'), '\nNew baseline.\n');
    git(repository, ['add', '--', 'README.md']);
    git(repository, ['commit', '-m', 'Advance Manifest baseline']);
    writeReadyV3ExemptChange(repository);
    fs.writeFileSync(planReviewPath, stalePlanReview);

    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const plan = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses package-schema planning history before provider or task replay', () => {
  const repository = createPackageSchemaRepository();
  try {
    writePackageSchemaPlanningTree(repository, '- [x] 1.1 Already complete');
    const plan = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, CHANGE_ID),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a current-schema parent missing a required artifact even when the revision repairs it', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  const changeId = CHANGE_ID;
  try {
    commitPlanningTransition(repository, changeId);

    fs.rmSync(
      path.join(repository, 'openspec/changes', changeId, 'execution.json'),
    );
    commit(repository, 'Admit incomplete current planning tree');

    writeReadyV3ExemptChange(repository, changeId);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, changeId);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision.commitHash, changeId),
      (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts an exact planning introduction reconstructed from Git', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const plan = commitPlanningTransition(repository, CHANGE_ID);
    const replay = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      CHANGE_ID,
    );

    assert.equal(replay.changeId, CHANGE_ID);
    assert.equal(replay.kind, 'introduction');
    assert.equal(replay.beforeTasks, undefined);
    assert.deepEqual(replay.afterTasks, [{ id: '1.1', completed: false }]);
    assert.deepEqual(replay.changedPaths, plan.changedPaths);
    assert.equal(replay.schemaName, 'jigwright');
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
    );
    assert.deepEqual(replay.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current planning and immutable CI reject dangling or noncanonical governance origins without mutation', () => {
  const originPath = `openspec/changes/${CHANGE_ID}/origin.json`;
  const cases = [
    {
      name: 'dangling Source citation',
      bytes: `${canonicalJson({
        schemaVersion: 1,
        sourceRefs: [`SRC-${'f'.repeat(64)}`],
        workItemRefs: [],
      })}\n`,
    },
    {
      name: 'noncanonical bytes',
      bytes: `${JSON.stringify(
        { schemaVersion: 1, sourceRefs: [], workItemRefs: [] },
        null,
        2,
      )}\n`,
    },
  ] as const;

  for (const scenario of cases) {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      write(repository, originPath, scenario.bytes);
      const beforeHead = git(repository, ['rev-parse', 'HEAD']).trim();
      const beforeStatus = git(repository, ['status', '--porcelain=v1', '-z']);

      assert.throws(
        () => commitPlanningTransition(repository, CHANGE_ID),
        (error) => isWorkflowError(error, 'WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.equal(
        fs.readFileSync(path.join(repository, originPath), 'utf8'),
        scenario.bytes,
      );
      assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), beforeHead);
      assert.equal(
        git(repository, ['status', '--porcelain=v1', '-z']),
        beforeStatus,
      );

      const invalidCommit = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, invalidCommit, CHANGE_ID),
        (error) => isWorkflowError(error, 'WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.equal(
        execFileSync('git', ['show', `${invalidCommit}:${originPath}`], {
          cwd: repository,
          encoding: 'utf8',
        }),
        scenario.bytes,
      );
      assert.equal(
        git(repository, ['rev-parse', 'HEAD']).trim(),
        invalidCommit,
      );
      assert.equal(git(repository, ['status', '--porcelain=v1', '-z']), '');
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('CI replays task authority from an immutable current-schema planning introduction', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const plan = commitPlanningTransition(repository, CHANGE_ID);

    const authority = loadHistoricalTaskAuthority(
      repository,
      plan.commitHash,
      CHANGE_ID,
      '1.1',
    );

    assert.equal(authority.taskId, '1.1');
    assert.deepEqual(authority.requiredChecks, ['fixture']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays a v2 agent-role override first added by the planning introduction', () => {
  const repository = createFixtureRepository();
  const changeId = 'demo-change';
  const changeBackup = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ci-agent-role-plan-change-'),
  );
  try {
    const central = overrideCentralConfiguration();
    const changePath = path.join(repository, 'openspec/changes', changeId);
    const backupPath = path.join(changeBackup, changeId);
    fs.cpSync(changePath, backupPath, { recursive: true });
    fs.rmSync(changePath, {
      recursive: true,
      force: true,
    });
    fs.rmSync(
      path.join(repository, `workflow/change-providers/${changeId}.json`),
      { force: true },
    );
    write(
      repository,
      'openspec/changes/other-change/keep.md',
      'Unrelated baseline change container.\n',
    );
    writeOverrideCentralConfiguration(repository, central);
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Prepare absent change with central role provider default',
    ]);

    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.cpSync(backupPath, changePath, { recursive: true });
    writeReadyV3ExemptChange(repository);
    writePlanningProviderBindingForChange(repository, changeId);
    writeAgentRolePlanV2(repository, changeId, central.configurationDigest);
    refreshFixturePlanReview(repository);
    const plan = commitPlanningTransition(repository, changeId);

    assert.equal(
      plan.changedPaths.includes(agentRolePlanV2Path(changeId)),
      true,
    );
    const replay = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      changeId,
    );
    assert.equal(replay.kind, 'introduction');
    assert.equal(
      replay.changedPaths.includes(agentRolePlanV2Path(changeId)),
      true,
    );
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
    );

    writeOverrideCentralConfiguration(
      repository,
      overrideCentralConfiguration(['codex', 'claude']),
    );
    assert.equal(
      validateCiPlanningCommit(repository, plan.commitHash, changeId)
        .planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
      'CI replay must ignore mutable worktree configuration',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(changeBackup, { recursive: true, force: true });
  }
});

test('CI fails closed when a committed central configuration drifts from the v2 override base', () => {
  const repository = createFixtureRepository();
  const changeId = 'demo-change';
  try {
    const central = overrideCentralConfiguration();
    writeOverrideCentralConfiguration(repository, central);
    git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Add central role provider default',
    ]);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    writeReadyV3ExemptChange(repository);
    writeAgentRolePlanV2(repository, changeId, central.configurationDigest);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, changeId);
    assert.equal(revision.kind, 'revision');
    assert.equal(
      revision.changedPaths.includes(agentRolePlanV2Path(changeId)),
      true,
    );

    writeOverrideCentralConfiguration(
      repository,
      overrideCentralConfiguration(['codex', 'claude']),
    );
    git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Change central role provider default',
    ]);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes', changeId, 'design.md'),
      '\nCommitted central drift.\n',
    );
    git(repository, ['add', `openspec/changes/${changeId}/design.md`]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      `Plan ${changeId}`,
      '-m',
      `Change: ${changeId}\nTransition: plan`,
    ]);
    const drift = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, drift, changeId),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays an explicit planning-provider binding from the planning commit', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const plan = commitPlanningTransition(repository, CHANGE_ID);

    const result = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      CHANGE_ID,
    );
    assert.equal(result.kind, 'introduction');
    assert.deepEqual(result.changedPaths, plan.changedPaths);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses changing the exact planning-provider binding', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);

    writeProviderBinding(repository, { providerId: 'spectra' });
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'proposal.md'),
      '\nForged provider replacement.\n',
    );
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlan(repository);
    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_MIGRATION_UNSUPPORTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses a planning introduction without its explicit provider binding', () => {
  const repository = prepareCurrentV3IntroductionRepository({
    includeProviderBinding: false,
  });
  try {
    const plan = commitPlan(repository);
    assert.throws(
      () => validateCiPlanningCommit(repository, plan, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_BINDING_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts a revision that reorders and removes unfinished tasks', () => {
  const repository = prepareCurrentV3IntroductionRepository({
    tasks: [
      '- [ ] 1.1 First task',
      '- [ ] 1.2 Removable task',
      '- [ ] 1.3 Completed task',
    ].join('\n'),
  });
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    writeCurrentTasksAndGuard(
      repository,
      [
        '- [ ] 1.1 First task',
        '- [ ] 1.2 Removable task',
        '- [x] 1.3 Completed task',
      ].join('\n'),
    );
    commit(repository, 'Complete fixture task');

    writeCurrentTasksAndGuard(
      repository,
      [
        '- [x] 1.3 Completed task',
        '- [ ] 1.1 First task',
        '- [ ] 2.1 New task',
      ].join('\n'),
    );
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nRevision.\n',
    );
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, CHANGE_ID);
    const replay = validateCiPlanningCommit(
      repository,
      revision.commitHash,
      CHANGE_ID,
    );

    assert.equal(replay.kind, 'revision');
    assert.deepEqual(replay.beforeTasks, [
      { id: '1.1', completed: false },
      { id: '1.2', completed: false },
      { id: '1.3', completed: true },
    ]);
    assert.deepEqual(replay.afterTasks, [
      { id: '1.3', completed: true },
      { id: '1.1', completed: false },
      { id: '2.1', completed: false },
    ]);
    assert.deepEqual(replay.changedPaths, revision.changedPaths);
    assert.equal(replay.schemaName, 'jigwright');
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      revision.planningAssurance?.planningGenerationId,
    );
    assert.deepEqual(replay.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a checked task in a planning introduction or revision', async (t) => {
  await t.test('introduction', () => {
    const repository = prepareCurrentV3IntroductionRepository({
      tasks: '- [x] 1.1 Already complete',
    });
    try {
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('revision', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      commitPlanningTransition(repository, CHANGE_ID);
      writeCurrentTasksAndGuard(repository, '- [x] 1.1 Illegally completed');
      writeReadyV3ExemptChange(repository, CHANGE_ID);
      refreshFixturePlanReview(repository);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects code, base specs, archives, and another change in a plan', async (t) => {
  const cases = [
    ['code', 'src/feature.ts'],
    ['base spec', 'openspec/specs/demo/spec.md'],
    ['archive', `openspec/changes/archive/2026-07-15-${CHANGE_ID}/proposal.md`],
    ['another change', 'openspec/changes/other-change/proposal.md'],
    ['dependency manifest', 'package.json'],
  ] as const;

  for (const [label, extraPath] of cases) {
    await t.test(label, () => {
      const repository = prepareCurrentV3IntroductionRepository();
      try {
        write(repository, extraPath, `${label}\n`);
        const commitHash = commitPlan(repository);
        assert.throws(
          () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
          (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('CI rejects symlink and executable planning artifacts from the Git tree', async (t) => {
  await t.test('symlink', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      const designPath = path.join(changeDirectory(repository), 'design.md');
      fs.rmSync(designPath);
      fs.symlinkSync('proposal.md', designPath);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_COMMITTED_CHECKOUT_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('executable', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      fs.chmodSync(path.join(changeDirectory(repository), 'design.md'), 0o755);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_COMMITTED_CHECKOUT_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects an incomplete planning tree and a non-canonical plan message', async (t) => {
  await t.test('missing required artifact', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      fs.rmSync(path.join(changeDirectory(repository), 'execution.json'));
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'MISSING_CHANGE_ARTIFACT'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('wrong subject', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      const commitHash = commitPlan(repository, 'Revise plan');
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_MESSAGE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects a merge commit even when it uses the plan message', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    git(repository, ['checkout', '-b', 'side']);
    write(repository, 'side.txt', 'side\n');
    commit(repository, 'Add side branch');
    git(repository, ['checkout', `work/${CHANGE_ID}`]);
    write(repository, 'main.txt', 'main\n');
    commit(repository, 'Advance planning branch');
    git(repository, [
      'merge',
      '--no-ff',
      'side',
      '-m',
      `Plan ${CHANGE_ID}`,
      '-m',
      `Change: ${CHANGE_ID}\nTransition: plan`,
    ]);
    const merge = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, merge, CHANGE_ID),
      (error) => isWorkflowError(error, 'CI_PLANNING_NON_LINEAR'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts a revision that deletes non-canonical planning noise', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    const noisePath = path.join(
      changeDirectory(repository),
      'requirement-audit.md',
    );
    fs.writeFileSync(noisePath, 'Non-canonical planning noise.\n');
    commit(repository, 'Add non-canonical planning noise');
    fs.rmSync(noisePath);
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nNoise retired.\n',
    );
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, CHANGE_ID);

    const result = validateCiPlanningCommit(
      repository,
      revision.commitHash,
      CHANGE_ID,
    );
    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, revision.changedPaths);
    assert.equal(
      result.changedPaths.includes(
        `openspec/changes/${CHANGE_ID}/requirement-audit.md`,
      ),
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects corrupt current-schema metadata before provider replay', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    const metadataPath = path.join(
      changeDirectory(repository),
      '.openspec.yaml',
    );
    fs.writeFileSync(
      metadataPath,
      'schema: jigwright\ncreated: 2026-07-24\ncorrupt: true\n',
    );
    commit(repository, 'Admit corrupt current metadata');
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_METADATA_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI still rejects a revision whose before tree stays incomplete', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    fs.rmSync(path.join(changeDirectory(repository), 'execution.json'));
    commit(repository, 'Admit incomplete current planning tree');
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nRevision without repair.\n',
    );
    const revision = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'MISSING_CHANGE_ARTIFACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a planning tree with duplicate entries', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const introduction = commitPlanningTransition(
      repository,
      CHANGE_ID,
    ).commitHash;

    const prefix = `openspec/changes/${CHANGE_ID}`;
    const forgedBlob = execFileSync(
      'git',
      ['-C', repository, 'hash-object', '-w', '--stdin'],
      { encoding: 'utf8', input: '# Forged proposal\n' },
    ).trim();
    const duplicatedChangeTree = mktree(
      repository,
      `${git(repository, ['ls-tree', `${introduction}:${prefix}`])}100644 blob ${forgedBlob}\tproposal.md\n`,
    );
    const changesTree = replaceTreeEntry(
      repository,
      `${introduction}:openspec/changes`,
      CHANGE_ID,
      duplicatedChangeTree,
    );
    const openspecTree = replaceTreeEntry(
      repository,
      `${introduction}:openspec`,
      'changes',
      changesTree,
    );
    const rootTree = replaceTreeEntry(
      repository,
      introduction,
      'openspec',
      openspecTree,
    );
    const revision = execFileSync(
      'git',
      [
        '-C',
        repository,
        'commit-tree',
        rootTree,
        '-p',
        introduction,
        '-m',
        `Plan ${CHANGE_ID}`,
        '-m',
        `Change: ${CHANGE_ID}\nTransition: plan`,
      ],
      { encoding: 'utf8' },
    ).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI still rejects added or escaping non-canonical planning paths', () => {
  const added = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(added, CHANGE_ID);
    writeReadyV3ExemptChange(added, CHANGE_ID);
    refreshFixturePlanReview(added);
    fs.writeFileSync(
      path.join(changeDirectory(added), 'requirement-audit.md'),
      'New noise.\n',
    );
    const additionCommit = commitPlan(added);
    assert.throws(
      () => validateCiPlanningCommit(added, additionCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(added, { recursive: true, force: true });
  }

  const escaping = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(escaping, CHANGE_ID);
    const outsidePath = path.join(
      escaping,
      'openspec/changes/other-change-note.md',
    );
    fs.writeFileSync(outsidePath, 'Outside the named change tree.\n');
    commit(escaping, 'Add outside note');
    fs.rmSync(outsidePath);
    fs.appendFileSync(
      path.join(changeDirectory(escaping), 'design.md'),
      '\nRevision.\n',
    );
    writeReadyV3ExemptChange(escaping, CHANGE_ID);
    refreshFixturePlanReview(escaping);
    const escapeCommit = commitPlan(escaping);
    assert.throws(
      () => validateCiPlanningCommit(escaping, escapeCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(escaping, { recursive: true, force: true });
  }
});
