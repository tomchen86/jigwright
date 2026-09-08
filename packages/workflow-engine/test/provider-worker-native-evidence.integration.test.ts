import test from 'node:test';
import { createFixtureRepository, git } from './fixture.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  readProviderInvocationRequest,
  readProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import assert from 'node:assert/strict';
import {
  type ProviderWorkerRuntimePort,
  type ProviderInvocationAcceptanceBinding,
} from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import path from 'node:path';
import fs from 'node:fs';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { runProviderWorkerAsync } from '../src/entrypoints/worker/provider-worker.ts';
import { readProviderInvocationLifecycleProjection } from '../src/runtime/storage-journal/investigation-session-store.ts';
import {
  type ProviderWrapperProtocolReceipt,
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
} from '../src/modules/provider-orchestration/agent-runtime-protocol.ts';
import {
  type ProviderWrapperSessionProtocolReceipt,
  createProviderWrapperSessionProtocolParser,
  renderProviderWrapperSessionFrame,
} from '@jigwright/agent-runtime/harness-jsonl-v2';
import {
  providerDefinitionExecutableBindingDigest,
  createAgentRuntimeHostProbeEvidenceV1,
  createAgentRuntimeHostExecutionBindingV1,
} from '../src/modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import {
  providerNativeSessionStorePathsV1,
  providerNativeSessionCompletionObjectPathV1,
  providerNativeSessionContinuationAuthorityObjectPathV1,
} from '../src/runtime/session-workspace/provider-runtime-authority-paths.ts';
import {
  lowerAdapterLimits,
  intent,
  sha256,
  executableIdentity,
  successfulWorkerReport,
  createCurrentPlanReviewNativeWorkerFixture,
  executableIdentityFor,
  writePrivateCanonicalJson,
  sha256Buffer,
  writeHostWrapperFailureArtifacts,
} from './support/provider-worker-fixture.ts';

for (const objectFormat of ['sha1', 'sha256'] as const) {
  test(`async provider worker completes the exact durable invocation through ProviderWorkerRuntimePort on ${objectFormat}`, async () => {
    const repository = createFixtureRepository({ objectFormat });
    const changeId = `worker-${objectFormat}`;
    try {
      lowerAdapterLimits(repository);
      git(repository, ['add', 'workflow/ai-adapter-policy.json']);
      git(repository, ['commit', '-m', 'Lower provider limits']);
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
      const loadedPolicy = loadAiAdapterPolicy(repository);
      assert.equal(request.policyDigest, loadedPolicy.digest);
      assert.deepEqual(request.limits, {
        timeoutMs: 12_345,
        aggregateOutputBytes: 54_321,
      });
      assert.equal(
        request.baseCommit.length,
        objectFormat === 'sha1' ? 40 : 64,
      );
      assert.equal(request.baseTree.length, objectFormat === 'sha1' ? 40 : 64);

      let launches = 0;
      let launchBinding:
        | Parameters<
            NonNullable<ProviderWorkerRuntimePort['runSingleShotAsync']>
          >[0]['acceptanceBinding']
        | null = null;
      let runtimeSignal: AbortSignal | null = null;
      const controller = new AbortController();
      const agentRuntime: ProviderWorkerRuntimePort = {
        runSingleShot() {
          assert.fail('production async worker must not use runSingleShot');
        },
        async runSingleShotAsync(input, options) {
          launches += 1;
          launchBinding = input.acceptanceBinding;
          assert.ok(options.signal);
          runtimeSignal = options.signal;
          assert.notEqual(options.signal, controller.signal);
          assert.equal(options.signal.aborted, false);
          assert.equal(
            sha256(canonicalJson(input.semanticOutputSchema)),
            request.outputSchema.digest,
          );
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          options.onActivity?.({ type: 'stdout', elapsedMs: 2, bytes: 10 });
          options.onActivity?.({ type: 'stderr', elapsedMs: 3, bytes: 4 });
          options.onActivity?.({ type: 'exited', elapsedMs: 7 });
          const semanticOutput = {
            reference: invocationId,
            terms: [{ kind: 'symbol', value: 'ProviderWorker' }],
          };
          const runtimeDirectory = path.join(
            input.invocationDirectory,
            'runtime',
          );
          fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
          for (const [name, value] of [
            [
              'prompt.json',
              {
                schemaVersion: 1,
                kind: 'provider-worker-runtime-fixture',
                requestDigest: request.requestDigest,
              },
            ],
            ['schema.json', input.semanticOutputSchema],
            ['semantic-output.json', semanticOutput],
          ] as const) {
            fs.writeFileSync(
              path.join(runtimeDirectory, name),
              `${canonicalJson(value)}\n`,
              { mode: 0o600, flag: 'wx' },
            );
          }
          return {
            invocationId,
            providerId: request.providerId,
            purpose: request.purpose,
            requestDigest: request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: 'a'.repeat(64),
              afterDigest: 'a'.repeat(64),
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(request.providerId),
            elapsedMs: 7,
            providerDefinitionSnapshot:
              resolveBuiltInProviderDefinitionSnapshot(
                request.providerId,
                'darwin',
              )!,
          };
        },
      };
      const completed = await runProviderWorkerAsync(repository, invocationId, {
        workerId: `fake-worker-${objectFormat}`,
        platform: 'aix',
        signal: controller.signal,
        agentRuntime,
        runner() {
          throw new Error('agentRuntime must take precedence over runner');
        },
      });

      assert.equal(completed.state, 'succeeded');
      assert.equal(completed.launched, true);
      const mergedRuntimeSignal = runtimeSignal as AbortSignal | null;
      assert.ok(mergedRuntimeSignal);
      controller.abort();
      assert.equal(mergedRuntimeSignal.aborted, true);
      const durable = readProviderInvocation(runtime, invocationId);
      assert.equal(durable.state, 'succeeded');
      assert.equal(
        readProviderInvocationLifecycleProjection(runtime, invocationId).state,
        'succeeded',
        'the strict lifecycle reader admits a real terminal async receipt',
      );
      for (const directoryName of [
        'host-wrapper-probe-runtime',
        'host-wrapper-runtime',
      ]) {
        fs.mkdirSync(
          path.join(runtime.invocations, invocationId, directoryName),
          { mode: 0o700 },
        );
      }
      assert.throws(
        () => readProviderInvocationLifecycleProjection(runtime, invocationId),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
        'a built-in success cannot adopt host-wrapper runtime directories',
      );
      for (const directoryName of [
        'host-wrapper-probe-runtime',
        'host-wrapper-runtime',
      ]) {
        fs.rmdirSync(
          path.join(runtime.invocations, invocationId, directoryName),
        );
      }
      const acceptedBinding =
        launchBinding as ProviderInvocationAcceptanceBinding | null;
      assert.ok(acceptedBinding);
      assert.ok(durable.runtimeReceipt);
      assert.deepEqual(completed.completionReceipt, durable.runtimeReceipt);
      const receiptPayload = { ...durable.runtimeReceipt };
      delete (receiptPayload as { receiptDigest?: string }).receiptDigest;
      assert.equal(
        durable.runtimeReceipt.receiptDigest,
        sha256(canonicalJson(receiptPayload)),
      );
      assert.deepEqual(receiptPayload, {
        schemaVersion: 4,
        kind: 'agent-runtime-completion-receipt',
        invocationId,
        requestDigest: request.requestDigest,
        leasedRevision: durable.revision - 1,
        terminalRevision: durable.revision,
        leaseGeneration: durable.leaseGeneration,
        executionJobId: acceptedBinding.executionJobId,
        executionAttemptId: acceptedBinding.executionAttemptId,
        executionRevision: acceptedBinding.executionRevision,
        executionStateDigest: acceptedBinding.executionStateDigest,
        acceptanceBindingDigest: acceptedBinding.bindingDigest,
        acceptanceBinding: acceptedBinding,
        terminalState: 'succeeded',
        terminalDisposition: 'accepted',
        failureCode: null,
        launched: true,
        progress: {
          schemaVersion: 1,
          kind: 'agent-runtime-process-progress',
          processState: 'exited',
          eventCount: 4,
          stdoutBytes: 10,
          stderrBytes: 4,
          lastProcessActivityElapsedMs: 7,
          lastProviderActivityElapsedMs: 3,
        },
        protocolReceipt: null,
        hostExecutionBinding: null,
      });
      assert.equal(
        durable.result?.runtimeObservation?.assurance,
        'unchanged-governed-projection',
      );
      assert.equal(
        durable.result?.runtimeObservation?.sameUserProcessConfined,
        false,
      );
      assert.deepEqual(
        durable.result?.runtimeObservation?.residuals,
        PROVIDER_RUNNER_RESIDUALS,
      );
      const definitionSnapshot = resolveBuiltInProviderDefinitionSnapshot(
        request.providerId,
        'darwin',
      )!;
      assert.deepEqual(
        durable.result?.runtimeObservation?.providerDefinitionSnapshot,
        definitionSnapshot,
      );
      assert.equal(
        durable.result?.runtimeObservation?.providerDefinitionBindingDigest,
        sha256(
          canonicalJson({
            providerDefinitionDigest: definitionSnapshot.definitionDigest,
            executable: executableIdentity(request.providerId),
          }),
        ),
      );

      const replayed = await runProviderWorkerAsync(repository, invocationId, {
        agentRuntime,
      });
      assert.equal(replayed.state, 'succeeded');
      assert.equal(replayed.launched, false);
      assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
      assert.equal(replayed.completionReceipt?.launched, true);
      assert.equal(launches, 1);

      const statePath = path.join(
        runtime.invocations,
        invocationId,
        'state.json',
      );
      const originalState = fs.readFileSync(statePath, 'utf8');
      const definitionTampered = JSON.parse(originalState) as {
        result: {
          runtimeObservation: {
            providerDefinitionSnapshot: Record<string, unknown>;
            providerDefinitionBindingDigest: string;
            executable: ReturnType<typeof executableIdentity>;
          };
        };
      };
      const tamperedSnapshot =
        definitionTampered.result.runtimeObservation.providerDefinitionSnapshot;
      tamperedSnapshot.commandProfile = 'caller-replaced-command-profile-v1';
      const tamperedDefinitionPayload = { ...tamperedSnapshot };
      delete tamperedDefinitionPayload.definitionDigest;
      tamperedSnapshot.definitionDigest = sha256(
        canonicalJson(tamperedDefinitionPayload),
      );
      definitionTampered.result.runtimeObservation.providerDefinitionBindingDigest =
        sha256(
          canonicalJson({
            providerDefinitionDigest: tamperedSnapshot.definitionDigest,
            executable: definitionTampered.result.runtimeObservation.executable,
          }),
        );
      fs.writeFileSync(statePath, `${canonicalJson(definitionTampered)}\n`);
      await assert.rejects(
        () =>
          runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_INVOCATION_RESULT_INVALID',
      );
      assert.equal(
        launches,
        1,
        'a recomputed unknown definition must not relaunch',
      );

      fs.writeFileSync(statePath, originalState);
      const executableTampered = JSON.parse(originalState) as {
        result: {
          runtimeObservation: {
            executable: { sha256: string };
          };
        };
      };
      executableTampered.result.runtimeObservation.executable.sha256 =
        'c'.repeat(64);
      fs.writeFileSync(statePath, `${canonicalJson(executableTampered)}\n`);
      await assert.rejects(
        () =>
          runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_INVOCATION_RESULT_INVALID',
      );
      assert.equal(launches, 1, 'executable identity drift must not relaunch');

      fs.writeFileSync(statePath, originalState);
      const tampered = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        runtimeReceipt: Record<string, unknown>;
      };
      tampered.runtimeReceipt.executionAttemptId =
        'attempt-provider-invocation-mismatched';
      const tamperedReceiptPayload = { ...tampered.runtimeReceipt };
      delete tamperedReceiptPayload.receiptDigest;
      tampered.runtimeReceipt.receiptDigest = sha256(
        canonicalJson(tamperedReceiptPayload),
      );
      fs.writeFileSync(statePath, `${canonicalJson(tampered)}\n`);
      await assert.rejects(
        () =>
          runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_INVOCATION_INVALID',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('async provider worker durably binds a wrapper protocol receipt to its accepted Attempt', async () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-wrapper-protocol-receipt';
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
    let protocolReceipt: ProviderWrapperProtocolReceipt | null = null;
    const agentRuntime: ProviderWorkerRuntimePort = {
      runSingleShot() {
        assert.fail('async worker must not call the sync runtime');
      },
      async runSingleShotAsync(input, options) {
        launches += 1;
        const parser = createProviderWrapperProtocolParser({
          binding: {
            invocationId,
            requestDigest: request.requestDigest,
            attemptId: input.acceptanceBinding.executionAttemptId,
          },
        });
        const initialStream = Buffer.from(
          [
            {
              schemaVersion: 1 as const,
              type: 'hello' as const,
              sequence: 1,
              protocol: 'harness-jsonl-v1' as const,
            },
            {
              schemaVersion: 1 as const,
              type: 'progress' as const,
              sequence: 2,
              phase: 'tool' as const,
            },
          ]
            .map(renderProviderWrapperFrame)
            .join(''),
          'utf8',
        );
        parser.push(initialStream);
        assert.equal(parser.requestCancellation(), true);
        const terminalStream = Buffer.from(
          renderProviderWrapperFrame({
            schemaVersion: 1,
            type: 'result',
            sequence: 3,
            outputSlot: 'primary',
          }),
          'utf8',
        );
        parser.push(terminalStream);
        const stream = Buffer.concat([initialStream, terminalStream]);
        protocolReceipt = parser.finish({ cancellationForced: false });
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({
          type: 'stdout',
          elapsedMs: 1,
          bytes: stream.length,
        });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        return {
          ...successfulWorkerReport(request, invocationId),
          elapsedMs: 2,
          wrapperProtocolReceipt: protocolReceipt,
        };
      },
    };

    const completed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime,
    });
    assert.ok(completed.completionReceipt);
    assert.equal(completed.completionReceipt.schemaVersion, 4);
    assert.ok('protocolReceipt' in completed.completionReceipt);
    assert.deepEqual(
      (
        completed.completionReceipt as unknown as {
          protocolReceipt: unknown;
        }
      ).protocolReceipt,
      protocolReceipt,
    );
    const retainedProtocolReceipt =
      protocolReceipt as ProviderWrapperProtocolReceipt | null;
    assert.ok(retainedProtocolReceipt);
    assert.deepEqual(retainedProtocolReceipt.cancellation, {
      requested: true,
      acknowledged: false,
      forced: false,
    });
    const durable = readProviderInvocation(runtime, invocationId);
    assert.deepEqual(durable.runtimeReceipt, completed.completionReceipt);

    const replayed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime,
    });
    assert.equal(replayed.launched, false);
    assert.deepEqual(replayed.completionReceipt, completed.completionReceipt);
    assert.equal(launches, 1);

    const statePath = path.join(
      runtime.invocations,
      invocationId,
      'state.json',
    );
    const originalState = fs.readFileSync(statePath, 'utf8');
    const unknownVersion = JSON.parse(originalState) as {
      runtimeReceipt: Record<string, unknown>;
    };
    unknownVersion.runtimeReceipt.schemaVersion = 99;
    const unknownVersionPayload = { ...unknownVersion.runtimeReceipt };
    delete unknownVersionPayload.receiptDigest;
    unknownVersion.runtimeReceipt.receiptDigest = sha256(
      canonicalJson(unknownVersionPayload),
    );
    fs.writeFileSync(statePath, `${canonicalJson(unknownVersion)}\n`);
    await assert.rejects(
      () => runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_INVOCATION_INVALID',
    );
    assert.equal(launches, 1, 'unknown receipt versions must not relaunch');

    fs.writeFileSync(statePath, originalState);
    const tampered = JSON.parse(originalState) as {
      runtimeReceipt: Record<string, unknown> & {
        protocolReceipt: Record<string, unknown>;
      };
    };
    const mismatchedAttemptId = 'attempt-mismatched-wrapper-receipt';
    tampered.runtimeReceipt.executionAttemptId = mismatchedAttemptId;
    tampered.runtimeReceipt.protocolReceipt.attemptId = mismatchedAttemptId;
    const protocolPayload = { ...tampered.runtimeReceipt.protocolReceipt };
    delete protocolPayload.receiptDigest;
    tampered.runtimeReceipt.protocolReceipt.receiptDigest = sha256(
      canonicalJson(protocolPayload),
    );
    const runtimePayload = { ...tampered.runtimeReceipt };
    delete runtimePayload.receiptDigest;
    tampered.runtimeReceipt.receiptDigest = sha256(
      canonicalJson(runtimePayload),
    );
    fs.writeFileSync(statePath, `${canonicalJson(tampered)}\n`);

    await assert.rejects(
      () => runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_INVOCATION_INVALID',
    );
    assert.equal(launches, 1, 'tampered terminal replay must not relaunch');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async built-in worker durably records semantic rejection after a validated result without native authority', async () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-built-in-result-rejected';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
    });
    const invocationId = started.investigation!.providerInvocationId;
    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    let launches = 0;
    let protocolReceipt: ProviderWrapperProtocolReceipt | null = null;
    const agentRuntime: ProviderWorkerRuntimePort = {
      runSingleShot() {
        assert.fail('built-in rejection fixture must use the async worker');
      },
      async runSingleShotAsync(input, options) {
        launches += 1;
        assert.equal(input.nativeSessionTurn, undefined);
        assert.equal(input.assignmentBinding, undefined);
        const parser = createProviderWrapperProtocolParser({
          binding: {
            invocationId,
            requestDigest: request.requestDigest,
            attemptId: input.acceptanceBinding.executionAttemptId,
          },
        });
        const stream = Buffer.from(
          [
            renderProviderWrapperFrame({
              schemaVersion: 1,
              type: 'hello',
              sequence: 1,
              protocol: 'harness-jsonl-v1',
            }),
            renderProviderWrapperFrame({
              schemaVersion: 1,
              type: 'result',
              sequence: 2,
              outputSlot: 'primary',
            }),
          ].join(''),
          'utf8',
        );
        parser.push(stream);
        protocolReceipt = parser.finish({ cancellationForced: false });
        options.onProtocolReceipt?.(protocolReceipt);
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({
          type: 'stdout',
          elapsedMs: 1,
          bytes: stream.byteLength,
        });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        const semanticOutput = { callerInvented: true };
        assert.equal(input.outputValidator.validate(semanticOutput), false);
        return {
          ...successfulWorkerReport(request, invocationId),
          semanticOutput,
          semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
          elapsedMs: 2,
          wrapperProtocolReceipt: protocolReceipt,
        };
      },
    };

    const failed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime,
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'PROVIDER_INVOCATION_RESULT_INVALID');
    assert.equal(failed.completionReceipt?.schemaVersion, 4);
    assert.equal(
      failed.completionReceipt?.terminalDisposition,
      'rejected-after-result',
    );
    assert.equal(failed.completionReceipt?.hostExecutionBinding, null);
    assert.deepEqual(
      failed.completionReceipt?.protocolReceipt,
      protocolReceipt,
    );
    const durable = readProviderInvocation(runtime, invocationId);
    assert.equal(durable.state, 'failed');
    assert.deepEqual(durable.runtimeReceipt, failed.completionReceipt);

    const replayed = await runProviderWorkerAsync(repository, invocationId, {
      agentRuntime,
    });
    assert.equal(replayed.state, 'failed');
    assert.equal(replayed.launched, false);
    assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async provider worker seals a truthful rejected-after-result native terminal without continuation authority', async () => {
  const fixture = createCurrentPlanReviewNativeWorkerFixture();
  const {
    repository,
    agentProviderConfigPath,
    runtime,
    request,
    invocationId,
  } = fixture;
  let launches = 0;
  let protocolReceipt: ProviderWrapperSessionProtocolReceipt | null = null;
  let nativeClaimDigest: string | null = null;
  let nativeCompletionDigest: string | null = null;
  try {
    const agentRuntime: ProviderWorkerRuntimePort = {
      runSingleShot() {
        assert.fail('native rejection fixture must use the async worker');
      },
      async runSingleShotAsync(input, options) {
        launches += 1;
        const controller = input.nativeSessionTurn;
        const assignment = input.assignmentBinding;
        assert.ok(controller);
        assert.ok(assignment);
        assert.deepEqual(controller.assignmentBinding, assignment);
        assert.equal(controller.nextAction(), 'start');

        const executable = executableIdentityFor(controller.profile.executable);
        const probeDirectory = path.join(
          input.invocationDirectory,
          'host-wrapper-probe-runtime',
        );
        const turnDirectory = path.join(
          input.invocationDirectory,
          'host-wrapper-runtime',
        );
        fs.mkdirSync(probeDirectory, { mode: 0o700 });
        fs.mkdirSync(turnDirectory, { mode: 0o700 });
        const probeOutputPath = path.join(probeDirectory, 'probe-result.json');
        const providerDefinitionBindingDigest =
          providerDefinitionExecutableBindingDigest(
            controller.profile.profileDigest,
            executable,
          );
        const probeRequestBytes = writePrivateCanonicalJson(
          path.join(probeDirectory, 'request.json'),
          {
            schemaVersion: 1,
            kind: 'agent-runtime-host-wrapper-probe-request.v1',
            invocationId,
            requestDigest: request.requestDigest,
            executionAttemptId: input.acceptanceBinding.executionAttemptId,
            acceptanceBindingDigest: input.acceptanceBinding.bindingDigest,
            assignmentBindingDigest: assignment.bindingDigest,
            providerFamily: request.providerId,
            profileDigest: controller.profile.profileDigest,
            providerDefinitionBindingDigest,
            outputFile: probeOutputPath,
          },
        );
        const probeResultBytes = writePrivateCanonicalJson(probeOutputPath, {
          schemaVersion: 1,
          kind: 'agent-runtime-host-wrapper-probe-result.v1',
          providerVersion: 'provider-worker-rejected-result-v1',
          authentication: 'authenticated',
        });
        const governedDigest = sha256(canonicalJson([]));
        const probeEvidence = createAgentRuntimeHostProbeEvidenceV1({
          invocationId,
          requestDigest: request.requestDigest,
          executionAttemptId: input.acceptanceBinding.executionAttemptId,
          acceptanceBindingDigest: input.acceptanceBinding.bindingDigest,
          assignmentBindingDigest: assignment.bindingDigest,
          providerProfileDigest: controller.profile.profileDigest,
          executable,
          providerDefinitionBindingDigest,
          providerVersion: 'provider-worker-rejected-result-v1',
          probeRequestFileDigest: sha256Buffer(probeRequestBytes),
          probeResultFileDigest: sha256Buffer(probeResultBytes),
          governedBeforeDigest: governedDigest,
          governedAfterDigest: governedDigest,
        });
        options.onHostProbeEvidence?.(probeEvidence);

        const claimed = controller.claim({
          attemptId: input.acceptanceBinding.executionAttemptId,
          expectedAction: 'start',
        });
        nativeClaimDigest = claimed.claimDigest;
        const invalidSemanticOutput = {
          schemaVersion: 2,
          verdict: 'caller-invented-verdict',
        };
        writePrivateCanonicalJson(path.join(turnDirectory, 'request.json'), {
          schemaVersion: 1,
          kind: 'agent-runtime-host-wrapper-turn-request.v1',
          invocationId,
          requestDigest: request.requestDigest,
          action: 'start',
          prompt: canonicalJson({
            schemaVersion: 1,
            kind: 'agent-runtime-host-wrapper-request.v1',
            request,
          }),
          outputFile: path.join(turnDirectory, 'semantic-output.json'),
        });
        writePrivateCanonicalJson(
          path.join(turnDirectory, 'semantic-output.json'),
          invalidSemanticOutput,
        );
        assert.equal(
          input.outputValidator.validate(invalidSemanticOutput),
          false,
        );

        const parser = createProviderWrapperSessionProtocolParser({
          binding: claimed.binding,
        });
        const stream = Buffer.from(
          [
            renderProviderWrapperSessionFrame({
              schemaVersion: 2,
              type: 'hello',
              sequence: 1,
              protocol: 'harness-jsonl-v2',
            }),
            renderProviderWrapperSessionFrame({
              schemaVersion: 2,
              type: 'session',
              sequence: 2,
              action: 'start',
              nativeSessionId: 'native-provider-worker-rejected-result',
            }),
            renderProviderWrapperSessionFrame({
              schemaVersion: 2,
              type: 'result',
              sequence: 3,
              outputSlot: 'primary',
            }),
          ].join(''),
          'utf8',
        );
        parser.push(stream);
        const outcome = parser.finish({ cancellationForced: false });
        protocolReceipt = outcome.receipt;
        const completed = controller.complete({
          claimDigest: claimed.claimDigest,
          terminal: {
            kind: 'protocol-outcome',
            outcome,
            privateIdentityObservation: null,
          },
        });
        nativeCompletionDigest = completed.completionDigest;
        const hostExecutionBinding = createAgentRuntimeHostExecutionBindingV1({
          assignmentBinding: assignment,
          probe: probeEvidence,
          nativeSessionClaim: claimed.claim,
          nativeSessionCompletionDigest: completed.completionDigest,
        });
        options.onProtocolReceipt?.(outcome.receipt);
        options.onHostExecutionBinding?.(hostExecutionBinding);
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({
          type: 'stdout',
          elapsedMs: 1,
          bytes: stream.byteLength,
        });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        throw workflowError(
          'AGENT_RUNTIME_V1_OUTPUT_INVALID',
          'The exact current semantic-output validator rejected the native result.',
          ExitCode.verification,
        );
      },
    };

    const failed = await runProviderWorkerAsync(repository, invocationId, {
      agentProviderConfigPath,
      platform: process.platform,
      agentRuntime,
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'AGENT_RUNTIME_V1_OUTPUT_INVALID');
    assert.equal(failed.completionReceipt?.schemaVersion, 4);
    assert.equal(failed.completionReceipt?.terminalState, 'failed');
    assert.equal(
      failed.completionReceipt?.terminalDisposition,
      'rejected-after-result',
    );
    assert.equal(
      failed.completionReceipt?.failureCode,
      'AGENT_RUNTIME_V1_OUTPUT_INVALID',
    );
    assert.deepEqual(
      failed.completionReceipt?.protocolReceipt,
      protocolReceipt,
    );
    assert.equal(
      failed.completionReceipt?.hostExecutionBinding?.phase,
      'native-terminal',
    );
    assert.equal(
      failed.completionReceipt?.hostExecutionBinding
        ?.nativeSessionCompletionDigest,
      nativeCompletionDigest,
    );
    const durable = readProviderInvocation(runtime, invocationId);
    assert.equal(durable.state, 'failed');
    assert.deepEqual(durable.runtimeReceipt, failed.completionReceipt);
    assert.equal(
      readProviderInvocationLifecycleProjection(runtime, invocationId).state,
      'failed',
    );

    assert.ok(nativeClaimDigest);
    assert.ok(nativeCompletionDigest);
    const nativePaths = providerNativeSessionStorePathsV1(runtime);
    const nativeCompletion = JSON.parse(
      fs.readFileSync(
        providerNativeSessionCompletionObjectPathV1(
          nativePaths,
          nativeCompletionDigest,
        ),
        'utf8',
      ),
    ) as {
      claimDigest: string;
      disposition: string;
      usable: boolean;
      protocolReceipt: ProviderWrapperSessionProtocolReceipt | null;
      handleDigest: string | null;
    };
    assert.equal(nativeCompletion.claimDigest, nativeClaimDigest);
    assert.equal(nativeCompletion.disposition, 'rejected');
    assert.equal(nativeCompletion.usable, false);
    assert.deepEqual(nativeCompletion.protocolReceipt, protocolReceipt);
    assert.equal(nativeCompletion.handleDigest, null);
    assert.deepEqual(
      fs.existsSync(nativePaths.handles)
        ? fs.readdirSync(nativePaths.handles)
        : [],
      [],
    );
    assert.equal(
      fs.existsSync(
        providerNativeSessionContinuationAuthorityObjectPathV1(
          nativePaths,
          nativeCompletionDigest,
        ),
      ),
      false,
    );

    const replayed = await runProviderWorkerAsync(repository, invocationId, {
      agentProviderConfigPath,
      platform: process.platform,
      agentRuntime,
    });
    assert.equal(replayed.state, 'failed');
    assert.equal(replayed.launched, false);
    assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
    assert.equal(launches, 1);
  } finally {
    fixture.cleanup();
  }
});

for (const fixture of [
  {
    mode: 'error',
    failureCode: 'PROVIDER_WRAPPER_REPORTED_ERROR',
    processState: 'exited',
    acknowledged: false,
    forced: false,
  },
  {
    mode: 'cancel-ack',
    failureCode: 'PROVIDER_PROCESS_CANCELLED',
    processState: 'cancelled',
    acknowledged: true,
    forced: false,
  },
  {
    mode: 'cancel-forced',
    failureCode: 'PROVIDER_PROCESS_CANCELLED',
    processState: 'cancelled',
    acknowledged: false,
    forced: true,
  },
] as const) {
  test(`async provider worker durably records wrapper ${fixture.mode} terminal evidence as failure`, async () => {
    const repository = createFixtureRepository();
    const changeId = `worker-wrapper-${fixture.mode}-receipt`;
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
      let protocolReceipt: ProviderWrapperProtocolReceipt | null = null;
      const agentRuntime: ProviderWorkerRuntimePort = {
        runSingleShot() {
          assert.fail('async worker must not call the sync runtime');
        },
        async runSingleShotAsync(input, options) {
          launches += 1;
          const parser = createProviderWrapperProtocolParser({
            binding: {
              invocationId,
              requestDigest: request.requestDigest,
              attemptId: input.acceptanceBinding.executionAttemptId,
            },
          });
          const frames = [
            renderProviderWrapperFrame({
              schemaVersion: 1,
              type: 'hello',
              sequence: 1,
              protocol: 'harness-jsonl-v1',
            }),
          ];
          const initialStream = Buffer.from(frames.join(''), 'utf8');
          parser.push(initialStream);
          assert.equal(parser.requestCancellation(), true);
          if (fixture.mode === 'error') {
            frames.push(
              renderProviderWrapperFrame({
                schemaVersion: 1,
                type: 'error',
                sequence: 2,
                code: 'FIXTURE_REJECTED',
              }),
            );
          }
          if (fixture.mode !== 'error') {
            if (fixture.acknowledged) {
              const acknowledgement = Buffer.from(
                renderProviderWrapperFrame({
                  schemaVersion: 1,
                  type: 'cancel-ack',
                  sequence: 2,
                }),
                'utf8',
              );
              parser.push(acknowledgement);
              frames.push(acknowledgement.toString('utf8'));
            }
          } else {
            parser.push(Buffer.from(frames[1]!, 'utf8'));
          }
          const stream = Buffer.from(frames.join(''), 'utf8');
          protocolReceipt = parser.finish({
            cancellationForced: fixture.forced,
          });
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
          options.onActivity?.({
            type: 'stdout',
            elapsedMs: 1,
            bytes: stream.length,
          });
          options.onActivity?.({
            type: fixture.processState,
            elapsedMs: 2,
          });
          (
            options as typeof options & {
              onProtocolReceipt?: (
                receipt: ProviderWrapperProtocolReceipt,
              ) => void;
            }
          ).onProtocolReceipt?.(protocolReceipt);
          throw workflowError(
            fixture.failureCode,
            'Fixture wrapper terminated without a successful result.',
            ExitCode.verification,
          );
        },
      };

      const failed = await runProviderWorkerAsync(repository, invocationId, {
        agentRuntime,
      });
      assert.equal(failed.state, 'failed');
      assert.equal(failed.failure?.code, fixture.failureCode);
      assert.equal(failed.completionReceipt?.schemaVersion, 4);
      assert.equal(failed.completionReceipt?.terminalState, 'failed');
      assert.equal(
        failed.completionReceipt?.terminalDisposition,
        'failed-before-result',
      );
      assert.equal(failed.completionReceipt?.failureCode, fixture.failureCode);
      assert.equal(
        failed.completionReceipt?.progress.processState,
        fixture.processState,
      );
      assert.ok(
        failed.completionReceipt !== null &&
          'protocolReceipt' in failed.completionReceipt,
      );
      assert.deepEqual(
        (
          failed.completionReceipt as unknown as {
            protocolReceipt: ProviderWrapperProtocolReceipt;
          }
        ).protocolReceipt,
        protocolReceipt,
      );
      assert.deepEqual(
        (
          failed.completionReceipt as unknown as {
            protocolReceipt: ProviderWrapperProtocolReceipt;
          }
        ).protocolReceipt.cancellation,
        {
          requested: true,
          acknowledged: fixture.acknowledged,
          forced: fixture.forced,
        },
      );
      const durable = readProviderInvocation(runtime, invocationId);
      assert.deepEqual(durable.runtimeReceipt, failed.completionReceipt);

      const replayed = await runProviderWorkerAsync(repository, invocationId, {
        agentRuntime,
      });
      assert.equal(replayed.state, 'failed');
      assert.equal(replayed.launched, false);
      assert.deepEqual(replayed.completionReceipt, durable.runtimeReceipt);
      assert.equal(launches, 1);

      if (fixture.mode === 'error') {
        const statePath = path.join(
          runtime.invocations,
          invocationId,
          'state.json',
        );
        const unknownVersion = JSON.parse(
          fs.readFileSync(statePath, 'utf8'),
        ) as {
          runtimeReceipt: Record<string, unknown>;
        };
        unknownVersion.runtimeReceipt.schemaVersion = 99;
        const receiptPayload = { ...unknownVersion.runtimeReceipt };
        delete receiptPayload.receiptDigest;
        unknownVersion.runtimeReceipt.receiptDigest = sha256(
          canonicalJson(receiptPayload),
        );
        fs.writeFileSync(statePath, `${canonicalJson(unknownVersion)}\n`);
        await assert.rejects(
          () =>
            runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'PROVIDER_INVOCATION_INVALID',
        );
        assert.equal(launches, 1, 'unknown versions must not relaunch');
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('async provider worker rejects fabricated host-wrapper evidence without exact host authority', async () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-host-wrapper-error-receipt';
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
    const statePath = path.join(
      runtime.invocations,
      invocationId,
      'state.json',
    );
    let claimedState: string | null = null;
    let protocolReceipt: ProviderWrapperSessionProtocolReceipt | null = null;
    const agentRuntime: ProviderWorkerRuntimePort = {
      runSingleShot() {
        assert.fail('host-wrapper receipt fixture must use the async runtime');
      },
      async runSingleShotAsync(input, options) {
        claimedState = fs.readFileSync(statePath, 'utf8');
        const binding = {
          invocationId,
          requestDigest: request.requestDigest,
          attemptId: input.acceptanceBinding.executionAttemptId,
          sessionControl: {
            action: 'start' as const,
            nativeSessionIdentityMode: 'provider-observed' as const,
            expectedNativeSessionId: null,
          },
        };
        const parser = createProviderWrapperSessionProtocolParser({ binding });
        const stream = Buffer.from(
          [
            renderProviderWrapperSessionFrame({
              schemaVersion: 2,
              type: 'hello',
              sequence: 1,
              protocol: 'harness-jsonl-v2',
            }),
            renderProviderWrapperSessionFrame({
              schemaVersion: 2,
              type: 'session',
              sequence: 2,
              action: 'start',
              nativeSessionId: 'native-worker-host-error',
            }),
            renderProviderWrapperSessionFrame({
              schemaVersion: 2,
              type: 'error',
              sequence: 3,
              code: 'FIXTURE_REJECTED',
            }),
          ].join(''),
          'utf8',
        );
        parser.push(stream);
        protocolReceipt = parser.finish({ cancellationForced: false }).receipt;
        writeHostWrapperFailureArtifacts(input.invocationDirectory, request);
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({
          type: 'stdout',
          elapsedMs: 1,
          bytes: stream.length,
        });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        options.onProtocolReceipt?.(protocolReceipt);
        throw workflowError(
          'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
          'Fixture host-wrapper reported a bound terminal error.',
          ExitCode.verification,
        );
      },
    };

    await assert.rejects(
      () => runProviderWorkerAsync(repository, invocationId, { agentRuntime }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
    );
    assert.ok(protocolReceipt);
    assert.ok(claimedState);
    assert.equal(fs.readFileSync(statePath, 'utf8'), claimedState);
    assert.equal(readProviderInvocation(runtime, invocationId).state, 'leased');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
