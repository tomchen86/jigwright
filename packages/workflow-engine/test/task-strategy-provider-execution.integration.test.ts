import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  sealTaskStrategyRed,
  inspectTaskStrategyTransaction,
} from '../src/composition-root/task-strategy-execution-production.ts';
import {
  beginTaskStrategyImplementation,
  inspectTaskStrategyImplementation,
} from '../src/composition-root/task-strategy-production.ts';
import assert from 'node:assert/strict';
import {
  runtimeRoot,
  builtInProviderExecutableIdentityForTest,
  builtInProviderDefinitionSnapshotForTest,
} from './fixture.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { createHash } from 'node:crypto';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
  claimProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  completeProviderInvocationFromRunner,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { readProviderRepairEvidence } from '../src/runtime/storage-journal/provider-execution-governance.ts';
import { executionJobStatePath } from '../src/runtime/storage-journal/execution-store.ts';
import { dispatchPreparedTaskStrategyProvider } from '../bootstrap/workflow-engine-host.ts';
import { beginTaskStrategyRedRevision } from '../src/composition-root/task-strategy-red-revision-production.ts';
import {
  createCrossAgentFixture,
  snapshotPersistentTree,
  diffAgainstTree,
  sha256Buffer,
  hasCode,
  completeTaskImplementationProvider,
  taskImplementationOutput,
  snapshotTree,
  runWorkflowCli,
} from './support/task-strategy-execution-fixture.ts';

test('cross-agent RED schedules one session-independent implementation reservation before launch', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });

    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    assert.equal(waiting.assignment.role, 'task-implementer');
    assert.equal(waiting.assignment.providerId, 'codex');
    assert.equal(
      waiting.assignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(
      waiting.assignment.achievedIndependence,
      'session-independent',
    );
    assert.equal(waiting.subject.transactionDigest, red.recordDigest);
    assert.equal(waiting.subject.sourceTree, red.red.candidateTree);
    assert.deepEqual(
      beginTaskStrategyImplementation(repository, session.sessionId),
      waiting,
    );
    const beforeInspection = snapshotPersistentTree(runtimeRoot(repository));
    assert.deepEqual(
      inspectTaskStrategyImplementation(repository, session.sessionId),
      waiting,
    );
    assert.deepEqual(
      snapshotPersistentTree(runtimeRoot(repository)),
      beforeInspection,
    );

    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const output = {
      schemaVersion: 1 as const,
      kind: 'task-strategy-patch-output.v1' as const,
      sessionId: session.sessionId,
      sourceTree: red.red.candidateTree,
      patchBase64: patch.toString('base64'),
      patchDigest: sha256Buffer(patch),
    };
    const completed = runProviderWorker(repository, waiting.invocationId, {
      runner(input) {
        assert.equal(
          sha256Buffer(Buffer.from(canonicalJson(input.semanticOutputSchema))),
          TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.digest,
        );
        assert.equal(input.request.writeAllowedPaths.length, 0);
        return {
          invocationId: waiting.invocationId,
          providerId: input.providerId,
          purpose: 'task-implementation',
          requestDigest: input.request.requestDigest,
          semanticOutput: output,
          semanticOutputDigest: sha256Buffer(
            Buffer.from(canonicalJson(output)),
          ),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '9'.repeat(64),
            afterDigest: '9'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: builtInProviderExecutableIdentityForTest(
            input.providerId,
          ),
          elapsedMs: 8,
          providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
            input.providerId,
          ),
        };
      },
    });
    assert.equal(completed.state, 'succeeded');
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'provider-succeeded-awaiting-import',
    );
    assert.equal(fs.existsSync(implementationPath), false);

    const imported = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(imported.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    const afterImport = snapshotPersistentTree(runtimeRoot(repository));
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'patch-imported',
    );
    assert.deepEqual(
      snapshotPersistentTree(runtimeRoot(repository)),
      afterImport,
    );

    const resultPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-implementations',
      session.sessionId,
      'subjects',
      waiting.subject.subjectDigest,
      'result.json',
    );
    const resultBinding = JSON.parse(
      fs.readFileSync(resultPath, 'utf8'),
    ) as Record<string, unknown> & {
      roleResult: Record<string, unknown>;
    };
    resultBinding.roleResult.form = 'granted-same-provider';
    const { resultDigest: _oldResultDigest, ...roleResultBody } =
      resultBinding.roleResult;
    resultBinding.roleResult.resultDigest = createHash('sha256')
      .update(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...roleResultBody,
        }),
      )
      .digest('hex');
    const { bindingDigest: _oldBindingDigest, ...bindingBody } = resultBinding;
    resultBinding.bindingDigest = createHash('sha256')
      .update(canonicalJson(bindingBody))
      .digest('hex');
    fs.writeFileSync(resultPath, `${canonicalJson(resultBinding)}\n`);
    assert.throws(
      () => inspectTaskStrategyImplementation(repository, session.sessionId),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker binds task implementation output to the exact sealed subject before durable success', () => {
  const cases = [
    {
      name: 'session',
      mutate(sessionId: string, sourceTree: string) {
        return { sessionId: `${sessionId}-other`, sourceTree };
      },
    },
    {
      name: 'source tree',
      mutate(sessionId: string) {
        return { sessionId, sourceTree: 'f'.repeat(40) };
      },
    },
  ] as const;

  for (const testCase of cases) {
    const { repository } = createCrossAgentFixture('assertion');
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
      const red = sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });
      const waiting = beginTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.equal(waiting.state, 'waiting-for-provider');
      if (waiting.state !== 'waiting-for-provider') continue;

      const wrongSubject = testCase.mutate(
        session.sessionId,
        red.red.candidateTree,
      );
      const completed = completeTaskImplementationProvider(
        repository,
        waiting.invocationId,
        'claude',
        taskImplementationOutput(
          wrongSubject.sessionId,
          wrongSubject.sourceTree,
          Buffer.from(`synthetic ${testCase.name} patch`),
        ),
      );

      assert.equal(completed.state, 'failed', testCase.name);
      assert.equal(
        completed.failure?.code,
        'PROVIDER_NATIVE_OUTPUT_INVALID',
        testCase.name,
      );
      const runtime = loadInvestigationRuntimeContext(repository).runtime;
      const invocation = readProviderInvocation(runtime, waiting.invocationId);
      assert.equal(invocation.state, 'failed', testCase.name);
      assert.equal(invocation.result, null, testCase.name);
      const repair = readProviderRepairEvidence(
        runtime,
        invocation,
        readProviderInvocationRequest(runtime, waiting.invocationId),
      );
      assert.equal(repair.repairContext.repairKind, 'semantic', testCase.name);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('provider completion rejects a digest-consistent wrong task subject before durable mutation', () => {
  const { repository } = createCrossAgentFixture('assertion');
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
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;

    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const request = readProviderInvocationRequest(
      runtime,
      waiting.invocationId,
    );
    const claim = claimProviderInvocation(runtime, waiting.invocationId, {
      workerId: 'task-subject-binding-regression-worker',
      leaseDurationMs: request.limits.timeoutMs,
    });
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      runtime,
      waiting.invocationId,
      'schema-v4',
    );
    const output = taskImplementationOutput(
      session.sessionId,
      'f'.repeat(40),
      Buffer.from('synthetic wrong-subject patch'),
    );
    const invocationDirectory = path.join(
      runtime.invocations,
      waiting.invocationId,
    );
    const manifestPath = path.join(invocationDirectory, 'manifest.json');
    const executionPath = executionJobStatePath(
      runtime,
      acceptanceBinding.executionJobId,
    );
    const taskRefsRoot = path.join(
      runtime.refs,
      'task-strategy-implementations',
    );
    const invocationBefore = snapshotTree(invocationDirectory);
    const manifestBefore = fs.readFileSync(manifestPath);
    const executionBefore = fs.readFileSync(executionPath);
    const taskRefsBefore = snapshotTree(taskRefsRoot);

    assert.throws(
      () =>
        completeProviderInvocationFromRunner(runtime, waiting.invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          acceptanceBinding,
          report: {
            invocationId: waiting.invocationId,
            providerId: request.providerId,
            purpose: 'task-implementation',
            requestDigest: request.requestDigest,
            semanticOutput: output,
            semanticOutputDigest: sha256Buffer(
              Buffer.from(canonicalJson(output)),
            ),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: '7'.repeat(64),
              afterDigest: '7'.repeat(64),
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: builtInProviderExecutableIdentityForTest(
              request.providerId,
            ),
            elapsedMs: 8,
            providerDefinitionSnapshot:
              builtInProviderDefinitionSnapshotForTest(request.providerId),
          },
        }),
      hasCode('PROVIDER_INVOCATION_INVALID'),
    );
    assert.deepEqual(snapshotTree(invocationDirectory), invocationBefore);
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(executionPath), executionBefore);
    assert.deepEqual(snapshotTree(taskRefsRoot), taskRefsBefore);
    assert.equal(
      readProviderInvocation(runtime, waiting.invocationId).state,
      'leased',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('routine status and resume drive one durable cross-agent TDD transaction to engine GREEN', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
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

    const beforeStatus = snapshotPersistentTree(runtimeRoot(repository));
    const authored = runWorkflowCli(
      repository,
      ['status', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(authored.status, 0, authored.stderr);
    const authoredOutput = JSON.parse(authored.stdout) as {
      taskStrategy: { state: string; strategy: string };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(authoredOutput.taskStrategy.state, 'red-authoring');
    assert.equal(authoredOutput.taskStrategy.strategy, 'cross-agent-tdd');
    assert.equal(
      authoredOutput.nextSteps[0]?.command,
      `pnpm workflow resume ${session.sessionId} --json`,
    );
    assert.deepEqual(
      snapshotPersistentTree(runtimeRoot(repository)),
      beforeStatus,
    );

    const first = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(first.status, 0, first.stderr);
    const firstOutput = JSON.parse(first.stdout) as {
      result: {
        state: 'waiting-for-provider';
        invocationId: string;
        transactionDigest: string;
      };
    };
    assert.equal(firstOutput.result.state, 'waiting-for-provider');
    assert.match(firstOutput.result.transactionDigest, /^[0-9a-f]{64}$/);
    const firstInspection = inspectTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(firstInspection.state, 'waiting-for-provider');
    if (firstInspection.state !== 'waiting-for-provider') return;
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    let dispatchedInvocationId: string | null = null;
    const dispatched = dispatchPreparedTaskStrategyProvider(
      repository,
      firstOutput.result,
      (_cwd, invocationId) => {
        dispatchedInvocationId = invocationId;
        return {
          schemaVersion: 1,
          kind: 'provider-worker-dispatch',
          invocationId,
          pid: 12345,
        };
      },
    );
    assert.equal(dispatched?.invocationId, firstOutput.result.invocationId);
    assert.equal(dispatchedInvocationId, firstOutput.result.invocationId);

    const replay = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(replay.status, 0, replay.stderr);
    const replayOutput = JSON.parse(replay.stdout) as {
      result: {
        state: string;
        invocationId: string;
        transactionDigest: string;
      };
    };
    assert.deepEqual(replayOutput.result, firstOutput.result);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const beforeWaitingStatus = snapshotPersistentTree(runtimeRoot(repository));
    const waitingStatus = runWorkflowCli(
      repository,
      ['status', session.sessionId, '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(waitingStatus.status, 0, waitingStatus.stderr);
    const waitingOutput = JSON.parse(waitingStatus.stdout) as {
      taskStrategy: { state: string; invocationId: string };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(waitingOutput.taskStrategy.state, 'waiting-for-provider');
    assert.equal(
      waitingOutput.taskStrategy.invocationId,
      firstOutput.result.invocationId,
    );
    assert.equal(
      waitingOutput.nextSteps[0]?.command,
      `pnpm workflow status ${session.sessionId} --json`,
    );
    assert.deepEqual(
      snapshotPersistentTree(runtimeRoot(repository)),
      beforeWaitingStatus,
    );

    const red = inspectTaskStrategyTransaction(repository, session.sessionId)!;
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    completeTaskImplementationProvider(
      repository,
      firstOutput.result.invocationId,
      firstInspection.assignment.providerId,
      taskImplementationOutput(session.sessionId, red.red.candidateTree, patch),
    );
    assert.equal(
      dispatchPreparedTaskStrategyProvider(
        repository,
        firstOutput.result,
        () => {
          throw new Error('terminal provider work must not be redispatched');
        },
      ),
      null,
    );

    const imported = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(imported.status, 0, imported.stderr);
    const importedOutput = JSON.parse(imported.stdout) as {
      result: { state: string; invocationId: string };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(importedOutput.result.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    assert.equal(
      importedOutput.nextSteps[0]?.command,
      `pnpm workflow check ${session.sessionId} --json`,
    );

    const checked = runWorkflowCli(
      repository,
      ['check', session.sessionId, '--json'],
      { AGENT: 'codex' },
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

test('routine strategy resume schedules a fresh same-provider implementation session', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const resumed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const output = JSON.parse(resumed.stdout) as {
      result: {
        state: string;
        invocationId: string;
        assignment: {
          providerId: string;
          requiredIndependence: string;
          achievedIndependence: string;
        };
      };
      nextSteps: Array<{ command: string }>;
    };
    assert.equal(output.result.state, 'waiting-for-provider');
    assert.match(
      output.result.invocationId,
      /^invocation-task-implementation-/,
    );
    const inspection = inspectTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(inspection.state, 'waiting-for-provider');
    if (inspection.state !== 'waiting-for-provider') return;
    assert.equal(inspection.assignment.providerId, 'codex');
    assert.equal(
      inspection.assignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(
      inspection.assignment.achievedIndependence,
      'session-independent',
    );
    assert.deepEqual(
      output.nextSteps.map(({ command }) => command),
      [
        `pnpm workflow status ${session.sessionId} --json`,
        `pnpm workflow resume ${session.sessionId} --json`,
      ],
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(inspection.invocationId, output.result.invocationId);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('cross-agent implementation uses the sole provider in a fresh session', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: true, claude: false },
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });

    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    assert.equal(
      waiting.assignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(
      waiting.assignment.achievedIndependence,
      'session-independent',
    );
    assert.equal(waiting.assignment.providerId, 'codex');
    assert.equal('grantId' in waiting.assignment, false);
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(repository),
          'investigations/refs/task-strategy-implementations',
          session.sessionId,
          'subjects',
          waiting.subject.subjectDigest,
          'reservation.json',
        ),
      ),
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker rejects a task implementation whose sealed RED owner has drifted', () => {
  const { repository } = createCrossAgentFixture('assertion');
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
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;

    fs.writeFileSync(
      testPath,
      "throw new Error('changed after reservation');\n",
    );
    assert.throws(
      () =>
        runProviderWorker(repository, waiting.invocationId, {
          runner() {
            assert.fail('stale task implementation must not launch');
          },
        }),
      hasCode('TASK_STRATEGY_RED_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker cannot terminally succeed after its task implementation owner changes during the runner', () => {
  const { repository } = createCrossAgentFixture('assertion');
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
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    const patch = Buffer.from('synthetic implementation patch');
    const output = taskImplementationOutput(
      session.sessionId,
      red.red.candidateTree,
      patch,
    );

    const completed = runProviderWorker(repository, waiting.invocationId, {
      runner(input) {
        const opened = beginTaskStrategyRedRevision(repository, {
          schemaVersion: 1,
          kind: 'task-strategy-red-revision-request',
          sessionId: session.sessionId,
          expectedTransactionDigest: red.recordDigest,
          reason: 'The sealed RED changed while implementation was running.',
        });
        assert.equal(opened.phase, 'session-evidence-cleared');
        return {
          invocationId: waiting.invocationId,
          providerId: 'claude',
          purpose: 'task-implementation',
          requestDigest: input.request.requestDigest,
          semanticOutput: output,
          semanticOutputDigest: sha256Buffer(
            Buffer.from(canonicalJson(output)),
          ),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '6'.repeat(64),
            afterDigest: '6'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: builtInProviderExecutableIdentityForTest(
            input.providerId,
          ),
          elapsedMs: 8,
          providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
            input.providerId,
          ),
        };
      },
    });

    assert.equal(completed.state, 'failed');
    assert.ok(completed.failure);
    const durable = readProviderInvocation(
      loadInvestigationRuntimeContext(repository).runtime,
      waiting.invocationId,
    );
    assert.equal(durable.state, 'failed');
    assert.equal(durable.result, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task implementation reservation rejects independently redigested replay metadata', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const waiting = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    if (waiting.state !== 'waiting-for-provider') return;
    const reservationPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-implementations',
      session.sessionId,
      'subjects',
      waiting.subject.subjectDigest,
      'reservation.json',
    );
    const reservation = JSON.parse(
      fs.readFileSync(reservationPath, 'utf8'),
    ) as Record<string, unknown>;
    reservation.createdAt = new Date(
      Date.parse(String(reservation.createdAt)) + 1_000,
    ).toISOString();
    const { recordDigest: _oldDigest, ...body } = reservation;
    reservation.recordDigest = createHash('sha256')
      .update(canonicalJson(body))
      .digest('hex');
    fs.writeFileSync(reservationPath, `${canonicalJson(reservation)}\n`);

    assert.throws(
      () => inspectTaskStrategyImplementation(repository, session.sessionId),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
