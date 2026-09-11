/**
 * Projects built-in provider preflight results into public runtime evidence
 * and re-admits it at the consumer boundary.
 *
 * Invariants:
 * - Admitted evidence must identify the provider family expected by the
 *   caller.
 */
import {
  AgentRuntimePortContractError,
  assertAgentRuntimeDefinitionIdentityV1,
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeProbeEvidenceV1,
  createAgentRuntimeUnavailableDefinitionIdentityV1,
  createHostObservedProviderProbeEvidenceAdmissionPortV1,
  type AgentRuntimeProbeEvidenceV1,
} from '@jigwright/core/agent-runtime-port';

import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {resolveBuiltInProviderDefinitionSnapshot} from '@jigwright/core/built-in-provider-definition';
import {
  preflightBuiltInProvider,
  type ProviderPreflightOptions,
  type ProviderResolution,
} from './provider-runner.ts';

const BUILT_IN_CAPABILITIES = createAgentRuntimeCapabilitiesV1({
  structuredStreaming: true,
  structuredOutput: true,
  resumableAfterTurn: false,
  forkable: false,
  reattachableInFlight: false,
  cancellationAck: true,
  usageReporting: 'none',
});

/** Observe one fixed family without persisting or deciding availability. */
export function probeBuiltInProviderFamilyEvidence(
  providerId: ProviderId,
  options: ProviderPreflightOptions,
): AgentRuntimeProbeEvidenceV1 {
  return projectBuiltInProviderResolutionEvidence(
    providerId,
    options.platform,
    preflightBuiltInProvider(providerId, options),
  );
}

/** Production consumers must re-admit evidence at their own boundary. */
export function admitBuiltInProviderFamilyEvidence(
  rawEvidence: AgentRuntimeProbeEvidenceV1,
  expectedProviderId: ProviderId,
): Readonly<{
  evidence: AgentRuntimeProbeEvidenceV1;
  resolution: ProviderResolution;
}> {
  const evidence =
    createHostObservedProviderProbeEvidenceAdmissionPortV1().admit(rawEvidence);
  if (evidence.providerFamily !== expectedProviderId) {
    throw new AgentRuntimePortContractError();
  }
  return Object.freeze({
    evidence,
    resolution: Object.freeze({
      status: providerResolutionStatus(evidence.status),
      ...(evidence.executableIdentity === null
        ? {}
        : { executable: evidence.executableIdentity }),
      ...(evidence.providerVersion === null
        ? {}
        : { version: evidence.providerVersion }),
    }),
  });
}

export function projectBuiltInProviderResolutionEvidence(
  providerId: ProviderId,
  platform: NodeJS.Platform,
  resolution: ProviderResolution,
): AgentRuntimeProbeEvidenceV1 {
  return createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass: 'host-observed',
    definition: definitionForBuiltInResolution(
      providerId,
      platform,
      resolution.status,
    ),
    status: publicProbeStatus(resolution.status),
    executableIdentity: resolution.executable ?? null,
    providerVersion: resolution.version ?? null,
    authentication:
      resolution.status === 'available'
        ? 'authenticated'
        : resolution.status === 'unauthenticated'
          ? 'unauthenticated'
          : 'not-observed',
    capabilities:
      resolution.status === 'available' ||
      resolution.status === 'unauthenticated'
        ? BUILT_IN_CAPABILITIES
        : null,
  });
}

export function projectBuiltInProviderDefinitionIdentity(
  providerId: ProviderId,
  platform: NodeJS.Platform,
): AgentRuntimeProbeEvidenceV1['definition'] {
  const definition = resolveBuiltInProviderDefinitionSnapshot(
    providerId,
    platform,
  );
  if (definition === null) throw new AgentRuntimePortContractError();
  return assertAgentRuntimeDefinitionIdentityV1({
    schemaVersion: 1,
    kind: 'built-in-provider-definition.v1',
    providerFamily: providerId,
    protocol: definition.protocol,
    definitionDigest: definition.definitionDigest,
  });
}

function definitionForBuiltInResolution(
  providerId: ProviderId,
  platform: NodeJS.Platform,
  status: ProviderResolution['status'],
): AgentRuntimeProbeEvidenceV1['definition'] {
  return status === 'disabled'
    ? createAgentRuntimeUnavailableDefinitionIdentityV1({
        providerFamily: providerId,
        status: 'host-disabled',
      })
    : status === 'unsupported-platform'
      ? createAgentRuntimeUnavailableDefinitionIdentityV1({
          providerFamily: providerId,
          status: 'unsupported-platform',
        })
      : projectBuiltInProviderDefinitionIdentity(providerId, platform);
}

function publicProbeStatus(
  status: ProviderResolution['status'],
): AgentRuntimeProbeEvidenceV1['status'] {
  return status === 'available'
    ? 'ready'
    : status === 'disabled'
      ? 'host-disabled'
      : status;
}

function providerResolutionStatus(
  status: AgentRuntimeProbeEvidenceV1['status'],
): ProviderResolution['status'] {
  return status === 'ready'
    ? 'available'
    : status === 'host-disabled'
      ? 'disabled'
      : status;
}
