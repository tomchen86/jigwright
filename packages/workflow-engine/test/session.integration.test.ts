import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCiPlanningCommit } from '../src/entrypoints/ci/ci-planning.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  commitSession,
  completeTask,
  finalizeTask,
  finishSession,
} from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { runRegisteredCheck } from '../src/adapters/consumer/repository/work-registry/registered-check.ts';
import {
  readImmutableReport,
  writeImmutableReport,
} from '../src/runtime/storage-journal/report-store.ts';
import {
  abortSession,
  checkSession,
  getSession,
  preflightTaskSession,
  startSession,
  startSessionUnderLifecycleLock,
} from '../src/application/execute-task/session.ts';
import { updateTaskSessionBase } from '../src/application/execute-task/update-base.ts';
import { reviseTask } from '../src/application/revise/task-revision.ts';
import {
  createSessionId,
  parseTaskWorktreeRegistrations,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../src/runtime/session-workspace/session-store.ts';
import {
  applyChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import { renderHandoff } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  addFixtureScripts,
  configureChecks,
  createFixtureRepository,
  git,
  installFakeOpenSpec,
  isWorkflowError,
  prepareCurrentV3IntroductionFixture,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';

if (import.meta.main) await import('./session-legacy-family.ts');

function prepareCurrentChange(repository: string, changeId = 'demo-change') {
  const ready = writeReadyV3ExemptChange(repository, changeId);
  commitPlanningTransition(repository, changeId);
  return ready;
}

function enableDisposableDatabasePolicy(repository: string): void {
  const consumerConfigPath = path.join(
    repository,
    'workflow/repository-consumer.json',
  );
  const consumerConfig = JSON.parse(
    fs.readFileSync(consumerConfigPath, 'utf8'),
  ) as { databasePolicy: { adapterId: string } };
  consumerConfig.databasePolicy.adapterId = 'postgresql-disposable-v1';
  fs.writeFileSync(
    consumerConfigPath,
    `${JSON.stringify(consumerConfig, null, 2)}\n`,
  );
}

function prepareCurrentChangeOnMain(
  repository: string,
  changeId = 'demo-change',
): void {
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  if (!fs.existsSync(maintainerPolicyPath)) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      maintainerPolicyPath,
    );
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Track fixture maintainer policy']);
  }
  const branch = `work/${changeId}`;
  git(repository, ['checkout', '-b', branch]);
  prepareCurrentChange(repository, changeId);
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', branch]);
  git(repository, ['branch', '-d', branch]);
}

function prepareConcurrentTaskWorktree(
  repository: string,
  changeId: string,
  allowedPath: string | readonly string[],
  exclusiveResources: string[] = [],
  readyOptions: Parameters<typeof writeReadyV3ExemptChange>[2] = {},
): { parent: string; worktree: string } {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-concurrent-task-worktree-'),
  );
  const worktree = path.join(parent, changeId);
  git(repository, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    `work/${changeId}`,
    worktree,
    'main',
  ]);
  installFakeOpenSpec(worktree);
  const guardPath = path.join(
    worktree,
    'openspec/changes',
    changeId,
    'guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
    tasks: Record<
      string,
      { allowedPaths: string[]; exclusiveResources?: string[] }
    >;
  };
  guard.changeId = changeId;
  guard.tasks['1.1']!.allowedPaths =
    typeof allowedPath === 'string' ? [allowedPath] : [...allowedPath];
  if (exclusiveResources.length > 0) {
    guard.tasks['1.1']!.exclusiveResources = [...exclusiveResources].sort();
  }
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  writeReadyV3ExemptChange(worktree, changeId, readyOptions);
  commitPlanningTransition(worktree, changeId);
  return { parent, worktree };
}

function createTaskWorktreeFromPlannedBase(
  repository: string,
  changeId: string,
): { parent: string; worktree: string } {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-planned-task-worktree-'),
  );
  const worktree = path.join(parent, changeId);
  git(repository, ['worktree', 'add', '--quiet', worktree, `work/${changeId}`]);
  installFakeOpenSpec(worktree);
  return { parent, worktree };
}

function addConcurrentChangeSkeleton(
  repository: string,
  changeId: string,
): void {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  fs.cpSync(
    path.join(repository, 'openspec/changes/demo-change'),
    changeDirectory,
    { recursive: true },
  );
  const guardPath = path.join(changeDirectory, 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
  };
  guard.changeId = changeId;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  const providerBinding = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/change-providers/demo-change.json'),
      'utf8',
    ),
  ) as { changeId: string; planningRoot: string };
  providerBinding.changeId = changeId;
  providerBinding.planningRoot = `openspec/changes/${changeId}`;
  fs.writeFileSync(
    path.join(repository, 'workflow/change-providers', `${changeId}.json`),
    `${JSON.stringify(providerBinding, null, 2)}\n`,
  );
}

function declareConcurrentWorkset(
  repository: string,
  concurrentChangeId: string,
): void {
  prepareCurrentChangeOnMain(repository, 'demo-change');
  prepareCurrentChangeOnMain(repository, concurrentChangeId);
  applyChangeRoutingReview(
    repository,
    prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    }),
  );
  applyChangeRoutingReview(
    repository,
    prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'set-concurrent', changeId: concurrentChangeId },
    }),
  );
  renderHandoff(repository);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Declare concurrent test workset']);
}

function removeConcurrentTaskWorktree(
  repository: string,
  fixture: { parent: string; worktree: string },
): void {
  git(repository, ['worktree', 'remove', '--force', fixture.worktree]);
  fs.rmSync(fixture.parent, { recursive: true, force: true });
}

function prepareFinishedNonFinalTaskForBaseUpdate(repository: string) {
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  renderHandoff(repository);
  git(repository, [
    'add',
    'workflow/document-policy.json',
    'docs/CURRENT_AND_NEXT_STEPS.md',
  ]);
  git(repository, ['commit', '-m', 'Track fixture handoff']);
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = ['src/task/**'];
  guard.tasks['1.2'] = structuredClone(guard.tasks['1.1']!);
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  fs.appendFileSync(
    path.join(repository, 'openspec/changes/demo-change/tasks.md'),
    '\n- [ ] 1.2 Keep the fixture change open\n',
  );
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
  prepareCurrentChange(repository);
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', 'work/demo-change']);
  const fixture = createTaskWorktreeFromPlannedBase(repository, 'demo-change');
  const started = startSession(fixture.worktree, 'demo-change', '1.1');
  fs.mkdirSync(path.join(fixture.worktree, 'src/task'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.worktree, 'src/task/feature.ts'),
    'export const feature = true;\n',
  );
  finalizeTask(fixture.worktree, started.sessionId);
  const committed = commitSession(
    fixture.worktree,
    started.sessionId,
    'Complete concurrent fixture task',
  );
  return { committed, fixture, started };
}

function snapshotTaskPreflightState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    refs: git(repository, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
    ]),
    worktrees: git(repository, ['worktree', 'list', '--porcelain']),
    runtime: snapshotTaskPreflightDirectory(runtimeRoot(repository)),
  };
}

type TaskSessionPreflightCliOutput = {
  result: {
    schemaVersion: number;
    kind: string;
    authority: string;
    status: string;
    changeId: string;
    taskId: string;
    observed: {
      repositoryRoot: string;
      gitCommonDirectory: string;
      branch: string;
      head: string;
      tree: string;
    };
    routing: {
      role: string;
      worksetDigest: string;
      concurrencyEnabled: boolean;
    };
    scope: {
      allowedPaths: string[];
      requiredChecks: string[];
      authorization: {
        requiresMandate: boolean;
        mode: string;
        roles: string[];
        matchedPatterns: string[];
        unclassifiedScope: boolean;
        policyDigest: string;
      };
    };
    isolation: {
      schemaVersion: number;
      routingRole: string;
      worktreeDigest: string;
      resources: unknown[];
    };
    mutationBoundary: {
      git: string;
      runtime: string;
      grants: string;
    };
  };
  nextSteps: Array<{ command: string; why: string }>;
};

function snapshotTaskPreflightDirectory(
  root: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (!fs.existsSync(root)) return Object.freeze([]);
  const entries: Array<Readonly<Record<string, unknown>>> = [];
  const visit = (absolute: string, relative: string): void => {
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      entries.push(
        Object.freeze({
          path: relative,
          kind: 'symlink',
          mode: stats.mode & 0o777,
          target: fs.readlinkSync(absolute),
        }),
      );
      return;
    }
    if (stats.isDirectory()) {
      entries.push(
        Object.freeze({
          path: relative,
          kind: 'directory',
          mode: stats.mode & 0o777,
        }),
      );
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(
          path.join(absolute, name),
          relative ? `${relative}/${name}` : name,
        );
      }
      return;
    }
    entries.push(
      Object.freeze({
        path: relative,
        kind: 'file',
        mode: stats.mode & 0o777,
        bytes: fs.readFileSync(absolute).toString('base64'),
      }),
    );
  };
  visit(root, '');
  return Object.freeze(entries);
}

test('current lifecycle rejects a non-managed schema directly', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session preflight reuses exact admission without mutating Git, runtime, or Grant state', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const before = snapshotTaskPreflightState(repository);
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'task-preflight',
        'demo-change',
        '--task',
        '1.1',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as TaskSessionPreflightCliOutput;
    assert.deepEqual(
      {
        schemaVersion: output.result.schemaVersion,
        kind: output.result.kind,
        authority: output.result.authority,
        status: output.result.status,
        changeId: output.result.changeId,
        taskId: output.result.taskId,
        branch: output.result.observed.branch,
        head: output.result.observed.head,
        tree: output.result.observed.tree,
        routingRole: output.result.routing.role,
        isolationRole: output.result.isolation.routingRole,
        requiresMandate: output.result.scope.authorization.requiresMandate,
        mutationBoundary: output.result.mutationBoundary,
      },
      {
        schemaVersion: 1,
        kind: 'task-session-preflight.v1',
        authority: 'advisory',
        status: 'ready',
        changeId: 'demo-change',
        taskId: '1.1',
        branch: 'work/demo-change',
        head: before.head,
        tree: before.tree,
        routingRole: 'single',
        isolationRole: 'single',
        requiresMandate: false,
        mutationBoundary: {
          git: 'read-only',
          runtime: 'read-only',
          grants: 'not-requested',
        },
      },
    );
    assert.equal(
      output.result.observed.repositoryRoot,
      fs.realpathSync(repository),
    );
    assert.match(output.result.observed.gitCommonDirectory, /\.git$/);
    assert.match(output.result.routing.worksetDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(
      output.result.isolation.worktreeDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(output.result.scope.allowedPaths, ['src/**']);
    assert.deepEqual(output.result.scope.requiredChecks, ['fixture']);
    assert.equal(output.result.scope.authorization.mode, 'conditional');
    assert.match(
      output.result.scope.authorization.policyDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(output.result.isolation.resources, []);
    assert.deepEqual(output.nextSteps, [
      {
        command: 'pnpm workflow open-task demo-change --task 1.1 --json',
        why: 'Open the selected or next incomplete task, committing an owned draft only when required.',
      },
    ]);
    assert.deepEqual(snapshotTaskPreflightState(repository), before);

    const started = startSession(repository, 'demo-change', '1.1');
    assert.deepEqual(started.isolation, output.result.isolation);
    abortSession(
      repository,
      started.sessionId,
      'Preflight regression cleanup.',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session worktree registration parser rejects malformed porcelain ordering and identities', () => {
  const head = 'a'.repeat(40);
  assert.deepEqual(
    parseTaskWorktreeRegistrations(
      `worktree /tmp/current\0HEAD ${head}\0branch refs/heads/work/demo-change\0locked fixture\0\0`,
    ),
    [
      {
        worktreePath: '/tmp/current',
        head,
        branchRef: 'refs/heads/work/demo-change',
        detached: false,
        bare: false,
        locked: true,
        prunable: false,
      },
    ],
  );
  for (const malformed of [
    `HEAD ${head}\0worktree /tmp/current\0branch refs/heads/work/demo-change\0\0`,
    `worktree /tmp/current\0bare\0HEAD ${head}\0\0`,
    `worktree /tmp/current\0HEAD ${head}\0branch refs/heads/\0\0`,
    `worktree /tmp/current\0HEAD ${head}\0locked fixture\0branch refs/heads/work/demo-change\0\0`,
  ]) {
    assert.throws(
      () => parseTaskWorktreeRegistrations(malformed),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_WORKTREE_REGISTRATION_INVALID'),
    );
  }
});

test('task-session admission rejects a duplicate live registration for its current branch without mutation', () => {
  const repository = createFixtureRepository();
  const duplicateParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-duplicate-branch-worktree-'),
  );
  const duplicateWorktree = path.join(duplicateParent, 'duplicate');
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    git(repository, [
      'worktree',
      'add',
      '--quiet',
      '--force',
      '--force',
      duplicateWorktree,
      'work/demo-change',
    ]);
    const before = snapshotTaskPreflightState(repository);

    assert.throws(
      () => preflightTaskSession(repository, 'demo-change', '1.1'),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_WORKTREE_REGISTRATION_CONFLICT'),
    );
    assert.deepEqual(snapshotTaskPreflightState(repository), before);
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_WORKTREE_REGISTRATION_CONFLICT'),
    );
    assert.deepEqual(snapshotTaskPreflightState(repository), before);
  } finally {
    if (fs.existsSync(repository)) {
      try {
        git(repository, ['worktree', 'remove', '--force', duplicateWorktree]);
      } catch {
        // The assertion failure is more useful than cleanup noise.
      }
    }
    fs.rmSync(duplicateParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session admission leaves a prunable duplicate registration untouched until the caller prunes it', () => {
  const repository = createFixtureRepository();
  const duplicateParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-prunable-branch-worktree-'),
  );
  const duplicateWorktree = path.join(duplicateParent, 'duplicate');
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    git(repository, [
      'worktree',
      'add',
      '--quiet',
      '--force',
      '--force',
      duplicateWorktree,
      'work/demo-change',
    ]);
    fs.rmSync(duplicateWorktree, { recursive: true, force: true });
    const before = git(repository, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
      '--expire',
      'now',
    ]);
    assert.match(before, /prunable/u);

    assert.throws(
      () => preflightTaskSession(repository, 'demo-change', '1.1'),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_WORKTREE_REGISTRATION_CONFLICT'),
    );
    assert.equal(
      git(repository, [
        'worktree',
        'list',
        '--porcelain',
        '-z',
        '--expire',
        'now',
      ]),
      before,
    );

    git(repository, ['worktree', 'prune', '--expire', 'now']);
    assert.equal(
      preflightTaskSession(repository, 'demo-change', '1.1').status,
      'ready',
    );
  } finally {
    if (fs.existsSync(repository)) {
      try {
        git(repository, ['worktree', 'prune', '--expire', 'now']);
      } catch {
        // The assertion failure is more useful than cleanup noise.
      }
    }
    fs.rmSync(duplicateParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session admission leaves an unsafe isolation lease and all unrelated state unchanged', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const prior = startSession(repository, 'demo-change', '1.1');
    abortSession(repository, prior.sessionId, 'Prepare unsafe lease fixture.');
    const leasePath = path.join(
      runtimeRoot(repository),
      'task-isolation',
      'worktrees',
      `${prior.isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
    );
    fs.mkdirSync(path.dirname(leasePath), { recursive: true, mode: 0o700 });
    const poisonBytes = '{"poison":true}\n';
    fs.writeFileSync(leasePath, poisonBytes, { flag: 'wx', mode: 0o600 });
    const before = snapshotTaskPreflightState(repository);

    assert.throws(
      () => preflightTaskSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.deepEqual(snapshotTaskPreflightState(repository), before);
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.deepEqual(snapshotTaskPreflightState(repository), before);
    assert.equal(fs.readFileSync(leasePath, 'utf8'), poisonBytes);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session admission detects a poisoned later resource before any lease or change-lock publication', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, { exclusiveResources?: string[] }>;
    };
    guard.tasks['1.1']!.exclusiveResources = [
      'fixture:first-resource',
      'fixture:second-resource',
    ];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    prepareCurrentChange(repository);
    const inspected = preflightTaskSession(repository, 'demo-change', '1.1');
    assert.equal(inspected.isolation.resources.length, 2);
    const isolationRoot = path.join(runtimeRoot(repository), 'task-isolation');
    const worktreeLease = path.join(
      isolationRoot,
      'worktrees',
      `${inspected.isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
    );
    const resourceLeases = inspected.isolation.resources.map(({ digest }) =>
      path.join(
        isolationRoot,
        'resources',
        `${digest.slice('sha256:'.length)}.lock`,
      ),
    );
    fs.mkdirSync(path.dirname(resourceLeases[1]!), {
      recursive: true,
      mode: 0o700,
    });
    const poisonBytes = '{"poison":"later-resource"}\n';
    fs.writeFileSync(resourceLeases[1]!, poisonBytes, {
      flag: 'wx',
      mode: 0o600,
    });
    const before = snapshotTaskPreflightState(repository);

    assert.throws(
      () => preflightTaskSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.deepEqual(snapshotTaskPreflightState(repository), before);
    assert.equal(fs.existsSync(worktreeLease), false);
    assert.equal(fs.existsSync(resourceLeases[0]!), false);
    assert.equal(fs.readFileSync(resourceLeases[1]!, 'utf8'), poisonBytes);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session start rolls back exact earlier publications when a later lease becomes unsafe', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, { exclusiveResources?: string[] }>;
    };
    guard.tasks['1.1']!.exclusiveResources = [
      'fixture:first-resource',
      'fixture:second-resource',
    ];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    prepareCurrentChange(repository);
    const visited: string[] = [];
    const poisonBytes = '{"poison":"publication-race"}\n';
    let poisonPath = '';

    assert.throws(
      () =>
        startSession(repository, 'demo-change', '1.1', {
          testHooks: {
            beforeIsolationLeasePublication({ index, leasePath }) {
              visited.push(leasePath);
              if (index !== 2) return;
              poisonPath = leasePath;
              fs.mkdirSync(path.dirname(leasePath), {
                recursive: true,
                mode: 0o700,
              });
              fs.writeFileSync(leasePath, poisonBytes, {
                flag: 'wx',
                mode: 0o600,
              });
            },
          },
        }),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.equal(visited.length, 3);
    assert.equal(fs.existsSync(visited[0]!), false);
    assert.equal(fs.existsSync(visited[1]!), false);
    assert.equal(fs.readFileSync(poisonPath, 'utf8'), poisonBytes);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
    const sessionsPath = path.join(runtimeRoot(repository), 'sessions');
    assert.deepEqual(
      fs.existsSync(sessionsPath) ? fs.readdirSync(sessionsPath) : [],
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session start reclaims an exact terminal-owner lease and republishes current ownership', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const prior = startSession(repository, 'demo-change', '1.1');
    const leasePath = path.join(
      runtimeRoot(repository),
      'task-isolation',
      'worktrees',
      `${prior.isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
    );
    const priorLeaseBytes = fs.readFileSync(leasePath, 'utf8');
    abortSession(
      repository,
      prior.sessionId,
      'Prepare terminal lease fixture.',
    );
    fs.writeFileSync(leasePath, priorLeaseBytes, { flag: 'wx', mode: 0o600 });

    assert.equal(
      preflightTaskSession(repository, 'demo-change', '1.1').status,
      'ready',
    );
    assert.equal(fs.readFileSync(leasePath, 'utf8'), priorLeaseBytes);
    const current = startSession(repository, 'demo-change', '1.1');
    const currentLease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as {
      sessionId: string;
    };
    assert.equal(currentLease.sessionId, current.sessionId);
    assert.notEqual(currentLease.sessionId, prior.sessionId);
    abortSession(repository, current.sessionId, 'Terminal lease cleanup.');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session start only reclaims a missing-owner lease after exact dead-process revalidation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const inspected = preflightTaskSession(repository, 'demo-change', '1.1');
    const leasePath = path.join(
      runtimeRoot(repository),
      'task-isolation',
      'worktrees',
      `${inspected.isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
    );
    fs.mkdirSync(path.dirname(leasePath), { recursive: true, mode: 0o700 });
    const missingSessionId = createSessionId();
    const ownerToken = '11111111-1111-4111-8111-111111111111';
    const leaseBytes = (pid: number) =>
      `${JSON.stringify({
        sessionId: missingSessionId,
        ownerToken,
        changeId: 'demo-change',
        taskId: '1.1',
        pid,
      })}\n`;
    fs.writeFileSync(leasePath, leaseBytes(process.pid), {
      flag: 'wx',
      mode: 0o600,
    });

    assert.throws(
      () => preflightTaskSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'TASK_SESSION_LEASE_CONFLICT'),
    );
    assert.equal(fs.readFileSync(leasePath, 'utf8'), leaseBytes(process.pid));

    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(exited.status, 0);
    assert.equal(typeof exited.pid, 'number');
    assert.throws(
      () => process.kill(exited.pid!, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    const deadBytes = leaseBytes(exited.pid!);
    fs.writeFileSync(leasePath, deadBytes);
    assert.equal(
      preflightTaskSession(repository, 'demo-change', '1.1').status,
      'ready',
    );
    assert.equal(fs.readFileSync(leasePath, 'utf8'), deadBytes);

    const session = startSession(repository, 'demo-change', '1.1');
    const currentLease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as {
      sessionId: string;
    };
    assert.equal(currentLease.sessionId, session.sessionId);
    abortSession(repository, session.sessionId, 'Missing-owner lease cleanup.');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('fixed session identity publication never overwrites or removes foreign bytes', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const prior = startSession(repository, 'demo-change', '1.1');
    abortSession(
      repository,
      prior.sessionId,
      'Prepare fixed identity fixture.',
    );
    const runtime = runtimePaths(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine',
    );
    const sessionId = prior.sessionId;
    const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
    const foreignBytes = fs.readFileSync(sessionPath, 'utf8');

    assert.throws(
      () =>
        withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
          startSessionUnderLifecycleLock(
            repository,
            'demo-change',
            '1.1',
            {
              sessionId,
              createdAt: '2026-09-01T00:00:00.000Z',
            },
            assertRepositoryLock,
          ),
        ),
      (error) => isWorkflowError(error, 'SESSION_PUBLICATION_CONFLICT'),
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), foreignBytes);
    assert.equal(
      fs.existsSync(path.join(runtime.locks, 'demo-change.lock')),
      false,
    );
    assert.deepEqual(
      fs.existsSync(path.join(runtime.root, 'task-isolation', 'worktrees'))
        ? fs.readdirSync(path.join(runtime.root, 'task-isolation', 'worktrees'))
        : [],
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session start rejects replacement, in-place rewrite, and hardlink races after publication', () => {
  const scenarios: Array<
    Readonly<{
      name: string;
      tamper: (sessionPath: string) => ReadonlyMap<string, string>;
    }>
  > = [
    {
      name: 'replacement',
      tamper(sessionPath) {
        const ownedAlias = `${sessionPath}.attacker-owned`;
        const ownedBytes = fs.readFileSync(sessionPath, 'utf8');
        const foreignBytes = '{"foreign":"replacement"}\n';
        fs.renameSync(sessionPath, ownedAlias);
        fs.writeFileSync(sessionPath, foreignBytes, {
          flag: 'wx',
          mode: 0o600,
        });
        return new Map([
          [ownedAlias, ownedBytes],
          [sessionPath, foreignBytes],
        ]);
      },
    },
    {
      name: 'in-place rewrite',
      tamper(sessionPath) {
        const foreignBytes = '{"foreign":"in-place"}\n';
        fs.writeFileSync(sessionPath, foreignBytes);
        return new Map([[sessionPath, foreignBytes]]);
      },
    },
    {
      name: 'hardlink',
      tamper(sessionPath) {
        const aliasPath = `${sessionPath}.attacker-link`;
        const ownedBytes = fs.readFileSync(sessionPath, 'utf8');
        fs.linkSync(sessionPath, aliasPath);
        return new Map([
          [sessionPath, ownedBytes],
          [aliasPath, ownedBytes],
        ]);
      },
    },
  ];
  const containsVerificationFailure = (error: unknown): boolean =>
    isWorkflowError(error, 'SESSION_WRITE_VERIFICATION_FAILED') ||
    (error instanceof AggregateError &&
      error.errors.some(containsVerificationFailure));

  for (const scenario of scenarios) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      let expectedFiles: ReadonlyMap<string, string> = new Map();
      let startError: unknown;
      assert.throws(
        () =>
          startSession(repository, 'demo-change', '1.1', {
            testHooks: {
              afterSessionPublication({ sessionPath }) {
                expectedFiles = scenario.tamper(sessionPath);
              },
            },
          }),
        (error) => {
          startError = error;
          return true;
        },
      );
      assert.equal(
        containsVerificationFailure(startError),
        true,
        `${scenario.name} did not reach exact publication verification`,
      );
      for (const [filePath, expectedBytes] of expectedFiles) {
        assert.equal(
          fs.readFileSync(filePath, 'utf8'),
          expectedBytes,
          `${scenario.name} bytes changed during refusal cleanup`,
        );
      }
      assert.equal(
        fs.existsSync(
          path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
        ),
        false,
        `${scenario.name} left the exact-owned change lock behind`,
      );
      for (const kind of ['worktrees', 'resources']) {
        const directory = path.join(
          runtimeRoot(repository),
          'task-isolation',
          kind,
        );
        assert.deepEqual(
          fs.existsSync(directory) ? fs.readdirSync(directory) : [],
          [],
          `${scenario.name} left an exact-owned isolation lease behind`,
        );
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('task-session preflight reports protected authority without requesting a Grant', () => {
  const repository = createFixtureRepository();
  try {
    const roleRegistryPath = path.join(repository, 'workflow/path-roles.json');
    const roleRegistry = JSON.parse(
      fs.readFileSync(roleRegistryPath, 'utf8'),
    ) as { roles: Record<string, string[]> };
    roleRegistry.roles['control-plane'] = ['control-plane/**'];
    fs.writeFileSync(
      roleRegistryPath,
      `${JSON.stringify(roleRegistry, null, 2)}\n`,
    );
    git(repository, ['add', 'workflow/path-roles.json']);
    git(repository, ['commit', '-m', 'Add fixture control-plane path role']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, { allowedPaths: string[] }>;
    };
    guard.tasks['1.1']!.allowedPaths = ['control-plane/**'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    prepareCurrentChange(repository);
    const before = snapshotTaskPreflightState(repository);
    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'task-preflight',
        'demo-change',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout) as TaskSessionPreflightCliOutput;
    assert.equal(output.result.status, 'mandate-required');
    assert.equal(output.result.taskId, '1.1');
    assert.deepEqual(output.result.scope.allowedPaths, ['control-plane/**']);
    assert.deepEqual(output.result.scope.authorization.roles, [
      'control-plane',
    ]);
    assert.deepEqual(output.result.scope.authorization.matchedPatterns, [
      'control-plane/**',
    ]);
    assert.equal(output.result.scope.authorization.requiresMandate, true);
    assert.deepEqual(output.result.mutationBoundary, {
      git: 'read-only',
      runtime: 'read-only',
      grants: 'not-requested',
    });
    assert.deepEqual(output.nextSteps, [
      {
        command: 'pnpm workflow guide --json',
        why: 'Inspect the versioned managed-task workflow command guide.',
      },
    ]);
    assert.deepEqual(snapshotTaskPreflightState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session preflight fails closed on an active lifecycle barrier without mutation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const runtime = runtimePaths(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine',
    );
    withRepositoryLifecycleOperation(runtime, () => {
      const before = snapshotTaskPreflightState(repository);
      const run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.join(
            sourceRepositoryRoot,
            'packages/workflow-engine/src/cli.ts',
          ),
          'task-preflight',
          'demo-change',
          '--task',
          '1.1',
          '--json',
        ],
        { cwd: repository, encoding: 'utf8' },
      );

      assert.notEqual(run.status, 0, run.stdout);
      assert.equal(
        (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
        'REPOSITORY_LIFECYCLE_CONFLICT',
      );
      assert.deepEqual(snapshotTaskPreflightState(repository), before);
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task-session preflight fails closed on change-lock and publication-directory barriers', () => {
  for (const scenario of [
    'live-change-lock',
    'unsafe-lock-directory',
  ] as const) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      const runtime = runtimePaths(
        fs.realpathSync(path.join(repository, '.git')),
        'workflow-engine',
      );
      fs.mkdirSync(path.dirname(runtime.locks), {
        recursive: true,
        mode: 0o700,
      });
      if (scenario === 'live-change-lock') {
        fs.mkdirSync(runtime.locks, { recursive: true, mode: 0o700 });
        const ownerToken = '11111111-1111-4111-8111-111111111111';
        fs.writeFileSync(
          path.join(runtime.locks, 'demo-change.lock'),
          `${JSON.stringify({
            operationId: `plan-${ownerToken}`,
            ownerToken,
            changeId: 'demo-change',
            transition: 'plan',
            pid: process.pid,
          })}\n`,
          { flag: 'wx', mode: 0o600 },
        );
      } else {
        fs.rmSync(runtime.locks, { recursive: true, force: true });
        fs.writeFileSync(runtime.locks, 'unsafe lock directory\n', {
          flag: 'wx',
          mode: 0o600,
        });
      }
      const before = snapshotTaskPreflightState(repository);
      const run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.join(
            sourceRepositoryRoot,
            'packages/workflow-engine/src/cli.ts',
          ),
          'task-preflight',
          'demo-change',
          '--task',
          '1.1',
          '--json',
        ],
        { cwd: repository, encoding: 'utf8' },
      );

      assert.notEqual(run.status, 0, run.stdout);
      assert.equal(
        (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
        scenario === 'live-change-lock'
          ? 'REPOSITORY_LIFECYCLE_CONFLICT'
          : 'RUNTIME_DIRECTORY_UNSAFE',
      );
      assert.deepEqual(snapshotTaskPreflightState(repository), before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('doctor counts a durable revising session as a write-capable session without mutation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    assert.throws(
      () =>
        reviseTask(repository, started.sessionId, 'Inspect current planning.', {
          testCrashAfter: 'session-revising',
        }),
      /simulated task revision crash after session-revising/u,
    );
    assert.equal(getSession(repository, started.sessionId).state, 'revising');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const before = {
      head: git(repository, ['rev-parse', 'HEAD']),
      status: git(repository, ['status', '--porcelain=v1', '-z']),
      sessionBytes: fs.readFileSync(sessionPath, 'utf8'),
    };

    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'doctor',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      (JSON.parse(run.stdout) as { activeSessionCount: number })
        .activeSessionCount,
      1,
    );
    assert.deepEqual(
      {
        head: git(repository, ['rev-parse', 'HEAD']),
        status: git(repository, ['status', '--porcelain=v1', '-z']),
        sessionBytes: fs.readFileSync(sessionPath, 'utf8'),
      },
      before,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current single-writer sessions use a neutral routing identity and reject the retired value', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    assert.equal(started.isolation?.routingRole, 'single');

    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      isolation: { routingRole: string };
    };
    stored.isolation.routingRole = 'legacy-single';
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);
    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current session reader rejects persisted records missing the isolation key', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const runtime = runtimeRoot(repository);
    const sessionPath = path.join(
      runtime,
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(stored, 'isolation'), true);
    const isolation = stored.isolation as {
      worktreeDigest: string;
      resources: Array<{ digest: string }>;
    };
    const lockPath = path.join(runtime, 'locks', 'demo-change.lock');
    const leasePaths = [
      path.join(
        runtime,
        'task-isolation',
        'worktrees',
        `${isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
      ),
      ...isolation.resources.map(({ digest }) =>
        path.join(
          runtime,
          'task-isolation',
          'resources',
          `${digest.slice('sha256:'.length)}.lock`,
        ),
      ),
    ];
    const lockBytes = fs.readFileSync(lockPath);
    const leaseBytes = leasePaths.map((leasePath) =>
      fs.readFileSync(leasePath),
    );

    delete stored.isolation;
    const poisonedSessionBytes = `${JSON.stringify(stored, null, 2)}\n`;
    fs.writeFileSync(sessionPath, poisonedSessionBytes);

    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), poisonedSessionBytes);
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
    for (const [index, leasePath] of leasePaths.entries()) {
      assert.deepEqual(fs.readFileSync(leasePath), leaseBytes[index]);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current session reader rejects persisted records missing the planning assurance key', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(stored, 'planningAssurance'), true);
    stored.planningAssurance = null;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);
    assert.equal(
      getSession(repository, started.sessionId).planningAssurance,
      null,
    );
    delete stored.planningAssurance;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('tracked session schema exposes only the current WorkflowSession shape', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas/session.schema.json'),
      'utf8',
    ),
  ) as {
    $id: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<
      string,
      { const?: unknown; enum?: unknown[]; $ref?: string }
    >;
    $defs: Record<string, unknown>;
  };

  assert.equal(
    schema.$id,
    'https://jigwright.local/workflow/session.schema.json',
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'sessionId',
    'state',
    'changeId',
    'taskId',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'artifacts',
    'allowedPaths',
    'requiredChecks',
    'requiredCheckDigests',
    'isolation',
    'planningAssurance',
    'createdAt',
  ]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'abortReason',
    'abortedAt',
    'allowedPaths',
    'artifacts',
    'baseline',
    'branch',
    'changeId',
    'checkEvidenceEngineDigest',
    'commitHash',
    'commitReportId',
    'committedAt',
    'completionReportId',
    'createdAt',
    'documentationRemediation',
    'finishReportId',
    'gitCommonDirectory',
    'implementationReconciliationPaths',
    'implementationReconciliationReportId',
    'isolation',
    'latestCheckReportId',
    'mandateBinding',
    'planningAssurance',
    'repositoryRoot',
    'requiredCheckDigests',
    'requiredChecks',
    'revisionLeaseId',
    'schemaVersion',
    'sessionId',
    'state',
    'taskId',
  ]);
  assert.equal(schema.properties.schemaVersion?.const, 1);
  assert.deepEqual(schema.properties.state?.enum, [
    'active',
    'revising',
    'aborted',
    'committed',
  ]);
  assert.equal(
    schema.properties.isolation?.$ref,
    '#/$defs/taskSessionIsolationBinding',
  );
  assert.equal(
    schema.properties.planningAssurance?.$ref,
    '#/$defs/planningAssurance',
  );

  const mandateBinding = schema.$defs.taskMandateBinding as {
    additionalProperties: boolean;
    required: string[];
    properties: { schemaVersion: { const: number } };
  };
  assert.equal(mandateBinding.additionalProperties, false);
  assert.equal(mandateBinding.properties.schemaVersion.const, 1);
  assert.deepEqual(mandateBinding.required, [
    'schemaVersion',
    'mandateTaskId',
    'mandateId',
    'mandateDigest',
    'changeId',
    'externalAuditRoot',
  ]);

  const isolation = schema.$defs.taskSessionIsolationBinding as {
    additionalProperties: boolean;
    required: string[];
    properties: { schemaVersion: { const: number } };
  };
  assert.equal(isolation.additionalProperties, false);
  assert.equal(isolation.properties.schemaVersion.const, 1);
  assert.deepEqual(isolation.required, [
    'schemaVersion',
    'routingRole',
    'routingWorksetDigest',
    'concurrencyEnabled',
    'worktreeDigest',
    'resources',
  ]);
  const planningAssurance = schema.$defs.planningAssurance as {
    anyOf: Array<{
      properties?: { reviewRoleResultForm: { enum: string[] } };
    }>;
  };
  assert.deepEqual(
    planningAssurance.anyOf[1]?.properties?.reviewRoleResultForm.enum,
    [
      'ordinary-provider',
      'granted-same-provider',
      'granted-role-context-sharing',
      'granted-caller-supplied',
      'direct-human-attestation',
    ],
  );
});

test('current session reader rejects persisted records missing required check digests', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const runtime = runtimeRoot(repository);
    const sessionPath = path.join(
      runtime,
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(stored, 'requiredCheckDigests'), true);
    const isolation = stored.isolation as {
      worktreeDigest: string;
      resources: Array<{ digest: string }>;
    };
    const lockPath = path.join(runtime, 'locks', 'demo-change.lock');
    const leasePaths = [
      path.join(
        runtime,
        'task-isolation',
        'worktrees',
        `${isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
      ),
      ...isolation.resources.map(({ digest }) =>
        path.join(
          runtime,
          'task-isolation',
          'resources',
          `${digest.slice('sha256:'.length)}.lock`,
        ),
      ),
    ];
    const lockBytes = fs.readFileSync(lockPath);
    const leaseBytes = leasePaths.map((leasePath) =>
      fs.readFileSync(leasePath),
    );

    delete stored.requiredCheckDigests;
    const poisonedSessionBytes = `${JSON.stringify(stored, null, 2)}\n`;
    fs.writeFileSync(sessionPath, poisonedSessionBytes);

    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), poisonedSessionBytes);
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
    for (const [index, leasePath] of leasePaths.entries()) {
      assert.deepEqual(fs.readFileSync(leasePath), leaseBytes[index]);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 sessions and every task report pin the exact planning assurance', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const ready = prepareCurrentChange(repository);
    const expectedBinding = {
      ...ready.planningAssurance,
      reviewGrantId: null,
      reviewGrantEnvelopeDigest: null,
      reviewGrantUseDigest: null,
      reviewGrantTransitionDigest: null,
      directHumanReviewAttestationDigest: null,
    };

    const started = startSession(repository, 'demo-change', '1.1');
    assert.deepEqual(
      (started as typeof started & { planningAssurance: unknown })
        .planningAssurance,
      expectedBinding,
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    assert.throws(
      () => finalizeTask(repository, started.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, started.sessionId);
    finalizeTask(repository, started.sessionId);
    commitSession(repository, started.sessionId, 'Bind planning assurance');

    const committed = getSession(repository, started.sessionId);
    assert.deepEqual(
      fs.readdirSync(
        path.join(runtimeRoot(repository), 'task-isolation', 'worktrees'),
      ),
      [],
    );
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    for (const reportId of [
      committed.latestCheckReportId,
      committed.completionReportId,
      committed.finishReportId,
      committed.commitReportId,
    ]) {
      assert.match(reportId ?? '', /^[0-9a-f]{64}$/);
      const report = readImmutableReport(
        reportsRoot,
        started.sessionId,
        reportId!,
      );
      assert.deepEqual(report.planningAssurance, expectedBinding);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current session reader preserves R-007 assurance without fabricated standard Grant refs', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      planningAssurance: Record<string, unknown>;
    };
    stored.planningAssurance = {
      ...stored.planningAssurance,
      reviewRoleResultForm: 'granted-role-context-sharing',
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'session-independent',
      degradationAuthorized: true,
      reviewGrantId: null,
      reviewGrantEnvelopeDigest: null,
      reviewGrantUseDigest: null,
      reviewGrantTransitionDigest: null,
      directHumanReviewAttestationDigest: null,
    };
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.deepEqual(
      getSession(repository, started.sessionId).planningAssurance,
      stored.planningAssurance,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays v3 planning assurance from Git with the live validator', () => {
  const repository = createFixtureRepository();
  try {
    prepareCurrentV3IntroductionFixture(repository, 'demo-change');
    const ready = prepareCurrentChange(repository);
    const planCommit = git(repository, ['rev-parse', 'HEAD']).trim();

    const validation = validateCiPlanningCommit(
      repository,
      planCommit,
      'demo-change',
    );

    // The CI loader reads only immutable Git objects, but must reach the exact
    // semantic result the live transition recorded.
    assert.equal(validation.schemaName, 'jigwright');
    assert.deepEqual(validation.planningAssurance, ready.planningAssurance);
    // An exempt plan consumes no collaboration grant, so its aggregate use set
    // is empty rather than absent.
    assert.deepEqual(validation.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI fails closed when a v3 plan omits tracked semantic evidence', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);

    // The managed transition refuses to drop a required v3 artifact, so the
    // only way this tree reaches history is a hand-authored commit that never
    // passed the engine. CI must reject it from Git facts alone.
    git(repository, [
      'rm',
      '--quiet',
      'openspec/changes/demo-change/plan-review.json',
    ]);
    git(repository, [
      'commit',
      '--quiet',
      '-m',
      ['Plan demo-change', '', 'Change: demo-change', 'Transition: plan'].join(
        '\n',
      ),
    ]);
    const tampered = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, tampered, 'demo-change'),
      (error) => error instanceof WorkflowError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task transitions reject a session whose planning assurance is stale', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      planningAssurance: { planningGenerationId: string };
    };
    stored.planningAssurance.planningGenerationId = 'f'.repeat(64);
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'SESSION_PLANNING_ASSURANCE_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion rejects a check report with mismatched planning assurance', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const checked = checkSession(repository, started.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const forged = structuredClone(
      readImmutableReport(reportsRoot, started.sessionId, checked.reportId),
    );
    (
      forged.planningAssurance as { planningGenerationId: string }
    ).planningGenerationId = 'f'.repeat(64);
    const forgedId = writeImmutableReport(reportsRoot, forged);
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      latestCheckReportId: string;
    };
    stored.latestCheckReportId = forgedId;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => completeTask(repository, started.sessionId),
      (error) => isWorkflowError(error, 'CHECK_REPORT_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution returns pinned non-destructive evidence', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const result = runRegisteredCheck(repository, 'fixture', process.env);

    assert.equal(result.head, git(repository, ['rev-parse', 'HEAD']).trim());
    assert.deepEqual(
      {
        checkId: result.check.checkId,
        outcome: result.check.outcome,
        exitCode: result.check.exitCode,
        destructiveDatabase: result.check.destructiveDatabase,
      },
      {
        checkId: 'fixture',
        outcome: 'passed',
        exitCode: 0,
        destructiveDatabase: false,
      },
    );
    assert.match(result.check.runnerDigest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution rejects unknown and destructive checks', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => runRegisteredCheck(repository, 'unknown', process.env),
      (error) => isWorkflowError(error, 'CI_CHECK_UNKNOWN'),
    );

    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );

    assert.throws(
      () => runRegisteredCheck(repository, 'destructive', process.env),
      (error) => isWorkflowError(error, 'STANDALONE_DESTRUCTIVE_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution rejects dirty and mutated checkouts', () => {
  const dirtyRepository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(dirtyRepository, 'dirty.txt'), 'dirty\n');
    assert.throws(
      () => runRegisteredCheck(dirtyRepository, 'fixture', process.env),
      (error) => isWorkflowError(error, 'STANDALONE_CHECK_DIRTY_WORKTREE'),
    );
  } finally {
    fs.rmSync(dirtyRepository, { recursive: true, force: true });
  }

  const mutatingRepository = createFixtureRepository();
  try {
    configureChecks(
      mutatingRepository,
      {
        mutating: {
          command: [
            'node',
            'scripts/write-file.mjs',
            path.join(mutatingRepository, 'mutated.txt'),
          ],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    assert.throws(
      () => runRegisteredCheck(mutatingRepository, 'mutating', process.env),
      (error) => isWorkflowError(error, 'CI_CHECK_MUTATED_WORKTREE'),
    );
  } finally {
    fs.rmSync(mutatingRepository, { recursive: true, force: true });
  }
});

test('start rejects protected and dirty repositories without leaving runtime state', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', 'work/demo-change']);
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'PROTECTED_BRANCH'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );

    git(repository, ['checkout', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'dirty.txt'), 'existing work\n');

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'DIRTY_WORKTREE'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('active session pins a clean baseline, enforces scope, and releases its lock', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.equal(session.state, 'active');
    assert.equal(checkSession(repository, session.sessionId).passed, true);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'TASK_SESSION_CHANGE_CONFLICT'),
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const allowedCheck = checkSession(repository, session.sessionId);
    assert.deepEqual(allowedCheck.changedPaths, ['src/feature.ts']);

    fs.writeFileSync(path.join(repository, 'outside.txt'), 'not allowed\n');
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );

    const aborted = abortSession(
      repository,
      session.sessionId,
      'integration test',
    );
    assert.equal(aborted.state, 'aborted');
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('two declared disjoint changes own durable isolated writers and an undeclared third writer is rejected', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    addConcurrentChangeSkeleton(repository, 'third-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixtures']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/first/**',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/second/**',
    );
    const third = prepareConcurrentTaskWorktree(
      repository,
      'third-change',
      'src/third/**',
    );
    fixtures.push(first, second, third);

    const firstSession = startSession(first.worktree, 'demo-change', '1.1');
    const secondSession = startSession(second.worktree, 'second-change', '1.1');

    assert.notEqual(firstSession.repositoryRoot, secondSession.repositoryRoot);
    assert.notEqual(firstSession.branch, secondSession.branch);
    assert.equal(firstSession.isolation?.routingRole, 'primary');
    assert.equal(secondSession.isolation?.routingRole, 'concurrent');
    assert.equal(
      firstSession.isolation?.routingWorksetDigest,
      secondSession.isolation?.routingWorksetDigest,
    );
    assert.equal(
      fs.readdirSync(
        path.join(runtimeRoot(repository), 'task-isolation', 'worktrees'),
      ).length,
      2,
    );
    const clearConcurrent = prepareChangeRoutingReview(first.worktree, {
      schemaVersion: 1,
      action: { kind: 'clear-concurrent' },
    });
    assert.throws(
      () => applyChangeRoutingReview(first.worktree, clearConcurrent),
      (error) => isWorkflowError(error, 'CHANGE_ROUTING_WORKSET_BUSY'),
    );
    assert.throws(
      () => startSession(third.worktree, 'third-change', '1.1'),
      (error) => isWorkflowError(error, 'CHANGE_ROUTING_REQUIRED'),
    );

    abortSession(first.worktree, firstSession.sessionId, 'Test cleanup.');
    abortSession(second.worktree, secondSession.sessionId, 'Test cleanup.');
    assert.deepEqual(
      fs.readdirSync(
        path.join(runtimeRoot(repository), 'task-isolation', 'worktrees'),
      ),
      [],
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('status inspects each concurrent active session in its own durable worktree', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent status fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const primary = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/primary/**',
    );
    const concurrent = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      ['src/concurrent/**', 'test/concurrent/**'],
      [],
      {
        executionTask({ policy }) {
          return {
            strategy: 'tdd-single-agent',
            enforcement: 'planned',
            allowedPaths: policy.allowedPaths,
            requiredChecks: policy.requiredChecks,
            diffReview: 'policy-required',
            behaviorContractRefs: [
              {
                specPath: 'specs/demo/spec.md',
                requirement: 'Demo behavior',
                scenario: 'Demo succeeds',
              },
            ],
            testPathScopes: ['test/concurrent/**'],
            fixturePathScopes: [],
            implementationPathScopes: ['src/concurrent/**'],
            redCheck: 'fixture',
            greenChecks: ['fixture'],
            requiredImplementerIndependence: 'none',
          };
        },
      },
    );
    fixtures.push(primary, concurrent);

    const primarySession = startSession(primary.worktree, 'demo-change', '1.1');
    const concurrentSession = startSession(
      concurrent.worktree,
      'second-change',
      '1.1',
    );
    const beforePrimary = snapshotTaskPreflightState(primary.worktree);
    const beforeConcurrent = snapshotTaskPreflightState(concurrent.worktree);

    const exact = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'status',
        concurrentSession.sessionId,
        '--json',
      ],
      { cwd: primary.worktree, encoding: 'utf8' },
    );
    assert.equal(exact.status, 0, exact.stderr);
    const exactOutput = JSON.parse(exact.stdout) as {
      session: { sessionId: string; isolation: { routingRole: string } };
      taskStrategy: { sessionId: string; strategy: string; state: string };
    };
    assert.equal(exactOutput.session.sessionId, concurrentSession.sessionId);
    assert.equal(exactOutput.session.isolation.routingRole, 'concurrent');
    assert.deepEqual(exactOutput.taskStrategy, {
      schemaVersion: 1,
      kind: 'task-strategy-lifecycle-status.v1',
      invocationId: null,
      sessionId: concurrentSession.sessionId,
      strategy: 'tdd-single-agent',
      state: 'red-authoring',
      transactionDigest: null,
      sessionState: 'active',
    });

    const inventory = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'status',
        '--json',
      ],
      { cwd: primary.worktree, encoding: 'utf8' },
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    const inventoryOutput = JSON.parse(inventory.stdout) as {
      sessions: Array<{
        sessionId: string;
        isolation: { routingRole: string };
      }>;
      taskStrategies: Array<{
        sessionId: string;
        strategy: string;
        state: string;
      }>;
    };
    assert.equal(
      inventoryOutput.sessions.find(
        ({ sessionId }) => sessionId === primarySession.sessionId,
      )?.isolation.routingRole,
      'primary',
    );
    assert.equal(
      inventoryOutput.sessions.find(
        ({ sessionId }) => sessionId === concurrentSession.sessionId,
      )?.isolation.routingRole,
      'concurrent',
    );
    assert.deepEqual(
      inventoryOutput.taskStrategies.find(
        ({ sessionId }) => sessionId === concurrentSession.sessionId,
      ),
      {
        schemaVersion: 1,
        kind: 'task-strategy-lifecycle-status.v1',
        invocationId: null,
        sessionId: concurrentSession.sessionId,
        strategy: 'tdd-single-agent',
        state: 'red-authoring',
        transactionDigest: null,
        sessionState: 'active',
      },
    );
    assert.deepEqual(
      snapshotTaskPreflightState(primary.worktree),
      beforePrimary,
    );
    assert.deepEqual(
      snapshotTaskPreflightState(concurrent.worktree),
      beforeConcurrent,
    );

    abortSession(
      primary.worktree,
      primarySession.sessionId,
      'Concurrent status test cleanup.',
    );
    abortSession(
      concurrent.worktree,
      concurrentSession.sessionId,
      'Concurrent status test cleanup.',
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a routed writer keeps its source workset through completion projection and finalize', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    prepareCurrentChangeOnMain(repository);
    applyChangeRoutingReview(
      repository,
      prepareChangeRoutingReview(repository, {
        schemaVersion: 1,
        action: { kind: 'focus', changeId: 'demo-change' },
      }),
    );
    renderHandoff(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Declare primary test workset']);
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const worktree = fixture.worktree;
    const session = startSession(worktree, 'demo-change', '1.1');
    fs.mkdirSync(path.join(worktree, 'src/task'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, 'src/task/feature.ts'),
      'export const feature = true;\n',
    );

    assert.throws(
      () => finalizeTask(worktree, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(
      worktree,
      session.sessionId,
      'src/task/feature.ts',
    );
    const finalized = finalizeTask(worktree, session.sessionId);
    assert.equal(finalized.session.finishReportId !== undefined, true);
    const committed = commitSession(
      worktree,
      session.sessionId,
      'Complete routed fixture task',
    );
    assert.equal(committed.session.state, 'committed');
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a second task writer is rejected when its declared write scope overlaps', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/shared/**',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/shared/file.ts',
    );
    fixtures.push(first, second);

    startSession(first.worktree, 'demo-change', '1.1');
    assert.throws(
      () => startSession(second.worktree, 'second-change', '1.1'),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_SCOPE_CONFLICT') &&
        (error as WorkflowError).details?.conflictingChangeId === 'demo-change',
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent writers reject distinct paths in the same serialized policy class', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'workflow/first-policy.json',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'workflow/second-policy.json',
    );
    fixtures.push(first, second);

    startSession(first.worktree, 'demo-change', '1.1');
    assert.throws(
      () => startSession(second.worktree, 'second-change', '1.1'),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_SERIALIZED_SCOPE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent destructive checks require distinct disposable database leases before editing', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    const consumerConfigPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumerConfig = JSON.parse(
      fs.readFileSync(consumerConfigPath, 'utf8'),
    ) as { databasePolicy: { adapterId: string } };
    consumerConfig.databasePolicy.adapterId = 'postgresql-disposable-v1';
    fs.writeFileSync(
      consumerConfigPath,
      `${JSON.stringify(consumerConfig, null, 2)}\n`,
    );
    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add destructive concurrent fixtures']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/first/**',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/second/**',
    );
    fixtures.push(first, second);
    const environment = {
      WORKFLOW_DISPOSABLE_DATABASE: '1',
      TEST_DATABASE_URL: 'postgresql://localhost:5432/concurrent_test',
    };

    startSession(first.worktree, 'demo-change', '1.1', { environment });
    assert.throws(
      () =>
        startSession(second.worktree, 'second-change', '1.1', {
          environment,
        }),
      (error) => isWorkflowError(error, 'TASK_SESSION_RESOURCE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent writers reject a shared guard-declared exclusive resource', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/first/**',
      ['simulator:shared-test'],
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/second/**',
      ['simulator:shared-test'],
    );
    fixtures.push(first, second);

    startSession(first.worktree, 'demo-change', '1.1');
    assert.throws(
      () => startSession(second.worktree, 'second-change', '1.1'),
      (error) => isWorkflowError(error, 'TASK_SESSION_RESOURCE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base replays a finished non-final task branch and recomputes local PR assurance', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const prepared = prepareFinishedNonFinalTaskForBaseUpdate(repository);
    fixture = prepared.fixture;
    const { committed, started } = prepared;
    const finishedSession = getSession(fixture.worktree, started.sessionId);
    const expectedInvalidatedRuntimeReportIds = [
      finishedSession.latestCheckReportId,
      finishedSession.completionReportId,
      finishedSession.finishReportId,
      finishedSession.commitReportId,
      finishedSession.implementationReconciliationReportId,
    ]
      .filter((reportId): reportId is string => reportId !== undefined)
      .sort();
    assert.ok(expectedInvalidatedRuntimeReportIds.length > 0);

    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);
    const ontoCommit = git(repository, ['rev-parse', 'main']).trim();

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      result: {
        changeId: string;
        oldHead: string;
        newHead: string;
        ontoCommit: string;
        invalidatedRuntimeReportIds: string[];
        revalidated: {
          planningGenerationId: string;
          allowedPaths: string[];
        };
        assurance: {
          base: string;
          head: string;
          checkIds: string[];
        };
      };
    };
    assert.equal(output.result.changeId, 'demo-change');
    assert.equal(output.result.oldHead, committed.commitHash);
    assert.notEqual(output.result.newHead, output.result.oldHead);
    assert.equal(output.result.ontoCommit, ontoCommit);
    assert.deepEqual(
      output.result.invalidatedRuntimeReportIds,
      expectedInvalidatedRuntimeReportIds,
    );
    assert.match(
      output.result.revalidated.planningGenerationId,
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(output.result.revalidated.allowedPaths, ['src/task/**']);
    assert.deepEqual(output.result.assurance, {
      base: ontoCommit,
      head: output.result.newHead,
      checkIds: ['fixture'],
    });

    const refreshed = getSession(fixture.worktree, started.sessionId);
    assert.equal(refreshed.state, 'committed');
    assert.equal(refreshed.commitHash, committed.commitHash);
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(
          path.resolve(
            fixture.worktree,
            git(fixture.worktree, ['rev-parse', '--git-common-dir']).trim(),
          ),
          'workflow-engine',
          'base-refreshes',
          'demo-change',
          `${output.result.newHead}.json`,
        ),
        'utf8',
      ),
    ) as {
      sessionId: string;
      oldHead: string;
      newHead: string;
      invalidatedRuntimeReportIds: string[];
      assuranceCheckIds: string[];
    };
    assert.equal(receipt.sessionId, started.sessionId);
    assert.equal(receipt.oldHead, committed.commitHash);
    assert.equal(receipt.newHead, output.result.newHead);
    assert.deepEqual(
      receipt.invalidatedRuntimeReportIds,
      expectedInvalidatedRuntimeReportIds,
    );
    assert.deepEqual(receipt.assuranceCheckIds, ['fixture']);
    git(fixture.worktree, [
      'merge-base',
      '--is-ancestor',
      ontoCommit,
      output.result.newHead,
    ]);
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      output.result.newHead,
    );
    const repeated = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );
    assert.equal(repeated.status, 14, repeated.stderr);
    assert.match(
      `${repeated.stdout}\n${repeated.stderr}`,
      /UPDATE_BASE_NOT_ADVANCED/,
    );
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      output.result.newHead,
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base rolls back when the selected local ref changes before receipt publication', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const prepared = prepareFinishedNonFinalTaskForBaseUpdate(repository);
    fixture = prepared.fixture;
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);
    const ontoCommit = git(repository, ['rev-parse', 'main']).trim();
    const before = snapshotTaskPreflightState(fixture.worktree);
    let movedOntoCommit: string | undefined;

    assert.throws(
      () =>
        updateTaskSessionBase(
          fixture!.worktree,
          'demo-change',
          'main',
          process.env,
          {
            beforeReceiptPublication(context) {
              assert.deepEqual(context, { ontoRef: 'main', ontoCommit });
              fs.writeFileSync(
                path.join(repository, 'src/base-drift.ts'),
                'export const baseDrift = true;\n',
              );
              git(repository, ['add', 'src/base-drift.ts']);
              git(repository, [
                'commit',
                '-m',
                'Advance selected base during update',
              ]);
              movedOntoCommit = git(repository, ['rev-parse', 'main']).trim();
            },
          },
        ),
      (error) => {
        assert.equal(
          isWorkflowError(error, 'UPDATE_BASE_TARGET_CHANGED'),
          true,
        );
        assert.deepEqual((error as WorkflowError).details, {
          ontoRef: 'main',
          expectedOntoCommit: ontoCommit,
          observedOntoCommit: movedOntoCommit,
        });
        return true;
      },
    );
    assert.notEqual(movedOntoCommit, undefined);
    const after = snapshotTaskPreflightState(fixture.worktree);
    assert.deepEqual(
      {
        head: after.head,
        tree: after.tree,
        status: after.status,
        runtime: after.runtime,
      },
      {
        head: before.head,
        tree: before.tree,
        status: before.status,
        runtime: before.runtime,
      },
    );
    assert.equal(
      git(repository, ['rev-parse', 'main']).trim(),
      movedOntoCommit,
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base revalidates active writers after acquiring the lifecycle lock', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const prepared = prepareFinishedNonFinalTaskForBaseUpdate(repository);
    fixture = prepared.fixture;
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);
    const beforeHead = git(fixture.worktree, ['rev-parse', 'HEAD']).trim();
    const refreshRoot = path.join(
      runtimeRoot(fixture.worktree),
      'base-refreshes',
      'demo-change',
    );
    let interleavedSession: ReturnType<typeof startSession> | undefined;

    assert.throws(
      () =>
        updateTaskSessionBase(
          fixture!.worktree,
          'demo-change',
          'main',
          process.env,
          {
            afterFinishedSessionPreflight() {
              interleavedSession = startSession(
                fixture!.worktree,
                'demo-change',
                '1.2',
              );
            },
          },
        ),
      (error) => isWorkflowError(error, 'UPDATE_BASE_ACTIVE_SESSION_PRESENT'),
    );
    assert.ok(interleavedSession);
    assert.equal(interleavedSession.state, 'active');
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      beforeHead,
    );
    assert.equal(fs.existsSync(refreshRoot), false);
    abortSession(
      fixture.worktree,
      interleavedSession.sessionId,
      'Release the interleaved update-base regression session.',
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base refuses an active writer before changing Git history', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const started = startSession(fixture.worktree, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );
    assert.equal(result.status, 13, result.stdout);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /UPDATE_BASE_ACTIVE_SESSION_PRESENT/,
    );
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      started.baseline.head,
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base rolls back when generated reconciliation needs a reviewed transition', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
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
      'tracked default handoff sentinel\n',
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Configure alternate handoff path']);
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const taskWorktree = fixture.worktree;
    const started = startSession(taskWorktree, 'demo-change', '1.1');
    fs.mkdirSync(path.join(taskWorktree, 'src/task'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(taskWorktree, 'src/task/feature.ts'),
      'export const feature = true;\n',
    );
    assert.throws(
      () => finalizeTask(taskWorktree, started.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(
      taskWorktree,
      started.sessionId,
      'src/task/feature.ts',
    );
    finalizeTask(taskWorktree, started.sessionId);
    const committed = commitSession(
      taskWorktree,
      started.sessionId,
      'Complete concurrent fixture task',
    );
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );
    assert.equal(result.status, 14, result.stderr);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /UPDATE_BASE_GENERATED_RECONCILIATION_REQUIRED/,
    );
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      committed.commitHash,
    );
    assert.equal(git(fixture.worktree, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(path.join(fixture.worktree, 'notebook/handoff.md')),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(fixture.worktree, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      'tracked default handoff sentinel\n',
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects workflow artifacts changed after session start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    fs.appendFileSync(guardPath, '\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects a session whose task policy was broadened', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    tampered.allowedPaths = ['outside.txt'];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_POLICY_TAMPERED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check executes required argv literally from the repository root', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-output-'),
  );
  const outputPath = path.join(outputDirectory, 'arguments.json');
  const sentinelPath = path.join(outputDirectory, 'shell-injection');
  const literalArgument = `; touch ${sentinelPath}`;

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        literal: {
          command: [
            'node',
            'scripts/capture-args.mjs',
            outputPath,
            literalArgument,
            '$(echo not-evaluated)',
          ],
          destructiveDatabase: false,
        },
      },
      ['literal'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId);
    const captured = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    assert.deepEqual(captured, {
      cwd: fs.realpathSync(repository),
      arguments: [literalArgument, '$(echo not-evaluated)'],
    });
    assert.equal(fs.existsSync(sentinelPath), false);
    assert.deepEqual(
      result.checks.map((check) => ({
        checkId: check.checkId,
        outcome: check.outcome,
        exitCode: check.exitCode,
      })),
      [{ checkId: 'literal', outcome: 'passed', exitCode: 0 }],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check fails on the first non-zero check and does not run later checks', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-failure-'),
  );
  const markerPath = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        failing: {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
      },
      ['failing', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_FAILED'), true);
        assert.deepEqual((error as WorkflowError).details, {
          checkId: 'failing',
          exitCode: 7,
          signal: null,
        });
        return true;
      },
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive database preflight runs before any required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-database-preflight-'),
  );
  const markerPath = path.join(outputDirectory, 'first-check-ran');

  try {
    addFixtureScripts(repository);
    enableDisposableDatabasePolicy(repository);
    configureChecks(
      repository,
      {
        first: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['first', 'destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: { ...process.env },
        }),
      (error) =>
        isWorkflowError(error, 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED'),
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive check evidence includes only the redacted database identity', () => {
  const repository = createFixtureRepository();
  try {
    enableDisposableDatabasePolicy(repository);
    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId, {
      environment: {
        ...process.env,
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@127.0.0.1:5433/expense_test?ssl=false',
        DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/expense_dev',
      },
    });

    assert.equal(
      result.checks[0].databaseIdentity,
      'postgresql://127.0.0.1:5433/expense_test',
    );
    assert.equal(JSON.stringify(result).includes('marker-secret'), false);
    assert.equal(JSON.stringify(result).includes('ssl=false'), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check revalidates scope before running the next required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-post-check-scope-'),
  );
  const outsidePath = path.join(repository, 'outside.txt');
  const laterMarker = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', outsidePath],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', laterMarker],
          destructiveDatabase: false,
        },
      },
      ['mutating', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check rejects a lock removed by a passing required check', () => {
  const repository = createFixtureRepository();
  const lockPath = path.join(
    runtimeRoot(repository),
    'locks',
    'demo-change.lock',
  );

  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/remove-file.mjs', lockPath],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check converts spawn errors without leaking environment values', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        overflowing: {
          command: ['node', 'scripts/overflow.mjs'],
          destructiveDatabase: false,
        },
      },
      ['overflowing'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: {
            ...process.env,
            WORKFLOW_TEST_SECRET: 'marker-secret',
          },
        }),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_EXECUTION_FAILED'), true);
        assert.equal((error as Error).message.includes('marker-secret'), false);
        assert.equal(JSON.stringify(error).includes('marker-secret'), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('change validation rejects inherited object properties as check IDs', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    configureChecks(
      repository,
      {
        fixture: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        },
      },
      ['constructor'],
    );

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'UNKNOWN_REQUIRED_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'node runner ignores caller-controlled PATH substitutes',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const fakeBin = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-bin-'),
    );
    const markerPath = path.join(fakeBin, 'fake-node-ran');
    const fakeNodePath = path.join(fakeBin, 'node');

    try {
      fs.writeFileSync(
        fakeNodePath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 0\n`,
      );
      fs.chmodSync(fakeNodePath, 0o755);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      const session = startSession(repository, 'demo-change', '1.1');

      const result = checkSession(repository, session.sessionId, {
        environment: { ...process.env, PATH: fakeBin },
      });

      assert.equal(result.passed, true);
      assert.equal(fs.existsSync(markerPath), false);
      assert.equal(result.checks[0].runner, 'node');
      assert.match(result.checks[0].runnerDigest, /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  },
);

test('change validation rejects bare executable check runners', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    configureChecks(
      repository,
      {
        unsafe: {
          command: ['pnpm', '--version'],
          destructiveDatabase: false,
        },
      },
      ['unsafe'],
    );

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'INVALID_CHECK_DEFINITION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
