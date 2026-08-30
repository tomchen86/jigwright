import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import { approvalSubjectDigest } from '../src/modules/authority/grant-core.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import {
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  codeOwnedApprovalModuleRegistry,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadChangeContract } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import type { InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  resolvePlanReviewInvocationOwner,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import type { AgentRuntimePort } from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import type { ProviderInvocationAcceptanceBinding } from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import {
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
  type ProviderWrapperProtocolReceipt,
} from '../src/modules/provider-orchestration/agent-runtime-protocol.ts';
import {
  buildContextManifest,
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
} from '../src/modules/authority/execution-governance.ts';
import {
  executionJobStatePath,
  readExecutionJobState,
} from '../src/runtime/storage-journal/execution-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import {
  createPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  readPlanReviewTargetSnapshotNode,
  type PlanReviewSubject,
} from '../src/modules/assurance/plan-review.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import { createCurrentAgentRuntimeAssignmentV1 } from '../src/composition-root/change-role-assignment-production.ts';
import {
  createProductionChangeRoleAssignmentGrantPort,
  observeCurrentChangeRoleAssignmentGrantForInvocation,
} from '../src/composition-root/change-role-assignment-grant-production.ts';
import {
  assertChangeRoleAssignmentGrantParameters,
  changeRoleAssignmentGrantTransitionDefinitions,
  createChangeRoleAssignmentGrantRequest,
} from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import {
  createProviderInvocationCancellationGrantRequest,
  providerInvocationCancellationTransitionDefinitions,
} from '../src/modules/authority/provider-invocation-cancellation-grant.ts';
import {
  createProductionProviderInvocationCancellationGrantPort,
  observeCurrentProviderInvocationCancellationRequest,
} from '../src/composition-root/provider-invocation-cancellation-grant-production.ts';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import {
  createProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
  type ProviderRunnerReport,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocationForWorker,
  completeProviderInvocationFromRunner,
  createProviderInvocation,
  createProviderInvocationCancellationBinding,
  prepareProviderInvocationAcceptanceBinding,
  providerInvocationManifestDigest,
  releaseProviderInvocationWorkerFence,
  readProviderInvocation,
  readProviderInvocationCancellationRequest,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  type PlanReviewManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  ensureProviderPromptContext,
  providerPromptContextStoreRoot,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { createAsyncCliDispatcherForTesting } from '../src/cli.ts';
import {
  createProviderWorkerDispatcherForTesting,
  runProviderWorker,
  runProviderWorkerAsync,
} from '../src/entrypoints/worker/provider-worker.ts';
import {
  createFixtureRepository,
  git,
  writeReadyV3ExemptChange,
} from './fixture.ts';

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

for (const objectFormat of ['sha1', 'sha256'] as const) {
  test(`async provider worker completes the exact durable invocation through AgentRuntimePort on ${objectFormat}`, async () => {
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
            NonNullable<AgentRuntimePort['runSingleShotAsync']>
          >[0]['acceptanceBinding']
        | null = null;
      let runtimeSignal: AbortSignal | null = null;
      const controller = new AbortController();
      const agentRuntime: AgentRuntimePort = {
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
            executable: executableIdentity(),
            elapsedMs: 7,
            providerDefinitionSnapshot:
              resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin')!,
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
        schemaVersion: 1,
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
        terminalState: 'succeeded',
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
        'claude',
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
            executable: executableIdentity(),
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
    const agentRuntime: AgentRuntimePort = {
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
        const stream = Buffer.from(
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
            {
              schemaVersion: 1 as const,
              type: 'result' as const,
              sequence: 3,
              outputSlot: 'primary' as const,
            },
          ]
            .map(renderProviderWrapperFrame)
            .join(''),
          'utf8',
        );
        parser.push(stream);
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
    assert.equal(completed.completionReceipt.schemaVersion, 2);
    assert.ok('protocolReceipt' in completed.completionReceipt);
    assert.deepEqual(
      (
        completed.completionReceipt as unknown as {
          protocolReceipt: unknown;
        }
      ).protocolReceipt,
      protocolReceipt,
    );
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
    unknownVersion.runtimeReceipt.schemaVersion = 4;
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
      const agentRuntime: AgentRuntimePort = {
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
      const agentRuntime: AgentRuntimePort = {
        runSingleShot() {
          assert.fail('success-race fixture must use the async runtime');
        },
        async runSingleShotAsync(_input, options) {
          const signal = options.signal;
          assert.ok(signal);
          options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
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
      });
      await launched;
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
      const agentRuntime: AgentRuntimePort = {
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
      const agentRuntime: AgentRuntimePort = {
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
          const initialStream = Buffer.from(frames.join(''), 'utf8');
          parser.push(initialStream);
          if (fixture.mode !== 'error') {
            parser.requestCancellation();
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
      assert.equal(failed.completionReceipt?.schemaVersion, 3);
      assert.equal(failed.completionReceipt?.terminalState, 'failed');
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
          requested: fixture.mode !== 'error',
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
        unknownVersion.runtimeReceipt.schemaVersion = 4;
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

test('below-floor current role assignment blocks worker claim and detached spawn until exact Grant', async () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-agent-providers-grant-')),
  );
  const agentProviderConfigPath = path.join(
    hostDirectory,
    'agent-providers.toml',
  );
  const changeId = 'demo-change';
  try {
    const central = createCentralRoleProviderDefault({
      schemaVersion: 1,
      kind: 'central-role-provider-default',
      providerGroups: [
        {
          roles: ['author'],
          sessionGroups: [['author']],
          providerRule: { kind: 'adaptive-author' },
        },
        {
          roles: ['builder'],
          sessionGroups: [['builder']],
          providerRule: {
            kind: 'ranked-fallback',
            preferredLogicalProviderId: null,
          },
        },
        {
          roles: ['reviewer'],
          sessionGroups: [['reviewer']],
          providerRule: {
            kind: 'ranked-fallback',
            preferredLogicalProviderId: null,
          },
        },
      ],
      globalProviderRanking: ['claude', 'codex'],
    });
    fs.writeFileSync(
      path.join(repository, 'workflow/role-provider-default.json'),
      renderCentralRoleProviderDefault(central),
    );
    const overrideBody: AgentRolePlanBodyV2 = {
      schemaVersion: 2,
      changeId,
      baseCentralConfigurationDigest: central.configurationDigest,
      roleLanes: [],
      pairwiseRequirements: [
        { pair: 'author-builder', required: 'session-independent' },
        { pair: 'author-reviewer', required: 'session-independent' },
        { pair: 'builder-reviewer', required: 'session-independent' },
      ],
      customWrapperPolicy: 'forbidden',
      grantReferences: [],
    };
    const overridePath = agentRolePlanV2Path(changeId);
    fs.mkdirSync(path.dirname(path.join(repository, overridePath)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, overridePath),
      renderAgentRolePlanV2({
        ...overrideBody,
        planDigest: agentRolePlanV2Digest(overrideBody),
      }),
    );
    fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
    git(repository, [
      'add',
      'workflow/role-provider-default.json',
      overridePath,
    ]);
    git(repository, ['commit', '-m', 'Add below-floor role override']);

    const ready = writeReadyV3ExemptChange(repository, changeId);
    const contract = loadChangeContract(repository, changeId);
    assert.ok(contract.investigation);
    const investigationManifest = contract.investigation.manifest;
    const planningContext = deriveInvestigationFirstPlanningSubject(
      repository,
      contract,
    );
    const subject = planningContext.subject;
    const investigationId = investigationManifest.investigationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const invocationId = 'invocation-plan-review-below-floor';
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-below-floor',
      targetDigest: subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const materialization = writeCurrentPlanningMaterialization(
      runtime,
      investigationManifest,
      subject.investigationBaseline,
      {
        'proposal.md': sha256(
          fs.readFileSync(
            path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
            'utf8',
          ),
        ),
      },
    );
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId,
      changePrefix: `openspec/changes/${changeId}`,
      subject,
      materializationNode: materialization,
      artifacts: new Map([
        [
          'proposal.md',
          fs.readFileSync(
            path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
          ),
        ],
      ]),
    });
    writeEvidenceNode(runtime, targetSnapshotNode);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v3',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        roleTopology: sha256(canonicalJson(null)),
        subject: subject.subjectDigest,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      semanticParentResultDigests: {
        materialization: materialization.resultDigest,
        targetSnapshot: targetSnapshotNode.resultDigest,
      },
      provenanceParentNodeIds: {
        materialization: materialization.nodeId,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      outputSchema: 'workflow.plan-review-authorization-output.v3',
      output: {
        subject,
        assignment,
        author: {
          providerId: 'codex',
          sessionId: 'fixture-author-session',
          principalId: 'fixture-author',
          identityAssurance: 'adapter-assigned',
          engineSpawned: false,
        },
        grantAuthorization: null,
        roleTopology: null,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    for (const retiredVersion of [1, 2] as const) {
      const retiredAuthorization = createEvidenceNode({
        type: authorization.type,
        nodeSchema: `workflow.plan-review-authorization.v${retiredVersion}`,
        evaluator: authorization.evaluator,
        policyDigest: authorization.policyDigest,
        exactInputDigests: { ...authorization.exactInputDigests },
        semanticParentResultDigests: {
          ...authorization.semanticParentResultDigests,
        },
        provenanceParentNodeIds: {
          ...authorization.provenanceParentNodeIds,
        },
        outputSchema: `workflow.plan-review-authorization-output.v${retiredVersion}`,
        output: authorization.output,
        runtimeMetadata: {},
      });
      writeEvidenceNode(runtime, retiredAuthorization);
      assert.throws(
        () =>
          resolvePlanReviewInvocationOwner(runtime, {
            changeId,
            subject,
            assignment,
            authorizationNodeId: retiredAuthorization.nodeId,
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'EVIDENCE_REF_INVALID',
      );
    }
    const manifest: PlanReviewManifest = {
      schemaVersion: 1,
      kind: 'plan-review-manifest',
      changeId,
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject,
      capabilityProfile: 'repository-read-only',
      planningTarget: readPlanReviewTargetSnapshotNode(targetSnapshotNode),
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-below-floor-nonce-000001',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'plan-review.v2',
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: {
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
      },
    });
    assert.throws(
      () =>
        createCurrentAgentRuntimeAssignmentV1({
          repositoryRoot: repository,
          runtime,
          grantRuntimeRoot: path.dirname(runtime.root),
          changeId,
          request,
          configFilePath: agentProviderConfigPath,
          platform: 'darwin',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED',
    );
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId,
      attempt: 1,
      manifest,
      request,
      planReviewSnapshotFiles: [
        {
          snapshotFile: '0000.artifact',
          content: fs.readFileSync(
            path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
          ),
        },
      ],
    });

    let runnerCalls = 0;
    assert.throws(
      () =>
        runProviderWorker(repository, invocationId, {
          agentProviderConfigPath,
          platform: 'darwin',
          runner() {
            runnerCalls += 1;
            return successfulWorkerReport(request, invocationId);
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED' &&
        'details' in error &&
        (error.details as { invocationId?: unknown })?.invocationId ===
          invocationId,
    );
    assert.equal(runnerCalls, 0);
    assert.equal(
      readProviderInvocation(runtime, invocationId).state,
      'prepared',
    );

    let spawnCalls = 0;
    const dispatch = createProviderWorkerDispatcherForTesting(
      {
        spawn() {
          spawnCalls += 1;
          return { pid: 1234, unref() {} };
        },
      },
      { agentProviderConfigPath, platform: 'darwin' },
    );
    assert.throws(
      () => dispatch(repository, invocationId),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED',
    );
    assert.equal(spawnCalls, 0);
    assert.equal(
      readProviderInvocation(runtime, invocationId).state,
      'prepared',
    );

    const grantPort = createProductionChangeRoleAssignmentGrantPort(
      repository,
      { configFilePath: agentProviderConfigPath, platform: 'darwin' },
    );
    const grantObservation =
      observeCurrentChangeRoleAssignmentGrantForInvocation(
        repository,
        invocationId,
        { configFilePath: agentProviderConfigPath, platform: 'darwin' },
      );
    const grantRequest = createChangeRoleAssignmentGrantRequest(
      grantObservation,
      'Authorize only this exact current below-floor assignment.',
    );
    const grantParameters = assertChangeRoleAssignmentGrantParameters(
      grantRequest.candidates[0]!.parameters,
    );
    assert.throws(
      () =>
        grantPort.observe({
          ...grantParameters,
          repositoryId: 'a-different-immutable-repository',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
    );
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const grantNow = new Date('2030-08-29T02:00:00.000Z');
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(path.dirname(runtime.root)),
      registry: createTransitionRegistry(
        changeRoleAssignmentGrantTransitionDefinitions(grantPort),
      ),
      policy: parseGrantPolicyV2(
        {
          schemaVersion: 2,
          defaultProfile: 'local-presence',
          profiles: {
            'local-presence': {
              requiredClaims: ['fresh-local-device-owner'],
            },
          },
          approvalModules: [
            {
              moduleId: 'human-gate-macos',
              version: '1',
              allowedClaims: ['fresh-local-device-owner'],
              configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
            },
          ],
          legacyVerification: { maintainerPolicyV1: 'read-only' },
        },
        { registry: codeOwnedApprovalModuleRegistry() },
      ),
      now: () => new Date(grantNow),
      randomUUID: () => ids.shift()!,
      challengeTtlMs: 10 * 60_000,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'approve-exact-role-independence-exception',
              reason: 'Approve this exact current provider invocation only.',
              approvalMethod: 'human-presence' as const,
              sessionNonce: 'nonce-below-floor-provider-worker-000000001',
            };
          },
          async authenticate({ approvalSubjectDigest }) {
            const proof: VerifiedApprovalProof = {
              moduleId: 'human-gate-macos',
              version: '1',
              claims: ['fresh-local-device-owner'],
              approvalSubjectDigest,
              proofDigest: `sha256:${sha256('below-floor-human-proof')}`,
              verifiedAt: grantNow.toISOString(),
              identity: null,
              portableEvidence: null,
            };
            return [proof];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    const challenge = await coordinator.requestGrant(grantRequest);
    const completed = await coordinator.resolveChallenge(challenge.challengeId);
    assert.equal(completed.outcome, 'completed');

    const completedRecord = readGrantRecord(
      grantStorePaths(path.dirname(runtime.root)),
      challenge.challengeId,
    );
    assert.equal(completedRecord.state, 'completed');
    if (completedRecord.state !== 'completed') {
      assert.fail('expected completed role-assignment Grant');
    }
    const hostConfiguration = fs.readFileSync(agentProviderConfigPath);
    fs.unlinkSync(agentProviderConfigPath);
    try {
      const recoveredActivation = grantPort.activate({
        parameters: grantParameters,
        approvalSubject: completedRecord.approvalSubject,
        approvalSubjectDigest: approvalSubjectDigest(
          completedRecord.approvalSubject,
        ),
        challengeId: completedRecord.challenge.challengeId,
        operationId: completedRecord.operationId,
        recovered: true,
        assertLifecycleOwned() {},
      });
      assert.equal(
        recoveredActivation.activation?.challengeId,
        challenge.challengeId,
      );
      assert.throws(
        () =>
          grantPort.activate({
            parameters: grantParameters,
            approvalSubject: completedRecord.approvalSubject,
            approvalSubjectDigest: approvalSubjectDigest(
              completedRecord.approvalSubject,
            ),
            challengeId: completedRecord.challenge.challengeId,
            operationId: '55555555-5555-4555-8555-555555555555',
            recovered: true,
            assertLifecycleOwned() {},
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
      );
    } finally {
      fs.writeFileSync(agentProviderConfigPath, hostConfiguration);
    }

    const submission = {
      schemaVersion: 2 as const,
      verdict: 'advisory-approve' as const,
      coverage: [...PLAN_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge' as const,
        evidence: [
          {
            kind: 'investigation-node' as const,
            nodeId: ready.applicabilityNode.nodeId,
            resultDigest: ready.applicabilityNode.resultDigest,
          },
        ],
      },
      findings: [],
      proposedTerms: [],
      suggestions: [],
      residualRisk: 'The review cannot prove semantic completeness.',
      uncertainty: 'The provider operates under observed soft containment.',
    };
    const afterGrant = runProviderWorker(repository, invocationId, {
      agentProviderConfigPath,
      platform: 'darwin',
      runner() {
        runnerCalls += 1;
        return {
          invocationId,
          providerId: request.providerId,
          purpose: request.purpose,
          requestDigest: request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection' as const,
          projection: {
            unchanged: true as const,
            changedCategories: [],
            beforeDigest: 'd'.repeat(64),
            afterDigest: 'd'.repeat(64),
          },
          sameUserProcessConfined: false as const,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
          providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
            'claude',
            'darwin',
          )!,
        };
      },
    });
    assert.equal(afterGrant.state, 'succeeded', JSON.stringify(afterGrant));
    assert.equal(runnerCalls, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('provider worker selects the code-owned exact PlanReview contract', () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-agent-providers-')),
  );
  const agentProviderConfigPath = path.join(
    hostDirectory,
    'agent-providers.toml',
  );
  try {
    fs.writeFileSync(
      path.join(repository, 'workflow/role-provider-default.json'),
      renderCentralRoleProviderDefault(
        createCentralRoleProviderDefault({
          schemaVersion: 1,
          kind: 'central-role-provider-default',
          providerGroups: [
            {
              roles: ['author', 'builder', 'reviewer'],
              sessionGroups: [['author'], ['builder'], ['reviewer']],
              providerRule: { kind: 'adaptive-author' },
            },
          ],
          globalProviderRanking: ['claude', 'codex'],
        }),
      ),
    );
    fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
    git(repository, ['add', 'workflow/role-provider-default.json']);
    git(repository, ['commit', '-m', 'Add ordinary role provider defaults']);
    const ready = writeReadyV3ExemptChange(repository);
    const contract = loadChangeContract(repository, 'demo-change');
    assert.ok(contract.investigation);
    const investigationManifest = contract.investigation.manifest;
    const context = deriveInvestigationFirstPlanningSubject(
      repository,
      contract,
    );
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const invocationId = 'invocation-plan-review-worker';
    const investigationId = investigationManifest.investigationId;
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-worker',
      targetDigest: context.subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const materialization = writeCurrentPlanningMaterialization(
      runtime,
      investigationManifest,
      context.subject.investigationBaseline,
      {
        'proposal.md': sha256(
          fs.readFileSync(
            path.join(
              repository,
              'openspec/changes',
              'demo-change',
              'proposal.md',
            ),
            'utf8',
          ),
        ),
      },
    );
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId: 'demo-change',
      changePrefix: 'openspec/changes/demo-change',
      subject: context.subject,
      materializationNode: materialization,
      artifacts: new Map([
        [
          'proposal.md',
          fs.readFileSync(
            path.join(
              repository,
              'openspec/changes',
              'demo-change',
              'proposal.md',
            ),
          ),
        ],
      ]),
    });
    writeEvidenceNode(runtime, targetSnapshotNode);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v3',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: context.subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        roleTopology: sha256(canonicalJson(null)),
        subject: context.subject.subjectDigest,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      semanticParentResultDigests: {
        materialization: materialization.resultDigest,
        targetSnapshot: targetSnapshotNode.resultDigest,
      },
      provenanceParentNodeIds: {
        materialization: materialization.nodeId,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      outputSchema: 'workflow.plan-review-authorization-output.v3',
      output: {
        subject: context.subject,
        assignment,
        author: {
          providerId: 'codex',
          sessionId: 'fixture-author-session',
          principalId: 'fixture-author',
          identityAssurance: 'adapter-assigned',
          engineSpawned: false,
        },
        grantAuthorization: null,
        roleTopology: null,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    const manifest: PlanReviewManifest = {
      schemaVersion: 1,
      kind: 'plan-review-manifest',
      changeId: 'demo-change',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject: context.subject,
      capabilityProfile: 'repository-read-only',
      planningTarget: readPlanReviewTargetSnapshotNode(targetSnapshotNode),
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-worker-nonce-000000',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: context.subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'plan-review.v2',
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: {
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
      },
    });
    const currentAssignment = createCurrentAgentRuntimeAssignmentV1({
      repositoryRoot: repository,
      runtime,
      grantRuntimeRoot: path.dirname(runtime.root),
      changeId: 'demo-change',
      request,
      configFilePath: agentProviderConfigPath,
      platform: 'darwin',
    });
    assert.equal(currentAssignment.binding.role, 'reviewer');
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId: 'demo-change',
      attempt: 1,
      manifest,
      request,
      planReviewSnapshotFiles: [
        {
          snapshotFile: '0000.artifact',
          content: fs.readFileSync(
            path.join(
              repository,
              'openspec/changes',
              'demo-change',
              'proposal.md',
            ),
          ),
        },
      ],
    });
    const submission = {
      schemaVersion: 2 as const,
      verdict: 'advisory-approve' as const,
      coverage: [...PLAN_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge' as const,
        evidence: [
          {
            kind: 'investigation-node' as const,
            nodeId: ready.applicabilityNode.nodeId,
            resultDigest: ready.applicabilityNode.resultDigest,
          },
        ],
      },
      findings: [],
      proposedTerms: [],
      suggestions: [],
      residualRisk: 'The review cannot prove semantic completeness.',
      uncertainty: 'The provider operates under observed soft containment.',
    };
    const result = runProviderWorker(repository, invocationId, {
      agentProviderConfigPath,
      runner(input) {
        assert.ok(input.assignmentBinding);
        assert.equal(input.assignmentBinding.changeId, 'demo-change');
        assert.equal(input.assignmentBinding.role, 'reviewer');
        assert.equal(input.assignmentBinding.providerProfileId, 'claude-main');
        assert.equal(
          input.assignmentBinding.assignmentManifestDigest,
          loadChangeContract(repository, 'demo-change').investigation?.manifest
            .manifestDigest,
        );
        assert.notEqual(
          input.assignmentBinding.assignmentDigest,
          request.roleAssignmentDigest,
        );
        assert.equal(
          canonicalJson(input.assignmentBinding).includes(
            request.roleAssignment.sessionId,
          ),
          false,
        );
        assert.equal(
          sha256(canonicalJson(input.semanticOutputSchema)),
          PLAN_REVIEW_OUTPUT_SCHEMA.digest,
        );
        return {
          invocationId,
          providerId: 'claude',
          purpose: 'plan-review',
          requestDigest: request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: 'd'.repeat(64),
            afterDigest: 'd'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
          providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
            'claude',
            'darwin',
          )!,
        };
      },
    });
    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    assert.equal(
      readProviderInvocation(runtime, invocationId).result?.outputDigest,
      sha256(
        canonicalJson({
          id: PLAN_REVIEW_OUTPUT_SCHEMA.id,
          version: PLAN_REVIEW_OUTPUT_SCHEMA.version,
          output: submission,
        }),
      ),
    );

    const claudeProtocol = resolveBuiltInProviderDefinitionSnapshot(
      'claude',
      'darwin',
    )!.protocol;
    fs.writeFileSync(
      agentProviderConfigPath,
      agentProviderConfigToml().replace(
        `protocol = "${claudeProtocol}"`,
        'protocol = "definition-drift-jsonl-v1"',
      ),
    );
    let blockedLaunches = 0;
    assert.throws(
      () => {
        createCurrentAgentRuntimeAssignmentV1({
          repositoryRoot: repository,
          runtime,
          grantRuntimeRoot: path.dirname(runtime.root),
          changeId: 'demo-change',
          request,
          configFilePath: agentProviderConfigPath,
          platform: 'darwin',
        });
        blockedLaunches += 1;
      },
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_DEFINITION_MISMATCH',
    );
    assert.equal(blockedLaunches, 0);

    fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
    const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
    const deniedPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      providers: { claude: { enabled: boolean } };
    };
    deniedPolicy.providers.claude.enabled = false;
    fs.writeFileSync(policyPath, `${JSON.stringify(deniedPolicy, null, 2)}\n`);
    const deniedRequest = createProviderInvocationRequest({
      invocationId: 'invocation-plan-review-data-denied',
      nonce: 'plan-review-worker-nonce-000002',
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignment: request.roleAssignment,
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      writeAllowedPaths: [],
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: request.limits,
    });
    let deniedLaunches = 0;
    assert.throws(
      () => {
        createCurrentAgentRuntimeAssignmentV1({
          repositoryRoot: repository,
          runtime,
          grantRuntimeRoot: path.dirname(runtime.root),
          changeId: 'demo-change',
          request: deniedRequest,
          configFilePath: agentProviderConfigPath,
          platform: 'darwin',
        });
        deniedLaunches += 1;
      },
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_DATA_AUTHORIZATION_DENIED',
    );
    assert.equal(deniedLaunches, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

async function beginExactProviderCancellationGrant(
  repository: string,
  invocationId: string,
  reason: string,
) {
  const locator = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const lifecycleRuntime = runtimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const port =
    createProductionProviderInvocationCancellationGrantPort(repository);
  const observation = observeCurrentProviderInvocationCancellationRequest(
    repository,
    invocationId,
    reason,
  );
  const request = createProviderInvocationCancellationGrantRequest(
    observation,
    'Approve cancellation of this one exact claimed provider invocation.',
  );
  const grantNow = new Date('2030-08-30T01:00:00.000Z');
  const coordinator = createGrantCoordinatorKernel({
    paths: grantStorePaths(path.dirname(runtime.root)),
    registry: createTransitionRegistry(
      providerInvocationCancellationTransitionDefinitions(port),
    ),
    policy: parseGrantPolicyV2(
      {
        schemaVersion: 2,
        defaultProfile: 'local-presence',
        profiles: {
          'local-presence': {
            requiredClaims: ['fresh-local-device-owner'],
          },
        },
        approvalModules: [
          {
            moduleId: 'human-gate-macos',
            version: '1',
            allowedClaims: ['fresh-local-device-owner'],
            configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
          },
        ],
        legacyVerification: { maintainerPolicyV1: 'read-only' },
      },
      { registry: codeOwnedApprovalModuleRegistry() },
    ),
    now: () => new Date(grantNow),
    randomUUID: () => crypto.randomUUID(),
    challengeTtlMs: 10 * 60_000,
    openApprovalSession(presentation) {
      return {
        async collectDecision() {
          return {
            choiceId: presentation.choices[0]!.choiceId,
            reasonCode: 'cancel-exact-provider-invocation',
            reason: 'Approve only this exact provider cancellation.',
            approvalMethod: 'human-presence' as const,
            sessionNonce: 'nonce-provider-cancellation-grant-000000000001',
          };
        },
        async authenticate({ approvalSubjectDigest }) {
          const proof: VerifiedApprovalProof = {
            moduleId: 'human-gate-macos',
            version: '1',
            claims: ['fresh-local-device-owner'],
            approvalSubjectDigest,
            proofDigest: `sha256:${sha256(
              `provider-cancellation-proof:${invocationId}`,
            )}`,
            verifiedAt: grantNow.toISOString(),
            identity: null,
            portableEvidence: null,
          };
          return [proof];
        },
        async close() {},
      };
    },
    async withLifecycleOperation(challengeId, operation) {
      return withRepositoryLifecycleOperationAsync(
        lifecycleRuntime,
        operation,
        { allowGrantChallengeIds: [challengeId] },
      );
    },
  });
  const challenge = await coordinator.requestGrant(request);
  return {
    challengeId: challenge.challengeId,
    resolution: coordinator.resolveChallenge(challenge.challengeId),
  };
}

function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Exercise lifecycle-owned provider work.',
    explicitPaths: ['src/.gitkeep'],
    explicitSymbols: [],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}

function writeCurrentPlanningMaterialization(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  manifest: InvestigationManifestV3,
  baseline: PlanReviewSubject['investigationBaseline'],
  artifacts: Record<string, string>,
) {
  const investigationTargetDigest =
    manifest.investigationApproval.investigationTargetDigest;
  const sessionSnapshotDigest = manifest.authoring.sessionSnapshotDigest;
  const authority = createEvidenceNode({
    type: 'investigation-manifest-authority',
    nodeSchema: 'investigation.manifest-authority.v1',
    evaluator: 'workflow-propose.manifest-authority.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.manifest-authority-output.v1',
    output: {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
    },
    runtimeMetadata: {},
  });
  const materialization = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(baseline)),
      manifestAuthority: authority.nodeId,
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {
      manifestAuthority: authority.resultDigest,
    },
    provenanceParentNodeIds: { manifestAuthority: authority.nodeId },
    outputSchema: 'workflow.propose-planning-materialization-output.v3',
    output: {
      investigationId: manifest.investigationId,
      changeId: manifest.changeId,
      semanticRevision: manifest.authoring.sessionRevision,
      baseline,
      artifacts,
      manifestAuthorityNodeId: authority.nodeId,
      manifestAuthorityResultDigest: authority.resultDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
      sessionSnapshotDigest,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authority);
  writeEvidenceNode(runtime, materialization);
  return materialization;
}

function lowerAdapterLimits(repository: string): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.limits.timeoutMs = 12_345;
  policy.limits.aggregateOutputBytes = 54_321;
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

function agentProviderConfigToml(): string {
  const claude = resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin')!;
  const codex = resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')!;
  return `schema_version = 2
global_ranking = ["claude-main", "codex-main"]

[[providers]]
id = "claude-main"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${claude.protocol}"
executable = "${claude.executableCandidates[0]}"

[[providers]]
id = "codex-main"
logical_provider_id = "codex"
family = "codex"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${codex.protocol}"
executable = "${codex.executableCandidates[0]}"

[provider_preferences]
author = ["claude-main", "codex-main"]
builder = ["claude-main", "codex-main"]
reviewer = ["claude-main", "codex-main"]
`;
}

function successfulWorkerReport(
  request: ProviderInvocationRequest,
  invocationId: string,
) {
  const semanticOutput = {
    reference: invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderWorker' }],
  };
  return {
    invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false as const,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: executableIdentity(),
    elapsedMs: 7,
    providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
      request.providerId,
      'darwin',
    )!,
  };
}

function executableIdentity() {
  return {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/bin/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
