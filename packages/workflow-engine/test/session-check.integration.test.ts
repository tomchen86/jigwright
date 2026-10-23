import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { reviewedGeneratedAssets } from '../src/composition-root/planning-provider-authoring-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  configureChecks,
  runtimeRoot,
  addFixtureScripts,
} from './fixture.ts';
import { runRegisteredCheck } from '../src/composition-root/check-execution-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSession } from '../src/application/execute-task/session.ts';
import { checkSession } from './support/session-lifecycle-host.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import os from 'node:os';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  prepareCurrentChange,
  enableDisposableDatabasePolicy,
} from './support/session-lifecycle-fixture.ts';

test('workflow validation and session authority ignore retained Spectra metadata', () => {
  const observations: unknown[] = [];
  for (const retained of [false, true]) {
    const repository = createFixtureRepository();
    try {
      if (retained) {
        fs.writeFileSync(
          path.join(repository, '.spectra.yaml'),
          'not: [valid yaml\ncommand: spectra deny-everything\n',
        );
        git(repository, ['add', '.spectra.yaml']);
        git(repository, [
          'commit',
          '-m',
          'Retain unused historical installation metadata',
        ]);
      }
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      const contract = loadChangeContract(repository, 'demo-change');
      const session = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      const checked = checkSession(
        maintainerManifestOperations,
        productionTaskStrategyExecutionGate,
        productionChangeContract,
        repository,
        session.sessionId,
      );
      fs.writeFileSync(path.join(repository, 'outside.txt'), 'out of scope\n');
      assert.throws(
        () =>
          checkSession(
            maintainerManifestOperations,
            productionTaskStrategyExecutionGate,
            productionChangeContract,
            repository,
            session.sessionId,
          ),
        (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
      );
      observations.push({
        change: contract.changeId,
        tasks: contract.tasks,
        state: session.state,
        passed: checked.passed,
        changedPaths: checked.changedPaths,
      });
      abortSession(repository, session.sessionId, 'Fixture complete');
      if (retained)
        assert.match(
          fs.readFileSync(path.join(repository, '.spectra.yaml'), 'utf8'),
          /deny-everything/u,
        );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observations[0], observations[1]);
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

test('check rejects workflow artifacts changed after session start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    fs.appendFileSync(guardPath, '\n');

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    tampered.allowedPaths = ['outside.txt'];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    const result = checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
    );
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          {
            environment: { ...process.env },
          },
        ),
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    const result = checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
      {
        environment: {
          ...process.env,
          WORKFLOW_DISPOSABLE_DATABASE: '1',
          TEST_DATABASE_URL:
            'postgres://runner:marker-secret@127.0.0.1:5433/expense_test?ssl=false',
          DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/expense_dev',
        },
      },
    );

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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
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
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          {
            environment: {
              ...process.env,
              WORKFLOW_TEST_SECRET: 'marker-secret',
            },
          },
        ),
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
      () =>
        startSession(
          productionChangeContract,
          repository,
          'demo-change',
          '1.1',
        ),
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
      const session = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );

      const result = checkSession(
        maintainerManifestOperations,
        productionTaskStrategyExecutionGate,
        productionChangeContract,
        repository,
        session.sessionId,
        {
          environment: { ...process.env, PATH: fakeBin },
        },
      );

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
      () =>
        startSession(
          productionChangeContract,
          repository,
          'demo-change',
          '1.1',
        ),
      (error) => isWorkflowError(error, 'INVALID_CHECK_DEFINITION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

import {
  createSessionCheckService,
  type SessionInspection,
} from '../src/application/finalize/verification.ts';
import type { CheckExecutionPort } from '../src/modules/assurance/check-execution-port.ts';
import { pinCheckRunner } from '../src/adapters/consumer/repository/work-registry/check-runner.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  sha256,
  parseObservedCheckFailure,
  type CheckEvidence,
  type ObservedCheckFailure,
} from '../src/foundation/check-evidence/check-evidence.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';

function fakeSessionExecutionFixture() {
  const repository = fs.realpathSync(createFixtureRepository());
  try {
    enableDisposableDatabasePolicy(repository);
    configureChecks(
      repository,
      Object.fromEntries(
        ['first', 'second', 'third'].map((checkId) => [
          checkId,
          {
            command: ['node', 'scripts/pass.mjs'],
            destructiveDatabase: checkId === 'second',
          },
        ]),
      ),
      ['first', 'second', 'third'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const events: string[] = [];
    const state = {
      preparationFailure: '' as '' | 'database' | 'pin',
      transportFailure: undefined as Error | undefined,
      recordFailure: undefined as Error | undefined,
      mutate() {},
      passed: [] as CheckEvidence[],
      failure: undefined as ObservedCheckFailure | undefined,
      admitted: undefined as SessionInspection | undefined,
      lastObservedGit: undefined as SessionInspection['git'] | undefined,
    };
    const sentinel = new Error('preparation failed');
    const execution: CheckExecutionPort = {
      preflightDatabase() {
        events.push('database');
        if (state.preparationFailure === 'database') throw sentinel;
        return 'postgresql://fixture:5432/workflow_test';
      },
      pin({ checkId, definition }, databaseIdentity) {
        events.push(`pin:${checkId}`);
        if (state.preparationFailure === 'pin' && checkId === 'second')
          throw sentinel;
        assert.equal(
          databaseIdentity,
          definition.destructiveDatabase
            ? 'postgresql://fixture:5432/workflow_test'
            : undefined,
        );
        const runner = pinCheckRunner(repository, checkId, definition);
        return {
          runner,
          execute() {
            events.push(`run:${checkId}`);
            if (checkId === 'second') {
              state.mutate();
              if (state.transportFailure) throw state.transportFailure;
              const body = {
                checkId,
                outcome: 'failed' as const,
                exitCode: 7,
                runner: runner.runner,
                runnerDigest: runner.digest,
                stdoutDigest: sha256(''),
                stderrDigest: sha256('ordinary failure'),
                stdoutExcerpt: '',
                stderrExcerpt: 'ordinary failure',
                stdoutTruncated: false,
                stderrTruncated: false,
              };
              state.failure = parseObservedCheckFailure({
                ...body,
                failureFingerprint: sha256(canonicalJson(body)),
              });
              return state.failure;
            }
            const evidence: CheckEvidence = {
              checkId,
              outcome: 'passed',
              exitCode: 0,
              runner: runner.runner,
              runnerDigest: runner.digest,
              destructiveDatabase: definition.destructiveDatabase,
            };
            state.passed.push(evidence);
            return evidence;
          },
        };
      },
    };
    const service = createSessionCheckService({
      reviewedAssets: reviewedGeneratedAssets,
      manifestOperations: maintainerManifestOperations,
      changeContract: {
        ...productionChangeContract,
        loadStableValidatedChangeContract(...args) {
          const result =
            productionChangeContract.loadStableValidatedChangeContract(...args);
          events.push('inspect');
          state.lastObservedGit = result.git;
          return result;
        },
      },
      taskStrategyExecutionGate: {
        assertExecutionAdmitted(inspection, environment) {
          state.admitted = inspection;
          productionTaskStrategyExecutionGate.assertExecutionAdmitted(
            inspection,
            environment,
          );
        },
        recordGreenFailure(inspection, passed, failure) {
          events.push('record');
          assert.notEqual(inspection, state.admitted);
          assert.equal(inspection.git, state.lastObservedGit);
          assert.deepEqual(passed, state.passed);
          assert.equal(passed[0], state.passed[0]);
          assert.equal(failure, state.failure);
          if (state.recordFailure) throw state.recordFailure;
          return null;
        },
      },
      createExecution(root) {
        assert.equal(root, repository);
        events.push('factory');
        return execution;
      },
    });
    assert.equal(events.length, 0, 'service construction must be inert');
    const reports = () => {
      const directory = path.join(
        runtimeRoot(repository),
        'reports',
        session.sessionId,
      );
      return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
    };
    const beforeReports = reports();
    return {
      repository,
      session,
      events,
      state,
      sentinel,
      run: () =>
        service.checkSession(repository, session.sessionId, {
          environment: {},
        }),
      assertUnpublished() {
        assert.deepEqual(reports(), beforeReports);
        assert.equal(
          getSession(repository, session.sessionId).latestCheckReportId,
          undefined,
        );
      },
      cleanup() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

for (const recorderThrows of [false, true]) {
  test(`session ordinary failure reobserves and records its passed prefix before ${recorderThrows ? 'propagating recorder failure' : 'CHECK_FAILED'}`, () => {
    const f = fakeSessionExecutionFixture();
    try {
      const recordFailure = new Error('ledger unavailable');
      if (recorderThrows) f.state.recordFailure = recordFailure;
      assert.throws(f.run, (error) => {
        if (recorderThrows) return error === recordFailure;
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, 'CHECK_FAILED');
        assert.equal(error.exitCode, 13);
        assert.equal(error.message, 'Required check second exited non-zero.');
        assert.deepEqual(error.details, {
          checkId: 'second',
          exitCode: 7,
          signal: null,
        });
        return true;
      });
      assert.deepEqual(f.events.slice(f.events.indexOf('factory')), [
        'factory',
        'database',
        'pin:first',
        'pin:second',
        'pin:third',
        'run:first',
        'inspect',
        'run:second',
        'inspect',
        'record',
      ]);
      assert.deepEqual(
        f.state.passed.map(({ checkId }) => checkId),
        ['first'],
      );
      f.assertUnpublished();
    } finally {
      f.cleanup();
    }
  });
}

for (const mutation of ['working-bytes', 'scope', 'lock', 'session'] as const) {
  test(`session rejects ${mutation} drift from a failed executor before recording or executing later checks`, () => {
    const f = fakeSessionExecutionFixture();
    try {
      f.state.mutate = () => {
        if (mutation === 'lock')
          fs.unlinkSync(
            path.join(runtimeRoot(f.repository), 'locks', 'demo-change.lock'),
          );
        else if (mutation === 'session') {
          const sessionPath = path.join(
            runtimeRoot(f.repository),
            'sessions',
            `${f.session.sessionId}.json`,
          );
          const current = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
          current.createdAt = new Date(
            Date.parse(current.createdAt) + 1000,
          ).toISOString();
          fs.writeFileSync(sessionPath, JSON.stringify(current));
        } else
          fs.writeFileSync(
            path.join(
              f.repository,
              mutation === 'scope' ? 'outside.txt' : 'src/feature.ts',
            ),
            'changed by check\n',
          );
      };
      const code =
        mutation === 'lock'
          ? 'SESSION_LOCK_INVALID'
          : mutation === 'scope'
            ? 'OUT_OF_SCOPE_PATHS'
            : mutation === 'session'
              ? 'SESSION_CHANGED_DURING_CHECK'
              : 'CHECK_MUTATED_WORKTREE';
      assert.throws(f.run, (error) => isWorkflowError(error, code));
      assert.deepEqual(
        f.events.slice(f.events.indexOf('run:second')),
        mutation === 'session' ? ['run:second'] : ['run:second', 'inspect'],
      );
      f.assertUnpublished();
    } finally {
      f.cleanup();
    }
  });
}

test('session transport exception bypasses post-execution inspection and failure recording', () => {
  const f = fakeSessionExecutionFixture();
  try {
    const failure = new Error('transport unavailable');
    f.state.transportFailure = failure;
    assert.throws(f.run, (error) => error === failure);
    assert.deepEqual(f.events.slice(f.events.indexOf('run:second')), [
      'run:second',
    ]);
    f.assertUnpublished();
  } finally {
    f.cleanup();
  }
});

for (const failure of ['database', 'pin'] as const) {
  test(`session ${failure} preparation failure prevents every execution`, () => {
    const f = fakeSessionExecutionFixture();
    try {
      f.state.preparationFailure = failure;
      assert.throws(f.run, (error) => error === f.sentinel);
      assert.deepEqual(
        f.events.slice(f.events.indexOf('factory')),
        failure === 'database'
          ? ['factory', 'database']
          : ['factory', 'database', 'pin:first', 'pin:second'],
      );
      f.assertUnpublished();
    } finally {
      f.cleanup();
    }
  });
}
