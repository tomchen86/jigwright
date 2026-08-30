import crypto from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  AgentProviderConfigSnapshot,
  AgentProviderProfileSnapshot,
  ProviderDefinitionSnapshot,
} from '@jigwright/agent-runtime';

import { loadChangeContract } from '../adapters/consumer/repository/work-registry/contracts.ts';
import { parseTaskAuthorizationPolicyFromWorkflowConfig } from '../adapters/consumer/repository/work-registry/task-authorization-policy.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  createChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentHostConfigurationEvidenceV1,
  type ChangeRoleAssignmentProviderRegistryEvidenceV1,
  type ChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentSessionCapabilityEvidenceV1,
} from '../modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
  type ChangeRoleAssignmentDataAuthorizationV1,
  type ChangeRoleAssignmentProtectedContextV1,
  type ChangeRoleAssignmentSessionCapabilityV1,
} from '../modules/provider-orchestration/change-role-assignment.ts';
import type { AgentRole } from '../modules/provider-orchestration/agent-role-plan.ts';
import { parsePathRoleRegistry } from '../modules/source/path-role-registry.ts';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeNativeSessionTurnControllerV1,
} from '../modules/provider-orchestration/agent-runtime-port.ts';
import type { ProviderInvocationRequest } from '../modules/provider-orchestration/provider-contracts.ts';
import {
  isProviderId,
  type ProviderId,
} from '../modules/provider-orchestration/provider-registry.ts';
import type { RoleTopologyProviderRegistryV1 } from '../modules/provider-orchestration/role-topology-resolution.ts';
import {
  AgentProviderConfigFileError,
  assertAgentProviderConfigFileCurrent,
  loadAgentProviderConfigFile,
  type LoadedAgentProviderConfigFile,
} from '../runtime/provider-execution/agent-provider-config-file.ts';
import { loadAiAdapterPolicy } from '../runtime/provider-execution/ai-adapter-policy.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../runtime/provider-execution/built-in-provider-definition.ts';
import {
  assertPinnedAgentRolePlanV2Snapshot,
  readPinnedAgentRolePlanV2Snapshot,
} from '../runtime/repository-transaction/agent-role-plan-store.ts';
import {
  assertPinnedCentralRoleProviderDefaultSnapshot,
  readPinnedCentralRoleProviderDefaultSnapshot,
} from '../runtime/repository-transaction/central-role-provider-default-store.ts';
import {
  discoverRepository,
  runGitBuffer,
} from '../runtime/repository-transaction/git.ts';
import { createOrReadExactChangeRoleAssignmentRecordV1 } from '../runtime/storage-journal/change-role-assignment-store.ts';
import {
  readCompletedChangeRoleAssignmentGrantAuthority,
  type CompletedChangeRoleAssignmentGrantAuthorityV1,
} from '../runtime/storage-journal/change-role-assignment-grant-store.ts';
import {
  claimProviderNativeSessionTurnV1,
  completeClaimedProviderNativeSessionTurnV1,
  completeProviderNativeSessionTurnV1,
  readProviderNativeSessionChainV1,
} from '../runtime/storage-journal/provider-native-session-store.ts';
import type { InvestigationRuntimePaths } from '../runtime/session-workspace/paths.ts';

const ROLE_BY_PURPOSE = Object.freeze({
  survey: 'author',
  'plan-review': 'reviewer',
  'task-diff-review': 'reviewer',
  'task-implementation': 'builder',
} as const);

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PINNED_POLICY_TREE_ENTRY =
  /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

export type CurrentAgentRuntimeAssignmentInputV1 = Readonly<{
  repositoryRoot: string;
  runtime: InvestigationRuntimePaths;
  grantRuntimeRoot: string;
  changeId: string;
  request: ProviderInvocationRequest;
  configFilePath: string;
  platform: NodeJS.Platform;
}>;

export type CurrentAgentRuntimeAssignmentV1 = Readonly<{
  record: ChangeRoleAssignmentRecordV1;
  binding: AgentRuntimeAssignmentBindingV1;
  nativeSessionTurn: AgentRuntimeNativeSessionTurnControllerV1 | null;
}>;

type CurrentManifestFacts = Readonly<{
  manifestDigest: string;
  pathRoleSourceDigest: string;
}>;

type CurrentSources = Readonly<{
  manifest: CurrentManifestFacts;
  host: LoadedAgentProviderConfigFile;
  policy: ReturnType<typeof loadAiAdapterPolicy>;
}>;

export type CurrentAgentRuntimeAssignmentPreGrantInputV1 = Omit<
  CurrentAgentRuntimeAssignmentInputV1,
  'grantRuntimeRoot' | 'runtime'
>;

type CurrentAgentRuntimeAssignmentPreGrantResolutionV1 = Readonly<{
  repositoryRoot: string;
  sources: CurrentSources;
  dataAuthorization: ChangeRoleAssignmentDataAuthorizationV1;
  candidate: ChangeRoleAssignmentRecordV1;
}>;

/**
 * Resolve and publish one launch-eligible V1 assignment from current Manifest,
 * host registry, and data-authorization facts. Grant-required or unavailable
 * topologies are recorded when possible but never degraded into launch
 * authority.
 */
export function createCurrentAgentRuntimeAssignmentV1(
  input: CurrentAgentRuntimeAssignmentInputV1,
): CurrentAgentRuntimeAssignmentV1 {
  const { repositoryRoot, sources, dataAuthorization, candidate } =
    resolveCurrentAgentRuntimeAssignmentPreGrant(input);
  const record = createOrReadExactChangeRoleAssignmentRecordV1(
    input.runtime,
    candidate,
    (snapshot) =>
      assertPinnedCentralRoleProviderDefaultSnapshot(repositoryRoot, snapshot),
    (snapshot) => assertPinnedAgentRolePlanV2Snapshot(repositoryRoot, snapshot),
    (evidence) => verifyHostConfiguration(sources, evidence),
    (evidence) =>
      verifyProviderRegistry(input, sources, dataAuthorization, evidence),
    (snapshot) => verifyDataAuthorization(input, sources, snapshot),
    (evidence) => verifySessionCapabilities(input, sources, evidence),
    (context) => verifyProtectedContext(input, sources, context),
  );
  const grantAuthority =
    record.grantRequirement === null
      ? null
      : readCompletedChangeRoleAssignmentGrantAuthority(
          input.runtime,
          input.grantRuntimeRoot,
          record,
          input.request.invocationId,
          input.request.repositoryId,
        );
  if (record.grantRequirement !== null && grantAuthority === null) {
    throw workflowError(
      'AGENT_RUNTIME_GRANT_REQUIRED',
      'AgentRuntime assignment requires one exact Central Fail-Grant decision before provider launch.',
      ExitCode.verification,
      {
        details: {
          invocationId: input.request.invocationId,
          changeId: input.changeId,
          recordDigest: record.recordDigest,
        },
      },
    );
  }
  const binding = projectRuntimeBinding(record, input.request);
  return Object.freeze({
    record,
    binding,
    nativeSessionTurn: createNativeSessionTurnController(
      record,
      binding,
      input,
      sources,
      dataAuthorization,
      grantAuthority,
    ),
  });
}

/**
 * Recompute one current assignment candidate without publishing runtime state,
 * consuming Grant authority, or creating a native provider session.
 */
export function resolveCurrentAgentRuntimeAssignmentPreGrantV1(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
): ChangeRoleAssignmentRecordV1 {
  return resolveCurrentAgentRuntimeAssignmentPreGrant(input).candidate;
}

function resolveCurrentAgentRuntimeAssignmentPreGrant(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
): CurrentAgentRuntimeAssignmentPreGrantResolutionV1 {
  const repository = discoverRepository(input.repositoryRoot);
  const repositoryRoot = repository.repositoryRealPath;
  const manifest = readCurrentManifestFacts(
    repositoryRoot,
    input.changeId,
    input.request.baseCommit,
  );
  const host = loadAgentProviderConfigFile(input.configFilePath, {
    platform: input.platform,
  });
  assertExternalHostConfiguration(
    host.sourcePath,
    repositoryRoot,
    repository.gitCommonDirectory,
  );
  const policy = loadAiAdapterPolicy(repositoryRoot);
  if (policy.digest !== input.request.policyDigest) {
    throw assignmentFailure(
      'AGENT_RUNTIME_DATA_AUTHORIZATION_STALE',
      'AgentRuntime assignment requires the exact current data-authorization policy.',
    );
  }
  const sources = Object.freeze({ manifest, host, policy });
  const providerConfiguration = assertAgentProviderConfigFileCurrent(host);
  const central = readPinnedCentralRoleProviderDefaultSnapshot(
    repositoryRoot,
    input.request.baseCommit,
  );
  const changeOverride = readPinnedAgentRolePlanV2Snapshot(
    repositoryRoot,
    input.request.baseCommit,
    input.changeId,
    central.configuration.configurationDigest,
  );
  const dataAuthorization = currentDataAuthorization(
    input,
    sources,
    providerConfiguration,
  );
  const providerRegistry = currentProviderRegistry(
    input.platform,
    sources,
    providerConfiguration,
    dataAuthorization,
  );
  const sessionCapabilities = currentSessionCapabilities(
    providerConfiguration,
    dataAuthorization,
  );
  const callerProfile = selectCallerProfile(
    providerConfiguration,
    dataAuthorization,
    input.request.providerId,
  );
  const caller = Object.freeze({
    logicalProviderId: callerProfile.logicalProviderId,
    profileId: callerProfile.id,
    // This is an engine-derived opaque identity, never a raw native provider ID.
    engineSessionId: `assignment-caller-${sha256(
      `workflow.agent-runtime-assignment-caller.v1\n${input.request.roleAssignmentDigest}`,
    )}`,
    adoptableRoles: Object.freeze([] as AgentRole[]),
  });
  const protectedContext = currentProtectedContext(input, sources);
  const providerRegistryDigest = sha256(canonicalJson(providerRegistry));
  const resolution = resolveChangeRoleAssignmentV1({
    changeId: input.changeId,
    // The MVP assignment generation is the exact current Manifest v3 identity.
    planningGeneration: manifest.manifestDigest,
    providerRegistryDigest,
    centralDefault: central.configuration,
    changeOverride: changeOverride?.plan ?? null,
    providerConfiguration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext,
  });
  if (resolution.outcome === 'unsatisfied') {
    throw assignmentFailure(
      'AGENT_RUNTIME_ASSIGNMENT_UNSATISFIED',
      `AgentRuntime assignment is unavailable (${resolution.code}).`,
    );
  }
  const candidate = createChangeRoleAssignmentRecordV1({
    central,
    host: {
      sourceDigest: host.sourceDigest,
      configuration: providerConfiguration,
    },
    changeOverride,
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution: resolution.resolution,
  });
  assertSourcesCurrent(input, sources);
  return Object.freeze({
    repositoryRoot,
    sources,
    dataAuthorization,
    candidate,
  });
}

function readCurrentManifestFacts(
  repositoryRoot: string,
  changeId: string,
  baselineCommit: string,
): CurrentManifestFacts {
  const contract = loadChangeContract(repositoryRoot, changeId);
  const investigation = contract.investigation;
  if (investigation?.manifest.schemaVersion !== 3) {
    throw assignmentFailure(
      'AGENT_RUNTIME_CURRENT_MANIFEST_REQUIRED',
      'AgentRuntime assignment requires one current authoritative Manifest v3.',
    );
  }
  const pathRoleSource = readPinnedAgentRuntimePathRoleSource(
    repositoryRoot,
    baselineCommit,
  );
  return Object.freeze({
    manifestDigest: investigation.manifest.manifestDigest,
    pathRoleSourceDigest: sha256(pathRoleSource),
  });
}

export function readPinnedAgentRuntimePathRoleSource(
  repositoryRoot: string,
  baselineCommit: string,
): Buffer {
  if (!FULL_OBJECT_ID.test(baselineCommit)) throw pinnedPathRoleInvalid();
  let baselinePolicy: ReturnType<
    typeof parseTaskAuthorizationPolicyFromWorkflowConfig
  >;
  try {
    if (
      !runGitBuffer(repositoryRoot, ['cat-file', '-t', baselineCommit]).equals(
        Buffer.from('commit\n', 'utf8'),
      )
    ) {
      throw new TypeError('baseline is not a commit');
    }
    const baselineConfig = JSON.parse(
      STRICT_UTF8.decode(
        readPinnedPolicyBlob(
          repositoryRoot,
          baselineCommit,
          'workflow/config.json',
        ),
      ),
    );
    baselinePolicy =
      parseTaskAuthorizationPolicyFromWorkflowConfig(baselineConfig);
  } catch {
    throw pinnedPathRoleInvalid();
  }
  if (baselinePolicy === null) throw pinnedPathRoleInvalid();
  let pathRoleSource: Buffer;
  try {
    pathRoleSource = readPinnedPolicyBlob(
      repositoryRoot,
      baselineCommit,
      baselinePolicy.pathRoleRegistry,
    );
    parsePathRoleRegistry(JSON.parse(STRICT_UTF8.decode(pathRoleSource)));
  } catch {
    throw pinnedPathRoleInvalid();
  }
  return pathRoleSource;
}

function readPinnedPolicyBlob(
  repositoryRoot: string,
  baselineCommit: string,
  policyPath: string,
): Buffer {
  const listing = STRICT_UTF8.decode(
    runGitBuffer(repositoryRoot, [
      'ls-tree',
      '-z',
      '--full-tree',
      baselineCommit,
      '--',
      `:(literal)${policyPath}`,
    ]),
  );
  const entry = PINNED_POLICY_TREE_ENTRY.exec(listing);
  if (entry === null || entry[3] !== policyPath) {
    throw pinnedPathRoleInvalid();
  }
  return runGitBuffer(repositoryRoot, ['cat-file', 'blob', entry[2]!]);
}

function pinnedPathRoleInvalid() {
  return assignmentFailure(
    'AGENT_RUNTIME_CURRENT_MANIFEST_REQUIRED',
    'AgentRuntime assignment requires one valid immutable baseline path-role policy in exact mode-100644 blobs.',
  );
}

function currentDataAuthorization(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
  configuration: AgentProviderConfigSnapshot,
): ChangeRoleAssignmentDataAuthorizationV1 {
  assertSourcesCurrent(input, sources);
  return Object.freeze({
    policyDigest: sources.policy.digest,
    inputManifestDigest: sources.manifest.manifestDigest,
    relevantTargetDigest: input.request.targetDigest,
    profiles: Object.freeze(
      configuration.providers.map((profile) => {
        const eligibility = profileEligibility(
          profile,
          input.platform,
          sources.policy,
        );
        return Object.freeze({
          profileId: profile.id,
          allowed: eligibility.allowed,
          reason: eligibility.reason,
        });
      }),
    ),
  });
}

function currentProviderRegistry(
  platform: NodeJS.Platform,
  sources: CurrentSources,
  configuration: AgentProviderConfigSnapshot,
  authorization: ChangeRoleAssignmentDataAuthorizationV1,
): RoleTopologyProviderRegistryV1 {
  const allowed = new Map(
    authorization.profiles.map((entry) => [entry.profileId, entry.allowed]),
  );
  const logicalProviderIds = [
    ...new Set(
      configuration.providers.map(({ logicalProviderId }) => logicalProviderId),
    ),
  ].sort();
  const providers = logicalProviderIds.map((logicalProviderId) => {
    const profiles = configuration.providers.filter(
      (profile) => profile.logicalProviderId === logicalProviderId,
    );
    const families = new Set(profiles.map(({ family }) => family));
    if (families.size !== 1) {
      throw assignmentFailure(
        'AGENT_RUNTIME_PROVIDER_REGISTRY_MISMATCH',
        'One logical provider cannot resolve to multiple provider families.',
      );
    }
    const eligible = profiles.filter((profile) => allowed.get(profile.id));
    const definitionDigests = eligible.map((profile) =>
      providerDefinitionDigest(profile, platform),
    );
    if (definitionDigests.some((digest) => digest !== definitionDigests[0])) {
      throw assignmentFailure(
        'AGENT_RUNTIME_PROVIDER_REGISTRY_MISMATCH',
        'One logical provider cannot resolve to multiple definition identities.',
      );
    }
    return Object.freeze({
      logicalProviderId,
      providerFamily: profiles[0]!.family,
      enabled: eligible.length > 0,
      definitionDigest: definitionDigests[0] ?? null,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    policyDigest: sha256(
      `workflow.agent-runtime-provider-registry-policy.v1\n${canonicalJson({
        platform,
        dataAuthorizationPolicyDigest: sources.policy.digest,
      })}`,
    ),
    providers: Object.freeze(providers),
  });
}

function currentSessionCapabilities(
  configuration: AgentProviderConfigSnapshot,
  authorization: ChangeRoleAssignmentDataAuthorizationV1,
): readonly ChangeRoleAssignmentSessionCapabilityV1[] {
  const allowed = new Map(
    authorization.profiles.map((entry) => [entry.profileId, entry.allowed]),
  );
  return Object.freeze(
    configuration.providers.map((profile) =>
      Object.freeze({
        profileId: profile.id,
        canStartFresh:
          allowed.get(profile.id) === true &&
          profile.capabilities.includes('fresh-session'),
        canResume:
          allowed.get(profile.id) === true &&
          profile.trustTier === 'host-wrapper' &&
          profile.protocol === 'harness-jsonl-v2' &&
          profile.capabilities.includes('resumable-session') &&
          profile.resumeArgs.length > 0,
      }),
    ),
  );
}

function currentProtectedContext(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
): ChangeRoleAssignmentProtectedContextV1 {
  assertSourcesCurrent(input, sources);
  return createChangeRoleAssignmentProtectedContextV1({
    classification: 'ordinary',
    pathRoleSourceDigest: sources.manifest.pathRoleSourceDigest,
    policySourceDigest: sources.policy.digest,
    inputManifestDigest: sources.manifest.manifestDigest,
    relevantTargetDigest: input.request.targetDigest,
  });
}

function selectCallerProfile(
  configuration: AgentProviderConfigSnapshot,
  authorization: ChangeRoleAssignmentDataAuthorizationV1,
  providerId: ProviderId,
): AgentProviderProfileSnapshot {
  const allowed = new Set(
    authorization.profiles
      .filter((entry) => entry.allowed)
      .map((entry) => entry.profileId),
  );
  const selected = configuration.globalRanking
    .map((profileId) =>
      configuration.providers.find((profile) => profile.id === profileId),
    )
    .find(
      (profile) =>
        profile !== undefined &&
        profile.family === providerId &&
        allowed.has(profile.id),
    );
  if (selected === undefined) {
    throw assignmentFailure(
      'AGENT_RUNTIME_DATA_AUTHORIZATION_DENIED',
      'The requested provider has no current authorized host profile.',
    );
  }
  return selected;
}

function profileEligibility(
  profile: AgentProviderProfileSnapshot,
  platform: NodeJS.Platform,
  policy: ReturnType<typeof loadAiAdapterPolicy>,
): Readonly<{ allowed: boolean; reason: string }> {
  if (!profile.enabled)
    return { allowed: false, reason: 'HOST_PROFILE_DISABLED' };
  if (!isProviderId(profile.family)) {
    throw definitionMismatch();
  }
  if (!policy.policy.providers[profile.family].enabled) {
    return { allowed: false, reason: 'REPOSITORY_PROVIDER_DISABLED' };
  }
  if (profile.trustTier === 'host-wrapper') {
    if (profile.protocol !== 'harness-jsonl-v2') {
      return { allowed: false, reason: 'HOST_WRAPPER_PROTOCOL_UNSUPPORTED' };
    }
    return { allowed: true, reason: 'HOST_WRAPPER_AUTHORIZED' };
  }
  requireBuiltInDefinition(profile, platform);
  return { allowed: true, reason: 'BUILT_IN_PROVIDER_AUTHORIZED' };
}

function providerDefinitionDigest(
  profile: AgentProviderProfileSnapshot,
  platform: NodeJS.Platform,
): string {
  return profile.trustTier === 'host-wrapper'
    ? profile.profileDigest
    : requireBuiltInDefinition(profile, platform).definitionDigest;
}

function requireBuiltInDefinition(
  profile: AgentProviderProfileSnapshot,
  platform: NodeJS.Platform,
): ProviderDefinitionSnapshot {
  if (
    profile.trustTier !== 'built-in-reviewed' ||
    !isProviderId(profile.family)
  ) {
    throw definitionMismatch();
  }
  const definition = resolveBuiltInProviderDefinitionSnapshot(
    profile.family,
    platform,
  );
  if (
    definition === null ||
    definition.protocol !== profile.protocol ||
    !definition.executableCandidates.includes(profile.executable)
  ) {
    throw definitionMismatch();
  }
  return definition;
}

function verifyHostConfiguration(
  sources: CurrentSources,
  evidence: ChangeRoleAssignmentHostConfigurationEvidenceV1,
): ChangeRoleAssignmentHostConfigurationEvidenceV1 {
  const configuration = assertAgentProviderConfigFileCurrent(sources.host);
  const current = Object.freeze({
    sourceDigest: sources.host.sourceDigest,
    configuration,
    globalRankingDigest: sha256(
      `workflow.change-role-assignment-host-global-ranking.v1\n${canonicalJson({
        platform: configuration.platform,
        globalRanking: configuration.globalRanking,
        globalRankingSource: configuration.globalRankingSource,
      })}`,
    ),
  });
  return assertSameCurrent(evidence, current);
}

function verifyProviderRegistry(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
  _initialAuthorization: ChangeRoleAssignmentDataAuthorizationV1,
  evidence: ChangeRoleAssignmentProviderRegistryEvidenceV1,
): ChangeRoleAssignmentProviderRegistryEvidenceV1 {
  const configuration = assertAgentProviderConfigFileCurrent(sources.host);
  const authorization = currentDataAuthorization(input, sources, configuration);
  const snapshot = currentProviderRegistry(
    input.platform,
    sources,
    configuration,
    authorization,
  );
  return assertSameCurrent(
    evidence,
    Object.freeze({
      snapshot,
      registryDigest: sha256(canonicalJson(snapshot)),
    }),
  );
}

function verifyDataAuthorization(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
  snapshot: ChangeRoleAssignmentDataAuthorizationV1,
): ChangeRoleAssignmentDataAuthorizationV1 {
  const current = currentDataAuthorization(
    input,
    sources,
    assertAgentProviderConfigFileCurrent(sources.host),
  );
  return assertSameCurrent(snapshot, current);
}

function verifySessionCapabilities(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
  evidence: ChangeRoleAssignmentSessionCapabilityEvidenceV1,
): ChangeRoleAssignmentSessionCapabilityEvidenceV1 {
  const configuration = assertAgentProviderConfigFileCurrent(sources.host);
  const authorization = currentDataAuthorization(input, sources, configuration);
  const snapshot = currentSessionCapabilities(configuration, authorization);
  const current = Object.freeze({
    snapshot,
    capabilitySnapshotDigest: sha256(
      `workflow.change-role-assignment-session-capabilities.v1\n${canonicalJson(snapshot)}`,
    ),
  });
  return assertSameCurrent(evidence, current);
}

function verifyProtectedContext(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
  context: ChangeRoleAssignmentProtectedContextV1,
): ChangeRoleAssignmentProtectedContextV1 {
  return assertSameCurrent(context, currentProtectedContext(input, sources));
}

function assertSourcesCurrent(
  input: CurrentAgentRuntimeAssignmentPreGrantInputV1,
  sources: CurrentSources,
): void {
  assertAgentProviderConfigFileCurrent(sources.host);
  const currentManifest = readCurrentManifestFacts(
    input.repositoryRoot,
    input.changeId,
    input.request.baseCommit,
  );
  const currentPolicy = loadAiAdapterPolicy(input.repositoryRoot);
  if (
    canonicalJson(currentManifest) !== canonicalJson(sources.manifest) ||
    currentPolicy.digest !== sources.policy.digest ||
    canonicalJson(currentPolicy.policy) !== canonicalJson(sources.policy.policy)
  ) {
    throw assignmentFailure(
      'AGENT_RUNTIME_ASSIGNMENT_SOURCE_STALE',
      'AgentRuntime assignment sources changed during composition.',
    );
  }
}

function createNativeSessionTurnController(
  record: ChangeRoleAssignmentRecordV1,
  assignmentBinding: AgentRuntimeAssignmentBindingV1,
  input: CurrentAgentRuntimeAssignmentInputV1,
  sources: CurrentSources,
  initialAuthorization: ChangeRoleAssignmentDataAuthorizationV1,
  grantAuthority: CompletedChangeRoleAssignmentGrantAuthorityV1 | null,
): AgentRuntimeNativeSessionTurnControllerV1 | null {
  const role = ROLE_BY_PURPOSE[input.request.purpose];
  const placement = record.resolution.placements.find(
    (candidate) => candidate.role === role,
  );
  const slot = record.sessionSlots.find((candidate) =>
    candidate.roles.includes(role),
  );
  const profile = record.host.configuration.providers.find(
    (candidate) => candidate.id === placement?.profileId,
  );
  if (placement === undefined || slot === undefined || profile === undefined) {
    throw assignmentFailure(
      'AGENT_RUNTIME_ASSIGNMENT_PROVIDER_MISMATCH',
      'The durable role assignment does not select one provider session slot.',
    );
  }
  if (profile.trustTier !== 'host-wrapper') return null;
  if (
    profile.protocol !== 'harness-jsonl-v2' ||
    slot.providerDefinitionDigest !== profile.profileDigest
  ) {
    throw definitionMismatch();
  }

  const readChain = () =>
    readProviderNativeSessionChainV1(
      input.runtime,
      record.changeId,
      record.planningGeneration,
      record.recordDigest,
      slot.sessionSlotId,
      (snapshot) =>
        assertPinnedCentralRoleProviderDefaultSnapshot(
          input.repositoryRoot,
          snapshot,
        ),
      (snapshot) =>
        assertPinnedAgentRolePlanV2Snapshot(input.repositoryRoot, snapshot),
      (evidence) => verifyHostConfiguration(sources, evidence),
      (evidence) =>
        verifyProviderRegistry(input, sources, initialAuthorization, evidence),
      (snapshot) => verifyDataAuthorization(input, sources, snapshot),
      (evidence) => verifySessionCapabilities(input, sources, evidence),
      (context) => verifyProtectedContext(input, sources, context),
      (assignment) =>
        verifyCompletedAssignmentGrant(input, assignment, grantAuthority),
    );

  const nextAction = (): 'start' | 'resume' => {
    const chain = readChain();
    if (chain.state === 'empty') return 'start';
    if (chain.state === 'resumable' && chain.scope.canResume) return 'resume';
    throw assignmentFailure(
      'AGENT_RUNTIME_NATIVE_SESSION_UNAVAILABLE',
      'The durable provider-native session cannot accept another turn.',
    );
  };

  return Object.freeze({
    profile,
    assignmentBinding,
    invocationBinding: Object.freeze({
      requestDigest: input.request.requestDigest,
      inputManifestDigest: input.request.inputManifestDigest,
      targetDigest: input.request.targetDigest,
      policyDigest: input.request.policyDigest,
    }),
    nextAction,
    claim(turn) {
      const expected = nextAction();
      if (turn.expectedAction !== expected) {
        throw assignmentFailure(
          'AGENT_RUNTIME_NATIVE_SESSION_CONFLICT',
          'The durable provider-native session action changed before claim.',
        );
      }
      const chain = readChain();
      const predecessorCompletionDigest =
        chain.turns.at(-1)?.completion?.completionDigest ?? null;
      const claimed = claimProviderNativeSessionTurnV1(
        input.runtime,
        {
          changeId: record.changeId,
          planningGeneration: record.planningGeneration,
          assignmentRecordDigest: record.recordDigest,
          sessionSlotId: slot.sessionSlotId,
          predecessorCompletionDigest,
          invocationId: input.request.invocationId,
          requestDigest: input.request.requestDigest,
          attemptId: turn.attemptId,
        },
        (snapshot) =>
          assertPinnedCentralRoleProviderDefaultSnapshot(
            input.repositoryRoot,
            snapshot,
          ),
        (snapshot) =>
          assertPinnedAgentRolePlanV2Snapshot(input.repositoryRoot, snapshot),
        (evidence) => verifyHostConfiguration(sources, evidence),
        (evidence) =>
          verifyProviderRegistry(
            input,
            sources,
            initialAuthorization,
            evidence,
          ),
        (snapshot) => verifyDataAuthorization(input, sources, snapshot),
        (evidence) => verifySessionCapabilities(input, sources, evidence),
        (context) => verifyProtectedContext(input, sources, context),
        (assignment) =>
          verifyCompletedAssignmentGrant(input, assignment, grantAuthority),
      );
      if (
        claimed.outcome !== 'claimed' ||
        claimed.binding === null ||
        claimed.claim.action !== expected
      ) {
        throw assignmentFailure(
          'AGENT_RUNTIME_NATIVE_SESSION_CONFLICT',
          'The durable provider-native turn was already claimed.',
        );
      }
      return Object.freeze({
        claimDigest: claimed.claim.claimDigest,
        predecessorCompletionDigest: claimed.claim.predecessorCompletionDigest,
        binding: claimed.binding,
      });
    },
    complete(turn) {
      const terminalInput = {
        changeId: record.changeId,
        planningGeneration: record.planningGeneration,
        assignmentRecordDigest: record.recordDigest,
        sessionSlotId: slot.sessionSlotId,
        claimDigest: turn.claimDigest,
        terminal: turn.terminal,
      } as const;
      let completion;
      try {
        completion = completeProviderNativeSessionTurnV1(
          input.runtime,
          terminalInput,
          (snapshot) =>
            assertPinnedCentralRoleProviderDefaultSnapshot(
              input.repositoryRoot,
              snapshot,
            ),
          (snapshot) =>
            assertPinnedAgentRolePlanV2Snapshot(input.repositoryRoot, snapshot),
          (evidence) => verifyHostConfiguration(sources, evidence),
          (evidence) =>
            verifyProviderRegistry(
              input,
              sources,
              initialAuthorization,
              evidence,
            ),
          (snapshot) => verifyDataAuthorization(input, sources, snapshot),
          (evidence) => verifySessionCapabilities(input, sources, evidence),
          (context) => verifyProtectedContext(input, sources, context),
          (assignment) =>
            verifyCompletedAssignmentGrant(input, assignment, grantAuthority),
        );
      } catch (error) {
        if (!isPostClaimTerminalCurrentnessChange(error)) throw error;
        completion = completeClaimedProviderNativeSessionTurnV1(
          input.runtime,
          terminalInput,
        );
      }
      return Object.freeze({
        completionDigest: completion.completionDigest,
      });
    },
  });
}

function isPostClaimTerminalCurrentnessChange(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return [
    'AGENT_PROVIDER_CONFIG_FILE_STALE',
    'AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE',
    'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    'AGENT_RUNTIME_ASSIGNMENT_SOURCE_STALE',
    'AGENT_RUNTIME_GRANT_REQUIRED',
  ].includes(String(error.code));
}

function verifyCompletedAssignmentGrant(
  input: CurrentAgentRuntimeAssignmentInputV1,
  assignment: ChangeRoleAssignmentRecordV1,
  expected: CompletedChangeRoleAssignmentGrantAuthorityV1 | null,
): void {
  if (assignment.grantRequirement === null) return;
  const current = readCompletedChangeRoleAssignmentGrantAuthority(
    input.runtime,
    input.grantRuntimeRoot,
    assignment,
    input.request.invocationId,
    input.request.repositoryId,
  );
  if (
    expected === null ||
    current === null ||
    canonicalJson(current) !== canonicalJson(expected)
  ) {
    throw assignmentFailure(
      'AGENT_RUNTIME_GRANT_REQUIRED',
      'Provider-native launch requires the exact completed Central role-assignment Grant.',
    );
  }
}

function projectRuntimeBinding(
  record: ChangeRoleAssignmentRecordV1,
  request: ProviderInvocationRequest,
): AgentRuntimeAssignmentBindingV1 {
  const role = ROLE_BY_PURPOSE[request.purpose];
  const placement = record.resolution.placements.find(
    (candidate) => candidate.role === role,
  );
  const slot = record.sessionSlots.find((candidate) =>
    candidate.roles.includes(role),
  );
  const profile = record.host.configuration.providers.find(
    (candidate) => candidate.id === placement?.profileId,
  );
  if (
    placement === undefined ||
    slot === undefined ||
    profile === undefined ||
    profile.family !== request.providerId ||
    placement.logicalProviderId !== slot.logicalProviderId ||
    slot.sessionMode !== 'fresh'
  ) {
    throw assignmentFailure(
      'AGENT_RUNTIME_ASSIGNMENT_PROVIDER_MISMATCH',
      'The durable role assignment does not select the requested fresh provider.',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'agent-runtime-assignment-binding.v1',
    changeId: record.changeId,
    planningGeneration: record.planningGeneration,
    recordDigest: record.recordDigest,
    assignmentDigest: record.assignmentDigest,
    role,
    logicalProviderId: placement.logicalProviderId,
    providerProfileId: profile.id,
    providerProfileSnapshot: profile,
    definitionDigest: slot.providerDefinitionDigest,
    dataAuthorizationPolicyDigest:
      record.dataAuthorization.snapshot.policyDigest,
    assignmentManifestDigest:
      record.dataAuthorization.snapshot.inputManifestDigest!,
    inputManifestDigest: request.inputManifestDigest,
    targetDigest: request.targetDigest,
  });
}

function assertExternalHostConfiguration(
  configPath: string,
  repositoryRoot: string,
  gitCommonDirectory: string,
): void {
  if (
    isSameOrDescendant(repositoryRoot, configPath) ||
    isSameOrDescendant(gitCommonDirectory, configPath)
  ) {
    throw new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_UNSAFE');
  }
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function assertSameCurrent<T>(candidate: T, current: T): T {
  if (canonicalJson(candidate) !== canonicalJson(current)) {
    throw assignmentFailure(
      'AGENT_RUNTIME_ASSIGNMENT_SOURCE_STALE',
      'AgentRuntime assignment source evidence is stale.',
    );
  }
  return current;
}

function definitionMismatch() {
  return assignmentFailure(
    'AGENT_RUNTIME_DEFINITION_MISMATCH',
    'Host provider profile does not match the code-owned definition snapshot.',
  );
}

function assignmentFailure(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
