import {
  createDocumentationClosureRecord,
  encodeDocumentationClosure,
} from '../src/modules/assurance/documentation-closure.ts';
import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { verifyPullRequest } from '../src/composition-root/ci-verification-production.ts';
import { loadHistoricalTaskAuthority } from '../src/composition-root/ci-replay-production.ts';
import { canonicalCheckDefinition } from '../src/modules/assurance/commit-replay/ci-historical-contract.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';

import {
  createTaskDiffDocumentationClosureRequirement,
  createTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/modules/assurance/task-diff-review.ts';
import { createTaskDiffReviewRecord } from '../src/modules/assurance/task-diff-review-artifact.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import {
  configureChecks,
  createFixtureRepository as createLegacyFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';

test('CI recomputes task, scope, trailers, and checks without runtime reports', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository, {
      documentationClosure: true,
    });
    const fakeReports = path.join(repository, '.git/workflow-engine/reports');
    fs.mkdirSync(fakeReports, { recursive: true });
    fs.writeFileSync(path.join(fakeReports, 'forged.json'), '{}\n');

    const result = verifyPullRequest(repository, base, head);
    assert.deepEqual(result.completedTasks, [
      { changeId: 'demo-change', taskId: '1.1' },
    ]);
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ['fixture'],
    );
    assert.deepEqual(result.changedPaths, [
      'openspec/changes/demo-change/tasks.md',
      'src/feature.ts',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays an active v3 head after its private runtime is removed', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository, {
      documentationClosure: true,
    });
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    assert.deepEqual(verifyPullRequest(repository, base, head).completedTasks, [
      { changeId: 'demo-change', taskId: '1.1' },
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a non-current schema at the active head', () => {
  const repository = createLegacyFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);

    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'OPENSPEC_LEGACY_SCHEMA_FORBIDDEN'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('immutable task authority rejects a package-schema governing parent', () => {
  const repository = createLegacyFixtureRepository();
  try {
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () =>
        loadHistoricalTaskAuthority(repository, parent, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'CI_TASK_CURRENT_PLAN_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('immutable task authority replays its current-v3 governing plan', () => {
  const repository = createFixtureRepository();
  try {
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();

    const authority = loadHistoricalTaskAuthority(
      repository,
      parent,
      'demo-change',
      '1.1',
    );

    assert.equal(authority.taskId, '1.1');
    assert.deepEqual(authority.requiredChecks, ['fixture']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary required-check edits fail at check time and CI replay', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const changeRoot = path.join(repository, 'openspec/changes/demo-change');
    fs.appendFileSync(
      path.join(changeRoot, 'tasks.md'),
      '\n- [ ] 1.2 Keep the change open\n',
    );
    const guardPath = path.join(changeRoot, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths.push('workflow/checks.json');
    guard.tasks['1.2'] = structuredClone(guard.tasks['1.1']);
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const registryPath = path.join(repository, 'workflow/checks.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.checks.fixture.command.push('ordinary-definition-drift');
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
        ),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
    abortSession(
      repository,
      session.sessionId,
      'Retain the attempted edit for independent CI replay',
    );
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_CHECK_DEFINITION_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered format and asset definitions activate in planning and replay from committed evidence', () => {
  const repository = createFixtureRepository();
  try {
    const checks = {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
      'workflow-format': {
        command: ['node', 'scripts/pass.mjs', 'format-scope'],
        destructiveDatabase: false,
      },
      'openspec-assets': {
        command: ['node', 'scripts/pass.mjs', 'asset-scope'],
        destructiveDatabase: false,
      },
    };
    configureChecks(repository, checks, ['fixture']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const registered = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.deepEqual(
      loadHistoricalTaskAuthority(repository, registered, 'demo-change', '1.1')
        .requiredChecks,
      ['fixture'],
    );
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].requiredChecks = ['workflow-format', 'openspec-assets'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const activated = git(repository, ['rev-parse', 'HEAD']).trim();
    const historical = loadHistoricalTaskAuthority(
      repository,
      activated,
      'demo-change',
      '1.1',
    );
    const expected = {
      'workflow-format': canonicalCheckDefinition(checks['workflow-format']),
      'openspec-assets': canonicalCheckDefinition(checks['openspec-assets']),
    };
    assert.deepEqual(historical.checkDefinitions, expected);
    const head = commitCompletedTask(repository, {
      documentationClosure: true,
    });
    const verified = verifyPullRequest(repository, activated, head);
    assert.deepEqual(
      verified.checks.map(({ checkId }) => checkId),
      ['openspec-assets', 'workflow-format'],
    );
    const registryPath = path.join(repository, 'workflow/checks.json');
    checks['openspec-assets'].command = ['node', 'scripts/fail.mjs'];
    fs.writeFileSync(
      registryPath,
      `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n`,
    );
    assert.deepEqual(
      loadHistoricalTaskAuthority(repository, activated, 'demo-change', '1.1')
        .checkDefinitions,
      expected,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts an ordinary planning introduction as a distinct transition', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/planned-change']);
    writeCurrentPlanningChange(repository, 'planned-change');
    commitPlanningTransition(repository, 'planned-change');
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    const result = verifyPullRequest(repository, base, head);

    assert.deepEqual(result.completedTasks, []);
    assert.deepEqual(result.commits, [head]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current planning rejects the reserved OpenSpec archive container before commit', () => {
  const repository = createLegacyFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/archive']);
    assert.throws(
      () => writeCurrentPlanningChange(repository, 'archive'),
      (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI authorizes a task from the planning revision in its parent', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths = ['feature/**'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.mkdirSync(path.join(repository, 'feature'));
    fs.writeFileSync(path.join(repository, 'feature/ok.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    const head = commitStagedTaskWithDocumentationClosure(
      repository,
      'feature/ok.ts',
      'Complete revised task',
    );

    assert.doesNotThrow(() => verifyPullRequest(repository, base, head));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a later plan revision cannot retroactively widen an earlier task', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Complete task outside its parent scope',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);

    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths.push('outside.txt');
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_OUT_OF_SCOPE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an invalid broad parent contract cannot be laundered by a later narrow plan', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths = ['outside.txt'];
    guard.tasks['9.9'] = {
      allowedPaths: ['outside.txt'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Use invalid historical authority',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);

    delete guard.tasks['9.9'];
    guard.tasks['1.1'].allowedPaths = ['src/**'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'TASK_POLICY_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a completed checkbox without an exact task trailer', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository, { trailers: false });
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_TRAILERS_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects aggregate paths outside newly completed task scope', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_OUT_OF_SCOPE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a later trailer commit cannot authorize an earlier checkbox transition', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    commitCompletedTask(repository, { trailers: false });
    fs.writeFileSync(path.join(repository, 'src/follow-up.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Add delayed task trailer',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_COMMIT_TRAILERS_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a managed trailer without its task transition', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Claim an incomplete task without completing it',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_TRANSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects replay of an already completed task trailer', () => {
  const repository = createFixtureRepository();
  try {
    commitCompletedTask(repository);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/replay']);
    fs.writeFileSync(path.join(repository, 'src/follow-up.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Replay completed task authority',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_TRANSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects completion that skips an earlier task', () => {
  const repository = createFixtureRepository();
  try {
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.appendFileSync(tasksPath, '- [ ] 1.2 Second task\n');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.2'] = {
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add second fixture task']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/skip-task']);
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.2', '- [x] 1.2'),
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Skip the first task',
      '-m',
      'Change: demo-change\nTask: 1.2',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_ORDER_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects reordering existing tasks to manufacture a valid prefix', () => {
  const repository = createFixtureRepository();
  try {
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      '# Tasks\n\n- [ ] 1.1 Demo task\n- [ ] 1.2 Second task\n',
    );
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.2'] = {
      allowedPaths: ['openspec/changes/demo-change/tasks.md', 'src/**'],
      requiredChecks: ['fixture'],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add second reorderable fixture task']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/reorder-task']);
    fs.writeFileSync(
      tasksPath,
      '# Tasks\n\n- [x] 1.2 Second task\n- [ ] 1.1 Demo task\n',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Reorder tasks around the completion frontier',
      '-m',
      'Change: demo-change\nTask: 1.2',
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_ORDER_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects head policy self-broadening for an existing change', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths.push('outside.txt');
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    writeReadyV3ExemptChange(repository);
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_PLANNING_MUTATION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI requires PR head to contain the exact current base', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);
    git(repository, ['checkout', 'main']);
    fs.writeFileSync(path.join(repository, 'base-update.txt'), 'base update\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Advance target branch']);
    const advancedBase = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', 'work/demo-change']);
    assert.throws(
      () => verifyPullRequest(repository, advancedBase, head),
      (error) => isWorkflowError(error, 'CI_BASE_NOT_ANCESTOR'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI only grants implicit tasks.md scope to exact checkbox projection', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('Demo task', 'Rewritten task'),
    );
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_TASK_PROJECTION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a required check that mutates the checkout', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', 'mutated.txt'],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository, {
      documentationClosure: true,
    });
    assert.throws(
      () => verifyPullRequest(repository, base, head),
      (error) => isWorkflowError(error, 'CI_CHECK_MUTATED_WORKTREE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI requires exact commit IDs and the checked out head', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const head = commitCompletedTask(repository);
    assert.throws(
      () => verifyPullRequest(repository, 'HEAD~1', head),
      (error) => isWorkflowError(error, 'CI_COMMIT_ID_INVALID'),
    );
    assert.throws(
      () => verifyPullRequest(repository, base, base),
      (error) => isWorkflowError(error, 'CI_HEAD_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow assurance CI is read-only and policy paths have owners', () => {
  const workflow = fs.readFileSync(
    path.join(sourceRepositoryRoot, '.github/workflows/workflow-assurance.yml'),
    'utf8',
  );
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /on:\n {2}pull_request_target:/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n {10}path: trusted-base/,
  );
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /path: candidate/);
  assert.match(workflow, /fetch-tags: true/);
  assert.match(
    workflow,
    /for-each-ref --format='delete %\(refname\)' refs\/tags\/workflow-grant\//,
  );
  assert.match(
    workflow,
    /refs\/tags\/workflow-grant\/\*:refs\/tags\/workflow-grant\/\*/,
  );
  assert.equal(
    workflow.match(/pnpm install --frozen-lockfile --ignore-scripts/g)?.length,
    2,
  );
  assert.match(
    workflow,
    /\.\.\/trusted-base\/packages\/workflow-engine\/src\/entrypoints\/cli\/workflow-cli\.ts ci/,
  );
  assert.doesNotMatch(workflow, /secrets\.|pnpm workflow ci/);
  const actionRefs = [...workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(actionRefs.length > 0);
  assert.ok(actionRefs.every((reference) => /^[0-9a-f]{40}$/.test(reference)));

  // Checkout failure must retain GitHub's ordinary success prerequisite for
  // every later step; repository commands cannot opt into a failure fallback.
  const steps = workflow.split(/\n {6}- name: /u).slice(1);
  assert.equal(steps[0]?.split('\n')[0], 'Checkout exact PR base');
  assert.equal(steps[1]?.split('\n')[0], 'Checkout exact PR head');
  for (const [index, role] of ['base', 'head'].entries()) {
    const checkout = steps[index]!;
    assert.match(
      checkout,
      new RegExp(
        `ref: \\$\\{\\{ github\\.event\\.pull_request\\.${role}\\.sha \\}\\}`,
      ),
    );
    assert.match(checkout, /fetch-depth: 0\n/u);
    assert.match(checkout, /persist-credentials: false\n/u);
    assert.doesNotMatch(checkout, /^\s+run:/mu);
  }
  assert.doesNotMatch(workflow, /^\s+(?:if|continue-on-error):/mu);
  assert.ok(steps.slice(2).some((step) => /^\s+run:/mu.test(step)));

  const owners = fs.readFileSync(
    path.join(sourceRepositoryRoot, '.github/CODEOWNERS'),
    'utf8',
  );
  for (const protectedPath of [
    '/AGENTS.md',
    '/.husky/',
    '/.github/workflows/',
    '/.github/CODEOWNERS',
    '/openspec/',
    '/workflow/',
    '/packages/workflow-engine/',
    '/package.json',
    '/pnpm-lock.yaml',
    '/pnpm-workspace.yaml',
  ]) {
    assert.match(owners, new RegExp(`^${escapeRegex(protectedPath)} `, 'm'));
  }
});

function createFixtureRepository(): string {
  const repository = createLegacyFixtureRepository();
  const packageSchemaFixtureCommit = git(repository, [
    'rev-parse',
    'HEAD',
  ]).trim();
  const changePath = 'openspec/changes/demo-change';
  const providerPath = 'workflow/change-providers/demo-change.json';
  git(repository, ['rm', '-r', '--', changePath, providerPath]);
  git(repository, ['commit', '--amend', '--no-edit']);
  syncOriginMain(repository);
  git(repository, [
    'checkout',
    packageSchemaFixtureCommit,
    '--',
    changePath,
    providerPath,
  ]);
  writeReadyV3ExemptChange(repository);
  git(repository, ['add', '.']);
  git(repository, [
    'commit',
    '-m',
    'Plan demo-change',
    '-m',
    'Change: demo-change\nTransition: plan',
  ]);
  return repository;
}

function commitCompletedTask(
  repository: string,
  options: { trailers?: boolean; documentationClosure?: boolean } = {},
): string {
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  git(repository, ['add', '.']);
  if (options.documentationClosure === true) {
    return commitStagedTaskWithDocumentationClosure(
      repository,
      'src/feature.ts',
      'Complete demo task',
    );
  }
  const message =
    options.trailers === false
      ? ['commit', '-m', 'Complete task without trailers']
      : [
          'commit',
          '-m',
          'Complete demo task',
          '-m',
          'Change: demo-change\nTask: 1.1',
        ];
  git(repository, message);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function commitStagedTaskWithDocumentationClosure(
  repository: string,
  sourcePath: string,
  subject: string,
): string {
  const tasksPath = 'openspec/changes/demo-change/tasks.md';
  const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
  const candidateTree = git(repository, ['write-tree']).trim();
  const beforeTaskObjectId = git(repository, [
    'rev-parse',
    `${baseCommit}:${tasksPath}`,
  ]).trim();
  const afterTaskObjectId = git(repository, [
    'rev-parse',
    `:${tasksPath}`,
  ]).trim();
  const sourceObjectId = git(repository, [
    'rev-parse',
    `:${sourcePath}`,
  ]).trim();
  const documentationTransitions = [
    {
      path: sourcePath,
      before: null,
      after: { mode: '100644' as const, objectId: sourceObjectId },
    },
  ];
  const requirement = createTaskDiffDocumentationClosureRequirement({
    required: true,
    changeBaseCommit: baseCommit,
    changeBaseTree: baseTree,
    candidateTree,
    changedPaths: [sourcePath],
    patchDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-documentation-change-patch.v1',
        transitions: documentationTransitions,
      }),
    ),
    hints: [],
  });
  const subjectRecord = createTaskDiffReviewSubject({
    repositoryId: 'github:fixture/jigwright-ci',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit,
    baseTree,
    candidateTree,
    transitions: [
      {
        path: tasksPath,
        before: { mode: '100644', objectId: beforeTaskObjectId },
        after: { mode: '100644', objectId: afterTaskObjectId },
      },
      ...documentationTransitions,
    ],
    taskContractDigest: '1'.repeat(64),
    requiredCheckPolicyDigest: '2'.repeat(64),
    checkEvidenceDigest: '3'.repeat(64),
    planningGenerationId: '4'.repeat(64),
    planTargetDigest: '5'.repeat(64),
    planReviewNodeId: '6'.repeat(64),
    planningAssuranceDigest: '7'.repeat(64),
    reviewRequirement: {
      required: true,
      basis: 'explicit',
      riskPaths: [],
    },
    documentationRequirement: requirement,
  });
  const review = createTaskDiffReviewRecord({
    subject: subjectRecord,
    assignment: {
      implementerPrincipalId: 'provider-b:implementer',
      implementerProviderId: 'provider-b',
      implementationSessionId: 'implementation-session-1',
      reviewerPrincipalId: 'provider-a:reviewer',
      reviewerProviderId: 'provider-a',
      reviewerSessionId: 'review-session-2',
      achievedIndependence: 'provider-independent',
      degradedForm: null,
      grantUseDigest: null,
    },
    submission: {
      schemaVersion: 1,
      verdict: 'advisory-approve',
      coverage: [...TASK_DIFF_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge',
        evidence: [
          {
            kind: 'repository-location',
            path: sourcePath,
            line: 1,
            blobObjectId: sourceObjectId,
            observation:
              'The exact implementation blob completes the current task.',
          },
        ],
      },
      findings: [],
      suggestions: [],
      riskPathDispositions: [],
      residualRisk: 'No release-blocking documentation risk remains.',
      uncertainty: 'Review is limited to the exact current task projection.',
      documentationAssessment: {
        decision: 'no-impact',
        notes:
          'The task projection changes no operator or product documentation.',
      },
    },
  });
  const closure = createDocumentationClosureRecord({
    changeId: 'demo-change',
    taskId: '1.1',
    review,
    finalAssurance: null,
    remediation: null,
    projectedCommitTree: candidateTree,
    projectionPaths: [tasksPath],
  });
  git(repository, [
    'commit',
    '-m',
    [
      subject,
      '',
      encodeDocumentationClosure(closure),
      '',
      'Change: demo-change',
      'Task: 1.1',
    ].join('\n'),
  ]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writePlanningChange(repository: string, changeId: string): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(directory, 'specs/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.openspec.yaml'),
    'schema: spec-driven\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(directory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(directory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Planned task\n',
  );
  fs.writeFileSync(
    path.join(directory, 'guard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n\n### Requirement: Planned behavior\n\nThe engine SHALL preserve the planned behavior.\n\n#### Scenario: Planned path\n\n- **WHEN** the planned path runs\n- **THEN** the behavior is preserved\n',
  );
}

function writeCurrentPlanningChange(
  repository: string,
  changeId: string,
): void {
  writePlanningChange(repository, changeId);
  const providerBinding = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/change-providers/demo-change.json'),
      'utf8',
    ),
  );
  providerBinding.changeId = changeId;
  providerBinding.planningRoot = `openspec/changes/${changeId}`;
  fs.writeFileSync(
    path.join(repository, `workflow/change-providers/${changeId}.json`),
    `${JSON.stringify(providerBinding, null, 2)}\n`,
  );
  writeReadyV3ExemptChange(repository, changeId);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
