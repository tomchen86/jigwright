import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import path from 'node:path';
import fs from 'node:fs';
import { sealTaskStrategyRed } from '../src/application/execute-task/task-strategy-execution.ts';
import {
  adoptCurrentTaskStrategyImplementation,
  adoptCurrentTaskStrategyCorrection,
} from '../src/application/execute-task/task-strategy-patch.ts';
import assert from 'node:assert/strict';
import { checkSession } from './support/local-engine-selection-host.ts';
import { inspectSession } from '../src/application/session-inspection/session-inspection.ts';
import {
  readCurrentTaskStrategyGreenFailure,
  resolveCurrentTaskStrategyCorrection,
} from '../src/application/execute-task/task-strategy-correction.ts';
import { runtimeRoot } from './fixture.ts';
import {
  createCrossAgentFixture,
  hasCode,
  runWorkflowCli,
  hasCodeAndRecovery,
  snapshotTree,
} from './support/task-strategy-execution-fixture.ts';

test('engine GREEN failure persists one bounded correction subject for the exact patch head', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
    { codex: true, claude: true },
    false,
    true,
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    const red = sealTaskStrategyRed(
      productionChangeContract,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const imported = adoptCurrentTaskStrategyImplementation(
      productionChangeContract,
      repository,
      session.sessionId,
    )!;

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCode('CHECK_FAILED'),
    );
    const failure = readCurrentTaskStrategyGreenFailure(
      inspectSession(productionChangeContract, repository, session.sessionId),
    );
    assert.equal(failure?.currentRedTransactionDigest, red.recordDigest);
    assert.equal(
      failure?.currentPatchHead.recordDigest,
      imported.record.recordDigest,
    );
    assert.equal(failure?.failingCheck.checkId, 'green-fail');
    const status = runWorkflowCli(repository, [
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    const output = JSON.parse(status.stdout) as {
      taskStrategy: { state: string; transactionDigest: string };
    };
    assert.equal(output.taskStrategy.state, 'correction-required');
    assert.equal(output.taskStrategy.transactionDigest, red.recordDigest);
    assert.equal(imported.binding.candidateTree, imported.record.candidateTree);
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCodeAndRecovery(
        'TASK_STRATEGY_CORRECTION_REQUIRED',
        `pnpm workflow resume ${session.sessionId} --json`,
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent correction resume adopts one append-only patch head and engine reruns GREEN', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
    { codex: true, claude: true },
    false,
    true,
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    sealTaskStrategyRed(
      productionChangeContract,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const initial = adoptCurrentTaskStrategyImplementation(
      productionChangeContract,
      repository,
      session.sessionId,
    )!;
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCode('CHECK_FAILED'),
    );

    fs.writeFileSync(implementationPath, 'export const corrected = true;\n');
    const resumed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      (JSON.parse(resumed.stdout) as { result: { state: string } }).result
        .state,
      'patch-imported',
    );
    const projection = resolveCurrentTaskStrategyCorrection(
      inspectSession(productionChangeContract, repository, session.sessionId),
    );
    assert.equal(projection.completedCorrectionRounds, 1);
    assert.equal(projection.failure, null);
    assert.equal(
      projection.head?.record.sourceTree,
      initial.record.candidateTree,
    );
    assert.equal(projection.head?.record.implementer.providerId, 'codex');
    assert.notEqual(
      projection.head?.record.recordDigest,
      initial.record.recordDigest,
    );
    assert.equal(
      checkSession(
        maintainerManifestOperations,
        productionTaskStrategyExecutionGate,
        productionChangeContract,
        repository,
        session.sessionId,
        { environment: {} },
      ).passed,
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent correction exhaustion cannot be bypassed by routine resume', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
    { codex: true, claude: true },
    false,
    true,
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    sealTaskStrategyRed(
      productionChangeContract,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const initial = true;\n');
    assert.ok(
      adoptCurrentTaskStrategyImplementation(
        productionChangeContract,
        repository,
        session.sessionId,
      ),
    );
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCode('CHECK_FAILED'),
    );

    for (const source of [
      'export const firstCorrection = true;\n',
      'export const secondCorrection = true;\n',
    ]) {
      fs.writeFileSync(implementationPath, source);
      assert.ok(
        adoptCurrentTaskStrategyCorrection(
          productionChangeContract,
          repository,
          session.sessionId,
        ),
      );
      assert.throws(
        () =>
          checkSession(
            maintainerManifestOperations,
            productionTaskStrategyExecutionGate,
            productionChangeContract,
            repository,
            session.sessionId,
            { environment: {} },
          ),
        hasCode('CHECK_FAILED'),
      );
    }

    const projection = resolveCurrentTaskStrategyCorrection(
      inspectSession(productionChangeContract, repository, session.sessionId),
    );
    assert.equal(projection.completedCorrectionRounds, 2);
    assert.equal(projection.exhausted, true);
    assert.notEqual(projection.failure, null);
    const durableRuntimeFiles = () =>
      snapshotTree(runtimeRoot(repository))
        .filter(({ kind }) => kind === 'file')
        .map(({ path: entryPath, content }) => ({
          path: entryPath,
          content,
        }));
    const beforeRuntime = durableRuntimeFiles();
    const beforeBytes = fs.readFileSync(implementationPath, 'utf8');
    const resumed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      (JSON.parse(resumed.stdout) as { result: { state: string } }).result
        .state,
      'correction-exhausted',
    );
    assert.deepEqual(durableRuntimeFiles(), beforeRuntime);
    assert.equal(fs.readFileSync(implementationPath, 'utf8'), beforeBytes);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
