import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { type ProviderInvocationAcceptanceBinding } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { createProviderRunnerForTesting } from '../src/runtime/provider-execution/provider-runner.ts';
import { spawnBoundedProviderProcess } from '../src/runtime/provider-execution/bounded-provider-process.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { createBuiltInAgentRuntimeV1Bridge } from '../src/composition-root/agent-runtime-v1-production.ts';
import { runHostWrapperProviderThroughAgentRuntimeV1 } from '../src/composition-root/agent-runtime-host-wrapper-production.ts';
import { productionAgentRuntime } from '../src/composition-root/agent-runtime-production.ts';
import { type HostWrapperProviderProfileSnapshot } from '@jigwright/agent-runtime';
import type { AgentRuntimeNativeSessionTurnControllerV1 } from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import { createAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-assignment-binding.ts';
import {
  assertAgentRuntimeHostExecutionBindingV1,
  type AgentRuntimeHostExecutionBindingV1,
} from '../src/modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import {
  type ProviderNativeSessionClaimV1,
  type ProviderNativeSessionCompletionV1,
} from '../src/modules/provider-orchestration/provider-native-session.ts';
import { createOrReadExactChangeRoleAssignmentRecordV1 } from '../src/runtime/storage-journal/change-role-assignment-store.ts';
import {
  claimProviderNativeSessionTurnV1,
  completeClaimedProviderNativeSessionTurnV1,
  readProviderNativeSessionChainV1,
} from '../src/runtime/storage-journal/provider-native-session-store.ts';
import {
  providerNativeSessionCompletionObjectPathV1,
  providerNativeSessionCompletionRefPathV1,
  providerNativeSessionStorePathsV1,
} from '../src/runtime/session-workspace/provider-runtime-authority-paths.ts';
import {
  assertProviderRuntimeProtocolReceipt,
  type ProviderRuntimeProtocolReceipt,
  type ProviderWrapperProtocolReceipt,
} from '../src/modules/provider-orchestration/agent-runtime-protocol.ts';
import { sourceRepositoryRoot } from './fixture.ts';
import {
  PROVIDER_SCHEMA,
  providerWrapperFixture,
  builtInProfile,
  createRunnerFixture,
  hostWrapperProfile,
  durableHostWrapperAssignment,
  canonicalHostWrapperFixture,
  hostWrapperStartController,
  hostWrapperInput,
  hostWrapperAssignmentBinding,
  fakeNativeSessionClaim,
  semanticOutput,
  outputValidatorFor,
  bindRunnerInputToInvestigationOwner,
  executableIdentity,
  claudeRunnerHost,
  sha256,
} from './provider-adapter-fixture.ts';

function runtimeV1BridgeFixture(
  repository: string,
  invocationDirectory: string,
) {
  const request = createProviderInvocationRequest({
    invocationId: 'invocation-runtime-v1-bridge',
    nonce: 'runtime-v1-bridge-nonce-000000000',
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'plan-reviewer',
      providerId: 'claude',
      sessionId: 'runtime-v1-bridge-session',
      targetDigest: '1'.repeat(64),
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'runtime-v1-fixture',
    baseCommit: '2'.repeat(40),
    baseTree: '3'.repeat(40),
    targetDigest: '1'.repeat(64),
    inputManifestDigest: '4'.repeat(64),
    authorizationNodeId: '5'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: {
      id: 'runtime-v1-output',
      version: 1,
      digest: sha256(canonicalJson(PROVIDER_SCHEMA)),
    },
    evaluatorVersion: 'runtime-v1-fixture',
    policyDigest: '6'.repeat(64),
    limits: { timeoutMs: 30_000, aggregateOutputBytes: 1_048_576 },
  });
  const definition = resolveBuiltInProviderDefinitionSnapshot(
    'claude',
    'darwin',
  )!;
  const executable = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
  );
  const selectedProfile = builtInProfile(executable.candidatePath);
  const acceptancePayload = {
    schemaVersion: 1 as const,
    kind: 'provider-invocation-acceptance-binding' as const,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    ownerWorkflowId: 'workflow-runtime-v1',
    invocationRevision: 1,
    leaseGeneration: 1,
    context: {
      ownerWorkflowId: 'workflow-runtime-v1',
      purpose: request.purpose,
      workflowId: 'workflow-runtime-v1',
      generation: 1,
      epoch: 1,
      contextDigest: '8'.repeat(64),
      manifest:
        {} as ProviderInvocationAcceptanceBinding['context']['manifest'],
    },
    executionJobId: 'job-runtime-v1',
    executionAttemptId: 'attempt-runtime-v1',
    executionRevision: 1,
    executionStateDigest: '9'.repeat(64),
    receiptRequirement: 'schema-v4' as const,
    repair: {
      invocationId: request.invocationId,
      lineagePath: path.join(invocationDirectory, 'repair-lineage.json'),
      lineageDigest: null,
      currentEvidencePath: path.join(
        invocationDirectory,
        'repair-evidence.json',
      ),
      evidencePath: null,
      evidenceDigest: null,
    },
  };
  const acceptanceBinding = {
    ...acceptancePayload,
    bindingDigest: sha256(canonicalJson(acceptancePayload)),
  };
  const bridgeInput = {
    providerId: 'claude' as const,
    repositoryRoot: repository,
    invocationDirectory,
    request,
    semanticOutputSchema: PROVIDER_SCHEMA,
    outputValidator: outputValidatorFor(request),
    governedRuntimeInputs: [],
    acceptanceBinding,
    reviewSnapshotRoot: null,
    sourceEnvironment: {},
    assignmentBinding: createAgentRuntimeAssignmentBindingV1({
      schemaVersion: 1,
      kind: 'agent-runtime-assignment-binding.v1',
      changeId: 'runtime-v1-bridge',
      planningGeneration: 'b'.repeat(64),
      recordDigest: 'c'.repeat(64),
      assignmentDigest: 'd'.repeat(64),
      role: 'author',
      logicalProviderId: 'claude',
      providerProfileId: selectedProfile.id,
      providerProfileSnapshot: selectedProfile,
      definitionDigest: definition.definitionDigest,
      dataAuthorizationPolicyDigest: request.policyDigest,
      assignmentManifestDigest: 'e'.repeat(64),
      inputManifestDigest: request.inputManifestDigest,
      targetDigest: request.targetDigest,
    }),
  };
  return { request, definition, executable, selectedProfile, bridgeInput };
}

test('public AgentRuntimePortV1 bridges one fresh single-shot into the existing runner', async () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-v1-bridge-'),
  );
  const invocationDirectory = path.join(repository, 'invocation');
  fs.mkdirSync(invocationDirectory);
  const activity: string[] = [];
  try {
    const { request, definition, executable, selectedProfile, bridgeInput } =
      runtimeV1BridgeFixture(repository, invocationDirectory);
    const bridge = createBuiltInAgentRuntimeV1Bridge({
      preflight(providerId, options, profile) {
        assert.equal(providerId, 'claude');
        assert.equal(options.platform, 'darwin');
        assert.deepEqual(profile, selectedProfile);
        return {
          status: 'available',
          executable,
          version: '2.1.206 (Claude Code)',
        };
      },
      async runAsync(input, options) {
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({ type: 'stdout', elapsedMs: 1, bytes: 7 });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        const output = semanticOutput(request);
        return {
          invocationId: request.invocationId,
          providerId: request.providerId,
          purpose: request.purpose,
          requestDigest: request.requestDigest,
          semanticOutput: output,
          semanticOutputDigest: sha256(canonicalJson(output)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '7'.repeat(64),
            afterDigest: '7'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: ['SAME_USER_PROCESS_NOT_CONFINED'],
          executable,
          elapsedMs: 2,
          providerDefinitionSnapshot: definition,
        };
      },
    });
    const report = await bridge(bridgeInput, {
      platform: 'darwin',
      onActivity(event) {
        activity.push(event.type);
      },
    });

    assert.deepEqual(report.semanticOutput, semanticOutput(request));
    assert.equal(report.requestDigest, request.requestDigest);
    assert.equal(report.assurance, 'unchanged-governed-projection');
    assert.deepEqual(activity, ['spawned', 'stdout', 'exited']);
    assert.deepEqual(
      report.providerDefinitionSnapshot,
      resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('public AgentRuntimePortV1 keeps observed activity when the run fails', async () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-v1-bridge-failure-'),
  );
  const invocationDirectory = path.join(repository, 'invocation');
  fs.mkdirSync(invocationDirectory);
  const activity: string[] = [];
  const crash = new TypeError('runner crashed after the process spawned');
  try {
    const { executable, bridgeInput } = runtimeV1BridgeFixture(
      repository,
      invocationDirectory,
    );
    const bridge = createBuiltInAgentRuntimeV1Bridge({
      preflight() {
        return {
          status: 'available',
          executable,
          version: '2.1.206 (Claude Code)',
        };
      },
      async runAsync(_input, options) {
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({ type: 'stdout', elapsedMs: 1, bytes: 7 });
        throw crash;
      },
    });

    await assert.rejects(
      bridge(bridgeInput, {
        platform: 'darwin',
        onActivity(event) {
          activity.push(event.type);
        },
      }),
      (error: unknown) => error === crash,
    );
    assert.deepEqual(
      activity,
      ['spawned', 'stdout'],
      'a failed run still has to account for the process it started',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async runner consumes harness-jsonl-v1 only after explicit adapter opt-in', async () => {
  const fixture = createRunnerFixture();
  const input = {
    ...bindRunnerInputToInvestigationOwner(
      fixture.input,
      'investigation-provider-wrapper-fixture',
    ),
    wrapperProtocol: { protocol: 'harness-jsonl-v1' as const },
  };
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('wrapper protocol execution must remain asynchronous');
    });
    host.executeAsync = async (executeInput, control) => {
      assert.equal(control.wrapperProtocol?.protocol, 'harness-jsonl-v1');
      fs.writeFileSync(
        path.join(
          fixture.input.invocationDirectory,
          'runtime',
          'semantic-output.json',
        ),
        canonicalJson(semanticOutput(fixture.request)),
      );
      return await spawnBoundedProviderProcess({
        executable: process.execPath,
        args: [providerWrapperFixture, 'success'],
        cwd: executeInput.cwd,
        environment: executeInput.environment,
        timeoutMs: executeInput.timeoutMs,
        maxOutputBytes: executeInput.maxOutputBytes,
        wrapperProtocol: control.wrapperProtocol!,
      });
    };

    const report = await createProviderRunnerForTesting(host).runAsync(input, {
      platform: 'darwin',
    });

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.wrapperProtocolReceipt?.terminal, 'result');
    assert.equal(
      report.wrapperProtocolReceipt?.attemptId,
      input.acceptanceBinding!.executionAttemptId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('production host-wrapper bridge starts and resumes one private native session through the public v1 port', async () => {
  const first = createRunnerFixture();
  const second = createRunnerFixture();
  const wrapper = path.join(
    sourceRepositoryRoot,
    'packages/agent-runtime/test/fixtures/provider-wrapper-fixture.mjs',
  );
  const profile = hostWrapperProfile(wrapper, true);
  const nativeSessionId = 'native-host-wrapper-1';
  const completionDigests = ['1'.repeat(64), '2'.repeat(64)];
  const terminals: unknown[] = [];
  const successActivities: string[] = [];
  let claimCount = 0;
  const controller = (
    action: 'start' | 'resume',
  ): Omit<
    AgentRuntimeNativeSessionTurnControllerV1,
    'assignmentBinding' | 'invocationBinding'
  > => ({
    profile,
    nextAction() {
      return action;
    },
    claim({ attemptId, expectedAction }) {
      assert.equal(expectedAction, action);
      claimCount += 1;
      const runtimeInput = action === 'start' ? first.input : second.input;
      const binding = {
        invocationId: runtimeInput.request.invocationId,
        requestDigest: runtimeInput.request.requestDigest,
        attemptId,
        sessionControl:
          action === 'start'
            ? {
                action: 'start' as const,
                nativeSessionIdentityMode: 'provider-observed' as const,
                expectedNativeSessionId: null,
              }
            : {
                action: 'resume' as const,
                nativeSessionIdentityMode: 'engine-supplied' as const,
                expectedNativeSessionId: nativeSessionId,
              },
      };
      const claim = fakeNativeSessionClaim(
        hostWrapperAssignmentBinding(runtimeInput, profile),
        profile,
        binding,
        action === 'start' ? null : completionDigests[0]!,
      );
      return {
        claim,
        claimDigest: claim.claimDigest,
        predecessorCompletionDigest:
          action === 'start' ? null : completionDigests[0]!,
        binding,
      };
    },
    complete(input) {
      terminals.push(input.terminal);
      return { completionDigest: completionDigests[terminals.length - 1]! };
    },
  });
  try {
    const firstInput = hostWrapperInput(
      bindRunnerInputToInvestigationOwner(
        first.input,
        'investigation-host-wrapper-start',
      ),
      profile,
      controller('start'),
    );
    const firstReport = await productionAgentRuntime.runSingleShotAsync(
      firstInput,
      {
        platform: process.platform,
        onActivity(event) {
          successActivities.push(event.type);
          throw new Error('activity observer must remain non-authoritative');
        },
      },
    );
    assert.deepEqual(firstReport.semanticOutput, semanticOutput(first.request));
    assert.ok(successActivities.includes('spawned'));
    assert.ok(successActivities.includes('exited'));
    assert.equal(
      (
        firstReport.providerDefinitionSnapshot as HostWrapperProviderProfileSnapshot
      ).profileDigest,
      profile.profileDigest,
    );
    const firstHostBinding = firstReport.hostExecutionBinding;
    assert.ok(firstHostBinding?.probe);
    assert.deepEqual(firstHostBinding.probe.executable, firstReport.executable);
    const forgedHostBinding = structuredClone(
      firstHostBinding,
    ) as unknown as Record<string, unknown>;
    const forgedProbe = forgedHostBinding.probe as Record<string, unknown>;
    const forgedExecutable = forgedProbe.executable as Record<string, unknown>;
    forgedExecutable.candidatePath = `${wrapper}.forged`;
    forgedProbe.providerDefinitionBindingDigest = sha256(
      canonicalJson({
        providerDefinitionDigest: forgedProbe.providerProfileDigest,
        executable: forgedExecutable,
      }),
    );
    const forgedBody = { ...forgedHostBinding };
    delete forgedBody.bindingDigest;
    forgedHostBinding.bindingDigest = sha256(
      `workflow.agent-runtime-host-execution-binding.v1\n${canonicalJson(forgedBody)}`,
    );
    assert.throws(() =>
      assertAgentRuntimeHostExecutionBindingV1(forgedHostBinding),
    );
    const forgedExecutableBinding = structuredClone(
      firstHostBinding,
    ) as unknown as Record<string, unknown>;
    const forgedExecutableProbe = forgedExecutableBinding.probe as Record<
      string,
      unknown
    >;
    const forgedExecutableIdentity = forgedExecutableProbe.executable as Record<
      string,
      unknown
    >;
    forgedExecutableIdentity.realPath = `${forgedExecutableIdentity.realPath as string}.forged`;
    const forgedExecutableBody = { ...forgedExecutableBinding };
    delete forgedExecutableBody.bindingDigest;
    forgedExecutableBinding.bindingDigest = sha256(
      `workflow.agent-runtime-host-execution-binding.v1\n${canonicalJson(forgedExecutableBody)}`,
    );
    assert.throws(() =>
      assertAgentRuntimeHostExecutionBindingV1(forgedExecutableBinding),
    );

    const secondInput = hostWrapperInput(
      bindRunnerInputToInvestigationOwner(
        second.input,
        'investigation-host-wrapper-resume',
      ),
      profile,
      controller('resume'),
    );
    const secondReport = await productionAgentRuntime.runSingleShotAsync(
      secondInput,
      { platform: process.platform },
    );
    assert.deepEqual(
      secondReport.semanticOutput,
      semanticOutput(second.request),
    );
    assert.equal(claimCount, 2);
    assert.equal(terminals.length, 2);
    assert.equal(JSON.stringify(terminals).includes(nativeSessionId), true);
    assert.equal(JSON.stringify(firstReport).includes(nativeSessionId), false);
    assert.equal(JSON.stringify(secondReport).includes(nativeSessionId), false);

    const firstReceipt = firstReport.wrapperProtocolReceipt;
    if (firstReceipt?.kind !== 'provider-wrapper-session-protocol-receipt') {
      assert.fail('host-wrapper start omitted its session protocol receipt');
    }
    const forgedResumeReceipt = structuredClone(
      firstReceipt,
    ) as unknown as Record<string, unknown>;
    forgedResumeReceipt.sessionAction = 'resume';
    forgedResumeReceipt.nativeSessionIdentityMode = 'engine-supplied';
    forgedResumeReceipt.expectedNativeSessionIdDigest =
      forgedResumeReceipt.observedNativeSessionIdDigest;
    const forgedPayload = { ...forgedResumeReceipt };
    delete forgedPayload.receiptDigest;
    forgedResumeReceipt.receiptDigest = sha256(canonicalJson(forgedPayload));
    assert.throws(() =>
      assertProviderRuntimeProtocolReceipt(forgedResumeReceipt, {
        invocationId: first.request.invocationId,
        requestDigest: first.request.requestDigest,
        attemptId: firstInput.acceptanceBinding.executionAttemptId,
        sessionControl: {
          action: 'start',
          nativeSessionIdentityMode: 'provider-observed',
          expectedNativeSessionId: null,
        },
      }),
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('production host-wrapper preserves terminal error evidence for the worker failure channel', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-error-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('error', 2), {
    mode: 0o700,
  });
  const profile = hostWrapperProfile(wrapper, false);
  const terminals: unknown[] = [];
  const observed: ProviderRuntimeProtocolReceipt[] = [];
  const activities: string[] = [];
  const failedHostBindings: AgentRuntimeHostExecutionBindingV1[] = [];
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-error',
  );
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          boundInput,
          profile,
          hostWrapperStartController(boundInput, profile, terminals),
        ),
        {
          platform: process.platform,
          onActivity(event) {
            activities.push(event.type);
            throw new Error('activity observer must remain non-authoritative');
          },
          onProtocolReceipt(receipt) {
            observed.push(receipt);
            throw new Error('receipt observer must remain non-authoritative');
          },
          onHostExecutionBinding(binding) {
            failedHostBindings.push(binding);
          },
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
    );
    assert.equal(observed.length, 1);
    assert.equal(
      observed[0]!.kind,
      'provider-wrapper-session-protocol-receipt',
    );
    assert.equal(observed[0]!.terminal, 'error');
    assert.equal(observed[0]!.errorCode, 'FIXTURE_REJECTED');
    assert.ok(activities.includes('spawned'));
    assert.ok(activities.includes('stdout'));
    assert.ok(activities.includes('exited'));
    assert.equal(failedHostBindings.length, 1);
    const failedHostBinding = assertAgentRuntimeHostExecutionBindingV1(
      failedHostBindings[0],
    );
    assert.ok(failedHostBinding.probe);
    assert.equal(
      failedHostBinding.probe.executable.candidatePath,
      profile.executable,
    );
    assert.equal(terminals.length, 1);
    assert.deepEqual(terminals[0], {
      kind: 'protocol-outcome',
      outcome: {
        schemaVersion: 2,
        kind: 'provider-wrapper-session-protocol-outcome',
        receipt: observed[0],
      },
      privateIdentityObservation: null,
    });
  } finally {
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper preserves cancelled process activity for the durable worker receipt', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-cancelled-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('cancelled'), {
    mode: 0o700,
  });
  const profile = hostWrapperProfile(wrapper, false);
  const terminals: unknown[] = [];
  const observed: ProviderRuntimeProtocolReceipt[] = [];
  const activities: string[] = [];
  const cancellation = new AbortController();
  const readyPath = path.join(hostDirectory, 'provider-ready');
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-cancelled',
  );
  // Probe completion precedes native startup; wait for its SIGTERM handler.
  fs.watchFile(readyPath, { interval: 10 }, (current) => {
    if (current.size > 0) cancellation.abort();
  });
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          boundInput,
          profile,
          hostWrapperStartController(boundInput, profile, terminals),
        ),
        {
          platform: process.platform,
          signal: cancellation.signal,
          onActivity(event) {
            activities.push(event.type);
          },
          onProtocolReceipt(receipt) {
            observed.push(receipt);
          },
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.terminal, 'cancelled');
    assert.ok(activities.includes('spawned'));
    assert.ok(activities.includes('cancelled'));
    assert.deepEqual(terminals, [
      {
        kind: 'protocol-outcome',
        outcome: {
          schemaVersion: 2,
          kind: 'provider-wrapper-session-protocol-outcome',
          receipt: observed[0],
        },
        privateIdentityObservation: null,
      },
    ]);
  } finally {
    fs.unwatchFile(readyPath);
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper never turns a nonzero process with a result frame into a usable native session', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-nonzero-result-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('result', 1), {
    mode: 0o700,
  });
  const profile = hostWrapperProfile(wrapper, false);
  const terminals: unknown[] = [];
  const observed: ProviderRuntimeProtocolReceipt[] = [];
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-nonzero-result',
  );
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          boundInput,
          profile,
          hostWrapperStartController(boundInput, profile, terminals),
        ),
        {
          platform: process.platform,
          onProtocolReceipt(receipt) {
            observed.push(receipt);
          },
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.terminal, 'result');
    assert.deepEqual(terminals, [
      {
        kind: 'protocol-outcome',
        outcome: {
          schemaVersion: 2,
          kind: 'provider-wrapper-session-protocol-outcome',
          receipt: observed[0],
        },
        privateIdentityObservation: null,
      },
    ]);
  } finally {
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper seals a semantically rejected result turn without a resumable handle', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-invalid-result-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('result'), {
    mode: 0o700,
  });
  const changeId = 'host-wrapper-invalid-result';
  const locator = discoverRepository(fixture.repository);
  const runtime = investigationRuntimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const assignment = durableHostWrapperAssignment(
    changeId,
    fixture.request,
    wrapper,
    true,
  );
  createOrReadExactChangeRoleAssignmentRecordV1(
    runtime,
    assignment.record,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
  );
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-invalid-result',
  );
  const nativeClaims: ProviderNativeSessionClaimV1[] = [];
  const nativeCompletions: ProviderNativeSessionCompletionV1[] = [];
  const hostBindings: AgentRuntimeHostExecutionBindingV1[] = [];
  const protocolReceipts: ProviderRuntimeProtocolReceipt[] = [];
  const input = hostWrapperInput(
    {
      ...boundInput,
      outputValidator: {
        ...boundInput.outputValidator,
        validate: () => false,
      },
    },
    assignment.profile,
    {
      profile: assignment.profile,
      nextAction: () => 'start',
      claim({ attemptId }) {
        const claimed = claimProviderNativeSessionTurnV1(
          runtime,
          {
            changeId: assignment.record.changeId,
            planningGeneration: assignment.record.planningGeneration,
            assignmentRecordDigest: assignment.record.recordDigest,
            sessionSlotId: assignment.slot.sessionSlotId,
            predecessorCompletionDigest: null,
            invocationId: fixture.request.invocationId,
            requestDigest: fixture.request.requestDigest,
            attemptId,
          },
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.ok(claimed.binding);
        nativeClaims.push(claimed.claim);
        return {
          claim: claimed.claim,
          claimDigest: claimed.claim.claimDigest,
          predecessorCompletionDigest: null,
          binding: claimed.binding,
        };
      },
      complete(value) {
        const nativeClaim = nativeClaims.at(-1);
        assert.ok(nativeClaim);
        const completion = completeClaimedProviderNativeSessionTurnV1(runtime, {
          changeId: assignment.record.changeId,
          planningGeneration: assignment.record.planningGeneration,
          assignmentRecordDigest: assignment.record.recordDigest,
          sessionSlotId: assignment.slot.sessionSlotId,
          claimDigest: nativeClaim.claimDigest,
          terminal: value.terminal,
        });
        nativeCompletions.push(completion);
        return { completionDigest: completion.completionDigest };
      },
    },
    assignment.binding,
  );
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(input, {
        platform: process.platform,
        onProtocolReceipt(receipt) {
          protocolReceipts.push(receipt);
        },
        onHostExecutionBinding(binding) {
          hostBindings.push(binding);
        },
      }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_OUTPUT_INVALID',
    );
    assert.equal(nativeClaims.length, 1);
    assert.equal(nativeCompletions.length, 1);
    const completion = nativeCompletions[0]!;
    assert.equal(completion.disposition, 'rejected');
    assert.equal(completion.usable, false);
    assert.equal(completion.protocolReceipt?.terminal, 'result');
    assert.notEqual(completion.nativeSessionIdDigest, null);
    assert.equal(completion.handleDigest, null);
    assert.deepEqual(protocolReceipts, [completion.protocolReceipt]);
    assert.equal(hostBindings.length, 1);
    const hostBinding = assertAgentRuntimeHostExecutionBindingV1(
      hostBindings[0],
    );
    assert.equal(
      hostBinding.nativeSessionCompletionDigest,
      completion.completionDigest,
    );
    const chain = readProviderNativeSessionChainV1(
      runtime,
      assignment.record.changeId,
      assignment.record.planningGeneration,
      assignment.record.recordDigest,
      assignment.slot.sessionSlotId,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
    );
    assert.equal(chain.state, 'terminal-unusable');
    assert.equal(
      chain.turns[0]?.completion?.completionDigest,
      completion.completionDigest,
    );
    const locations = providerNativeSessionStorePathsV1(runtime);
    assert.equal(
      fs.existsSync(
        providerNativeSessionCompletionObjectPathV1(
          locations,
          completion.completionDigest,
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        providerNativeSessionCompletionRefPathV1(
          locations,
          nativeClaims[0]!.scope.scopeKey,
          nativeClaims[0]!.turn,
        ),
      ),
      true,
    );
    assert.deepEqual(
      fs.existsSync(locations.handles) ? fs.readdirSync(locations.handles) : [],
      [],
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('host-wrapper resume unsupported by its definition fails before claim or launch', async () => {
  const fixture = createRunnerFixture();
  const wrapper = path.join(
    sourceRepositoryRoot,
    'packages/agent-runtime/test/fixtures/provider-wrapper-fixture.mjs',
  );
  const profile = hostWrapperProfile(wrapper, false);
  let claims = 0;
  const controller: Omit<
    AgentRuntimeNativeSessionTurnControllerV1,
    'assignmentBinding' | 'invocationBinding'
  > = {
    profile,
    nextAction: () => 'resume',
    claim() {
      claims += 1;
      throw new Error('claim must remain unreachable');
    },
    complete() {
      throw new Error('completion must remain unreachable');
    },
  };
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          bindRunnerInputToInvestigationOwner(
            fixture.input,
            'investigation-host-wrapper-unsupported-resume',
          ),
          profile,
          controller,
        ),
        { platform: process.platform },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_RESUME_UNSUPPORTED',
    );
    assert.equal(claims, 0);
    assert.equal(
      fs.existsSync(
        path.join(fixture.input.invocationDirectory, 'host-wrapper-runtime'),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

for (const fixtureMode of ['error', 'cancel-ack', 'cancel-ignore'] as const) {
  test(`async runner exposes the validated ${fixtureMode} wrapper receipt on its failure channel`, async () => {
    const fixture = createRunnerFixture();
    const input = {
      ...bindRunnerInputToInvestigationOwner(
        fixture.input,
        `investigation-provider-wrapper-${fixtureMode}`,
      ),
      wrapperProtocol: { protocol: 'harness-jsonl-v1' as const },
    };
    const controller = new AbortController();
    const observed: ProviderWrapperProtocolReceipt[] = [];
    try {
      const host = claudeRunnerHost(() => {
        assert.fail('wrapper protocol execution must remain asynchronous');
      });
      host.executeAsync = async (executeInput, control) =>
        await spawnBoundedProviderProcess({
          executable: process.execPath,
          args: [providerWrapperFixture, fixtureMode],
          cwd: executeInput.cwd,
          environment: executeInput.environment,
          timeoutMs: executeInput.timeoutMs,
          maxOutputBytes: executeInput.maxOutputBytes,
          ...(fixtureMode === 'error' ? {} : { signal: controller.signal }),
          wrapperProtocol: {
            ...control.wrapperProtocol!,
            ...(fixtureMode === 'error'
              ? {}
              : {
                  onFrame(receipt) {
                    if (receipt.frame.type === 'hello') controller.abort();
                  },
                }),
          },
        });

      await assert.rejects(
        createProviderRunnerForTesting(host).runAsync(input, {
          platform: 'darwin',
          ...(fixtureMode === 'error' ? {} : { signal: controller.signal }),
          onProtocolReceipt(receipt) {
            if (receipt.kind !== 'provider-wrapper-protocol-receipt') {
              assert.fail(
                'harness-jsonl-v1 emitted a session protocol receipt',
              );
            }
            observed.push(receipt);
            if (fixtureMode === 'error') {
              throw new Error('receipt observer must be non-authoritative');
            }
          },
        }),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code ===
            (fixtureMode === 'error'
              ? 'PROVIDER_WRAPPER_REPORTED_ERROR'
              : 'PROVIDER_PROCESS_CANCELLED'),
      );

      assert.equal(observed.length, 1);
      assert.equal(
        observed[0]!.terminal,
        fixtureMode === 'error' ? 'error' : 'cancelled',
      );
      assert.deepEqual(observed[0]!.cancellation, {
        requested: fixtureMode !== 'error',
        acknowledged: fixtureMode === 'cancel-ack',
        forced: fixtureMode === 'cancel-ignore',
      });
      assert.equal(
        observed[0]!.attemptId,
        input.acceptanceBinding!.executionAttemptId,
      );
    } finally {
      fixture.cleanup();
    }
  });
}

test('async runner releases its concurrency slot after execution rejects', async () => {
  const fixture = createRunnerFixture();
  const expected = new Error('async execution failed');
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('the async runner must not use synchronous execution');
    });
    host.executeAsync = async () => {
      throw expected;
    };

    await assert.rejects(
      createProviderRunnerForTesting(host).runAsync(fixture.input, {
        platform: 'darwin',
      }),
      expected,
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.repository,
          '.git',
          'workflow-engine',
          'investigations',
          'provider-slots',
        ),
      ),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});
