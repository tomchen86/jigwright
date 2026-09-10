/**
 * Materializes durable role assignment records, session slots, and Grant
 * requirements.
 *
 * Invariants:
 * - Read records must match their recomputed digest and requested change
 *   generation.
 */
import crypto from 'node:crypto';

import {
  assertAgentProviderConfigSnapshot,
  type AgentProviderConfigSnapshot,
} from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertAgentRolePlanV2Snapshot,
  type AgentRole,
  type AgentRolePair,
  type AgentRolePlanV2Snapshot,
} from './agent-role-plan.ts';
import {
  assertCentralRoleProviderDefaultSnapshotV1,
  type CentralRoleProviderDefaultSnapshotV1,
} from './central-role-provider-default.ts';
import {
  changeRoleAssignmentDataAuthorizationDigestV1,
  resolveChangeRoleAssignmentV1,
  type ChangeRoleAssignmentCallerV1,
  type ChangeRoleAssignmentDataAuthorizationV1,
  type ChangeRoleAssignmentSessionCapabilityV1,
  type ResolvedChangeRoleAssignmentV1,
} from './change-role-assignment.ts';
import type { RoleTopologyProviderRegistryV1 } from './role-topology-resolution.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const LOGICAL_PROVIDER_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
const PROVIDER_FAMILY = /^[a-z0-9](?:[a-z0-9._/-]{0,126}[a-z0-9])?$/u;
const ROLE_ORDER = ['author', 'builder', 'reviewer'] as const;
const MAX_REASON_BYTES = 4_096;

/**
 * Canonical below-floor facts for a future Central Grant transition. This
 * projection is deliberately proof- and lifecycle-neutral: it does not confer
 * authority and contains no approval method or Grant lifecycle identity.
 */
export type ChangeRoleAssignmentGrantRequirementV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-grant-requirement.v1';
  exactRolePairs: readonly AgentRolePair[];
  assignmentDigest: string;
  resolutionDigest: string;
  centralConfigurationDigest: string;
  changeOverrideDigest: string;
  hostConfigurationDigest: string;
  providerRegistryDigest: string;
  dataAuthorizationDigest: string;
  sessionCapabilityDigest: string;
}>;

export type ChangeRoleAssignmentSessionSlotProfileV1 = Readonly<{
  role: AgentRole;
  profileId: string | null;
  profileDigest: string | null;
}>;

export type ChangeRoleAssignmentSessionSlotV1 = Readonly<{
  sessionSlotId: string;
  resolverSessionSlotId: string;
  sessionMode: 'caller-existing' | 'fresh';
  callerEngineSessionId: string | null;
  roles: readonly AgentRole[];
  logicalProviderId: string;
  providerDefinitionDigest: string;
  profiles: readonly ChangeRoleAssignmentSessionSlotProfileV1[];
}>;

export type ChangeRoleAssignmentHostConfigurationEvidenceV1 = Readonly<{
  sourceDigest: string;
  configuration: AgentProviderConfigSnapshot;
  globalRankingDigest: string;
}>;

export type ChangeRoleAssignmentProviderRegistryEvidenceV1 = Readonly<{
  snapshot: RoleTopologyProviderRegistryV1;
  registryDigest: string;
}>;

export type ChangeRoleAssignmentSessionCapabilityEvidenceV1 = Readonly<{
  snapshot: readonly ChangeRoleAssignmentSessionCapabilityV1[];
  capabilitySnapshotDigest: string;
}>;

export type ChangeRoleAssignmentHostConfigurationVerifierPort = (
  evidence: ChangeRoleAssignmentHostConfigurationEvidenceV1,
) => ChangeRoleAssignmentHostConfigurationEvidenceV1;

export type ChangeRoleAssignmentProviderRegistryVerifierPort = (
  evidence: ChangeRoleAssignmentProviderRegistryEvidenceV1,
) => ChangeRoleAssignmentProviderRegistryEvidenceV1;

export type ChangeRoleAssignmentSessionCapabilityVerifierPort = (
  evidence: ChangeRoleAssignmentSessionCapabilityEvidenceV1,
) => ChangeRoleAssignmentSessionCapabilityEvidenceV1;

export type ChangeRoleAssignmentRecordBodyV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-record.v1';
  changeId: string;
  planningGeneration: string;
  central: CentralRoleProviderDefaultSnapshotV1;
  host: ChangeRoleAssignmentHostConfigurationEvidenceV1;
  changeOverride: AgentRolePlanV2Snapshot | null;
  caller: ChangeRoleAssignmentCallerV1;
  dataAuthorization: Readonly<{
    snapshot: ChangeRoleAssignmentDataAuthorizationV1;
    decisionSnapshotDigest: string;
  }>;
  sessionCapabilities: ChangeRoleAssignmentSessionCapabilityEvidenceV1;
  providerRegistry: ChangeRoleAssignmentProviderRegistryEvidenceV1;
  resolution: ResolvedChangeRoleAssignmentV1;
  sessionSlots: readonly ChangeRoleAssignmentSessionSlotV1[];
  assignmentDigest: string;
  grantRequirement: ChangeRoleAssignmentGrantRequirementV1 | null;
}>;

export type ChangeRoleAssignmentRecordV1 = ChangeRoleAssignmentRecordBodyV1 &
  Readonly<{ recordDigest: string }>;

export type CreateChangeRoleAssignmentRecordInputV1 = Readonly<{
  central: CentralRoleProviderDefaultSnapshotV1;
  host: Readonly<{
    sourceDigest: string;
    configuration: AgentProviderConfigSnapshot;
  }>;
  changeOverride: AgentRolePlanV2Snapshot | null;
  caller: ChangeRoleAssignmentCallerV1;
  dataAuthorization: ChangeRoleAssignmentDataAuthorizationV1;
  sessionCapabilities: readonly ChangeRoleAssignmentSessionCapabilityV1[];
  providerRegistry: RoleTopologyProviderRegistryV1;
  resolution: ResolvedChangeRoleAssignmentV1;
}>;

export type ChangeRoleAssignmentRecordExpectationV1 = Readonly<{
  changeId?: string;
  planningGeneration?: string;
  recordDigest?: string;
}>;

export class ChangeRoleAssignmentRecordError extends TypeError {
  readonly code = 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID';

  constructor() {
    super('Durable change role-assignment record is invalid.');
    this.name = 'ChangeRoleAssignmentRecordError';
  }
}

/** Materialize one immutable assignment record from complete resolver inputs. */
export function createChangeRoleAssignmentRecordV1(
  input: CreateChangeRoleAssignmentRecordInputV1,
): ChangeRoleAssignmentRecordV1 {
  const body = materializeBody(input);
  return deepFreeze({
    ...body,
    recordDigest: digestBody(body),
  });
}

/** Revalidate every stored snapshot and replay the pure resolver from it. */
export function assertChangeRoleAssignmentRecordV1(
  value: unknown,
  expected: ChangeRoleAssignmentRecordExpectationV1 = {},
): ChangeRoleAssignmentRecordV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'planningGeneration',
      'central',
      'host',
      'changeOverride',
      'caller',
      'dataAuthorization',
      'sessionCapabilities',
      'providerRegistry',
      'resolution',
      'sessionSlots',
      'assignmentDigest',
      'grantRequirement',
      'recordDigest',
    ]) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw recordInvalid();
  }
  const body = assertRecordBody(projectBody(value));
  const recordDigest = digestBody(body);
  if (
    value.recordDigest !== recordDigest ||
    (expected.changeId !== undefined && expected.changeId !== body.changeId) ||
    (expected.planningGeneration !== undefined &&
      expected.planningGeneration !== body.planningGeneration) ||
    (expected.recordDigest !== undefined &&
      expected.recordDigest !== recordDigest)
  ) {
    throw recordInvalid();
  }
  return deepFreeze({ ...body, recordDigest });
}

export function changeRoleAssignmentRecordDigestV1(
  value: ChangeRoleAssignmentRecordBodyV1,
): string {
  return digestBody(assertRecordBody(value));
}

function materializeBody(
  input: CreateChangeRoleAssignmentRecordInputV1,
): ChangeRoleAssignmentRecordBodyV1 {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'central',
      'host',
      'changeOverride',
      'caller',
      'dataAuthorization',
      'sessionCapabilities',
      'providerRegistry',
      'resolution',
    ])
  ) {
    throw recordInvalid();
  }
  const central = assertCentralSnapshot(input.central);
  const host = assertHostInput(input.host);
  const changeOverride = cloneChangeOverrideSnapshot(input.changeOverride);
  const caller = assertCaller(input.caller);
  const providerRegistrySnapshot = assertProviderRegistry(
    input.providerRegistry,
    host.configuration,
  );
  const registryDigest = sha256(canonicalJson(providerRegistrySnapshot));
  const dataAuthorizationSnapshot = assertDataAuthorization(
    input.dataAuthorization,
    host.configuration,
  );
  const sessionCapabilitySnapshot = assertSessionCapabilities(
    input.sessionCapabilities,
    host.configuration,
  );
  const identity = resolutionIdentity(input.resolution);
  let replay: ReturnType<typeof resolveChangeRoleAssignmentV1>;
  try {
    replay = resolveChangeRoleAssignmentV1({
      changeId: identity.changeId,
      planningGeneration: identity.planningGeneration,
      providerRegistryDigest: registryDigest,
      centralDefault: central.configuration,
      changeOverride: changeOverride?.plan ?? null,
      providerConfiguration: host.configuration,
      caller,
      dataAuthorization: dataAuthorizationSnapshot,
      sessionCapabilities: sessionCapabilitySnapshot,
      protectedContext:
        input.resolution.protectedContext === null
          ? undefined
          : input.resolution.protectedContext,
    });
  } catch {
    throw recordInvalid();
  }
  if (
    replay.outcome === 'unsatisfied' ||
    canonicalJson(replay.resolution) !== canonicalJson(input.resolution)
  ) {
    throw recordInvalid();
  }
  const resolution = replay.resolution;
  const sessionSlots = deriveSessionSlots(
    resolution,
    caller,
    host.configuration,
    providerRegistrySnapshot,
  );
  const hostSnapshot = Object.freeze({
    ...host,
    globalRankingDigest: sha256(
      `workflow.change-role-assignment-host-global-ranking.v1\n${canonicalJson({
        platform: host.configuration.platform,
        globalRanking: host.configuration.globalRanking,
        globalRankingSource: host.configuration.globalRankingSource,
      })}`,
    ),
  });
  const dataAuthorization = Object.freeze({
    snapshot: dataAuthorizationSnapshot,
    decisionSnapshotDigest: changeRoleAssignmentDataAuthorizationDigestV1(
      dataAuthorizationSnapshot,
    ),
  });
  const sessionCapabilities = Object.freeze({
    snapshot: sessionCapabilitySnapshot,
    capabilitySnapshotDigest: sha256(
      `workflow.change-role-assignment-session-capabilities.v1\n${canonicalJson(
        sessionCapabilitySnapshot,
      )}`,
    ),
  });
  const providerRegistry = Object.freeze({
    snapshot: providerRegistrySnapshot,
    registryDigest,
  });
  const assignmentDigest = digestAssignmentCandidate({
    resolution,
    sessionSlots,
    hostConfigurationDigest: host.configuration.configDigest,
    providerRegistryDigest: registryDigest,
    dataAuthorizationDigest: dataAuthorization.decisionSnapshotDigest,
    sessionCapabilityDigest: sessionCapabilities.capabilitySnapshotDigest,
  });
  const grantRequirement = createGrantRequirement({
    resolution,
    assignmentDigest,
    hostConfigurationDigest: host.configuration.configDigest,
    providerRegistryDigest: registryDigest,
    dataAuthorizationDigest: dataAuthorization.decisionSnapshotDigest,
    sessionCapabilityDigest: sessionCapabilities.capabilitySnapshotDigest,
  });
  const body = {
    schemaVersion: 1 as const,
    kind: 'change-role-assignment-record.v1' as const,
    changeId: resolution.changeId,
    planningGeneration: resolution.planningGeneration,
    central,
    host: hostSnapshot,
    changeOverride,
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution,
    sessionSlots,
    assignmentDigest,
    grantRequirement,
  };
  return deepFreeze(body);
}

function assertRecordBody(value: unknown): ChangeRoleAssignmentRecordBodyV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'planningGeneration',
      'central',
      'host',
      'changeOverride',
      'caller',
      'dataAuthorization',
      'sessionCapabilities',
      'providerRegistry',
      'resolution',
      'sessionSlots',
      'assignmentDigest',
      'grantRequirement',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'change-role-assignment-record.v1' ||
    !isRecord(value.host) ||
    !hasExactKeys(value.host, [
      'sourceDigest',
      'configuration',
      'globalRankingDigest',
    ]) ||
    !isRecord(value.dataAuthorization) ||
    !hasExactKeys(value.dataAuthorization, [
      'snapshot',
      'decisionSnapshotDigest',
    ]) ||
    !isRecord(value.sessionCapabilities) ||
    !hasExactKeys(value.sessionCapabilities, [
      'snapshot',
      'capabilitySnapshotDigest',
    ]) ||
    !isRecord(value.providerRegistry) ||
    !hasExactKeys(value.providerRegistry, ['snapshot', 'registryDigest'])
  ) {
    throw recordInvalid();
  }
  const recreated = materializeBody({
    central:
      value.central as CreateChangeRoleAssignmentRecordInputV1['central'],
    host: {
      sourceDigest: String(value.host.sourceDigest),
      configuration: value.host.configuration as AgentProviderConfigSnapshot,
    },
    changeOverride:
      value.changeOverride as CreateChangeRoleAssignmentRecordInputV1['changeOverride'],
    caller: value.caller as ChangeRoleAssignmentCallerV1,
    dataAuthorization: value.dataAuthorization
      .snapshot as ChangeRoleAssignmentDataAuthorizationV1,
    sessionCapabilities: value.sessionCapabilities
      .snapshot as readonly ChangeRoleAssignmentSessionCapabilityV1[],
    providerRegistry: value.providerRegistry
      .snapshot as RoleTopologyProviderRegistryV1,
    resolution: value.resolution as ResolvedChangeRoleAssignmentV1,
  });
  if (canonicalJson(recreated) !== canonicalJson(value)) throw recordInvalid();
  return recreated;
}

function assertCentralSnapshot(
  value: unknown,
): ChangeRoleAssignmentRecordBodyV1['central'] {
  try {
    return assertCentralRoleProviderDefaultSnapshotV1(value);
  } catch {
    throw recordInvalid();
  }
}

function cloneChangeOverrideSnapshot(
  value: AgentRolePlanV2Snapshot | null,
): AgentRolePlanV2Snapshot | null {
  if (value === null) return null;
  try {
    return assertAgentRolePlanV2Snapshot(value);
  } catch {
    throw recordInvalid();
  }
}

function assertHostInput(
  value: CreateChangeRoleAssignmentRecordInputV1['host'],
): Readonly<{
  sourceDigest: string;
  configuration: AgentProviderConfigSnapshot;
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sourceDigest', 'configuration']) ||
    typeof value.sourceDigest !== 'string' ||
    !DIGEST.test(value.sourceDigest)
  ) {
    throw recordInvalid();
  }
  let configuration: AgentProviderConfigSnapshot;
  try {
    configuration = assertAgentProviderConfigSnapshot(value.configuration);
  } catch {
    throw recordInvalid();
  }
  return deepFreeze({ sourceDigest: value.sourceDigest, configuration });
}

function assertCaller(value: unknown): ChangeRoleAssignmentCallerV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'logicalProviderId',
      'profileId',
      'engineSessionId',
      'adoptableRoles',
    ]) ||
    typeof value.logicalProviderId !== 'string' ||
    !LOGICAL_PROVIDER_ID.test(value.logicalProviderId) ||
    (value.profileId !== null &&
      (typeof value.profileId !== 'string' || value.profileId.length === 0)) ||
    (value.engineSessionId !== null &&
      (typeof value.engineSessionId !== 'string' ||
        value.engineSessionId.length === 0 ||
        value.engineSessionId.length > 256 ||
        /[\0\r\n]/u.test(value.engineSessionId))) ||
    !Array.isArray(value.adoptableRoles) ||
    !isCanonicalRoles(value.adoptableRoles)
  ) {
    throw recordInvalid();
  }
  return deepFreeze({
    logicalProviderId: value.logicalProviderId,
    profileId: value.profileId,
    engineSessionId: value.engineSessionId,
    adoptableRoles: [...value.adoptableRoles],
  });
}

function assertDataAuthorization(
  value: unknown,
  configuration: AgentProviderConfigSnapshot,
): ChangeRoleAssignmentDataAuthorizationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'policyDigest',
      'inputManifestDigest',
      'relevantTargetDigest',
      'profiles',
    ]) ||
    typeof value.policyDigest !== 'string' ||
    !DIGEST.test(value.policyDigest) ||
    typeof value.inputManifestDigest !== 'string' ||
    !DIGEST.test(value.inputManifestDigest) ||
    typeof value.relevantTargetDigest !== 'string' ||
    !DIGEST.test(value.relevantTargetDigest) ||
    !Array.isArray(value.profiles)
  ) {
    throw recordInvalid();
  }
  const byProfile = new Map<string, { allowed: boolean; reason: string }>();
  for (const entry of value.profiles) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['profileId', 'allowed', 'reason']) ||
      typeof entry.profileId !== 'string' ||
      typeof entry.allowed !== 'boolean' ||
      typeof entry.reason !== 'string' ||
      entry.reason.length === 0 ||
      Buffer.byteLength(entry.reason) > MAX_REASON_BYTES ||
      byProfile.has(entry.profileId)
    ) {
      throw recordInvalid();
    }
    byProfile.set(entry.profileId, {
      allowed: entry.allowed,
      reason: entry.reason,
    });
  }
  if (byProfile.size !== configuration.providers.length) throw recordInvalid();
  return deepFreeze({
    policyDigest: value.policyDigest,
    inputManifestDigest: value.inputManifestDigest,
    relevantTargetDigest: value.relevantTargetDigest,
    profiles: configuration.providers.map(({ id }) => {
      const entry = byProfile.get(id);
      if (entry === undefined) throw recordInvalid();
      return { profileId: id, ...entry };
    }),
  });
}

function assertSessionCapabilities(
  value: unknown,
  configuration: AgentProviderConfigSnapshot,
): readonly ChangeRoleAssignmentSessionCapabilityV1[] {
  if (!Array.isArray(value)) throw recordInvalid();
  const byProfile = new Map<
    string,
    Readonly<{ canStartFresh: boolean; canResume: boolean }>
  >();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['profileId', 'canStartFresh', 'canResume']) ||
      typeof entry.profileId !== 'string' ||
      typeof entry.canStartFresh !== 'boolean' ||
      typeof entry.canResume !== 'boolean' ||
      byProfile.has(entry.profileId)
    ) {
      throw recordInvalid();
    }
    byProfile.set(entry.profileId, {
      canStartFresh: entry.canStartFresh,
      canResume: entry.canResume,
    });
  }
  if (byProfile.size !== configuration.providers.length) throw recordInvalid();
  return deepFreeze(
    configuration.providers.map(({ id }) => {
      const entry = byProfile.get(id);
      if (entry === undefined) throw recordInvalid();
      return { profileId: id, ...entry };
    }),
  );
}

function assertProviderRegistry(
  value: unknown,
  configuration: AgentProviderConfigSnapshot,
): RoleTopologyProviderRegistryV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'policyDigest', 'providers']) ||
    value.schemaVersion !== 1 ||
    typeof value.policyDigest !== 'string' ||
    !DIGEST.test(value.policyDigest) ||
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    value.providers.length > 64
  ) {
    throw recordInvalid();
  }
  let previous = '';
  const providers = value.providers.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'logicalProviderId',
        'providerFamily',
        'enabled',
        'definitionDigest',
      ]) ||
      typeof entry.logicalProviderId !== 'string' ||
      !LOGICAL_PROVIDER_ID.test(entry.logicalProviderId) ||
      entry.logicalProviderId <= previous ||
      typeof entry.providerFamily !== 'string' ||
      !PROVIDER_FAMILY.test(entry.providerFamily) ||
      typeof entry.enabled !== 'boolean' ||
      (entry.definitionDigest !== null &&
        (typeof entry.definitionDigest !== 'string' ||
          !DIGEST.test(entry.definitionDigest)))
    ) {
      throw recordInvalid();
    }
    previous = entry.logicalProviderId;
    return Object.freeze({
      logicalProviderId: entry.logicalProviderId,
      providerFamily: entry.providerFamily,
      enabled: entry.enabled,
      definitionDigest: entry.definitionDigest,
    });
  });
  const byLogicalId = new Map(
    providers.map((entry) => [entry.logicalProviderId, entry]),
  );
  for (const profile of configuration.providers) {
    const registered = byLogicalId.get(profile.logicalProviderId);
    if (registered?.providerFamily !== profile.family) throw recordInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    policyDigest: value.policyDigest,
    providers,
  });
}

function resolutionIdentity(value: unknown): Readonly<{
  changeId: string;
  planningGeneration: string;
}> {
  if (
    !isRecord(value) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    value.changeId === 'archive' ||
    typeof value.planningGeneration !== 'string' ||
    !DIGEST.test(value.planningGeneration)
  ) {
    throw recordInvalid();
  }
  return Object.freeze({
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
  });
}

function deriveSessionSlots(
  resolution: ResolvedChangeRoleAssignmentV1,
  caller: ChangeRoleAssignmentCallerV1,
  configuration: AgentProviderConfigSnapshot,
  registry: RoleTopologyProviderRegistryV1,
): readonly ChangeRoleAssignmentSessionSlotV1[] {
  const registryByLogicalId = new Map(
    registry.providers.map((entry) => [entry.logicalProviderId, entry]),
  );
  const profileById = new Map(
    configuration.providers.map((profile) => [profile.id, profile]),
  );
  const grouped = new Map<
    string,
    ResolvedChangeRoleAssignmentV1['placements'][number][]
  >();
  for (const placement of resolution.placements) {
    const placements = grouped.get(placement.sessionSlotId) ?? [];
    placements.push(placement);
    grouped.set(placement.sessionSlotId, placements);
  }
  const slots = [...grouped.entries()].map(
    ([resolverSessionSlotId, placements]) => {
      const logicalProviderId = placements[0]!.logicalProviderId;
      const sessionMode = placements[0]!.sessionMode;
      if (
        placements.some(
          (placement) =>
            placement.logicalProviderId !== logicalProviderId ||
            placement.sessionMode !== sessionMode,
        )
      ) {
        throw recordInvalid();
      }
      const registered = registryByLogicalId.get(logicalProviderId);
      if (
        registered?.enabled !== true ||
        registered.definitionDigest === null
      ) {
        throw recordInvalid();
      }
      const profiles = placements.map(({ role, profileId }) => {
        if (profileId === null) {
          return Object.freeze({ role, profileId: null, profileDigest: null });
        }
        const profile = profileById.get(profileId);
        if (profile?.logicalProviderId !== logicalProviderId) {
          throw recordInvalid();
        }
        return Object.freeze({
          role,
          profileId,
          profileDigest: profile.profileDigest,
        });
      });
      const roles = placements.map(({ role }) => role);
      return Object.freeze({
        sessionSlotId: `role-assignment-session-${sha256(
          `workflow.change-role-assignment-session-slot.v1\n${canonicalJson({
            changeId: resolution.changeId,
            planningGeneration: resolution.planningGeneration,
            resolverSessionSlotId,
          })}`,
        )}`,
        resolverSessionSlotId,
        sessionMode,
        callerEngineSessionId:
          sessionMode === 'caller-existing' ? caller.engineSessionId : null,
        roles: Object.freeze(roles),
        logicalProviderId,
        providerDefinitionDigest: registered.definitionDigest,
        profiles: Object.freeze(profiles),
      });
    },
  );
  slots.sort(
    (left, right) =>
      ROLE_ORDER.indexOf(left.roles[0]!) - ROLE_ORDER.indexOf(right.roles[0]!),
  );
  if (
    slots.some(
      (slot) =>
        (slot.sessionMode === 'caller-existing' &&
          slot.callerEngineSessionId === null) ||
        (slot.sessionMode === 'fresh' && slot.callerEngineSessionId !== null),
    ) ||
    canonicalJson(slots.flatMap(({ roles }) => roles)) !==
      canonicalJson(ROLE_ORDER)
  ) {
    throw recordInvalid();
  }
  return deepFreeze(slots);
}

function digestAssignmentCandidate(
  input: Readonly<{
    resolution: ResolvedChangeRoleAssignmentV1;
    sessionSlots: readonly ChangeRoleAssignmentSessionSlotV1[];
    hostConfigurationDigest: string;
    providerRegistryDigest: string;
    dataAuthorizationDigest: string;
    sessionCapabilityDigest: string;
  }>,
): string {
  return sha256(
    `workflow.change-role-assignment-candidate.v1\n${canonicalJson({
      schemaVersion: 1,
      kind: 'change-role-assignment-candidate.v1',
      changeId: input.resolution.changeId,
      planningGeneration: input.resolution.planningGeneration,
      resolutionDigest: input.resolution.resolutionDigest,
      centralConfigurationDigest: input.resolution.centralConfigurationDigest,
      changeOverrideDigest: input.resolution.changeOverrideDigest,
      hostConfigurationDigest: input.hostConfigurationDigest,
      providerRegistryDigest: input.providerRegistryDigest,
      dataAuthorizationDigest: input.dataAuthorizationDigest,
      sessionCapabilityDigest: input.sessionCapabilityDigest,
      sessionSlots: input.sessionSlots,
    })}`,
  );
}

function createGrantRequirement(
  input: Readonly<{
    resolution: ResolvedChangeRoleAssignmentV1;
    assignmentDigest: string;
    hostConfigurationDigest: string;
    providerRegistryDigest: string;
    dataAuthorizationDigest: string;
    sessionCapabilityDigest: string;
  }>,
): ChangeRoleAssignmentGrantRequirementV1 | null {
  if (input.resolution.exactGrantRolePairs.length === 0) return null;
  return deepFreeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-requirement.v1',
    exactRolePairs: Object.freeze([...input.resolution.exactGrantRolePairs]),
    assignmentDigest: input.assignmentDigest,
    resolutionDigest: input.resolution.resolutionDigest,
    centralConfigurationDigest: input.resolution.centralConfigurationDigest,
    changeOverrideDigest: input.resolution.changeOverrideDigest,
    hostConfigurationDigest: input.hostConfigurationDigest,
    providerRegistryDigest: input.providerRegistryDigest,
    dataAuthorizationDigest: input.dataAuthorizationDigest,
    sessionCapabilityDigest: input.sessionCapabilityDigest,
  });
}

function projectBody(
  value: Record<string, unknown>,
): ChangeRoleAssignmentRecordBodyV1 {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
    central: value.central,
    host: value.host,
    changeOverride: value.changeOverride,
    caller: value.caller,
    dataAuthorization: value.dataAuthorization,
    sessionCapabilities: value.sessionCapabilities,
    providerRegistry: value.providerRegistry,
    resolution: value.resolution,
    sessionSlots: value.sessionSlots,
    assignmentDigest: value.assignmentDigest,
    grantRequirement: value.grantRequirement,
  } as ChangeRoleAssignmentRecordBodyV1;
}

function digestBody(value: ChangeRoleAssignmentRecordBodyV1): string {
  return sha256(
    `workflow.change-role-assignment-record.v1\n${canonicalJson(value)}`,
  );
}

function isCanonicalRoles(value: unknown[]): value is AgentRole[] {
  if (
    value.some(
      (role) =>
        typeof role !== 'string' || !ROLE_ORDER.includes(role as AgentRole),
    ) ||
    new Set(value).size !== value.length
  ) {
    return false;
  }
  return value.every(
    (role, index) =>
      role ===
      ROLE_ORDER.filter((candidate) => value.includes(candidate))[index],
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recordInvalid(): ChangeRoleAssignmentRecordError {
  return new ChangeRoleAssignmentRecordError();
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
