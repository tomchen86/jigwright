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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  completeTask,
  finishSession,
} from './support/session-lifecycle-host.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import { checkSession } from './support/session-lifecycle-host.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

function prepareCurrentChange(
  repository: string,
  changeId = 'demo-change',
  options: { additionalPendingTask?: boolean } = {},
) {
  if (options.additionalPendingTask) {
    const changeRoot = path.join(repository, 'openspec/changes', changeId);
    fs.appendFileSync(
      path.join(changeRoot, 'tasks.md'),
      '\n- [ ] 1.2 Keep the fixture change open\n',
    );
    const guardPath = path.join(changeRoot, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<
        string,
        { allowedPaths: string[]; requiredChecks: string[] }
      >;
    };
    guard.tasks['1.2'] = structuredClone(guard.tasks['1.1']!);
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  }
  const ready = writeReadyV3ExemptChange(repository, changeId);
  commitPlanningTransition(repository, changeId);
  return ready;
}

test('start requires combined OpenSpec readiness before creating runtime state', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nINVALID committed planning state.\n',
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Forge invalid planning state']);

    assert.throws(
      () =>
        startSession(
          productionChangeContract,
          repository,
          'demo-change',
          '1.1',
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('start rejects repository mutation during its in-lock OpenSpec validation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    fs.writeFileSync(
      path.join(repository, '.git/mutate-on-lifecycle-start'),
      '1',
    );

    assert.throws(
      () =>
        startSession(
          productionChangeContract,
          repository,
          'demo-change',
          '1.1',
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_MUTATED_REPOSITORY'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks/demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects OpenSpec mutation of an already-dirty allowed path', () => {
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
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const intended = true;\n',
    );
    fs.writeFileSync(path.join(repository, '.git/mutate-on-next-status'), '1');

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_MUTATED_REPOSITORY'),
    );
    assert.equal(
      getSession(repository, session.sessionId).latestCheckReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects every combined-contract drift class before executing checks', () => {
  const cases: Array<{
    name: string;
    code: string;
    mutate(repository: string): void;
  }> = [
    {
      name: 'change content',
      code: 'OPENSPEC_CHANGE_NOT_READY',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/proposal.md'),
          '\nUncommitted planning drift.\n',
        );
      },
    },
    {
      name: 'change metadata',
      code: 'OPENSPEC_CHANGE_METADATA_INVALID',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
          'unexpected: value\n',
        );
      },
    },
    {
      name: 'schema configuration',
      code: 'ARTIFACTS_CHANGED',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/config.yaml'),
          '# drift\n',
        );
      },
    },
    {
      name: 'change artifact mode',
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
      mutate(repository) {
        fs.chmodSync(
          path.join(repository, 'openspec/changes/demo-change/proposal.md'),
          0o755,
        );
      },
    },
    {
      name: 'selected check definition',
      code: 'ARTIFACTS_CHANGED',
      mutate(repository) {
        const checksPath = path.join(repository, 'workflow/checks.json');
        const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
        checks.checks.marker.destructiveDatabase = true;
        fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
      },
    },
    {
      name: 'imported OpenSpec runtime',
      code: 'ARTIFACTS_CHANGED',
      mutate(repository) {
        fs.writeFileSync(
          path.join(
            repository,
            'node_modules/@fission-ai/openspec/bin/runtime-helper.js',
          ),
          'export const fixtureRuntime = false;\n',
        );
      },
    },
  ];

  for (const fixture of cases) {
    const repository = createFixtureRepository();
    const outputDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'managed-change-check-'),
    );
    const markerPath = path.join(outputDirectory, 'check-ran');
    try {
      configureChecks(
        repository,
        {
          marker: {
            command: ['node', 'scripts/write-file.mjs', markerPath],
            destructiveDatabase: false,
          },
        },
        ['marker'],
      );
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      const session = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      fixture.mutate(repository);

      assert.throws(
        () =>
          checkSession(
            maintainerManifestOperations,
            productionTaskStrategyExecutionGate,
            productionChangeContract,
            repository,
            session.sessionId,
          ),
        (error) => isWorkflowError(error, fixture.code),
        fixture.name,
      );
      assert.equal(fs.existsSync(markerPath), false, fixture.name);
      assert.equal(
        getSession(repository, session.sessionId).latestCheckReportId,
        undefined,
      );
      abortSession(repository, session.sessionId, `cleanup ${fixture.name}`);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  }
});

test('check rejects a forged legacy artifact map with imported runtime drift', () => {
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
    delete tampered.artifacts['openspec/changes/demo-change/.openspec.yaml'];
    delete tampered.artifacts[
      'node_modules/@fission-ai/openspec/bin/runtime-helper.js'
    ];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);
    fs.writeFileSync(
      path.join(
        repository,
        'node_modules/@fission-ai/openspec/bin/runtime-helper.js',
      ),
      'export const fixtureRuntime = false;\n',
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
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects the exact historical task 3.2 artifact map without upgrading private session state', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'managed-change-historical-session-'),
  );
  const markerPath = path.join(outputDirectory, 'check-ran');
  const changeId = 'integrate-openspec-with-workflow';
  try {
    configureChecks(
      repository,
      {
        marker: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
      },
      ['marker'],
    );
    renameFixtureChange(repository, changeId, '3.2');
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    prepareCurrentChange(repository, changeId);
    const session = startSession(
      productionChangeContract,
      repository,
      changeId,
      '3.2',
    );
    const privateRuntimeRoot = runtimeRoot(repository);
    const sessionPath = path.join(
      privateRuntimeRoot,
      'sessions',
      `${session.sessionId}.json`,
    );
    const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      artifacts: Record<string, string>;
    };
    const historicalArtifacts = loadChangeContract(
      repository,
      changeId,
    ).artifactDigests;
    const bootstrapModule =
      'packages/workflow-engine/src/adapters/planning/openspec/documents/managed-change-contract.ts';
    assert.equal(Object.hasOwn(historicalArtifacts, bootstrapModule), false);
    assert.notDeepEqual(historicalArtifacts, persisted.artifacts);
    persisted.artifacts = historicalArtifacts;
    const historicalSessionBytes = `${JSON.stringify(persisted, null, 2)}\n`;
    fs.writeFileSync(sessionPath, historicalSessionBytes);
    assert.deepEqual(
      getSession(repository, session.sessionId).artifacts,
      historicalArtifacts,
    );

    const privateStateBefore = snapshotPrivateFiles(privateRuntimeRoot);
    const refsBefore = git(repository, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)',
    ]);
    const worktreeBefore = git(repository, ['status', '--porcelain=v2', '-z']);
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

    assert.equal(fs.readFileSync(sessionPath, 'utf8'), historicalSessionBytes);
    assert.deepEqual(
      snapshotPrivateFiles(privateRuntimeRoot),
      privateStateBefore,
    );
    assert.equal(
      git(repository, ['for-each-ref', '--format=%(refname)%09%(objectname)']),
      refsBefore,
    );
    assert.equal(
      git(repository, ['status', '--porcelain=v2', '-z']),
      worktreeBefore,
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('an unmanaged schema cannot enter current lifecycle state', () => {
  const repository = createFixtureRepository();
  try {
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    fs.writeFileSync(
      path.join(changeDirectory, '.openspec.yaml'),
      'schema: unsupported-experiment\ncreated: 2026-07-15\n',
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Configure unsupported schema fixture']);
    git(repository, ['checkout', '-b', 'work/demo-change']);

    assert.throws(
      () =>
        startSession(
          productionChangeContract,
          repository,
          'demo-change',
          '1.1',
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, '.openspec.yaml'), 'utf8'),
      'schema: unsupported-experiment\ncreated: 2026-07-15\n',
    );
    for (const artifact of [
      'investigation.json',
      'execution.json',
      'plan-review.json',
    ]) {
      assert.equal(fs.existsSync(path.join(changeDirectory, artifact)), false);
    }
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('finish revalidates combined readiness before rerunning checks or staging', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'managed-change-finish-'),
  );
  const counterPath = path.join(outputDirectory, 'count');
  try {
    fs.writeFileSync(
      path.join(repository, 'scripts/increment.mjs'),
      [
        "import fs from 'node:fs';",
        'const target = process.argv[2];',
        "const count = fs.existsSync(target) ? Number(fs.readFileSync(target, 'utf8')) : 0;",
        'fs.writeFileSync(target, String(count + 1));',
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        counter: {
          command: ['node', 'scripts/increment.mjs', counterPath],
          destructiveDatabase: false,
        },
      },
      ['counter'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository, 'demo-change', {
      additionalPendingTask: true,
    });
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    completeTask(repository, session.sessionId);

    fs.appendFileSync(
      path.join(repository, 'openspec/config.yaml'),
      '# drift\n',
    );
    assert.throws(
      () => finishSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );

    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(
      getSession(repository, session.sessionId).finishReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('finish rolls back exact staging when readiness changes after staging', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository, 'demo-change', {
      additionalPendingTask: true,
    });
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
    );
    completeTask(repository, session.sessionId);
    fs.writeFileSync(
      path.join(repository, '.git/mutate-status-countdown'),
      '3',
    );

    assert.throws(
      () => finishSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_STATE_CHANGED'),
    );
    assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(
      getSession(repository, session.sessionId).finishReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function renameFixtureChange(
  repository: string,
  changeId: string,
  taskId: string,
): void {
  const oldChangeId = 'demo-change';
  const oldTaskId = '1.1';
  const oldDirectory = path.join(repository, 'openspec/changes', oldChangeId);
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  fs.renameSync(oldDirectory, changeDirectory);
  for (const relativePath of [
    '.openspec.yaml',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    'specs/demo/spec.md',
  ]) {
    const artifactPath = path.join(changeDirectory, relativePath);
    fs.writeFileSync(
      artifactPath,
      fs
        .readFileSync(artifactPath, 'utf8')
        .replaceAll(oldChangeId, changeId)
        .replaceAll(oldTaskId, taskId),
    );
  }
  const oldProviderBindingPath = path.join(
    repository,
    'workflow/change-providers',
    `${oldChangeId}.json`,
  );
  const providerBindingPath = path.join(
    repository,
    'workflow/change-providers',
    `${changeId}.json`,
  );
  fs.renameSync(oldProviderBindingPath, providerBindingPath);
  fs.writeFileSync(
    providerBindingPath,
    fs
      .readFileSync(providerBindingPath, 'utf8')
      .replaceAll(oldChangeId, changeId),
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Prepare historical managed change']);
}

function snapshotPrivateFiles(root: string): Record<string, string> {
  const files: Array<[string, string]> = [];
  walk(root, '');
  return Object.fromEntries(files);

  function walk(directory: string, prefix: string): void {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, relativePath);
      } else {
        files.push([
          relativePath.split(path.sep).join('/'),
          fs.readFileSync(entryPath).toString('base64'),
        ]);
      }
    }
  }
}
