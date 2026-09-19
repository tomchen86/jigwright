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
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/application/execute-task/task-strategy-execution.ts';
import { readTaskStrategyPatchCurrentBinding } from '../src/runtime/storage-journal/task-strategy-patch-store.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { adoptCurrentTaskStrategyImplementation } from '../src/application/execute-task/task-strategy-patch.ts';
import {
  createFixtureRepository,
  git,
  writeReadyV3ExemptChange,
  runtimeRoot,
} from './fixture.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import {
  createCrossAgentFixture,
  runWorkflowCli,
  snapshotPersistentTree,
} from './support/task-strategy-execution-fixture.ts';

test('routine resume adopts exact single-agent implementation bytes without provider ceremony', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
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
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );

    const sealed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(sealed.status, 0, sealed.stderr);
    const sealedOutput = JSON.parse(sealed.stdout) as {
      result: { state: string; invocationId: null };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(sealedOutput.result.state, 'implementation-required');
    assert.equal(sealedOutput.result.invocationId, null);
    assert.equal(
      sealedOutput.nextSteps[0]?.command,
      `pnpm workflow resume ${session.sessionId} --json`,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    const implementationBytes = 'export const feature = true;\n';
    fs.writeFileSync(implementationPath, implementationBytes);
    const beforeResume = fs.readFileSync(implementationPath);

    const adopted = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(adopted.status, 0, adopted.stderr);
    const adoptedOutput = JSON.parse(adopted.stdout) as {
      result: { state: string; invocationId: null };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(adoptedOutput.result.state, 'patch-imported');
    assert.equal(adoptedOutput.result.invocationId, null);
    assert.deepEqual(fs.readFileSync(implementationPath), beforeResume);
    assert.equal(
      adoptedOutput.nextSteps[0]?.command,
      `pnpm workflow check ${session.sessionId} --json`,
    );

    const replay = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(adopted.stdout));
    assert.deepEqual(fs.readFileSync(implementationPath), beforeResume);

    const checked = runWorkflowCli(
      repository,
      ['check', session.sessionId, '--json'],
      { AGENT: 'claude' },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(
      (JSON.parse(checked.stdout) as { result: { passed: boolean } }).result
        .passed,
      true,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent resume refuses frozen RED drift before minting a patch receipt', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    const originalTest =
      "throw new Error('feature behavior is not implemented');\n";
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, originalTest);
    const sealed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(sealed.status, 0, sealed.stderr);
    const transaction = inspectTaskStrategyTransaction(
      repository,
      session.sessionId,
    )!;

    fs.writeFileSync(testPath, "throw new Error('weakened');\n");
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    const refused = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'claude', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /TASK_STRATEGY_PATCH_FROZEN_PATH/);
    assert.equal(
      readTaskStrategyPatchCurrentBinding(
        loadInvestigationRuntimeContext(repository).runtime,
        session.sessionId,
        transaction.red.candidateTree,
      ),
      null,
    );
    assert.equal(
      fs.readFileSync(testPath, 'utf8'),
      "throw new Error('weakened');\n",
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent local adoption replays every durable publication cut without rewriting bytes', () => {
  for (const phase of [
    'reservation-persisted',
    'record-persisted',
    'receipt-persisted',
  ] as const) {
    const { repository } = createCrossAgentFixture(
      'assertion',
      'tdd-single-agent',
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
      fs.writeFileSync(
        testPath,
        "throw new Error('feature behavior is not implemented');\n",
      );
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
      const implementationBytes = Buffer.from('export const feature = true;\n');
      fs.writeFileSync(implementationPath, implementationBytes);

      assert.throws(
        () =>
          adoptCurrentTaskStrategyImplementation(
            productionChangeContract,
            repository,
            session.sessionId,
            { testCrashAfter: phase },
          ),
        new RegExp(phase),
      );
      assert.deepEqual(
        fs.readFileSync(implementationPath),
        implementationBytes,
      );

      const replayed = adoptCurrentTaskStrategyImplementation(
        productionChangeContract,
        repository,
        session.sessionId,
      );
      assert.ok(replayed);
      assert.deepEqual(
        fs.readFileSync(implementationPath),
        implementationBytes,
      );
      assert.equal(
        readTaskStrategyPatchCurrentBinding(
          loadInvestigationRuntimeContext(repository).runtime,
          session.sessionId,
          replayed.record.sourceTree,
        )?.candidateTree,
        replayed.record.candidateTree,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('single-agent reservation replay never resurrects implementation bytes reverted by the caller', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
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
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
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
    assert.throws(
      () =>
        adoptCurrentTaskStrategyImplementation(
          productionChangeContract,
          repository,
          session.sessionId,
          {
            testCrashAfter: 'record-persisted',
          },
        ),
      /record-persisted/,
    );
    fs.rmSync(implementationPath);

    assert.equal(
      adoptCurrentTaskStrategyImplementation(
        productionChangeContract,
        repository,
        session.sessionId,
      ),
      null,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      readTaskStrategyPatchCurrentBinding(
        loadInvestigationRuntimeContext(repository).runtime,
        session.sessionId,
        red.red.candidateTree,
      ),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routine strategy resume leaves ordinary tasks outside Mode A ceremony', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository, 'demo-change');
    commitPlanningTransition(repository, 'demo-change');
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const before = snapshotPersistentTree(runtimeRoot(repository));

    const resumed = runWorkflowCli(repository, [
      'resume',
      session.sessionId,
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const output = JSON.parse(resumed.stdout) as {
      result: { state: string; transactionDigest: null };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(output.result.state, 'not-required');
    assert.equal(output.result.transactionDigest, null);
    assert.equal(
      output.nextSteps[0]?.command,
      `pnpm workflow check ${session.sessionId} --json`,
    );
    assert.deepEqual(snapshotPersistentTree(runtimeRoot(repository)), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
