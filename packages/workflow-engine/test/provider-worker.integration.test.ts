import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runCli, createAsyncCliDispatcherForTesting } from '../src/cli.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { createFixtureRepository, git } from './fixture.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import {
  runProviderWorker,
  runProviderWorkerAsync,
  createProviderWorkerDispatcherForTesting,
} from '../src/entrypoints/worker/provider-worker.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderInvocationManifest,
  claimProviderInvocationForWorker,
  prepareProviderInvocationAcceptanceBinding,
  completeProviderInvocationFromRunner,
  releaseProviderInvocationWorkerFence,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { type ProviderRunnerReport } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  providerPromptContextStoreRoot,
  ensureProviderPromptContext,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  buildContextManifest,
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
} from '../src/modules/authority/execution-governance.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import {
  readExecutionJobState,
  executionJobStatePath,
} from '../src/runtime/storage-journal/execution-store.ts';
import {
  intent,
  successfulWorkerReport,
} from './support/provider-worker-fixture.ts';

test('public AgentRuntime identity is core-owned and the engine compatibility port is worker-scoped', () => {
  const workerPortSource = fs.readFileSync(
    new URL(
      '../src/modules/provider-orchestration/agent-runtime-port.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const corePortSource = fs.readFileSync(
    new URL('../../core/src/agent-runtime-port.ts', import.meta.url),
    'utf8',
  );

  assert.match(corePortSource, /export interface AgentRuntimePortV1/u);
  assert.match(workerPortSource, /export interface ProviderWorkerRuntimePort/u);
  assert.doesNotMatch(workerPortSource, /export interface AgentRuntimePort\b/u);
});

test('synchronous CLI refuses the hidden provider worker before repository access', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-worker-sync-cli-'),
  );
  const originalStderrWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(
      runCli(['provider-worker', 'invocation-sync-cli', '--json'], directory),
      ExitCode.usage,
    );
    const failure = JSON.parse(stderr) as {
      ok: false;
      error: { code: string; message: string };
    };
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'INVALID_USAGE');
    assert.equal(
      failure.error.message,
      'Unknown workflow command: provider-worker',
    );

    const cliSource = fs.readFileSync(
      new URL('../src/cli.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(cliSource, /\brunProviderWorker\b/u);
  } finally {
    process.stderr.write = originalStderrWrite;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('hidden provider-worker CLI command dispatches the async worker entry', async () => {
  const calls: Array<{ cwd: string; invocationId: string }> = [];
  const dispatch = createAsyncCliDispatcherForTesting(
    async (cwd, invocationId) => {
      calls.push({ cwd, invocationId });
      return {
        schemaVersion: 1,
        kind: 'provider-worker-result',
        invocationId,
        state: 'leased',
        revision: 3,
        launched: false,
        failure: null,
        completionReceipt: null,
      };
    },
  );

  const result = await dispatch(
    ['provider-worker', 'invocation-async-cli'],
    '/repository',
  );
  assert.deepEqual(calls, [
    { cwd: '/repository', invocationId: 'invocation-async-cli' },
  ]);
  assert.equal(result.command, 'provider-worker');
  assert.equal(
    (result.result as { invocationId: string }).invocationId,
    'invocation-async-cli',
  );
});

test('provider worker records launch and admission failure durably', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-failure';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    let launches = 0;
    const failed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        throw workflowError(
          'PROVIDER_UNAVAILABLE',
          'The selected provider is unavailable.',
          ExitCode.verification,
        );
      },
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_UNAVAILABLE');
    assert.match(
      failed.failure!.message,
      /The selected provider is unavailable\./,
    );

    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    assert.equal(
      readProviderInvocation(runtime, invocationId).runtimeReceipt,
      undefined,
      'the optional projection must not rewrite synchronous legacy records',
    );

    const replayed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        throw new Error('failed invocations must not relaunch');
      },
    });
    assert.equal(replayed.state, 'failed');
    assert.equal(replayed.launched, false);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker keeps an unexpected throw reason on the durable failure', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-unexpected-failure';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const failed = runProviderWorker(repository, invocationId, {
      runner() {
        throw new TypeError('adapter policy digest is not a function');
      },
    });

    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_WORKER_UNEXPECTED_FAILURE');
    assert.match(
      failed.failure!.message,
      /TypeError: adapter policy digest is not a function/,
      'an unexpected throw is the only account of why the attempt failed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker refuses a current report that omits provider definition evidence', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-definition-evidence-required';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    let launches = 0;

    const failed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        const report = successfulWorkerReport(request, invocationId);
        const { providerDefinitionSnapshot: _omitted, ...withoutDefinition } =
          report;
        return withoutDefinition as unknown as ProviderRunnerReport;
      },
    });

    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_INVOCATION_RESULT_INVALID');
    const replayed = runProviderWorker(repository, invocationId, {
      runner() {
        launches += 1;
        assert.fail('invalid current reports must not relaunch');
      },
    });
    assert.equal(replayed.launched, false);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async provider worker records a rejected launch and partial progress receipt', async () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-async-failure';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const failed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime: {
        runSingleShot() {
          assert.fail('async worker must not call the sync runtime');
        },
        async runSingleShotAsync(_input, options) {
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          throw workflowError(
            'PROVIDER_UNAVAILABLE',
            'The selected provider is unavailable.',
            ExitCode.verification,
          );
        },
      },
    });

    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(failed.completionReceipt?.terminalState, 'failed');
    assert.deepEqual(failed.completionReceipt?.progress, {
      schemaVersion: 1,
      kind: 'agent-runtime-process-progress',
      processState: 'running',
      eventCount: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      lastProcessActivityElapsedMs: 0,
      lastProviderActivityElapsedMs: null,
    });
    const durable = readProviderInvocation(runtime, invocationId);
    assert.deepEqual(failed.completionReceipt, durable.runtimeReceipt);
    assert.equal(durable.runtimeReceipt?.terminalState, 'failed');
    const replayed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime: {
        runSingleShot() {
          assert.fail('terminal replay must not call the sync runtime');
        },
        async runSingleShotAsync() {
          assert.fail('terminal replay must not relaunch async work');
        },
      },
    });
    assert.equal(replayed.launched, false);
    assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker rejects output when current context rolls during execution', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-context-rollover';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const owner = readProviderInvocation(runtime, invocationId).investigationId;
    const manifest = readProviderInvocationManifest(runtime, invocationId);

    const result = runProviderWorker(repository, invocationId, {
      workerId: 'worker-context-rollover',
      runner() {
        const storeRoot = providerPromptContextStoreRoot(
          path.join(runtime.invocations, invocationId),
        );
        const binding = ensureProviderPromptContext(
          storeRoot,
          request,
          manifest,
          owner,
        );
        const nextContent = canonicalJson({
          kind: 'rolled-provider-context',
          owner,
        });
        const next = buildContextManifest({
          workflowId: binding.workflowId,
          epoch: binding.epoch + 1,
          contractVersion: binding.manifest.contractVersion,
          baselineDigest: binding.manifest.baselineDigest,
          intentDigest: binding.manifest.intentDigest,
          termSetDigest: binding.manifest.termSetDigest,
          planningSnapshotDigest: binding.manifest.planningSnapshotDigest,
          items: [
            { identity: 'provider-input-manifest', content: nextContent },
          ],
        });
        const current = inspectDurableEpochContextStore(
          storeRoot,
          binding.workflowId,
        );
        rolloverDurableEpochContextStore(storeRoot, {
          workflowId: binding.workflowId,
          expectedGeneration: binding.generation,
          expectedEpoch: binding.epoch,
          expectedContextDigest: binding.contextDigest,
          nextManifest: next,
          items: [
            { identity: 'provider-input-manifest', content: nextContent },
          ],
          reason: 'Exercise provider completion freshness.',
          restartFrom: request.purpose,
          carriedForward: [],
          carryForwardManifest: {
            sourceWorkflow: binding.workflowId,
            sourceEpoch: binding.epoch,
            carriedForward: [],
            excluded: [
              {
                identity: 'provider-input-manifest',
                reason: 'The provider input changed while the worker ran.',
              },
            ],
          },
          invalidated: ['provider-input-manifest'],
          verification: null,
          createdAt: new Date(Date.parse(current.updatedAt) + 1),
        });
        return successfulWorkerReport(request, invocationId);
      },
    });

    assert.equal(result.state, 'failed');
    assert.equal(result.failure?.kind, 'repository-reconciliation-required');
    assert.equal(result.failure?.code, 'PROVIDER_CONTEXT_STALE_OR_WRONG');
    assert.equal(readProviderInvocation(runtime, invocationId).result, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider worker rejects execution Job authority drift after launch', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-execution-authority-drift';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);

    const result = runProviderWorker(repository, invocationId, {
      workerId: 'worker-execution-authority-drift',
      runner() {
        const record = readProviderInvocation(runtime, invocationId);
        const projection = projectProviderInvocationExecution({
          record,
          request,
        });
        const execution = readExecutionJobState(runtime, projection.job.jobId);
        assert.ok(execution);
        fs.writeFileSync(
          executionJobStatePath(runtime, projection.job.jobId),
          `${canonicalJson({ ...execution, revision: execution.revision + 1 })}\n`,
          { mode: 0o600 },
        );
        return successfulWorkerReport(request, invocationId);
      },
    });

    assert.equal(result.state, 'failed');
    assert.equal(result.failure?.kind, 'repository-reconciliation-required');
    assert.equal(result.failure?.code, 'PROVIDER_ACCEPTANCE_BINDING_STALE');
    assert.equal(readProviderInvocation(runtime, invocationId).result, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion guard rejects rollover after runner return and before acceptance', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-completion-context-race';
  let fence: { invocationId: string; token: string } | null = null;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const claim = claimProviderInvocationForWorker(runtime, invocationId, {
      workerId: 'worker-completion-context-race',
      leaseDurationMs: request.limits.timeoutMs,
    });
    fence = { invocationId, token: claim.workerFenceToken };
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      runtime,
      invocationId,
      'synchronous-no-activity',
    );
    const nextContent = canonicalJson({
      kind: 'rolled-between-runner-and-completion',
      invocationId,
    });
    const next = buildContextManifest({
      workflowId: acceptanceBinding.context.workflowId,
      epoch: acceptanceBinding.context.epoch + 1,
      contractVersion: acceptanceBinding.context.manifest.contractVersion,
      baselineDigest: acceptanceBinding.context.manifest.baselineDigest,
      intentDigest: acceptanceBinding.context.manifest.intentDigest,
      termSetDigest: acceptanceBinding.context.manifest.termSetDigest,
      planningSnapshotDigest:
        acceptanceBinding.context.manifest.planningSnapshotDigest,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
    });
    const current = inspectDurableEpochContextStore(
      runtime.root,
      acceptanceBinding.context.workflowId,
    );
    rolloverDurableEpochContextStore(runtime.root, {
      workflowId: acceptanceBinding.context.workflowId,
      expectedGeneration: acceptanceBinding.context.generation,
      expectedEpoch: acceptanceBinding.context.epoch,
      expectedContextDigest: acceptanceBinding.context.contextDigest,
      nextManifest: next,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
      reason: 'Exercise completion-time freshness.',
      restartFrom: request.purpose,
      carriedForward: [],
      carryForwardManifest: {
        sourceWorkflow: acceptanceBinding.context.workflowId,
        sourceEpoch: acceptanceBinding.context.epoch,
        carriedForward: [],
        excluded: [
          {
            identity: 'provider-input-manifest',
            reason: 'The provider input changed before completion acceptance.',
          },
        ],
      },
      invalidated: ['provider-input-manifest'],
      verification: null,
      createdAt: new Date(Date.parse(current.updatedAt) + 1),
    });

    assert.throws(
      () =>
        completeProviderInvocationFromRunner(runtime, invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          report: successfulWorkerReport(request, invocationId),
          acceptanceBinding,
        }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_CONTEXT_STALE_OR_WRONG',
    );
    assert.equal(readProviderInvocation(runtime, invocationId).state, 'leased');
    const projection = projectProviderInvocationExecution({
      record: claim.record,
      request,
    });
    assert.equal(
      readExecutionJobState(runtime, projection.job.jobId)?.job
        .acceptedAttemptId,
      null,
    );
  } finally {
    if (fence !== null) {
      const locator = discoverRepository(repository);
      releaseProviderInvocationWorkerFence(
        investigationRuntimePaths(
          locator.gitCommonDirectory,
          'workflow-engine',
        ),
        fence.invocationId,
        fence.token,
      );
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider dispatch is detached and replay targets the stored prepared request', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-dispatch';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    let replayedInvocationId: string | null = null;
    startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
      providerDriver({ request }) {
        replayedInvocationId = request.invocationId;
      },
    });
    assert.equal(replayedInvocationId, invocationId);

    const launches: Array<{
      executable: string;
      args: string[];
      cwd: string;
      detached: boolean;
    }> = [];
    let unrefCount = 0;
    const dispatch = createProviderWorkerDispatcherForTesting({
      spawn(executable, args, options) {
        launches.push({
          executable,
          args,
          cwd: options.cwd,
          detached: options.detached,
        });
        return {
          pid: 1234,
          unref() {
            unrefCount += 1;
          },
        };
      },
    });
    const dispatched = dispatch(repository, invocationId);
    assert.equal(dispatched.invocationId, invocationId);
    assert.equal(dispatched.pid, 1234);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.executable, process.execPath);
    assert.equal(launches[0]!.cwd, fs.realpathSync(repository));
    assert.equal(launches[0]!.detached, true);
    assert.deepEqual(launches[0]!.args.slice(-3), [
      'provider-worker',
      invocationId,
      '--json',
    ]);
    assert.equal(unrefCount, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
