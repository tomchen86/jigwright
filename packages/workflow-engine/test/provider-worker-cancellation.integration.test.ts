import test from 'node:test';
import { createFixtureRepository, git } from './fixture.ts';
import { startPropose } from '../src/composition-root/propose-production.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { type ProviderWorkerRuntimePort } from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import assert from 'node:assert/strict';
import { type ProviderRunnerReport } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import { readProviderInvocationActivity } from '../src/runtime/storage-journal/provider-invocation-activity.ts';
import { runProviderWorkerAsync } from '../src/entrypoints/worker/provider-worker.ts';
import {
  readProviderInvocation,
  readProviderInvocationCancellationRequest,
  readProviderInvocationRequest,
  createProviderInvocationCancellationBinding,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  intent,
  beginExactProviderCancellationGrant,
  successfulWorkerReport,
  sha256,
} from './support/provider-worker-fixture.ts';

test(
  'approved exact Grant aborts the leased async provider and clears its claim-bound fence',
  { timeout: 10_000 },
  async () => {
    const repository = createFixtureRepository();
    const changeId = 'worker-durable-cancellation';
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
      let markLaunched!: () => void;
      const launched = new Promise<void>((resolve) => {
        markLaunched = resolve;
      });
      const agentRuntime: ProviderWorkerRuntimePort = {
        runSingleShot() {
          assert.fail('async cancellation fixture must not use runSingleShot');
        },
        async runSingleShotAsync(_input, options) {
          const signal = options.signal;
          assert.ok(signal);
          markLaunched();
          return await new Promise<ProviderRunnerReport>((_resolve, reject) => {
            const cancel = () => {
              options.onActivity?.({ type: 'cancelled', elapsedMs: 1 });
              reject(
                workflowError(
                  'AGENT_RUNTIME_V1_CANCELLED',
                  'Exact durable provider cancellation was requested.',
                  ExitCode.verification,
                ),
              );
            };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
          });
        },
      };

      const worker = runProviderWorkerAsync(repository, invocationId, {
        workerId: 'durable-cancellation-worker',
        agentRuntime,
      });
      await launched;
      assert.equal(
        readProviderInvocation(runtime, invocationId).state,
        'leased',
      );
      const reason =
        'Cancel the exact active provider before protected recovery.';
      const grant = await beginExactProviderCancellationGrant(
        repository,
        invocationId,
        reason,
      );
      const [result, resolution] = await Promise.all([
        worker,
        grant.resolution,
      ]);
      assert.equal(resolution.outcome, 'completed');
      assert.equal(result.state, 'failed');
      assert.equal(result.failure?.code, 'AGENT_RUNTIME_V1_CANCELLED');
      const cancellation = readProviderInvocationCancellationRequest(
        runtime,
        invocationId,
      );
      assert.ok(cancellation);
      assert.equal(cancellation.grantChallengeId, grant.challengeId);
      assert.equal(cancellation.reason, reason);
      assert.equal(
        readProviderInvocation(runtime, invocationId).state,
        'failed',
      );
      assert.equal(
        fs.existsSync(
          path.join(runtime.locks, `${invocationId}.worker-active`),
        ),
        false,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test(
  'approved cancellation preserves a natural provider success that wins the terminal race',
  { timeout: 10_000 },
  async () => {
    const repository = createFixtureRepository();
    const changeId = 'worker-cancellation-success-race';
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
      let markLaunched!: () => void;
      const launched = new Promise<void>((resolve) => {
        markLaunched = resolve;
      });
      let cancellationSignalObserved = false;
      const agentRuntime: ProviderWorkerRuntimePort = {
        runSingleShot() {
          assert.fail('success-race fixture must use the async runtime');
        },
        async runSingleShotAsync(_input, options) {
          const signal = options.signal;
          assert.ok(signal);
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          options.onActivity?.({ type: 'stdout', elapsedMs: 1, bytes: 7 });
          markLaunched();
          await new Promise<void>((resolve) => {
            const finishNaturally = () => {
              cancellationSignalObserved = true;
              resolve();
            };
            signal.addEventListener('abort', finishNaturally, { once: true });
            if (signal.aborted) finishNaturally();
          });
          options.onActivity?.({ type: 'exited', elapsedMs: 2 });
          return successfulWorkerReport(request, invocationId);
        },
      };

      const worker = runProviderWorkerAsync(repository, invocationId, {
        workerId: 'cancellation-success-race-worker',
        agentRuntime,
      }).then((result) => {
        // Observe the worker's own completion, before Grant cleanup can hide
        // missing heartbeat stop or fence release in the public worker chain.
        const finalActivity = readProviderInvocationActivity(
          runtime,
          invocationId,
        );
        assert.equal(finalActivity?.progress.processState, 'exited');
        assert.equal(finalActivity?.progress.eventCount, 3);
        assert.equal(finalActivity?.progress.stdoutBytes, 7);
        assert.equal(
          finalActivity?.workerId,
          'cancellation-success-race-worker',
        );
        assert.equal(
          finalActivity?.leaseGeneration,
          readProviderInvocation(runtime, invocationId).leaseGeneration,
        );
        assert.equal(
          fs.existsSync(
            path.join(runtime.locks, `${invocationId}.worker-active`),
          ),
          false,
        );
        return result;
      });
      await launched;
      const liveRecord = readProviderInvocation(runtime, invocationId);
      const liveActivity = readProviderInvocationActivity(
        runtime,
        invocationId,
      );
      assert.equal(liveRecord.state, 'leased');
      assert.equal(liveActivity?.leaseGeneration, liveRecord.leaseGeneration);
      assert.equal(liveActivity?.workerId, 'cancellation-success-race-worker');
      assert.equal(liveActivity?.progress.processState, 'running');
      assert.equal(liveActivity?.progress.eventCount, 2);
      assert.equal(liveActivity?.progress.stdoutBytes, 7);
      const grant = await beginExactProviderCancellationGrant(
        repository,
        invocationId,
        'Request cancellation while preserving the actual provider result.',
      );
      const [result, resolution] = await Promise.all([
        worker,
        grant.resolution,
      ]);

      assert.equal(cancellationSignalObserved, true);
      assert.equal(result.state, 'succeeded');
      assert.equal(resolution.outcome, 'completed');
      assert.equal(
        readProviderInvocation(runtime, invocationId).state,
        'succeeded',
      );
      assert.equal(
        fs.existsSync(
          path.join(runtime.locks, `${invocationId}.worker-active`),
        ),
        false,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test(
  'forged cancellation storage cannot abort the claimed provider process',
  { timeout: 10_000 },
  async () => {
    const repository = createFixtureRepository();
    const changeId = 'worker-forged-cancellation';
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
      let markLaunched!: () => void;
      const launched = new Promise<void>((resolve) => {
        markLaunched = resolve;
      });
      let finishProvider!: () => void;
      const finish = new Promise<void>((resolve) => {
        finishProvider = resolve;
      });
      let abortObserved = false;
      const agentRuntime: ProviderWorkerRuntimePort = {
        runSingleShot() {
          assert.fail('forged-cancellation fixture must use the async runtime');
        },
        async runSingleShotAsync(_input, options) {
          const signal = options.signal;
          assert.ok(signal);
          signal.addEventListener(
            'abort',
            () => {
              abortObserved = true;
            },
            { once: true },
          );
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          markLaunched();
          await finish;
          options.onActivity?.({ type: 'exited', elapsedMs: 100 });
          return successfulWorkerReport(request, invocationId);
        },
      };

      const worker = runProviderWorkerAsync(repository, invocationId, {
        workerId: 'forged-cancellation-worker',
        agentRuntime,
      });
      await launched;
      const binding = createProviderInvocationCancellationBinding(
        runtime,
        invocationId,
      );
      const forgedBody = {
        schemaVersion: 1 as const,
        kind: 'provider-invocation-cancellation-request.v1' as const,
        binding,
        grantChallengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        grantOperationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        grantRecordDigest: `sha256:${'c'.repeat(64)}` as const,
        reason: 'Forged storage has no Grant Core authority.',
        requestedAt: '2030-08-30T00:00:00.000Z',
      };
      const forged = {
        ...forgedBody,
        requestDigest: `sha256:${sha256(
          `workflow.provider-invocation-cancellation-request.v1\n${canonicalJson(forgedBody)}`,
        )}` as const,
      };
      fs.writeFileSync(
        path.join(
          runtime.invocations,
          invocationId,
          'cancellation-request.json',
        ),
        `${canonicalJson(forged)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(abortObserved, false);
      finishProvider();

      const result = await worker;
      assert.equal(abortObserved, false);
      assert.equal(result.state, 'succeeded');
      assert.deepEqual(
        readProviderInvocationCancellationRequest(runtime, invocationId),
        forged,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);
