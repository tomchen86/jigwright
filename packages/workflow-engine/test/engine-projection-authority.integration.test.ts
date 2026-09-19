import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { reviewedGeneratedAssets } from '../src/composition-root/planning-provider-authoring-production.ts';
import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import {
  productionChangeRoutingInspector,
  productionChangeContract,
} from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
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
import path from 'node:path';
import test from 'node:test';

import {
  classifyProjectionPaths,
  engineProjectionDefinitions,
  engineProjectionPathsForTransition,
} from '../src/modules/projection/engine-projection-registry.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import { renderHandoff as renderHandoffWithContractReader } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  completeTask,
  finalizeTask,
} from './support/local-engine-selection-host.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import {
  readImmutableReport,
  type WorkflowReport,
} from '../src/runtime/storage-journal/report-store.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import {
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';

test('the reviewed engine projection registry is fixed and transition-scoped', () => {
  assert.deepEqual(engineProjectionDefinitions(), [
    {
      path: 'workflow/semantic-ledger/index.json',
      transitions: ['plan', 'completion'],
    },
    {
      path: 'docs/CURRENT_AND_NEXT_STEPS.md',
      transitions: ['archive', 'completion', 'plan', 'rollback-completion'],
    },
  ]);
  assert.deepEqual(engineProjectionPathsForTransition('completion'), [
    'workflow/semantic-ledger/index.json',
    'docs/CURRENT_AND_NEXT_STEPS.md',
  ]);
  assert.throws(
    () =>
      classifyProjectionPaths(
        ['docs/CURRENT_AND_NEXT_STEPS.md'],
        ['docs/CURRENT_AND_NEXT_STEPS.md'],
        ['docs/CURRENT_AND_NEXT_STEPS.md'],
      ),
    (error) => isWorkflowError(error, 'PROJECTION_PATH_CLASSIFICATION_INVALID'),
  );
});

test('document policy cannot invent an engine-owned completion projection', () => {
  const repository = createFixtureRepository();
  try {
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    policy.documents['docs/UNREVIEWED.md'] = {
      mode: 'generated',
      enforcement: 'active',
      transition: 'completion',
    };
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'docs/UNREVIEWED.md'), 'before\n');
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    git(repository, [
      'add',
      'workflow/document-policy.json',
      'docs/UNREVIEWED.md',
    ]);
    git(repository, ['commit', '-m', 'Add unreviewed projection policy']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
        ),
      (error) => isWorkflowError(error, 'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY'),
    );
    assert.equal(
      fs.readFileSync(path.join(repository, 'docs/UNREVIEWED.md'), 'utf8'),
      'before\n',
    );
    assert.equal(
      getSession(repository, session.sessionId).completionReportId,
      undefined,
    );
    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task guards cannot claim engine-owned projection paths before or after completion', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    const guardPath = path.join(changeDirectory, 'guard.json');
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    guard.tasks['1.1'].allowedPaths = ['docs/**', 'src/**'];
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);

    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE'),
    );

    const tasksPath = path.join(changeDirectory, 'tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace(/- \[ \]/g, '- [x]'),
    );
    assert.throws(
      () => writeReadyV3ExemptChange(repository),
      (error) => isWorkflowError(error, 'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE'),
    );
    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the public handoff command is read-only and refuses render', () => {
  const repository = createFixtureRepository();
  try {
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, 'caller-owned sentinel\n');
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(
          import.meta.dirname,
          '../bootstrap/workflow-engine-host.ts',
        ),
        'handoff',
        'render',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /INVALID_USAGE/u);
    assert.equal(
      fs.readFileSync(handoffPath, 'utf8'),
      'caller-owned sentinel\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion and finish evidence classify the exact projection union', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    enableCompletionProjection(repository);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, session.sessionId);
    const result = finalizeTask(repository, session.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const completion = readImmutableReport(
      reportsRoot,
      session.sessionId,
      result.completionReportId,
    );
    const finish = readImmutableReport(
      reportsRoot,
      session.sessionId,
      result.finishReportId,
    );
    assertReportCategories(completion);
    assertReportCategories(finish);
    assert.deepEqual(finish.stagedPaths, EXPECTED_CATEGORIES.changedPaths);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the compatible completion sequence cannot bypass documentation review', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    enableCompletionProjection(repository);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
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
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    const tasksBefore = fs.readFileSync(tasksPath, 'utf8');
    const handoffBefore = fs.readFileSync(handoffPath, 'utf8');
    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_NOT_READY'),
    );
    assert.equal(
      getSession(repository, session.sessionId).completionReportId,
      undefined,
    );
    assert.equal(fs.readFileSync(tasksPath, 'utf8'), tasksBefore);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), handoffBefore);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

const EXPECTED_CATEGORIES = {
  taskPaths: ['src/feature.ts'],
  taskProjectionPaths: ['openspec/changes/demo-change/tasks.md'],
  engineProjectionPaths: ['docs/CURRENT_AND_NEXT_STEPS.md'],
  changedPaths: [
    'docs/CURRENT_AND_NEXT_STEPS.md',
    'openspec/changes/demo-change/tasks.md',
    'src/feature.ts',
  ],
};

function enableCompletionProjection(repository: string): void {
  const policyPath = path.join(repository, 'workflow/document-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  renderHandoff(repository);
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  git(repository, [
    'add',
    'workflow/document-policy.json',
    'workflow/maintainer-policy.json',
    'docs',
  ]);
  git(repository, ['commit', '-m', 'Enable completion projection']);
}

function assertReportCategories(report: WorkflowReport): void {
  assert.deepEqual(
    {
      taskPaths: report.taskPaths,
      taskProjectionPaths: report.taskProjectionPaths,
      engineProjectionPaths: report.engineProjectionPaths,
      changedPaths: report.changedPaths,
    },
    EXPECTED_CATEGORIES,
  );
}

function prepareCurrentV3Change(repository: string): void {
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}
