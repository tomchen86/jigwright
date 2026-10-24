import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { compareAndSwapEvidenceRefsDocument } from '../src/runtime/storage-journal/evidence-object-store.ts';
import {
  preparedLockTemporaryPath,
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../src/runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  publishProviderResultToInvestigation,
  resumeInvestigationSession,
} from '../src/runtime/investigation-lifecycle/investigation-session.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import { readHumanResolutionJournal } from '../src/runtime/lifecycle-ledgers/human-resolution-journal.ts';
import { withHumanResolutionGrantExecution } from '../src/runtime/storage-journal/human-resolution-grant-store.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import {
  withChangeTransitionAuthority,
  withHumanResolutionTransitionAuthority,
  withInvestigationTransitionAuthority,
} from '../src/runtime/session-workspace/planning-lock.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import {
  assertOwnedLock,
  releaseOwnedLock,
  runtimePaths as workflowRuntimePaths,
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../src/runtime/session-workspace/session-store.ts';
import {
  FIRST_INSTANT,
  SESSION_STORE_MODULE_URL,
  PLANNING_LOCK_MODULE_URL,
  HUMAN_RESOLUTION_GRANT_STORE_MODULE_URL,
  EVIDENCE_STORE_MODULE_URL,
  FILESYSTEM_SAFETY_MODULE_URL,
  PATHS_MODULE_URL,
  SESSION_MODULE_URL,
  investigationFixture,
  startFixture,
  mainTermsEnvelope,
  completeBlindInvocation,
  runLockCrashChild,
  assertLinkedLockPair,
  sessionPath,
} from './investigation-session-fixture.ts';

test('an active change does not hold investigation, human-resolution, plan, or archive for another change', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const active = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const discovered = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      discovered.gitCommonDirectory,
      'workflow-engine',
    );
    const reached: string[] = [];

    withInvestigationTransitionAuthority(runtime, 'other-change', () => {
      reached.push('investigation');
    });
    withHumanResolutionTransitionAuthority(
      runtime,
      'other-change',
      null,
      () => {
        reached.push('human-resolution');
      },
    );
    withChangeTransitionAuthority(runtime, 'other-change', 'plan', () => {
      reached.push('plan');
    });
    withChangeTransitionAuthority(runtime, 'other-change', 'archive', () => {
      reached.push('archive');
    });

    assert.deepEqual(reached, [
      'investigation',
      'human-resolution',
      'plan',
      'archive',
    ]);
    abortSession(repository, active.sessionId, 'fixture cleanup');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('every transition entrance remains fail-closed for the active change', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const active = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const discovered = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      discovered.gitCommonDirectory,
      'workflow-engine',
    );
    const operations = [
      () =>
        withInvestigationTransitionAuthority(
          runtime,
          'demo-change',
          () => undefined,
        ),
      () =>
        withHumanResolutionTransitionAuthority(
          runtime,
          'demo-change',
          null,
          () => undefined,
        ),
      () =>
        withChangeTransitionAuthority(
          runtime,
          'demo-change',
          'plan',
          () => undefined,
        ),
      () =>
        withChangeTransitionAuthority(
          runtime,
          'demo-change',
          'archive',
          () => undefined,
        ),
    ];

    for (const operation of operations) {
      assert.throws(operation, (error) =>
        isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
      );
    }
    abortSession(repository, active.sessionId, 'fixture cleanup');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a reserved maintainer authority still fences repository lifecycle globally', () => {
  const repository = createFixtureRepository();
  try {
    const discovered = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      discovered.gitCommonDirectory,
      'workflow-engine',
    );
    const reserved = path.join(runtime.root, 'maintainer-grants', 'reserved');
    fs.mkdirSync(reserved, { recursive: true, mode: 0o700 });
    fs.chmodSync(reserved, 0o700);
    fs.writeFileSync(
      path.join(reserved, '11111111-1111-4111-8111-111111111111.json'),
      '{}\n',
      { mode: 0o600 },
    );

    assert.throws(
      () =>
        withInvestigationTransitionAuthority(
          runtime,
          'independent-change',
          () => undefined,
        ),
      (error) => isWorkflowError(error, 'ACTIVE_AUTHORITY_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('dead private locks are reclaimed but live owners remain fenced', () => {
  const fixture = investigationFixture('invocation-lock-recovery');
  try {
    const started = startFixture(fixture);
    const repositoryLockPath = path.join(
      runtimeRoot(fixture.repository),
      'operations',
      'repository-lifecycle.lock',
    );
    const changeLockPath = path.join(
      runtimeRoot(fixture.repository),
      'locks',
      'demo-change.lock',
    );
    fs.writeFileSync(
      repositoryLockPath,
      `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken: '11111111-1111-4111-8111-111111111111',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    fs.writeFileSync(
      changeLockPath,
      `${JSON.stringify({
        operationId: 'investigation-22222222-2222-4222-8222-222222222222',
        ownerToken: '22222222-2222-4222-8222-222222222222',
        changeId: 'demo-change',
        transition: 'investigation',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assert.deepEqual(
      resumeInvestigationSession(fixture.repository, started.investigationId),
      started,
    );
    assert.equal(fs.existsSync(repositoryLockPath), false);
    assert.equal(fs.existsSync(changeLockPath), false);

    const lockPath = path.join(
      fixture.paths.locks,
      `${started.investigationId}.lock`,
    );
    fs.writeFileSync(
      lockPath,
      `${canonicalJson({
        schemaVersion: 1,
        ownerToken: '33333333-3333-4333-8333-333333333333',
        pid: 2_147_483_647,
        createdAt: FIRST_INSTANT,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(fs.existsSync(lockPath), false);

    completeBlindInvocation(fixture, waiting.providerInvocationId);
    fs.writeFileSync(
      lockPath,
      `${canonicalJson({
        schemaVersion: 1,
        ownerToken: '44444444-4444-4444-8444-444444444444',
        pid: process.pid,
        createdAt: FIRST_INSTANT,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assert.throws(
      () =>
        publishProviderResultToInvestigation(
          fixture.repository,
          waiting.investigationId,
          {
            expectedRevision: waiting.revision,
            invocationId: waiting.providerInvocationId,
          },
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_SESSION_OPERATION_CONFLICT'),
    );
    assert.equal(fs.existsSync(lockPath), true);
    fs.unlinkSync(lockPath);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('transition-lock recovery rejects symlinked parents without unlinking targets', () => {
  const fixture = investigationFixture('invocation-lock-parent-symlink');
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-lock-parent-'),
  );
  try {
    const externalLock = path.join(external, 'repository-lifecycle.lock');
    fs.writeFileSync(
      externalLock,
      `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken: 'external-dead-owner',
        pid: 2_147_483_647,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const runtime = runtimeRoot(fixture.repository);
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.symlinkSync(external, path.join(runtime, 'operations'));

    assert.throws(
      () => startFixture(fixture),
      (error) => isWorkflowError(error, 'RUNTIME_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(externalLock), true);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('repository lifecycle reclaims an orphaned active-journal temp after a writer crash', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const activeDirectory = path.join(
      runtime.root,
      'investigations',
      'human-resolutions',
      'active',
    );
    fs.mkdirSync(activeDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(activeDirectory, 0o700);
    const orphanedTemporary = path.join(
      activeDirectory,
      'demo-change.json.99999999.11111111-1111-4111-8111-111111111111.tmp',
    );
    fs.writeFileSync(orphanedTemporary, '{"partial":true}\n', {
      mode: 0o600,
    });
    fs.chmodSync(orphanedTemporary, 0o600);
    const investigationPaths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    assert.equal(
      readHumanResolutionJournal(
        investigationPaths,
        '11111111-1111-4111-8111-111111111111',
      ),
      null,
    );
    assert.equal(fs.existsSync(orphanedTemporary), true);

    withRepositoryLifecycleOperation(runtime, (assertOwned) => {
      assertOwned();
      assert.equal(fs.existsSync(orphanedTemporary), false);
    });

    fs.writeFileSync(path.join(activeDirectory, 'unexpected.tmp'), '', {
      mode: 0o600,
    });
    assert.throws(
      () => withRepositoryLifecycleOperation(runtime, () => {}),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_JOURNAL_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('lock publishers recover before-link and post-link process crashes', () => {
  const repository = createFixtureRepository();
  const changeId = 'atomic-lock-publication';
  const grantId = '55555555-5555-4555-8555-555555555555';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const investigationPaths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const cases: Array<{
      fragment: string;
      finalLock: string;
      operation: string;
      retry: () => void;
    }> = [
      {
        fragment: 'repository-lifecycle.lock.',
        finalLock: path.join(runtime.operations, 'repository-lifecycle.lock'),
        operation: `
          const { runtimePaths, withRepositoryLifecycleOperation } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withRepositoryLifecycleOperation(runtime, () => {});
        `,
        retry: () => withRepositoryLifecycleOperation(runtime, () => {}),
      },
      {
        fragment: 'atomic-session-operation.lock.',
        finalLock: path.join(
          runtime.operations,
          'atomic-session-operation.lock',
        ),
        operation: `
          const { runtimePaths, withSessionOperation } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withSessionOperation(runtime, 'atomic-session-operation', () => {});
        `,
        retry: () =>
          withSessionOperation(runtime, 'atomic-session-operation', () => {}),
      },
      {
        fragment: `${changeId}.lock.`,
        finalLock: path.join(runtime.locks, `${changeId}.lock`),
        operation: `
          const { runtimePaths } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const { withHumanResolutionTransitionAuthority } =
            await import(${JSON.stringify(PLANNING_LOCK_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withHumanResolutionTransitionAuthority(
            runtime,
            ${JSON.stringify(changeId)},
            null,
            () => {},
          );
        `,
        retry: () =>
          withHumanResolutionTransitionAuthority(
            runtime,
            changeId,
            null,
            () => {},
          ),
      },
      {
        fragment: `${grantId}.execution.lock.`,
        finalLock: path.join(
          investigationPaths.root,
          'human-resolutions',
          'locks',
          `${grantId}.execution.lock`,
        ),
        operation: `
          const { investigationRuntimePaths } =
            await import(${JSON.stringify(PATHS_MODULE_URL)});
          const { withHumanResolutionGrantExecution } =
            await import(${JSON.stringify(HUMAN_RESOLUTION_GRANT_STORE_MODULE_URL)});
          const paths = investigationRuntimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withHumanResolutionGrantExecution(
            paths,
            ${JSON.stringify(grantId)},
            () => {},
          );
        `,
        retry: () =>
          withHumanResolutionGrantExecution(
            investigationPaths,
            grantId,
            () => {},
          ),
      },
      {
        fragment: `${changeId}.lock.`,
        finalLock: path.join(investigationPaths.refs, `${changeId}.lock`),
        operation: `
          const { investigationRuntimePaths } =
            await import(${JSON.stringify(PATHS_MODULE_URL)});
          const { compareAndSwapEvidenceRefsDocument } =
            await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
          const paths = investigationRuntimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          compareAndSwapEvidenceRefsDocument(paths, {
            changeId: ${JSON.stringify(changeId)},
            expectedDigest: null,
            nextRefs: null,
          });
        `,
        retry: () =>
          compareAndSwapEvidenceRefsDocument(investigationPaths, {
            changeId,
            expectedDigest: null,
            nextRefs: null,
          }),
      },
    ];

    for (const candidate of cases) {
      const beforeLink = runLockCrashChild(
        repository,
        candidate.operation,
        'write',
        candidate.fragment,
      );
      assert.equal(beforeLink.signal, 'SIGKILL');
      assert.equal(fs.existsSync(candidate.finalLock), false);
      candidate.retry();

      const postLink = runLockCrashChild(
        repository,
        candidate.operation,
        'unlink',
        candidate.fragment,
      );
      assert.equal(postLink.signal, 'SIGKILL');
      const temporary = assertLinkedLockPair(candidate.finalLock);
      candidate.retry();
      assert.equal(fs.existsSync(candidate.finalLock), false);
      assert.equal(fs.existsSync(temporary), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('session operations reclaim a dead owner after callback entry', () => {
  const repository = createFixtureRepository();
  const sessionId = 'dead-session-operation-owner';
  try {
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const { runtimePaths, withSessionOperation } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const runtime = runtimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          withSessionOperation(
            runtime,
            ${JSON.stringify(sessionId)},
            () => process.kill(process.pid, 'SIGKILL'),
          );
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    const lockPath = path.join(runtime.operations, `${sessionId}.lock`);
    assert.equal(fs.lstatSync(lockPath).nlink, 1);

    let executions = 0;
    withSessionOperation(runtime, sessionId, () => {
      executions += 1;
    });
    assert.equal(executions, 1);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository and plan/archive transitions reclaim dead callback owners', () => {
  const candidates: Array<{
    name: string;
    operation: (gitCommonDirectory: string) => string;
    retry: (
      runtime: ReturnType<typeof workflowRuntimePaths>,
      changeId: string,
      record: () => void,
    ) => void;
  }> = [
    {
      name: 'repository',
      operation: (gitCommonDirectory) => `
        const { runtimePaths, withRepositoryLifecycleOperation } =
          await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
        const runtime = runtimePaths(
          ${JSON.stringify(gitCommonDirectory)},
          'workflow-engine',
        );
        withRepositoryLifecycleOperation(
          runtime,
          () => process.kill(process.pid, 'SIGKILL'),
        );
      `,
      retry: (runtime, _changeId, record) =>
        withRepositoryLifecycleOperation(runtime, record),
    },
    ...(['plan', 'archive'] as const).map((transition) => ({
      name: transition,
      operation: (gitCommonDirectory: string) => `
        const { runtimePaths } =
          await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
        const { withChangeTransitionAuthority } =
          await import(${JSON.stringify(PLANNING_LOCK_MODULE_URL)});
        const runtime = runtimePaths(
          ${JSON.stringify(gitCommonDirectory)},
          'workflow-engine',
        );
        withChangeTransitionAuthority(
          runtime,
          'dead-transition-owner',
          ${JSON.stringify(transition)},
          () => process.kill(process.pid, 'SIGKILL'),
        );
      `,
      retry: (
        runtime: ReturnType<typeof workflowRuntimePaths>,
        changeId: string,
        record: () => void,
      ) => withChangeTransitionAuthority(runtime, changeId, transition, record),
    })),
  ];

  for (const candidate of candidates) {
    const repository = createFixtureRepository();
    const changeId = 'dead-transition-owner';
    try {
      const repositoryState = discoverRepository(repository);
      const runtime = workflowRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          candidate.operation(repositoryState.gitCommonDirectory),
        ],
        { cwd: repository, encoding: 'utf8' },
      );
      assert.equal(child.signal, 'SIGKILL', candidate.name);
      const repositoryLock = path.join(
        runtime.operations,
        'repository-lifecycle.lock',
      );
      assert.equal(fs.lstatSync(repositoryLock).nlink, 1, candidate.name);
      if (candidate.name !== 'repository') {
        assert.equal(
          fs.lstatSync(path.join(runtime.locks, `${changeId}.lock`)).nlink,
          1,
          candidate.name,
        );
      }

      let executions = 0;
      candidate.retry(runtime, changeId, () => {
        executions += 1;
      });
      assert.equal(executions, 1, candidate.name);
      assert.equal(fs.existsSync(repositoryLock), false, candidate.name);
      assert.equal(
        fs.existsSync(path.join(runtime.locks, `${changeId}.lock`)),
        false,
        candidate.name,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('evidence ref operations reclaim a dead owner after final unlink begins', () => {
  const repository = createFixtureRepository();
  const changeId = 'dead-evidence-ref-owner';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const lockPath = path.join(paths.refs, `${changeId}.lock`);
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { compareAndSwapEvidenceRefsDocument } =
            await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
          const { investigationRuntimePaths } =
            await import(${JSON.stringify(PATHS_MODULE_URL)});
          const paths = investigationRuntimePaths(
            ${JSON.stringify(repositoryState.gitCommonDirectory)},
            'workflow-engine',
          );
          const lockPath = ${JSON.stringify(lockPath)};
          const originalUnlink = fs.unlinkSync.bind(fs);
          fs.unlinkSync = (target, ...args) => {
            if (target === lockPath) {
              process.kill(process.pid, 'SIGKILL');
            }
            return originalUnlink(target, ...args);
          };
          compareAndSwapEvidenceRefsDocument(paths, {
            changeId: ${JSON.stringify(changeId)},
            expectedDigest: null,
            nextRefs: null,
          });
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.lstatSync(lockPath).nlink, 1);

    compareAndSwapEvidenceRefsDocument(paths, {
      changeId,
      expectedDigest: null,
      nextRefs: null,
    });
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed task start recovers its shared change lock crash windows', () => {
  for (const phase of ['write', 'unlink'] as const) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      writeReadyV3ExemptChange(repository);
      commitPlanningTransition(repository, 'demo-change');
      const repositoryState = discoverRepository(repository);
      const runtime = workflowRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const lockPath = path.join(runtime.locks, 'demo-change.lock');
      const child = runLockCrashChild(
        repository,
        `
          const { startSession } =
            await import(${JSON.stringify(SESSION_MODULE_URL)});
          const { productionChangeContract } =
            await import(${JSON.stringify(new URL('../src/composition-root/change-routing-observation-production.ts', import.meta.url).href)});
          startSession(
            productionChangeContract,
            ${JSON.stringify(repository)},
            'demo-change',
            '1.1',
          );
        `,
        phase,
        'demo-change.lock.',
      );
      assert.equal(child.signal, 'SIGKILL');
      const temporary =
        phase === 'unlink' ? assertLinkedLockPair(lockPath) : null;
      if (phase === 'write') {
        assert.equal(fs.existsSync(lockPath), false);
      }
      const started = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      assert.equal(started.changeId, 'demo-change');
      assert.equal(fs.lstatSync(lockPath).nlink, 1);
      if (temporary !== null) {
        assert.equal(fs.existsSync(temporary), false);
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('managed task start reclaims dead locks bound to terminal sessions', () => {
  for (const candidate of [
    { state: 'aborted' },
    { state: 'committed' },
  ] as const) {
    const { state } = candidate;
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      writeReadyV3ExemptChange(repository);
      commitPlanningTransition(repository, 'demo-change');
      const started = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      const repositoryState = discoverRepository(repository);
      const runtime = workflowRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const sessionPath = path.join(
        runtime.sessions,
        `${started.sessionId}.json`,
      );
      const terminal =
        state === 'aborted'
          ? {
              ...started,
              state,
              abortedAt: FIRST_INSTANT,
              abortReason: 'Simulate a crash after terminal persistence.',
            }
          : {
              ...started,
              state,
              latestCheckReportId: 'a'.repeat(64),
              completionReportId: 'b'.repeat(64),
              finishReportId: 'c'.repeat(64),
              commitReportId: 'd'.repeat(64),
              commitHash: 'e'.repeat(40),
              committedAt: FIRST_INSTANT,
            };
      fs.writeFileSync(
        sessionPath,
        `${JSON.stringify(terminal, null, 2)}\n`,
        'utf8',
      );
      const lockPath = path.join(runtime.locks, 'demo-change.lock');
      const marker = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<
        string,
        unknown
      >;
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          ...marker,
          pid: state === 'aborted' ? process.pid : 2_147_483_647,
        })}\n`,
        'utf8',
      );

      const successor = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      assert.notEqual(successor.sessionId, started.sessionId, state);
      assert.equal(successor.state, 'active', state);
      const successorMarker = fs.readFileSync(lockPath, 'utf8');
      releaseOwnedLock(lockPath, started.sessionId);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), successorMarker, state);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('managed session locks reject unversioned markers without releasing them', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const lockPath = path.join(runtime.locks, 'demo-change.lock');

    assertOwnedLock(
      lockPath,
      started.sessionId,
      started.changeId,
      started.taskId,
    );

    const unversionedMarker = `${JSON.stringify({
      sessionId: started.sessionId,
      changeId: started.changeId,
      taskId: started.taskId,
    })}\n`;
    fs.writeFileSync(lockPath, unversionedMarker, 'utf8');

    assert.throws(
      () =>
        assertOwnedLock(
          lockPath,
          started.sessionId,
          started.changeId,
          started.taskId,
        ),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.throws(
      () => releaseOwnedLock(lockPath, started.sessionId),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), unversionedMarker);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed lock release claim fences a concurrent successor start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const sessionPath = path.join(
      runtime.sessions,
      `${started.sessionId}.json`,
    );
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify(
        {
          ...started,
          state: 'aborted',
          abortedAt: FIRST_INSTANT,
          abortReason: 'Simulate terminal persistence before lock release.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const lockPath = path.join(runtime.locks, 'demo-change.lock');
    const marker = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ ...marker, pid: 2_147_483_647 })}\n`,
      'utf8',
    );

    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { startSession } =
            await import(${JSON.stringify(SESSION_MODULE_URL)});
          const { productionChangeContract } =
            await import(${JSON.stringify(new URL('../src/composition-root/change-routing-observation-production.ts', import.meta.url).href)});
          const { releaseOwnedLock } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const originalRead = fs.readFileSync.bind(fs);
          let interleaved = false;
          let successor = 'not-run';
          fs.readFileSync = (target, ...args) => {
            const result = originalRead(target, ...args);
            if (typeof target === 'number' && !interleaved) {
              interleaved = true;
              try {
                startSession(
                  productionChangeContract,
                  ${JSON.stringify(repository)},
                  'demo-change',
                  '1.1',
                );
                successor = 'started';
              } catch (error) {
                successor =
                  error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : String(error);
              }
            }
            return result;
          };
          releaseOwnedLock(
            ${JSON.stringify(lockPath)},
            ${JSON.stringify(started.sessionId)},
          );
          process.stdout.write(successor);
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'ACTIVE_SESSION_CONFLICT');
    assert.equal(fs.existsSync(lockPath), false);

    const successor = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    assert.notEqual(successor.sessionId, started.sessionId);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed lock release treats a winning reclaimer as already released', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const repositoryState = discoverRepository(repository);
    const runtime = workflowRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const lockPath = path.join(runtime.locks, 'demo-change.lock');
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { releaseOwnedLock } =
            await import(${JSON.stringify(SESSION_STORE_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const originalOpen = fs.openSync.bind(fs);
          const originalUnlink = fs.unlinkSync.bind(fs);
          let simulated = false;
          fs.openSync = (target, ...args) => {
            if (target === lockPath && !simulated) {
              simulated = true;
              originalUnlink(lockPath);
            }
            return originalOpen(target, ...args);
          };
          releaseOwnedLock(
            lockPath,
            ${JSON.stringify(started.sessionId)},
          );
          process.stdout.write('released');
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'released');
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(
      fs
        .readdirSync(runtime.locks)
        .filter((name) => name.startsWith('demo-change.lock.reclaim.')),
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('prepared lock reclaim claims fence publishers and competing reclaimers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-lock-'));
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const deadOwnerToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const publisherToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const marker = `${JSON.stringify({
    pid: deadPid,
    ownerToken: deadOwnerToken,
  })}\n`;
  const readOwner = (content: string) =>
    content === marker ? { pid: deadPid, ownerToken: deadOwnerToken } : null;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const liveClaim = `${lockPath}.reclaim.${process.pid}.cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
    fs.mkdirSync(liveClaim, { mode: 0o700 });
    fs.chmodSync(liveClaim, 0o700);

    assert.equal(reclaimDeadPreparedLock(lockPath, readOwner), 'occupied');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), marker);
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'EEXIST',
    );
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(
      fs.existsSync(
        preparedLockTemporaryPath(lockPath, process.pid, publisherToken),
      ),
      false,
    );
    fs.unlinkSync(lockPath);
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'EEXIST',
    );
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(liveClaim), true);

    fs.rmdirSync(liveClaim);
    const deadClaim = `${lockPath}.reclaim.${deadPid}.dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    fs.mkdirSync(deadClaim, { mode: 0o700 });
    fs.chmodSync(deadClaim, 0o700);
    const descriptor = publishPreparedExclusiveLock(
      lockPath,
      marker,
      publisherToken,
      () => new Error('unsafe prepared lock claim'),
    );
    fs.closeSync(descriptor);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), marker);
    assert.equal(fs.existsSync(deadClaim), false);
    fs.unlinkSync(lockPath);

    const malformedClaim = `${lockPath}.reclaim.invalid`;
    fs.mkdirSync(malformedClaim, { mode: 0o700 });
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      /unsafe prepared lock claim/,
    );
    assert.equal(fs.existsSync(malformedClaim), true);
    assert.equal(fs.existsSync(lockPath), false);
    fs.rmdirSync(malformedClaim);

    const malformedExactClaim = `${lockPath}.reclaim.${process.pid}.78787878-7878-4878-8878-787878787878`;
    fs.writeFileSync(malformedExactClaim, '', { mode: 0o600 });
    assert.throws(
      () =>
        publishPreparedExclusiveLock(
          lockPath,
          marker,
          publisherToken,
          () => new Error('unsafe prepared lock claim'),
        ),
      /unsafe prepared lock claim/,
    );
    assert.equal(fs.existsSync(malformedExactClaim), true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publisher detects a reclaimer claim created between scan and link', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-race-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const deadOwnerToken = '12121212-1212-4212-8212-121212121212';
  const publisherToken = '34343434-3434-4434-8434-343434343434';
  const claimToken = '56565656-5656-4656-8656-565656565656';
  const marker = `${JSON.stringify({
    pid: deadPid,
    ownerToken: deadOwnerToken,
  })}\n`;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { publishPreparedExclusiveLock } =
            await import(${JSON.stringify(FILESYSTEM_SAFETY_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const originalLink = fs.linkSync.bind(fs);
          fs.linkSync = (source, target) => {
            fs.mkdirSync(
              \`\${target}.reclaim.\${process.pid}.${claimToken}\`,
              { mode: 0o700 },
            );
            fs.unlinkSync(target);
            return originalLink(source, target);
          };
          try {
            const descriptor = publishPreparedExclusiveLock(
              lockPath,
              ${JSON.stringify(marker)},
              ${JSON.stringify(publisherToken)},
            );
            fs.closeSync(descriptor);
            process.stdout.write('acquired');
          } catch (error) {
            process.stdout.write(
              error && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : String(error),
            );
          }
        `,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'EEXIST');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(
      fs.existsSync(
        preparedLockTemporaryPath(lockPath, child.pid!, publisherToken),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(`${lockPath}.reclaim.${child.pid}.${claimToken}`),
      true,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publisher cleanup claim fences a successor during error cleanup', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-cleanup-race-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const oldOwnerToken = '90909090-9090-4090-8090-909090909090';
  const publisherToken = '91919191-9191-4191-8191-919191919191';
  const successorToken = '92929292-9292-4292-8292-929292929292';
  const reclaimerToken = '93939393-9393-4393-8393-939393939393';
  const marker = `${JSON.stringify({
    pid: deadPid,
    ownerToken: oldOwnerToken,
  })}\n`;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { publishPreparedExclusiveLock } =
            await import(${JSON.stringify(FILESYSTEM_SAFETY_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const marker = ${JSON.stringify(marker)};
          const originalLink = fs.linkSync.bind(fs);
          const originalUnlink = fs.unlinkSync.bind(fs);
          let publication = 0;
          let reclaimerClaim;
          let cleanupIntercepted = false;
          let successor = 'not-run';
          fs.linkSync = (source, target) => {
            publication += 1;
            if (publication === 1) {
              reclaimerClaim =
                \`\${target}.reclaim.\${process.pid}.${reclaimerToken}\`;
              fs.mkdirSync(reclaimerClaim, { mode: 0o700 });
              originalUnlink(target);
            }
            return originalLink(source, target);
          };
          fs.unlinkSync = (target, ...args) => {
            if (target === lockPath && !cleanupIntercepted) {
              cleanupIntercepted = true;
              originalUnlink(target);
              fs.rmdirSync(reclaimerClaim);
              try {
                const descriptor = publishPreparedExclusiveLock(
                  lockPath,
                  marker,
                  ${JSON.stringify(successorToken)},
                );
                fs.closeSync(descriptor);
                successor = 'acquired';
              } catch (error) {
                successor =
                  error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : String(error);
              }
              return originalUnlink(target, ...args);
            }
            return originalUnlink(target, ...args);
          };
          let publisher;
          try {
            const descriptor = publishPreparedExclusiveLock(
              lockPath,
              marker,
              ${JSON.stringify(publisherToken)},
            );
            fs.closeSync(descriptor);
            publisher = 'acquired';
          } catch (error) {
            publisher =
              error && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : String(error);
          }
          process.stdout.write(JSON.stringify({ publisher, successor }));
        `,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), {
      publisher: 'EEXIST',
      successor: 'EEXIST',
    });
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepared lock reclaim is idempotent when a competing reaper wins', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-reaper-race-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const ownerToken = '94949494-9494-4494-8494-949494949494';
  const marker = `${JSON.stringify({ pid: deadPid, ownerToken })}\n`;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const { reclaimDeadPreparedLock } =
            await import(${JSON.stringify(FILESYSTEM_SAFETY_MODULE_URL)});
          const lockPath = ${JSON.stringify(lockPath)};
          const marker = ${JSON.stringify(marker)};
          const originalUnlink = fs.unlinkSync.bind(fs);
          let simulated = false;
          fs.unlinkSync = (target, ...args) => {
            if (target === lockPath && !simulated) {
              simulated = true;
              originalUnlink(target);
            }
            return originalUnlink(target, ...args);
          };
          const result = reclaimDeadPreparedLock(
            lockPath,
            (content) =>
              content === marker
                ? {
                    pid: ${deadPid},
                    ownerToken: ${JSON.stringify(ownerToken)},
                  }
                : null,
          );
          process.stdout.write(result);
        `,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, 'reclaimed');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepared lock reclaimer preserves forged hard-link pairs', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'prepared-lock-pair-'),
  );
  const lockPath = path.join(directory, 'operation.lock');
  const deadPid = 2_147_483_647;
  const ownerToken = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const marker = `${JSON.stringify({ pid: deadPid, ownerToken })}\n`;
  const exactTemporary = preparedLockTemporaryPath(
    lockPath,
    deadPid,
    ownerToken,
  );
  const readOwner = (content: string) =>
    content === marker ? { pid: deadPid, ownerToken } : null;
  try {
    fs.writeFileSync(lockPath, marker, { flag: 'wx', mode: 0o600 });
    const unexpectedAlias = path.join(directory, 'unexpected-alias');
    fs.linkSync(lockPath, unexpectedAlias);
    fs.writeFileSync(exactTemporary, marker, { flag: 'wx', mode: 0o600 });

    assert.equal(reclaimDeadPreparedLock(lockPath, readOwner), 'unsafe');
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(unexpectedAlias), true);
    assert.equal(fs.existsSync(exactTemporary), true);

    fs.unlinkSync(exactTemporary);
    fs.unlinkSync(unexpectedAlias);
    fs.linkSync(lockPath, exactTemporary);
    const thirdAlias = path.join(directory, 'third-alias');
    fs.linkSync(lockPath, thirdAlias);

    assert.equal(reclaimDeadPreparedLock(lockPath, readOwner), 'unsafe');
    assert.equal(fs.lstatSync(lockPath).nlink, 3);
    assert.equal(fs.existsSync(exactTemporary), true);
    assert.equal(fs.existsSync(thirdAlias), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
