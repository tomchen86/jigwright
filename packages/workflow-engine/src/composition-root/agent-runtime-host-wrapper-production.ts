/**
 * Runs host-wrapper provider turns and publishes AgentRuntime protocol
 * completion.
 *
 * Invariants:
 * - Resume requires an advertised resumable-session capability and resume
 *   arguments.
 * - Observed process activity reaches the consumer even when the turn fails.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  agentRuntimeNativeSessionIdDigestV1,
  agentRuntimeOutputSchemaDigestV1,
  assertAgentRuntimeDefinitionIdentityV1,
  assertAgentRuntimeResumeInputV1,
  assertAgentRuntimeStartInputV1,
  createAgentRuntimeAttemptBindingV1,
  createAgentRuntimeCapabilitiesV1,
  type AgentRuntimeDefinitionIdentityV1,
  type AgentRuntimeEventV1,
  type AgentRuntimeLaunchDefinitionSourceV1,
  type AgentRuntimeResumeInputV1,
  type AgentRuntimeStartInputV1,
} from '@jigwright/core/agent-runtime-port';
import {
  assertAgentProviderProfileSnapshot,
  type HostWrapperProviderProfileSnapshot,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolOutcome,
} from '@jigwright/agent-runtime';
import {
  createHostObservedAgentRuntimePortV1,
  type AgentRuntimeDriverEventV1,
} from '@jigwright/agent-runtime/agent-runtime-port';
import {
  assertProviderExecutableObservationCurrent,
  inspectProviderExecutable,
  type ProviderExecutableObservation,
} from '@jigwright/agent-runtime/provider-executable-identity';
import {
  spawnBoundedProviderProcess,
  spawnBoundedProviderSessionProcess,
} from '@jigwright/agent-runtime/bounded-provider-process';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import type {
  AgentRuntimeAsyncSingleShotOptions,
  AgentRuntimeNativeSessionTurnControllerV1,
  AgentRuntimeProcessActivity,
  AgentRuntimeSingleShotInput,
} from '../modules/provider-orchestration/agent-runtime-port.ts';
import { assertProviderRuntimeProtocolReceipt } from '../modules/provider-orchestration/agent-runtime-protocol.ts';
import {
  createAgentRuntimeHostExecutionBindingV1,
  createAgentRuntimeHostProbeEvidenceV1,
  providerDefinitionExecutableBindingDigest,
  type AgentRuntimeHostExecutionBindingV1,
  type AgentRuntimeHostProbeEvidenceV1,
} from '../modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import type { ProviderRunnerReport } from '../modules/provider-orchestration/provider-contracts.ts';
import { isProviderId } from '../modules/provider-orchestration/provider-registry.ts';
import { createProviderExecutionEnvironment } from '../runtime/provider-execution/execution-environment.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../modules/provider-orchestration/provider-runtime-evidence.ts';
import {
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
} from '../runtime/repository-transaction/git.ts';

type HostWrapperLaunchDefinition = HostWrapperProviderProfileSnapshot &
  AgentRuntimeLaunchDefinitionSourceV1;

type NativeTurnClaim = ReturnType<
  AgentRuntimeNativeSessionTurnControllerV1['claim']
>;

type HostProbeRuntime = Readonly<{
  directory: string;
  requestPath: string;
  outputPath: string;
  requestDigest: string;
  executable: NonNullable<ProviderExecutableObservation['identity']>;
  providerDefinitionBindingDigest: string;
  governedInputs: AgentRuntimeSingleShotInput['governedRuntimeInputs'];
}>;

/**
 * Production bridge for one explicitly assigned harness-jsonl-v2 wrapper turn.
 * The durable controller is the only component that can supply or retain a raw
 * native session identity; the returned report contains only digests.
 */
export async function runHostWrapperProviderThroughAgentRuntimeV1(
  input: AgentRuntimeSingleShotInput,
  options: AgentRuntimeAsyncSingleShotOptions,
): Promise<ProviderRunnerReport> {
  const controller = requireController(input);
  const profile = admitHostProfile(controller.profile);
  assertHostAssignment(input, profile);
  const action = controller.nextAction();
  if (
    action === 'resume' &&
    (!profile.capabilities.includes('resumable-session') ||
      profile.resumeArgs.length === 0)
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_RESUME_UNSUPPORTED',
      'The selected host-wrapper definition does not advertise durable turn resume.',
    );
  }

  const executableObservation = inspectProviderExecutable(profile.executable);
  if (
    executableObservation.state !== 'observed' ||
    executableObservation.identity === null
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      'The selected host-wrapper executable is absent or unsafe.',
    );
  }
  const definitionIdentity = projectDefinitionIdentity(profile);
  const capabilities = createAgentRuntimeCapabilitiesV1({
    structuredStreaming: true,
    structuredOutput: true,
    resumableAfterTurn:
      profile.capabilities.includes('resumable-session') &&
      profile.resumeArgs.length > 0,
    forkable: false,
    reattachableInFlight: false,
    cancellationAck: true,
    usageReporting: 'none',
  });
  let driverFailure: unknown = null;
  let claim: NativeTurnClaim | null = null;
  let completionPublished = false;
  let probeEvidence: AgentRuntimeHostProbeEvidenceV1 | null = null;
  let hostExecutionBinding: AgentRuntimeHostExecutionBindingV1 | null = null;
  const observeActivity = (event: AgentRuntimeProcessActivity): void => {
    try {
      options.onActivity?.(event);
    } catch {
      // Activity observers cannot alter an already-admitted process terminal.
    }
  };
  const probeRuntime = createProbeRuntime(
    input,
    profile,
    executableObservation.identity,
  );
  const probeBefore = captureGovernedProviderProjection(
    input.repositoryRoot,
    probeRuntime.governedInputs,
  );

  const port = createHostObservedAgentRuntimePortV1<
    HostWrapperLaunchDefinition,
    AgentRuntimeStartInputV1,
    AgentRuntimeResumeInputV1
  >({
    definition: profile,
    admitDefinition(value) {
      return admitHostProfile(value);
    },
    projectDefinitionIdentity,
    admitStartInput: assertAgentRuntimeStartInputV1,
    admitResumeInput: assertAgentRuntimeResumeInputV1,
    driver: {
      async probe() {
        const observation = await executeHostProbe(
          input,
          profile,
          executableObservation,
          probeRuntime,
          options.signal,
        );
        return Object.freeze({
          status: 'ready' as const,
          executableIdentity: executableObservation.identity,
          providerVersion: observation.providerVersion,
          authentication: 'authenticated' as const,
          capabilities,
        });
      },
      start(_definition, publicInput, control) {
        return executeHostTurn(publicInput, control.signal);
      },
      resume(_definition, publicInput, control) {
        return executeHostTurn(publicInput, control.signal);
      },
      async cancel() {
        return Object.freeze({ acknowledged: true, forced: false });
      },
    },
  });

  const probe = await port.probe(profile);
  if (probe.status !== 'ready' || typeof probe.providerVersion !== 'string') {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      `Host-wrapper preflight failed (${probe.status}).`,
    );
  }
  const probeAfter = captureGovernedProviderProjection(
    input.repositoryRoot,
    probeRuntime.governedInputs,
  );
  const probeProjection = compareGovernedProviderProjections(
    probeBefore,
    probeAfter,
  );
  if (!probeProjection.unchanged) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_GOVERNED_PROJECTION_DRIFT',
      'Host-wrapper availability probe changed a governed repository projection.',
    );
  }
  const probeRequestBytes = readStablePrivateFile(
    probeRuntime.requestPath,
    64 * 1_024,
    false,
    'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
    'Host-wrapper availability probe request is invalid.',
  );
  const probeResultBytes = readStablePrivateFile(
    probeRuntime.outputPath,
    64 * 1_024,
    false,
    'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
    'Host-wrapper availability probe result is invalid.',
  );
  if (
    sha256Buffer(probeRequestBytes) !== probeRuntime.requestDigest ||
    readProbeProviderVersion(probeResultBytes) !== probe.providerVersion
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      'Host-wrapper availability probe evidence changed before admission.',
    );
  }
  probeEvidence = createAgentRuntimeHostProbeEvidenceV1({
    invocationId: input.request.invocationId,
    requestDigest: input.request.requestDigest,
    executionAttemptId: input.acceptanceBinding.executionAttemptId,
    acceptanceBindingDigest: input.acceptanceBinding.bindingDigest,
    assignmentBindingDigest: controller.assignmentBinding.bindingDigest,
    providerProfileDigest: profile.profileDigest,
    executable: probeRuntime.executable,
    providerDefinitionBindingDigest:
      probeRuntime.providerDefinitionBindingDigest,
    providerVersion: probe.providerVersion,
    probeRequestFileDigest: sha256Buffer(probeRequestBytes),
    probeResultFileDigest: sha256Buffer(probeResultBytes),
    governedBeforeDigest: probeProjection.beforeDigest,
    governedAfterDigest: probeProjection.afterDigest,
  });
  try {
    options.onHostProbeEvidence?.(probeEvidence);
  } catch {
    // Evidence observers cannot alter the already-validated probe result.
  }
  if (options.signal?.aborted === true) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_CANCELLED',
      'Host-wrapper execution was cancelled before its native turn claim.',
    );
  }
  claim = controller.claim({
    attemptId: input.acceptanceBinding.executionAttemptId,
    expectedAction: action,
  });
  assertClaimBinding(input, action, claim);
  const publicInput = createPublicInput(
    input,
    action,
    claim,
    definitionIdentity,
  );
  const stream =
    action === 'start'
      ? port.start(profile, publicInput as AgentRuntimeStartInputV1)
      : port.resume(profile, publicInput as AgentRuntimeResumeInputV1);
  let completed: Extract<AgentRuntimeEventV1, { type: 'completed' }> | null =
    null;
  for await (const event of stream) {
    if (event.type === 'process-activity') {
      observeActivity({
        type: event.activity,
        elapsedMs: event.elapsedMs,
        ...(event.bytes === null ? {} : { bytes: event.bytes }),
      });
    } else if (event.type === 'completed') {
      completed = event;
    } else if (event.type === 'failed' || event.type === 'cancelled') {
      if (event.type === 'cancelled') {
        observeActivity({
          type: 'cancelled',
          elapsedMs: event.elapsedMs,
        });
      }
      if (driverFailure !== null) throw driverFailure;
      throw runtimeFailure(
        event.type === 'cancelled'
          ? 'AGENT_RUNTIME_V1_CANCELLED'
          : 'AGENT_RUNTIME_V1_TERMINAL_FAILURE',
        event.type === 'cancelled'
          ? 'Host-wrapper execution was cancelled before completion.'
          : 'Host-wrapper execution ended without an accepted completion.',
      );
    }
  }
  if (completed === null) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_COMPLETION_MISSING',
      'Host-wrapper execution did not publish one completion.',
    );
  }
  let wrapperProtocolReceipt: ReturnType<
    typeof assertProviderRuntimeProtocolReceipt
  >;
  try {
    wrapperProtocolReceipt = assertProviderRuntimeProtocolReceipt(
      completed.observation.protocolEvidence,
      claim.binding,
    );
  } catch {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROTOCOL_MISSING',
      'Host-wrapper completion did not retain its exact session protocol receipt.',
    );
  }
  if (
    wrapperProtocolReceipt.kind !== 'provider-wrapper-session-protocol-receipt'
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROTOCOL_MISSING',
      'Host-wrapper completion did not retain its exact session protocol receipt.',
    );
  }
  if (hostExecutionBinding === null) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_NATIVE_TURN_INVALID',
      'Host-wrapper completion omitted its durable host execution binding.',
    );
  }
  if (
    probeEvidence === null ||
    canonicalJson(completed.observation.executable) !==
      canonicalJson(probeEvidence.executable)
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_DEFINITION_INVALID',
      'Host-wrapper completion executable does not match its exact probe authority.',
    );
  }
  return Object.freeze({
    invocationId: input.request.invocationId,
    providerId: input.providerId,
    purpose: input.request.purpose,
    requestDigest: input.request.requestDigest,
    semanticOutput: completed.output,
    semanticOutputDigest: sha256(canonicalJson(completed.output)),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: completed.observation.projection.unchanged,
      changedCategories: [
        ...completed.observation.projection.changedCategories,
      ],
      beforeDigest: completed.observation.projection.beforeDigest,
      afterDigest: completed.observation.projection.afterDigest,
    },
    sameUserProcessConfined: false as const,
    residuals: [...completed.observation.residuals],
    executable: completed.observation.executable,
    elapsedMs: completed.elapsedMs,
    providerDefinitionSnapshot: profile,
    wrapperProtocolReceipt,
    hostExecutionBinding,
  });

  function executeHostTurn(
    publicInput: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
    internalSignal: AbortSignal,
  ): AsyncIterable<AgentRuntimeDriverEventV1> {
    return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
      const activeClaim = claim!;
      const activities: AgentRuntimeDriverEventV1[] = [];
      let privateIdentity: ProviderWrapperNativeSessionIdentityObservation | null =
        null;
      try {
        const runtime = createRuntimeFiles(input, publicInput);
        const before = captureGovernedProviderProjection(
          input.repositoryRoot,
          runtime.governedInputs,
        );
        const outcome = await spawnBoundedProviderSessionProcess({
          executable: profile.executable,
          args: renderArguments(
            profile,
            action,
            activeClaim,
            runtime.requestPath,
          ),
          cwd: runtime.directory,
          environment: createProviderExecutionEnvironment(
            input.providerId,
            process.execPath,
            runtime.directory,
            input.sourceEnvironment,
          ),
          stdinContent: Buffer.from(publicInput.prompt, 'utf8'),
          timeoutMs: input.request.limits.timeoutMs,
          maxOutputBytes: input.request.limits.aggregateOutputBytes,
          signal:
            options.signal === undefined
              ? internalSignal
              : AbortSignal.any([options.signal, internalSignal]),
          onActivity(event) {
            if (event.type === 'cancelled') {
              observeActivity({
                type: 'cancelled',
                elapsedMs: event.elapsedMs,
              });
              return;
            }
            activities.push(
              Object.freeze({
                type: 'process-activity' as const,
                activity: event.type,
                elapsedMs: event.elapsedMs,
                ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
              }),
            );
          },
          wrapperSessionProtocol: {
            protocol: 'harness-jsonl-v2',
            binding: activeClaim.binding,
            privateNativeSessionIdentitySink(identity) {
              if (privateIdentity !== null) {
                throw runtimeFailure(
                  'AGENT_RUNTIME_V1_NATIVE_IDENTITY_DUPLICATE',
                  'Host-wrapper emitted more than one private native identity.',
                );
              }
              privateIdentity = identity;
            },
          },
        });
        const currentExecutable = assertProviderExecutableObservationCurrent(
          executableObservation,
        );
        const after = captureGovernedProviderProjection(
          input.repositoryRoot,
          runtime.governedInputs,
        );
        const projection = compareGovernedProviderProjections(before, after);
        const wholeRunAfter = captureGovernedProviderProjection(
          input.repositoryRoot,
          probeRuntime.governedInputs,
        );
        const wholeRunProjection = compareGovernedProviderProjections(
          probeBefore,
          wholeRunAfter,
        );
        const governedProjectionChanged =
          !projection.unchanged || !wholeRunProjection.unchanged;
        const protocolOutcome = outcome.wrapperSessionProtocolOutcome;
        if (protocolOutcome === undefined) {
          publishFailureCompletion(
            outcome.timedOut ? { kind: 'timeout' } : { kind: 'claim-crash' },
          );
          if (governedProjectionChanged) {
            throw runtimeFailure(
              'AGENT_RUNTIME_V1_GOVERNED_PROJECTION_DRIFT',
              'Host-wrapper changed a governed repository projection.',
            );
          }
          throw runtimeFailure(
            outcome.timedOut
              ? 'AGENT_RUNTIME_V1_TIMEOUT'
              : 'AGENT_RUNTIME_V1_PROTOCOL_MISSING',
            'Host-wrapper did not produce one terminal session protocol outcome.',
          );
        }
        const observedIdentity =
          privateIdentity as ProviderWrapperNativeSessionIdentityObservation | null;
        if (protocolOutcome.receipt.terminal !== 'result') {
          publishProtocolCompletion(protocolOutcome, null);
          while (activities.length > 0) yield activities.shift()!;
          try {
            options.onProtocolReceipt?.(protocolOutcome.receipt);
          } catch {
            // Receipt observers cannot alter the already-bound terminal state.
          }
          if (governedProjectionChanged) {
            throw runtimeFailure(
              'AGENT_RUNTIME_V1_GOVERNED_PROJECTION_DRIFT',
              'Host-wrapper changed a governed repository projection.',
            );
          }
          throw runtimeFailure(
            'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
            'Host-wrapper process or protocol ended without an accepted result.',
          );
        }
        if (
          outcome.terminationReason !== 'exited' ||
          outcome.exitCode !== 0 ||
          observedIdentity === null
        ) {
          publishRejectedProtocolCompletion(protocolOutcome);
          while (activities.length > 0) yield activities.shift()!;
          if (governedProjectionChanged) {
            throw runtimeFailure(
              'AGENT_RUNTIME_V1_GOVERNED_PROJECTION_DRIFT',
              'Host-wrapper changed a governed repository projection.',
            );
          }
          throw runtimeFailure(
            'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
            'Host-wrapper process or protocol ended without an accepted result.',
          );
        }
        if (governedProjectionChanged) {
          publishRejectedProtocolCompletion(protocolOutcome);
          throw runtimeFailure(
            'AGENT_RUNTIME_V1_GOVERNED_PROJECTION_DRIFT',
            'Host-wrapper changed a governed repository projection.',
          );
        }
        const semanticOutput = readSemanticOutput(
          runtime.outputPath,
          input.request.limits.aggregateOutputBytes,
        );
        let outputAccepted = false;
        try {
          outputAccepted = input.outputValidator.validate(semanticOutput);
        } catch {
          outputAccepted = false;
        }
        if (!outputAccepted) {
          publishRejectedProtocolCompletion(protocolOutcome);
          throw runtimeFailure(
            'AGENT_RUNTIME_V1_OUTPUT_INVALID',
            'Host-wrapper semantic output failed its exact current contract.',
          );
        }
        publishProtocolCompletion(protocolOutcome, observedIdentity);
        try {
          options.onProtocolReceipt?.(protocolOutcome.receipt);
        } catch {
          // Receipt observers cannot alter the already-bound terminal state.
        }
        while (activities.length > 0) yield activities.shift()!;
        yield Object.freeze({
          type: 'session-started' as const,
          nativeSessionId: observedIdentity.nativeSessionId,
          continuityToken: null,
          protocolReceiptDigest: observedIdentity.protocolReceiptDigest,
          elapsedMs: outcome.elapsedMs,
        });
        yield Object.freeze({
          type: 'completed' as const,
          output: semanticOutput,
          observation: Object.freeze({
            executable: currentExecutable.identity!,
            providerVersion: probe.providerVersion,
            projection: Object.freeze({
              unchanged: true as const,
              changedCategories: Object.freeze([] as const),
              beforeDigest: wholeRunProjection.beforeDigest,
              afterDigest: wholeRunProjection.afterDigest,
            }),
            residuals: Object.freeze([...PROVIDER_RUNNER_RESIDUALS]),
            protocolEvidence: protocolOutcome.receipt,
          }),
          elapsedMs: outcome.elapsedMs,
        });
      } catch (error) {
        driverFailure = error;
        if (!completionPublished) {
          try {
            publishFailureCompletion({ kind: 'claim-crash' });
          } catch {
            // Preserve the first execution failure; the claimed turn remains
            // fail-closed and cannot be relaunched by this bridge.
          }
        }
        while (activities.length > 0) yield activities.shift()!;
        throw error;
      }
    })();
  }

  function publishProtocolCompletion(
    outcome: ProviderWrapperSessionProtocolOutcome,
    privateIdentityObservation: ProviderWrapperNativeSessionIdentityObservation | null,
  ): void {
    const completion = controller.complete({
      claimDigest: claim!.claimDigest,
      terminal: {
        kind: 'protocol-outcome',
        outcome,
        privateIdentityObservation,
      },
    });
    completionPublished = true;
    publishHostExecutionBinding(completion.completionDigest);
  }

  function publishRejectedProtocolCompletion(
    outcome: ProviderWrapperSessionProtocolOutcome,
  ): void {
    publishProtocolCompletion(outcome, null);
    try {
      options.onProtocolReceipt?.(outcome.receipt);
    } catch {
      // Receipt observers cannot alter the already-bound rejected terminal.
    }
  }

  function publishFailureCompletion(
    terminal: { kind: 'timeout' } | { kind: 'claim-crash' },
  ): void {
    const completion = controller.complete({
      claimDigest: claim!.claimDigest,
      terminal,
    });
    completionPublished = true;
    publishHostExecutionBinding(completion.completionDigest);
  }

  function publishHostExecutionBinding(completionDigest: string): void {
    if (probeEvidence === null) {
      throw runtimeFailure(
        'AGENT_RUNTIME_V1_NATIVE_TURN_INVALID',
        'Host-wrapper native completion omitted its exact probe evidence.',
      );
    }
    const binding = createAgentRuntimeHostExecutionBindingV1({
      assignmentBinding: controller.assignmentBinding,
      probe: probeEvidence,
      nativeSessionClaim: claim!.claim,
      nativeSessionCompletionDigest: completionDigest,
    });
    hostExecutionBinding = binding;
    try {
      options.onHostExecutionBinding?.(binding);
    } catch {
      // Authority observers cannot alter the already-published native terminal.
    }
  }
}

function requireController(
  input: AgentRuntimeSingleShotInput,
): AgentRuntimeNativeSessionTurnControllerV1 {
  if (input.nativeSessionTurn === undefined) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_NATIVE_TURN_REQUIRED',
      'Host-wrapper execution requires one durable native-session turn controller.',
    );
  }
  return input.nativeSessionTurn;
}

function admitHostProfile(value: unknown): HostWrapperLaunchDefinition {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('platform' in value) ||
    typeof value.platform !== 'string'
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_DEFINITION_INVALID',
      'Host-wrapper definition is invalid.',
    );
  }
  const admitted = assertAgentProviderProfileSnapshot(
    value,
    value.platform as NodeJS.Platform,
  );
  if (
    admitted.trustTier !== 'host-wrapper' ||
    admitted.protocol !== 'harness-jsonl-v2'
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_DEFINITION_INVALID',
      'Host-wrapper execution requires a harness-jsonl-v2 profile.',
    );
  }
  return admitted as HostWrapperLaunchDefinition;
}

function assertHostAssignment(
  input: AgentRuntimeSingleShotInput,
  profile: HostWrapperProviderProfileSnapshot,
): void {
  const assignment = input.assignmentBinding;
  if (
    assignment === undefined ||
    canonicalJson(assignment) !==
      canonicalJson(input.nativeSessionTurn?.assignmentBinding) ||
    input.nativeSessionTurn?.invocationBinding.requestDigest !==
      input.request.requestDigest ||
    input.nativeSessionTurn.invocationBinding.inputManifestDigest !==
      input.request.inputManifestDigest ||
    input.nativeSessionTurn.invocationBinding.targetDigest !==
      input.request.targetDigest ||
    input.nativeSessionTurn.invocationBinding.policyDigest !==
      input.request.policyDigest ||
    !isProviderId(profile.family) ||
    profile.family !== input.providerId ||
    profile.logicalProviderId !== assignment.logicalProviderId ||
    profile.id !== assignment.providerProfileId ||
    canonicalJson(profile) !==
      canonicalJson(assignment.providerProfileSnapshot) ||
    profile.profileDigest !== assignment.definitionDigest ||
    assignment.dataAuthorizationPolicyDigest !== input.request.policyDigest ||
    assignment.inputManifestDigest !== input.request.inputManifestDigest ||
    assignment.targetDigest !== input.request.targetDigest
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_ASSIGNMENT_BINDING_INVALID',
      'Host-wrapper execution requires one exact current assignment binding.',
    );
  }
}

function assertClaimBinding(
  input: AgentRuntimeSingleShotInput,
  action: 'start' | 'resume',
  claim: NativeTurnClaim,
): void {
  const assignment = input.assignmentBinding!;
  const durableClaim = claim.claim;
  const sessionControl = claim.binding.sessionControl;
  const expectedNativeSessionIdDigest =
    sessionControl.nativeSessionIdentityMode === 'engine-supplied'
      ? agentRuntimeNativeSessionIdDigestV1(
          sessionControl.expectedNativeSessionId,
        )
      : null;
  if (
    durableClaim.claimDigest !== claim.claimDigest ||
    durableClaim.predecessorCompletionDigest !==
      claim.predecessorCompletionDigest ||
    durableClaim.invocationId !== input.request.invocationId ||
    durableClaim.requestDigest !== input.request.requestDigest ||
    durableClaim.attemptId !== input.acceptanceBinding.executionAttemptId ||
    durableClaim.action !== action ||
    durableClaim.scope.changeId !== assignment.changeId ||
    durableClaim.scope.planningGeneration !== assignment.planningGeneration ||
    durableClaim.scope.assignmentRecordDigest !== assignment.recordDigest ||
    durableClaim.scope.logicalProviderId !== assignment.logicalProviderId ||
    durableClaim.scope.profileId !== assignment.providerProfileId ||
    durableClaim.scope.profileDigest !==
      input.nativeSessionTurn!.profile.profileDigest ||
    durableClaim.scope.providerDefinitionDigest !==
      assignment.definitionDigest ||
    claim.binding.invocationId !== input.request.invocationId ||
    claim.binding.requestDigest !== input.request.requestDigest ||
    claim.binding.attemptId !== input.acceptanceBinding.executionAttemptId ||
    sessionControl.action !== action ||
    (action === 'start' &&
      sessionControl.nativeSessionIdentityMode !== 'provider-observed') ||
    (action === 'resume' &&
      sessionControl.nativeSessionIdentityMode !== 'engine-supplied') ||
    durableClaim.expectedNativeSessionIdDigest !== expectedNativeSessionIdDigest
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_NATIVE_TURN_INVALID',
      'Durable native-session turn binding does not match this invocation.',
    );
  }
}

function projectDefinitionIdentity(
  profile: HostWrapperProviderProfileSnapshot,
): AgentRuntimeDefinitionIdentityV1 {
  return assertAgentRuntimeDefinitionIdentityV1({
    schemaVersion: 1,
    kind: 'host-wrapper-provider-definition.v1',
    providerFamily: profile.family,
    protocol: profile.protocol,
    definitionDigest: profile.profileDigest,
  });
}

function createProbeRuntime(
  input: AgentRuntimeSingleShotInput,
  profile: HostWrapperProviderProfileSnapshot,
  executable: NonNullable<ProviderExecutableObservation['identity']>,
): HostProbeRuntime {
  const directory = path.join(
    input.invocationDirectory,
    'host-wrapper-probe-runtime',
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  const requestPath = path.join(directory, 'request.json');
  const outputPath = path.join(directory, 'probe-result.json');
  const providerDefinitionBindingDigest =
    providerDefinitionExecutableBindingDigest(
      profile.profileDigest,
      executable,
    );
  const requestBytes = Buffer.from(
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'agent-runtime-host-wrapper-probe-request.v1',
      invocationId: input.request.invocationId,
      requestDigest: input.request.requestDigest,
      executionAttemptId: input.acceptanceBinding.executionAttemptId,
      acceptanceBindingDigest: input.acceptanceBinding.bindingDigest,
      assignmentBindingDigest: input.assignmentBinding!.bindingDigest,
      providerFamily: profile.family,
      profileDigest: profile.profileDigest,
      providerDefinitionBindingDigest,
      outputFile: outputPath,
    })}\n`,
    'utf8',
  );
  writeExclusive(requestPath, requestBytes);
  writeExclusive(outputPath, '');
  return Object.freeze({
    directory,
    requestPath,
    outputPath,
    requestDigest: sha256Buffer(requestBytes),
    executable,
    providerDefinitionBindingDigest,
    governedInputs: [
      ...input.governedRuntimeInputs,
      {
        id: 'engine-host-wrapper-probe-runtime',
        path: directory,
        kind: 'directory-closure' as const,
        expectedFiles: ['request.json', 'probe-result.json'],
        mutableContentPaths: ['probe-result.json'],
      },
    ],
  });
}

async function executeHostProbe(
  input: AgentRuntimeSingleShotInput,
  profile: HostWrapperProviderProfileSnapshot,
  executableObservation: ProviderExecutableObservation,
  runtime: HostProbeRuntime,
  signal: AbortSignal | undefined,
): Promise<Readonly<{ providerVersion: string }>> {
  const args = profile.startArgs.map((argument) =>
    argument.replaceAll('{request_file}', runtime.requestPath),
  );
  if (args.some((argument) => /\{[a-z_]+\}/u.test(argument))) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_DEFINITION_INVALID',
      'Host-wrapper probe arguments contain an unsupported placeholder.',
    );
  }
  const outcome = await spawnBoundedProviderProcess({
    executable: profile.executable,
    args,
    cwd: runtime.directory,
    environment: createProviderExecutionEnvironment(
      input.providerId,
      process.execPath,
      runtime.directory,
      input.sourceEnvironment,
    ),
    stdinContent: Buffer.alloc(0),
    timeoutMs: Math.min(input.request.limits.timeoutMs, 10_000),
    maxOutputBytes: 64 * 1_024,
    ...(signal === undefined ? {} : { signal }),
  });
  const current = assertProviderExecutableObservationCurrent(
    executableObservation,
  );
  if (
    outcome.terminationReason === 'cancelled' ||
    current.identity === null ||
    outcome.terminationReason !== 'exited' ||
    outcome.exitCode !== 0
  ) {
    throw runtimeFailure(
      outcome.terminationReason === 'cancelled'
        ? 'AGENT_RUNTIME_V1_CANCELLED'
        : 'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      outcome.terminationReason === 'cancelled'
        ? 'Host-wrapper availability probe was cancelled.'
        : 'Host-wrapper availability probe did not complete successfully.',
    );
  }
  let value: unknown;
  try {
    value = readProbeResult(
      readStablePrivateFile(
        runtime.outputPath,
        64 * 1_024,
        false,
        'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
        'Host-wrapper availability probe result is invalid.',
      ),
    );
  } catch {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      'Host-wrapper availability probe result is invalid.',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'authentication,kind,providerVersion,schemaVersion' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('kind' in value) ||
    value.kind !== 'agent-runtime-host-wrapper-probe-result.v1' ||
    !('authentication' in value) ||
    value.authentication !== 'authenticated' ||
    !('providerVersion' in value) ||
    typeof value.providerVersion !== 'string' ||
    value.providerVersion.length === 0 ||
    Buffer.byteLength(value.providerVersion, 'utf8') > 256
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      'Host-wrapper did not attest one authenticated provider version.',
    );
  }
  return Object.freeze({ providerVersion: value.providerVersion });
}

function readProbeResult(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function readProbeProviderVersion(bytes: Buffer): string {
  const value = readProbeResult(bytes);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'authentication,kind,providerVersion,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-host-wrapper-probe-result.v1' ||
    value.authentication !== 'authenticated' ||
    typeof value.providerVersion !== 'string' ||
    value.providerVersion.length === 0 ||
    Buffer.byteLength(value.providerVersion, 'utf8') > 256
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
      'Host-wrapper availability probe result is invalid.',
    );
  }
  return value.providerVersion;
}

function createPublicInput(
  input: AgentRuntimeSingleShotInput,
  action: 'start' | 'resume',
  claim: NativeTurnClaim,
  definition: AgentRuntimeDefinitionIdentityV1,
): AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1 {
  const assignment = input.assignmentBinding!;
  const acceptance = input.acceptanceBinding;
  const binding = createAgentRuntimeAttemptBindingV1({
    operationId: input.request.invocationId,
    workflowId: acceptance.context.workflowId,
    workflowEpoch: acceptance.context.epoch,
    workflowContextDigest: acceptance.context.contextDigest,
    jobId: acceptance.executionJobId,
    attemptId: acceptance.executionAttemptId,
    leaseGeneration: acceptance.leaseGeneration,
    engineSessionId: acceptance.context.workflowId,
    invocationId: input.request.invocationId,
    requestDigest: input.request.requestDigest,
    providerProfileId: assignment.providerProfileId,
    providerProfileDigest: input.nativeSessionTurn!.profile.profileDigest,
    executableCandidate: input.nativeSessionTurn!.profile.executable,
    definitionDigest: definition.definitionDigest,
    dataAuthorizationPolicyDigest: assignment.dataAuthorizationPolicyDigest,
    inputManifestDigest: assignment.inputManifestDigest,
    targetDigest: assignment.targetDigest,
    assignmentDigest: assignment.assignmentDigest,
    outputSchemaDigest: agentRuntimeOutputSchemaDigestV1(
      input.semanticOutputSchema,
    ),
    effect: 'repository-read-only',
  });
  const common = {
    binding,
    repositoryRoot: input.repositoryRoot,
    workingDirectory: input.repositoryRoot,
    runtimeDirectory: input.invocationDirectory,
    prompt: canonicalJson({
      schemaVersion: 1,
      kind: 'agent-runtime-host-wrapper-request.v1',
      request: input.request,
    }),
    output: {
      slot: 'primary' as const,
      schema: input.semanticOutputSchema,
      validate: input.outputValidator.validate,
    },
    governedInputs: [],
    limits: {
      timeoutMs: input.request.limits.timeoutMs,
      aggregateOutputBytes: input.request.limits.aggregateOutputBytes,
      maxEventCount: 4_096,
    },
    privateSessionIdentitySink() {},
  };
  if (action === 'start') {
    return assertAgentRuntimeStartInputV1({
      action: 'start',
      mode: 'provider-observed-native',
      ...common,
    });
  }
  const control = claim.binding.sessionControl;
  if (
    control.nativeSessionIdentityMode !== 'engine-supplied' ||
    claim.predecessorCompletionDigest === null
  ) {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_NATIVE_TURN_INVALID',
      'Resume requires one private predecessor session identity.',
    );
  }
  return assertAgentRuntimeResumeInputV1({
    action: 'resume',
    mode: 'engine-supplied-native',
    ...common,
    nativeSessionId: control.expectedNativeSessionId,
    nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(
      control.expectedNativeSessionId,
    ),
    predecessorCompletionDigest: claim.predecessorCompletionDigest,
    continuityToken: null,
  });
}

function createRuntimeFiles(
  input: AgentRuntimeSingleShotInput,
  publicInput: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
): Readonly<{
  directory: string;
  requestPath: string;
  outputPath: string;
  governedInputs: AgentRuntimeSingleShotInput['governedRuntimeInputs'];
}> {
  const directory = path.join(
    input.invocationDirectory,
    'host-wrapper-runtime',
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  const requestPath = path.join(directory, 'request.json');
  const outputPath = path.join(directory, 'semantic-output.json');
  writeExclusive(
    requestPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'agent-runtime-host-wrapper-turn-request.v1',
      invocationId: input.request.invocationId,
      requestDigest: input.request.requestDigest,
      action: publicInput.action,
      prompt: publicInput.prompt,
      outputFile: outputPath,
    })}\n`,
  );
  writeExclusive(outputPath, '');
  return Object.freeze({
    directory,
    requestPath,
    outputPath,
    governedInputs: [
      ...input.governedRuntimeInputs,
      {
        id: 'engine-host-wrapper-runtime',
        path: directory,
        kind: 'directory-closure' as const,
        expectedFiles: ['request.json', 'semantic-output.json'],
        mutableContentPaths: ['semantic-output.json'],
      },
    ],
  });
}

function renderArguments(
  profile: HostWrapperProviderProfileSnapshot,
  action: 'start' | 'resume',
  claim: NativeTurnClaim,
  requestPath: string,
): string[] {
  const source = action === 'start' ? profile.startArgs : profile.resumeArgs;
  const control = claim.binding.sessionControl;
  return source.map((argument) => {
    let rendered = argument.replaceAll('{request_file}', requestPath);
    if (action === 'resume') {
      if (control.nativeSessionIdentityMode !== 'engine-supplied') {
        throw runtimeFailure(
          'AGENT_RUNTIME_V1_NATIVE_TURN_INVALID',
          'Resume arguments require one engine-supplied native identity.',
        );
      }
      rendered = rendered.replaceAll(
        '{native_session_id}',
        control.expectedNativeSessionId,
      );
    }
    if (/\{[a-z_]+\}/u.test(rendered)) {
      throw runtimeFailure(
        'AGENT_RUNTIME_V1_DEFINITION_INVALID',
        'Host-wrapper arguments contain an unsupported placeholder.',
      );
    }
    return rendered;
  });
}

function readSemanticOutput(outputPath: string, maxBytes: number): unknown {
  try {
    return JSON.parse(
      readStablePrivateFile(
        outputPath,
        maxBytes,
        false,
        'AGENT_RUNTIME_V1_OUTPUT_INVALID',
        'Host-wrapper semantic output is absent or exceeds its bound.',
      ).toString('utf8'),
    ) as unknown;
  } catch {
    throw runtimeFailure(
      'AGENT_RUNTIME_V1_OUTPUT_INVALID',
      'Host-wrapper semantic output is not valid JSON.',
    );
  }
}

function writeExclusive(filePath: string, content: string | Buffer): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readStablePrivateFile(
  filePath: string,
  maxBytes: number,
  allowEmpty: boolean,
  code: string,
  message: string,
): Buffer {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < (allowEmpty ? 0n : 1n) ||
      before.size > BigInt(maxBytes)
    ) {
      throw new Error('invalid private file');
    }
    const expectedSize = Number(before.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathState = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      offset !== expectedSize ||
      !sameFileState(before, after) ||
      pathState === undefined ||
      !sameFileState(after, pathState)
    ) {
      throw new Error('unstable private file');
    }
    return buffer.subarray(0, expectedSize);
  } catch {
    throw runtimeFailure(code, message);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function sameFileState(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function runtimeFailure(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
