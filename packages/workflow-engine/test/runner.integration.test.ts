import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { reviewedGeneratedAssets } from '../src/composition-root/planning-provider-authoring-production.ts';
import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
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

import { resolveCheckRunner } from '../src/adapters/consumer/repository/work-registry/runner-resolution.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import { checkSession } from './support/session-lifecycle-host.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import './runner-closure.integration.test.ts';
import './runner-package-security.integration.test.ts';
import {
  addFixturePackage,
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

function prepareCurrentChange(repository: string): void {
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}

test('registered full-gate style runner preserves strip-types and streams startup hints', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(
      path.join(repository, 'scripts/live-hint.ts'),
      "process.stderr.write('LIVE FULL GATE HINT\\n');\n",
    );
    configureChecks(
      repository,
      {
        live: {
          command: [
            'node',
            '--experimental-strip-types',
            'scripts/live-hint.ts',
          ],
          destructiveDatabase: false,
          liveStderr: true,
        },
      },
      ['live'],
    );
    prepareCurrentChange(repository);
    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'run-check',
        'live',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /LIVE FULL GATE HINT/);
    assert.equal(JSON.parse(run.stdout).result.check.outcome, 'passed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('change validation rejects eval, preload, external, and ambiguous runners', () => {
  const invalidCommands = [
    ['node', '-e', 'process.exit(0)'],
    ['node', '--eval', 'process.exit(0)'],
    ['node', '--require', '/tmp/inject.cjs'],
    ['node', '--test', '--import=./scripts/preload.mjs', 'scripts/pass.mjs'],
    [
      'node',
      '--experimental-strip-types',
      '--test-concurrency=4',
      '--test',
      'scripts/pass.mjs',
    ],
    [
      'node',
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=3',
      'scripts/pass.mjs',
    ],
    [
      'node',
      '--experimental-strip-types',
      '--test',
      '--test-concurrency',
      '4',
      'scripts/pass.mjs',
    ],
    [
      'node',
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=4',
      '--test-concurrency=4',
      'scripts/pass.mjs',
    ],
    [
      'node',
      '--experimental-strip-types',
      '--test',
      'scripts/pass.mjs',
      '--test-concurrency=4',
    ],
    [
      'node',
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=4',
      '--test-reporter=spec',
      'scripts/pass.mjs',
    ],
    ['node', '/tmp/check.mjs'],
    ['node', '../check.mjs'],
    ['node-package-bin', 'src/**', 'fixture-tool', 'fixture-tool'],
    ['node-package-bin', '.', '..', 'fixture-tool'],
    ['node-package-bin', '.', 'fixture-tool', '.'],
  ];

  for (const command of invalidCommands) {
    const repository = createFixtureRepository();
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      configureChecks(
        repository,
        { unsafe: { command, destructiveDatabase: false } },
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
        command.join(' '),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('registered node test concurrency is exact, retained, and digests every entrypoint', () => {
  const repository = createFixtureRepository();
  const entrypoints = ['scripts/pass.mjs', 'scripts/fail.mjs'];
  const absoluteEntrypoints = entrypoints.map((entrypoint) =>
    fs.realpathSync(path.join(repository, entrypoint)),
  );
  const definition = {
    command: [
      'node',
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=4',
      ...entrypoints,
    ],
    destructiveDatabase: false,
  };

  try {
    const before = resolveCheckRunner(repository, 'concurrent', definition);

    assert.deepEqual(before.args, [
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=4',
      ...absoluteEntrypoints,
    ]);

    const withoutStripTypes = resolveCheckRunner(repository, 'concurrent', {
      ...definition,
      command: ['node', '--test', '--test-concurrency=4', ...entrypoints],
    });
    assert.deepEqual(withoutStripTypes.args, [
      '--test',
      '--test-concurrency=4',
      ...absoluteEntrypoints,
    ]);

    fs.appendFileSync(absoluteEntrypoints[1], '// changed\n');
    const after = resolveCheckRunner(repository, 'concurrent', definition);
    assert.notEqual(after.digest, before.digest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('caller NODE_OPTIONS cannot turn a failing check into passing evidence', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-node-options-'),
  );
  const injectedMarker = path.join(outputDirectory, 'injected');
  const preloadPath = path.join(outputDirectory, 'preload.cjs');

  try {
    fs.writeFileSync(
      preloadPath,
      `require('node:fs').writeFileSync(${JSON.stringify(injectedMarker)}, 'ran'); process.exit(0);\n`,
    );
    configureChecks(
      repository,
      {
        failing: {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        },
      },
      ['failing'],
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
              NODE_OPTIONS: `--require=${preloadPath}`,
            },
          },
        ),
      (error) => isWorkflowError(error, 'CHECK_FAILED'),
    );
    assert.equal(fs.existsSync(injectedMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('node runner detects an entrypoint changed during execution', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/mutate-self.mjs'],
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
      (error) => isWorkflowError(error, 'CHECK_RUNNER_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner executes the declared string bin and records its digest', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-package-bin-'),
  );
  const outputPath = path.join(outputDirectory, 'ran');

  try {
    addFixturePackage(
      repository,
      `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'ran');\n`,
    );
    configureChecks(
      repository,
      {
        package: {
          command: [
            'node-package-bin',
            '.',
            'fixture-tool',
            'fixture-tool',
            outputPath,
          ],
          destructiveDatabase: false,
        },
      },
      ['package'],
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

    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'ran');
    assert.equal(
      result.checks[0].runner,
      'node-package-bin:.:fixture-tool/fixture-tool',
    );
    assert.match(result.checks[0].runnerDigest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result).includes(outputPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('package runner rejects the wrong name for a string bin', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(repository);
    configureChecks(
      repository,
      {
        package: {
          command: ['node-package-bin', '.', 'fixture-tool', 'other'],
          destructiveDatabase: false,
        },
      },
      ['package'],
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
      (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package runner detects a bin changed during execution', () => {
  const repository = createFixtureRepository();
  try {
    addFixturePackage(
      repository,
      `import fs from 'node:fs';\nfs.appendFileSync(import.meta.filename, '\\n');\n`,
    );
    configureChecks(
      repository,
      {
        package: {
          command: ['node-package-bin', '.', 'fixture-tool', 'fixture-tool'],
          destructiveDatabase: false,
        },
      },
      ['package'],
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
      (error) => isWorkflowError(error, 'CHECK_RUNNER_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('scope verification checks both endpoints of a tracked rename', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(repository, 'outside.txt'), 'outside\n');
    git(repository, ['add', 'outside.txt']);
    git(repository, ['commit', '-m', 'Add outside fixture']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );

    git(repository, ['mv', 'outside.txt', 'src/inside.txt']);

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
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('all package runners are pinned before the first required check starts', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-runner-preflight-'),
  );
  const markerPath = path.join(outputDirectory, 'first-check-ran');
  try {
    addFixturePackage(repository);
    configureChecks(
      repository,
      {
        first: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
        package: {
          command: ['node-package-bin', '.', 'fixture-tool', 'missing-bin'],
          destructiveDatabase: false,
        },
      },
      ['first', 'package'],
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
      (error) => isWorkflowError(error, 'CHECK_RUNNER_UNAVAILABLE'),
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('package runner digest pins imported runtime dependency files', () => {
  const repository = createFixtureRepository();
  const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
  const importedPath = path.join(packageDirectory, 'lib/main.mjs');
  try {
    addFixturePackage(repository, `import '../lib/main.mjs';\n`);
    fs.mkdirSync(path.dirname(importedPath), { recursive: true });
    fs.writeFileSync(importedPath, 'process.exit(7);\n');
    const definition = {
      command: ['node-package-bin', '.', 'fixture-tool', 'fixture-tool'],
      destructiveDatabase: false,
    };
    const before = resolveCheckRunner(repository, 'package', definition).digest;
    fs.writeFileSync(importedPath, 'process.exit(0);\n');
    const after = resolveCheckRunner(repository, 'package', definition).digest;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('passing checks cannot mutate allowed working-tree state', () => {
  const repository = createFixtureRepository();
  const changedPath = path.join(repository, 'src/changed.ts');
  const laterMarker = path.join(repository, 'later-ran');
  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', changedPath],
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
      (error) => isWorkflowError(error, 'CHECK_MUTATED_WORKTREE'),
    );
    assert.equal(fs.existsSync(changedPath), true);
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

import { createCheckExecution } from '../src/adapters/consumer/repository/work-registry/check-runner.ts';
import type { CheckEvidenceMetadata } from '../src/foundation/check-evidence/check-evidence.ts';
import { enableDisposableDatabasePolicy } from './support/session-lifecycle-fixture.ts';

test('ordinary execution construction and identity pinning do not inspect database policy or environment', () => {
  const forbiddenRead = new Error('environment read too early');
  const environment = new Proxy(
    {},
    {
      get() {
        throw forbiddenRead;
      },
    },
  );
  assert.doesNotThrow(() =>
    createCheckExecution('/nonexistent/check-execution-fixture', environment),
  );
  const repository = createFixtureRepository();
  try {
    const execution = createCheckExecution(repository, environment);
    const pinned = execution.pin({
      checkId: 'destructive',
      definition: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: true,
      },
    });
    assert.match(pinned.runner.digest, /^[0-9a-f]{64}$/u);
    assert.throws(
      () => pinned.execute(),
      (error) =>
        isWorkflowError(error, 'DESTRUCTIVE_DATABASE_POLICY_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('each pinned execution builds its database environment at execution time', () => {
  const repository = createFixtureRepository();
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'check-execution-environment-'),
  );
  const marker = path.join(output, 'executed');
  try {
    enableDisposableDatabasePolicy(repository);
    fs.writeFileSync(
      path.join(repository, 'scripts/check-environment.mjs'),
      [
        "import fs from 'node:fs';",
        "if (process.env.WORKFLOW_CHECK_EXECUTION !== '1' || process.env.WORKFLOW_DISPOSABLE_DATABASE !== '1') process.exit(9);",
        "fs.appendFileSync(process.argv[2], new URL(process.env.TEST_DATABASE_URL).pathname + '\\n');",
      ].join('\n'),
    );
    const definition = {
      command: ['node', 'scripts/check-environment.mjs', marker],
      destructiveDatabase: true,
    };
    configureChecks(repository, { fixture: definition }, ['fixture']);
    const environment: NodeJS.ProcessEnv = {};
    const execution = createCheckExecution(repository, environment);
    const pinned = execution.pin({ checkId: 'fixture', definition });
    assert.equal(fs.existsSync(marker), false);
    assert.throws(
      () => pinned.execute(),
      (error) =>
        isWorkflowError(error, 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED'),
    );
    environment.WORKFLOW_DISPOSABLE_DATABASE = '1';
    environment.TEST_DATABASE_URL = 'postgresql://fixture@localhost/first_test';
    const identity = execution.preflightDatabase();
    const withIdentity = execution.pin(
      { checkId: 'fixture', definition },
      identity,
    );
    const first = withIdentity.execute();
    assert.equal(first.outcome, 'passed');
    if (first.outcome === 'passed')
      assert.equal(first.databaseIdentity, identity);
    environment.TEST_DATABASE_URL =
      'postgresql://fixture@localhost/second_test';
    assert.equal(withIdentity.execute().outcome, 'passed');
    assert.equal(
      fs.readFileSync(marker, 'utf8'),
      '/first_test\n/second_test\n',
    );
    delete environment.WORKFLOW_DISPOSABLE_DATABASE;
    assert.throws(
      () => withIdentity.execute(),
      (error) =>
        isWorkflowError(error, 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED'),
    );
    assert.equal(
      fs.readFileSync(marker, 'utf8'),
      '/first_test\n/second_test\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('ordinary metadata is evaluated only after successful execution and unchanged runner identity', () => {
  const repository = createFixtureRepository();
  try {
    const scripts = {
      passed: 'process.exit(0);\n',
      failed: 'process.exit(7);\n',
      signaled: "process.kill(process.pid, 'SIGTERM');\n",
      'changed-before': 'process.exit(0);\n',
      'changed-after':
        "import fs from 'node:fs';\nfs.appendFileSync(new URL(import.meta.url), '// changed\\n');\n",
    };
    for (const [name, source] of Object.entries(scripts))
      fs.writeFileSync(path.join(repository, `scripts/${name}.mjs`), source);
    const definitions = Object.fromEntries(
      Object.keys(scripts).map((checkId) => [
        checkId,
        {
          command: ['node', `scripts/${checkId}.mjs`],
          destructiveDatabase: false,
        },
      ]),
    );
    configureChecks(repository, definitions, ['passed']);
    const execution = createCheckExecution(repository, {});
    const pinned = Object.fromEntries(
      Object.entries(definitions).map(([checkId, definition]) => [
        checkId,
        execution.pin({ checkId, definition }),
      ]),
    );
    let clockCalls = 0;
    const completedAt = new Date('2026-09-22T01:02:03.000Z');
    const metadata: CheckEvidenceMetadata = {
      completedAt() {
        clockCalls += 1;
        return completedAt;
      },
      externalSnapshotDigest: 'a'.repeat(64),
      maxAgeMs: 1234,
    };
    assert.equal(clockCalls, 0);
    const passed = pinned.passed!.execute(metadata);
    assert.equal(passed.outcome, 'passed');
    if (passed.outcome === 'passed')
      assert.deepEqual(
        {
          completedAt: passed.completedAt,
          externalSnapshotDigest: passed.externalSnapshotDigest,
          maxAgeMs: passed.maxAgeMs,
        },
        {
          completedAt: completedAt.toISOString(),
          externalSnapshotDigest: metadata.externalSnapshotDigest,
          maxAgeMs: metadata.maxAgeMs,
        },
      );
    assert.equal(clockCalls, 1);
    const failed = pinned.failed!.execute({
      ...metadata,
      externalSnapshotDigest: 'invalid',
      maxAgeMs: -1,
    });
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.exitCode, 7);
    assert.equal(clockCalls, 1, 'ordinary failure ignores completion metadata');
    assert.throws(
      () => pinned.signaled!.execute(metadata),
      (error) => isWorkflowError(error, 'CHECK_TERMINATED'),
    );
    assert.equal(clockCalls, 1);
    fs.appendFileSync(
      path.join(repository, 'scripts/changed-before.mjs'),
      '// changed before execution\n',
    );
    for (const checkId of ['changed-before', 'changed-after']) {
      assert.throws(
        () => pinned[checkId]!.execute(metadata),
        (error) => isWorkflowError(error, 'CHECK_RUNNER_CHANGED'),
      );
      assert.equal(clockCalls, 1, checkId);
    }
    for (const invalid of [
      { externalSnapshotDigest: 'invalid', maxAgeMs: 1234 },
      { externalSnapshotDigest: 'a'.repeat(64), maxAgeMs: 0 },
      { externalSnapshotDigest: 'a'.repeat(64), maxAgeMs: undefined },
    ]) {
      assert.throws(
        () => pinned.passed!.execute({ ...metadata, ...invalid }),
        (error) => isWorkflowError(error, 'CHECK_EVIDENCE_METADATA_INVALID'),
      );
    }
    assert.equal(clockCalls, 4);
    assert.throws(
      () => pinned.passed!.execute({ completedAt: () => new Date(NaN) }),
      (error) => isWorkflowError(error, 'CHECK_EVIDENCE_METADATA_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
