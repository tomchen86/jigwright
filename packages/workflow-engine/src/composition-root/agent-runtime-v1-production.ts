/**
 * Bridges reviewed built-in provider execution to the public AgentRuntime
 * interface.
 *
 * Invariants:
 * - Public execution requires a current built-in provider definition.
 * - Observed process activity reaches the consumer even when the run fails.
 */
import crypto from 'node:crypto';

import {
  agentRuntimeOutputSchemaDigestV1,
  assertAgentRuntimeDefinitionIdentityV1,
  assertAgentRuntimeResumeInputV1,
  assertAgentRuntimeStartInputV1,
  createAgentRuntimeAttemptBindingV1,
  createAgentRuntimeCapabilitiesV1,
  type AgentRuntimeDefinitionIdentityV1,
  type AgentRuntimeEventV1,
  type AgentRuntimeProbeEvidenceV1,
  type AgentRuntimeStartInputV1,
} from '@jigwright/core/agent-runtime-port';
import {
  createHostObservedAgentRuntimePortV1,
  type AgentRuntimeDriverEventV1,
} from '@jigwright/agent-runtime/agent-runtime-port';
import {
  assertAgentProviderProfileSnapshot,
  type BuiltInReviewedProviderProfileSnapshot,
} from '@jigwright/core/agent-provider-config';
import {assertKnownBuiltInProviderDefinitionSnapshot, resolveBuiltInProviderDefinitionSnapshot} from '@jigwright/core/built-in-provider-definition';
import { type ProviderDefinitionSnapshot } from '@jigwright/core/provider-definition-snapshot';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import type { AgentRuntimeAsyncSingleShotOptions } from '../modules/provider-orchestration/agent-runtime-port.ts';
import { assertAgentRuntimeAssignmentBindingV1 } from '../modules/provider-orchestration/agent-runtime-assignment-binding.ts';
import type { ProviderId } from '../modules/provider-orchestration/provider-registry.ts';
import type { ProviderRunnerReport } from '../modules/provider-orchestration/provider-contracts.ts';
import {
  preflightBuiltInProvider,
  preflightBuiltInProviderProfile,
  runBuiltInProviderAsync,
  type ProviderAsyncRunOptions,
  type ProviderPreflightOptions,
  type ProviderResolution,
  type ProviderRunInput,
} from '../runtime/provider-execution/provider-runner.ts';

type BuiltInAgentRuntimeV1BridgeHost = Readonly<{
  preflight(
    providerId: ProviderId,
    options: ProviderPreflightOptions,
    selectedProfile: BuiltInReviewedProviderProfileSnapshot | null,
  ): ProviderResolution;
  runAsync(
    input: ProviderRunInput,
    options: ProviderAsyncRunOptions,
  ): Promise<ProviderRunnerReport>;
}>;

export type BuiltInAgentRuntimeV1Bridge = (
  input: ProviderRunInput,
  options: AgentRuntimeAsyncSingleShotOptions,
) => Promise<ProviderRunnerReport>;

const CAPABILITIES = createAgentRuntimeCapabilitiesV1({
  structuredStreaming: true,
  structuredOutput: true,
  resumableAfterTurn: false,
  forkable: false,
  reattachableInFlight: false,
  cancellationAck: true,
  usageReporting: 'none',
});

/**
 * Adapt the existing reviewed provider runner behind the public v1 port. This
 * is deliberately a fresh, single-shot bridge: resume, fork, and reattach stay
 * unavailable until their durable lifecycle is connected end to end.
 */
export function createBuiltInAgentRuntimeV1Bridge(
  host: BuiltInAgentRuntimeV1BridgeHost,
): BuiltInAgentRuntimeV1Bridge {
  if (
    typeof host?.preflight !== 'function' ||
    typeof host.runAsync !== 'function'
  ) {
    throw new TypeError('Built-in AgentRuntime v1 bridge host is invalid.');
  }
  const preflight = host.preflight.bind(host);
  const runAsync = host.runAsync.bind(host);

  return async (input, options) => {
    const acceptance = input.acceptanceBinding;
    if (acceptance === undefined) {
      throw workflowError(
        'AGENT_RUNTIME_V1_ACCEPTANCE_BINDING_REQUIRED',
        'Public AgentRuntime execution requires an exact Job/Attempt acceptance binding.',
        ExitCode.verification,
      );
    }
    const definition = resolveBuiltInProviderDefinitionSnapshot(
      input.providerId,
      options.platform,
    );
    if (definition === null) {
      throw workflowError(
        'AGENT_RUNTIME_V1_DEFINITION_UNAVAILABLE',
        'Public AgentRuntime execution requires one current built-in provider definition.',
        ExitCode.verification,
      );
    }
    const definitionIdentity = projectDefinitionIdentity(definition);
    const assignment = admitAssignmentBinding(input, definition);
    const selectedProfile = assignment?.providerProfileSnapshot ?? null;
    let driverFailure: unknown = null;
    let probedProviderVersion: string | null = null;
    const port = createHostObservedAgentRuntimePortV1({
      definition,
      admitDefinition(value) {
        return assertKnownBuiltInProviderDefinitionSnapshot(value, {
          providerId: input.providerId,
          platform: options.platform,
        });
      },
      projectDefinitionIdentity,
      admitStartInput: assertAgentRuntimeStartInputV1,
      admitResumeInput: assertAgentRuntimeResumeInputV1,
      driver: {
        async probe() {
          const resolution = preflight(
            input.providerId,
            {
              platform: options.platform,
              enabled: true,
              sourceEnvironment: input.sourceEnvironment,
              temporaryDirectory: input.invocationDirectory,
            },
            selectedProfile,
          );
          if (
            selectedProfile !== null &&
            resolution.executable?.candidatePath !== selectedProfile.executable
          ) {
            throw workflowError(
              'AGENT_RUNTIME_V1_PROFILE_STALE',
              'AgentRuntime preflight did not observe the exact assigned executable candidate.',
              ExitCode.staleState,
            );
          }
          probedProviderVersion = resolution.version ?? null;
          return Object.freeze({
            status: publicProbeStatus(resolution.status),
            executableIdentity: resolution.executable ?? null,
            providerVersion: resolution.version ?? null,
            authentication:
              resolution.status === 'available'
                ? ('authenticated' as const)
                : resolution.status === 'unauthenticated'
                  ? ('unauthenticated' as const)
                  : ('not-observed' as const),
            capabilities:
              resolution.status === 'available' ? CAPABILITIES : null,
          });
        },
        start(_snapshot, _publicInput, control) {
          return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
            const activity: AgentRuntimeDriverEventV1[] = [];
            try {
              const report = await runAsync(input, {
                platform: options.platform,
                signal: combineSignals(options.signal, control.signal),
                onActivity(event) {
                  const projected = projectProcessActivity(event);
                  if (projected !== null) activity.push(projected);
                },
                ...(options.onProtocolReceipt === undefined
                  ? {}
                  : { onProtocolReceipt: options.onProtocolReceipt }),
              });
              while (activity.length > 0) yield activity.shift()!;
              yield Object.freeze({
                type: 'completed' as const,
                output: report.semanticOutput,
                observation: Object.freeze({
                  executable: report.executable,
                  providerVersion: probedProviderVersion,
                  projection: Object.freeze({
                    unchanged: true as const,
                    changedCategories: Object.freeze([] as const),
                    beforeDigest: report.projection.beforeDigest,
                    afterDigest: report.projection.afterDigest,
                  }),
                  residuals: Object.freeze([...report.residuals]),
                  protocolEvidence: report.wrapperProtocolReceipt ?? null,
                }),
                elapsedMs: report.elapsedMs,
              });
            } catch (error) {
              driverFailure = error;
              while (activity.length > 0) yield activity.shift()!;
              throw error;
            }
          })();
        },
        resume() {
          return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
            yield* [] as AgentRuntimeDriverEventV1[];
            throw workflowError(
              'AGENT_RUNTIME_V1_RESUME_UNSUPPORTED',
              'The MVP AgentRuntime path supports fresh single-shot execution only.',
              ExitCode.verification,
            );
          })();
        },
        async cancel() {
          return Object.freeze({ acknowledged: true, forced: false });
        },
      },
    });

    const probe = await port.probe(definition);
    if (probe.status !== 'ready') {
      throw workflowError(
        'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE',
        `Public AgentRuntime provider preflight failed (${probe.status}).`,
        ExitCode.verification,
      );
    }
    const startInput = createStartInput(
      input,
      definitionIdentity,
      probe,
      assignment,
    );
    let completed: Extract<AgentRuntimeEventV1, { type: 'completed' }> | null =
      null;
    for await (const event of port.start(definition, startInput)) {
      if (event.type === 'process-activity') {
        options.onActivity?.({
          type: event.activity,
          elapsedMs: event.elapsedMs,
          ...(event.bytes === null ? {} : { bytes: event.bytes }),
        });
      } else if (event.type === 'completed') {
        completed = event;
      } else if (event.type === 'failed' || event.type === 'cancelled') {
        if (driverFailure !== null) throw driverFailure;
        throw workflowError(
          event.type === 'cancelled'
            ? 'AGENT_RUNTIME_V1_CANCELLED'
            : 'AGENT_RUNTIME_V1_TERMINAL_FAILURE',
          event.type === 'cancelled'
            ? 'Public AgentRuntime execution was cancelled before completion.'
            : 'Public AgentRuntime execution ended without an accepted completion.',
          ExitCode.verification,
        );
      }
    }
    if (completed === null) {
      throw workflowError(
        'AGENT_RUNTIME_V1_COMPLETION_MISSING',
        'Public AgentRuntime execution did not publish one completion.',
        ExitCode.verification,
      );
    }
    const report: ProviderRunnerReport = {
      invocationId: input.request.invocationId,
      providerId: input.providerId,
      purpose: input.request.purpose,
      requestDigest: input.request.requestDigest,
      semanticOutput: completed.output,
      semanticOutputDigest: sha256(canonicalJson(completed.output)),
      assurance: 'unchanged-governed-projection' as const,
      projection: {
        unchanged: true,
        changedCategories: [],
        beforeDigest: completed.observation.projection.beforeDigest,
        afterDigest: completed.observation.projection.afterDigest,
      },
      sameUserProcessConfined: false as const,
      residuals: [...completed.observation.residuals],
      executable: completed.observation.executable,
      elapsedMs: completed.elapsedMs,
      providerDefinitionSnapshot: definition,
      ...(completed.observation.protocolEvidence === null
        ? {}
        : {
            wrapperProtocolReceipt: completed.observation
              .protocolEvidence as ProviderRunnerReport['wrapperProtocolReceipt'],
          }),
    };
    return Object.freeze(report);
  };
}

export const runBuiltInProviderThroughAgentRuntimeV1 =
  createBuiltInAgentRuntimeV1Bridge({
    preflight(providerId, options, selectedProfile) {
      return selectedProfile === null
        ? preflightBuiltInProvider(providerId, options)
        : preflightBuiltInProviderProfile(selectedProfile, options);
    },
    runAsync: runBuiltInProviderAsync,
  });

function createStartInput(
  input: ProviderRunInput,
  definition: AgentRuntimeDefinitionIdentityV1,
  probe: AgentRuntimeProbeEvidenceV1,
  assignment: ReturnType<typeof admitAssignmentBinding>,
): AgentRuntimeStartInputV1 {
  const acceptance = input.acceptanceBinding!;
  if (probe.executableIdentity === null) {
    throw workflowError(
      'AGENT_RUNTIME_V1_PROFILE_STALE',
      'AgentRuntime start requires the exact executable observed by preflight.',
      ExitCode.staleState,
    );
  }
  const outputSchemaDigest = agentRuntimeOutputSchemaDigestV1(
    input.semanticOutputSchema,
  );
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
    providerProfileId:
      assignment?.providerProfileId ?? input.request.providerId,
    providerProfileDigest:
      assignment?.providerProfileSnapshot.profileDigest ??
      definition.definitionDigest,
    executableCandidate: probe.executableIdentity.candidatePath,
    definitionDigest: definition.definitionDigest,
    dataAuthorizationPolicyDigest:
      assignment?.dataAuthorizationPolicyDigest ?? input.request.policyDigest,
    inputManifestDigest:
      assignment?.inputManifestDigest ?? input.request.inputManifestDigest,
    targetDigest: input.request.targetDigest,
    assignmentDigest:
      assignment?.assignmentDigest ?? input.request.roleAssignmentDigest,
    outputSchemaDigest,
    effect: 'repository-read-only',
  });
  return assertAgentRuntimeStartInputV1({
    action: 'start',
    mode: 'single-shot',
    binding,
    repositoryRoot: input.repositoryRoot,
    workingDirectory: input.repositoryRoot,
    runtimeDirectory: input.invocationDirectory,
    prompt: canonicalJson({
      schemaVersion: 1,
      kind: 'agent-runtime-single-shot-request.v1',
      request: input.request,
    }),
    output: {
      slot: 'primary',
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
  });
}

function admitAssignmentBinding(
  input: ProviderRunInput,
  definition: ProviderDefinitionSnapshot,
) {
  if (input.assignmentBinding === undefined) return null;
  let value;
  try {
    value = assertAgentRuntimeAssignmentBindingV1(input.assignmentBinding);
  } catch {
    throw workflowError(
      'AGENT_RUNTIME_V1_ASSIGNMENT_BINDING_INVALID',
      'Public AgentRuntime execution requires one exact current assignment binding.',
      ExitCode.verification,
    );
  }
  const expectedRole =
    input.request.purpose === 'task-implementation'
      ? 'builder'
      : input.request.purpose === 'survey'
        ? 'author'
        : 'reviewer';
  let providerProfileSnapshot;
  try {
    providerProfileSnapshot = assertAgentProviderProfileSnapshot(
      value.providerProfileSnapshot,
      definition.platform as NodeJS.Platform,
    );
  } catch {
    throw workflowError(
      'AGENT_RUNTIME_V1_ASSIGNMENT_BINDING_INVALID',
      'Public AgentRuntime execution requires one exact current assignment binding.',
      ExitCode.verification,
    );
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-assignment-binding.v1' ||
    value.role !== expectedRole ||
    value.definitionDigest !== definition.definitionDigest ||
    providerProfileSnapshot.trustTier !== 'built-in-reviewed' ||
    providerProfileSnapshot.family !== input.providerId ||
    providerProfileSnapshot.id !== value.providerProfileId ||
    providerProfileSnapshot.protocol !== definition.protocol ||
    !definition.executableCandidates.includes(
      providerProfileSnapshot.executable,
    ) ||
    value.dataAuthorizationPolicyDigest !== input.request.policyDigest ||
    value.inputManifestDigest !== input.request.inputManifestDigest ||
    value.targetDigest !== input.request.targetDigest ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.changeId) ||
    value.changeId === 'archive' ||
    value.logicalProviderId.length === 0 ||
    value.providerProfileId.length === 0
  ) {
    throw workflowError(
      'AGENT_RUNTIME_V1_ASSIGNMENT_BINDING_INVALID',
      'Public AgentRuntime execution requires one exact current assignment binding.',
      ExitCode.verification,
    );
  }
  return Object.freeze({ ...value, providerProfileSnapshot });
}

function projectDefinitionIdentity(
  definition: ProviderDefinitionSnapshot,
): AgentRuntimeDefinitionIdentityV1 {
  return assertAgentRuntimeDefinitionIdentityV1({
    schemaVersion: 1,
    kind: 'built-in-provider-definition.v1',
    providerFamily: definition.providerFamily,
    protocol: definition.protocol,
    definitionDigest: definition.definitionDigest,
  });
}

function publicProbeStatus(
  status: ProviderResolution['status'],
):
  | 'ready'
  | 'host-disabled'
  | 'unsupported-platform'
  | 'absent'
  | 'unsafe-candidate'
  | 'incompatible'
  | 'unauthenticated' {
  return status === 'available'
    ? 'ready'
    : status === 'disabled'
      ? 'host-disabled'
      : status;
}

function projectProcessActivity(
  event: Parameters<
    NonNullable<AgentRuntimeAsyncSingleShotOptions['onActivity']>
  >[0],
): AgentRuntimeDriverEventV1 | null {
  if (event.type === 'cancelled') return null;
  return Object.freeze({
    type: 'process-activity' as const,
    activity: event.type,
    elapsedMs: event.elapsedMs,
    ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
  });
}

function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  return external === undefined
    ? internal
    : AbortSignal.any([external, internal]);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
