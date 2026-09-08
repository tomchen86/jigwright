import test from 'node:test';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  startSession,
  abortSession,
  preflightTaskSession,
  startSessionUnderLifecycleLock,
} from '../src/application/execute-task/session.ts';
import {
  parseTaskWorktreeRegistrations,
  createSessionId,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../src/runtime/session-workspace/session-store.ts';
import os from 'node:os';
import {
  prepareCurrentChange,
  snapshotTaskPreflightState,
  type TaskSessionPreflightCliOutput,
} from './support/session-lifecycle-fixture.ts';

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
