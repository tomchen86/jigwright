/**
 * Probes configured providers and admits evidence for their selected
 * definitions.
 *
 * Invariants:
 * - Built-in probe preflight must observe the exact selected executable.
 */
import { builtInProviderAdapters } from './built-in-provider-adapter-production.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentRuntimePortContractError,
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeProbeEvidenceV1,
  createAgentRuntimeUnavailableDefinitionIdentityV1,
  createHostObservedProviderProbeEvidenceAdmissionPortV1,
  type AgentRuntimeProbeEvidenceV1,
} from '@jigwright/core/agent-runtime-port';
import {
  AgentProviderConfigError,
  assertAgentProviderProfileSnapshot,
  resolveAgentProviderProfile,
  type AgentProviderProfileSnapshot,
  type BuiltInReviewedProviderProfileSnapshot,
  type HostWrapperProviderProfileSnapshot,
} from '@jigwright/core/agent-provider-config';
import {
  assertProviderExecutableObservationCurrent,
  inspectProviderExecutable,
  type ProviderExecutableObservation,
} from '@jigwright/agent-runtime/provider-executable-identity';
import { spawnBoundedProviderProcess } from '@jigwright/agent-runtime/bounded-provider-process';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { isProviderId } from '../modules/provider-orchestration/provider-registry.ts';
import {
  AgentProviderConfigFileError,
  assertAgentProviderConfigFileCurrent,
  loadAgentProviderConfigFile,
} from '../runtime/provider-execution/agent-provider-config-file.ts';
import { loadAiAdapterPolicy } from '../runtime/provider-policy/ai-adapter-policy.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import { createProviderExecutionEnvironment } from '../runtime/process-environment/execution-environment.ts';
import {
  projectBuiltInProviderDefinitionIdentity,
  projectBuiltInProviderResolutionEvidence,
} from '../runtime/provider-execution/agent-runtime-probe-evidence.ts';
import { preflightBuiltInProviderProfile } from '../runtime/provider-execution/provider-runner.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';

export { AgentProviderConfigFileError } from '../runtime/provider-execution/agent-provider-config-file.ts';

const HOST_PROBE_TIMEOUT_MS = 10_000;
const HOST_PROBE_OUTPUT_BYTES = 64 * 1_024;

export type AgentProviderProbeOperation = 'probe' | 'test';

export type AgentProviderProfileProbeReport = Readonly<{
  schemaVersion: 1;
  kind: 'agent-provider-profile-probe.v1';
  operation: AgentProviderProbeOperation;
  liveRequested: boolean;
  modelLaunched: false;
  authority: 'observation-only';
  empiricalAvailabilityAccepted: false;
  availabilityDecisionAuthority: 'provider-availability-pilot.v1';
  sourcePath: string;
  sourceDigest: string;
  configDigest: string;
  profileId: string;
  profileDigest: string;
  executableCandidate: string;
  policyDigest: string;
  dataAuthorization: Readonly<{
    allowed: boolean;
    reason: string;
  }>;
  evidence: AgentRuntimeProbeEvidenceV1;
}>;

type AgentProviderProbeContext = Readonly<{
  platform: NodeJS.Platform;
  sourceEnvironment: NodeJS.ProcessEnv;
  temporaryDirectory: string;
  operation: AgentProviderProbeOperation;
}>;

export type AgentProviderProfileProbeEffects = Readonly<{
  probeBuiltIn(
    profile: BuiltInReviewedProviderProfileSnapshot,
    context: AgentProviderProbeContext,
  ): Promise<AgentRuntimeProbeEvidenceV1> | AgentRuntimeProbeEvidenceV1;
  probeHostWrapper(
    profile: HostWrapperProviderProfileSnapshot,
    context: AgentProviderProbeContext,
  ): Promise<AgentRuntimeProbeEvidenceV1> | AgentRuntimeProbeEvidenceV1;
}>;

const productionProfileProbeEffects: AgentProviderProfileProbeEffects =
  Object.freeze({
    probeBuiltIn: probeBuiltInProviderProfileEvidence,
    probeHostWrapper: probeHostWrapperProviderProfileEvidence,
  });

/** Execute one profile-bound production observation without availability authority. */
export async function probeAgentProviderProfile(
  repositoryRoot: string,
  configFilePath: string,
  profileId: string,
  operation: AgentProviderProbeOperation,
  platform: NodeJS.Platform = process.platform,
): Promise<AgentProviderProfileProbeReport> {
  return await probeAgentProviderProfileWithEffects(
    repositoryRoot,
    configFilePath,
    profileId,
    operation,
    platform,
    productionProfileProbeEffects,
  );
}

/** Tests may replace bounded host effects; admission and currentness stay production-owned. */
export function createAgentProviderProfileProbeForTesting(
  effects: AgentProviderProfileProbeEffects,
): (
  repositoryRoot: string,
  configFilePath: string,
  profileId: string,
  operation: AgentProviderProbeOperation,
  platform?: NodeJS.Platform,
) => Promise<AgentProviderProfileProbeReport> {
  return (repositoryRoot, configFilePath, profileId, operation, platform) =>
    probeAgentProviderProfileWithEffects(
      repositoryRoot,
      configFilePath,
      profileId,
      operation,
      platform ?? process.platform,
      effects,
    );
}

function probeBuiltInProviderProfileEvidence(
  rawProfile: BuiltInReviewedProviderProfileSnapshot,
  context: AgentProviderProbeContext,
): AgentRuntimeProbeEvidenceV1 {
  const profile = assertAgentProviderProfileSnapshot(
    rawProfile,
    context.platform,
  );
  if (
    profile.trustTier !== 'built-in-reviewed' ||
    !isProviderId(profile.family)
  )
    throw new AgentProviderConfigError();
  const executableObservation = inspectProviderExecutable(profile.executable);
  const resolution = preflightBuiltInProviderProfile(
    builtInProviderAdapters,
    profile,
    {
      platform: context.platform,
      enabled: profile.enabled,
      sourceEnvironment: context.sourceEnvironment,
      temporaryDirectory: context.temporaryDirectory,
    },
  );
  assertProviderExecutableObservationCurrent(executableObservation);
  if (
    resolution.executable !== undefined &&
    (executableObservation.state !== 'observed' ||
      executableObservation.identity === null ||
      resolution.executable.candidatePath !== profile.executable ||
      canonicalJson(resolution.executable) !==
        canonicalJson(executableObservation.identity))
  ) {
    throw probeStale(
      'AGENT_PROVIDER_PROBE_EXECUTABLE_STALE',
      'Built-in provider preflight did not observe the exact selected executable.',
    );
  }
  return projectBuiltInProviderResolutionEvidence(
    profile.family,
    context.platform,
    resolution,
  );
}

async function probeHostWrapperProviderProfileEvidence(
  rawProfile: HostWrapperProviderProfileSnapshot,
  context: AgentProviderProbeContext,
): Promise<AgentRuntimeProbeEvidenceV1> {
  const profile = assertAgentProviderProfileSnapshot(
    rawProfile,
    context.platform,
  );
  if (profile.trustTier !== 'host-wrapper')
    throw new AgentProviderConfigError();
  if (!profile.enabled) {
    return createAgentRuntimeProbeEvidenceV1({
      authority: 'observation-only',
      observationClass: 'host-observed',
      definition: createAgentRuntimeUnavailableDefinitionIdentityV1({
        providerFamily: profile.family,
        status: 'host-disabled',
      }),
      status: 'host-disabled',
      executableIdentity: null,
      providerVersion: null,
      authentication: 'not-observed',
      capabilities: null,
    });
  }
  const executableObservation = inspectProviderExecutable(profile.executable);
  if (
    executableObservation.state === 'absent' ||
    executableObservation.identity === null
  ) {
    return hostWrapperEvidence(
      profile,
      context.platform,
      executableObservation,
      executableObservation.state === 'absent' ? 'absent' : 'unsafe-candidate',
      null,
      'not-observed',
    );
  }
  const requestPath = path.join(context.temporaryDirectory, 'request.json');
  const outputPath = path.join(context.temporaryDirectory, 'probe-result.json');
  writeExclusiveJson(requestPath, {
    schemaVersion: 1,
    kind: 'agent-runtime-host-wrapper-probe-request.v1',
    providerFamily: profile.family,
    profileDigest: profile.profileDigest,
    outputFile: outputPath,
  });
  writeExclusiveFile(outputPath, '');
  const args = profile.startArgs.map((argument) =>
    argument.replaceAll('{request_file}', requestPath),
  );
  if (args.some((argument) => /\{[a-z_]+\}/u.test(argument))) {
    throw probeInvalid(
      'AGENT_PROVIDER_PROBE_DEFINITION_INVALID',
      'Host-wrapper probe arguments contain an unsupported placeholder.',
    );
  }
  const outcome = await spawnBoundedProviderProcess({
    executable: profile.executable,
    args,
    cwd: context.temporaryDirectory,
    environment: createProviderExecutionEnvironment(
      null,
      process.execPath,
      context.temporaryDirectory,
      context.sourceEnvironment,
    ),
    stdinContent: Buffer.alloc(0),
    timeoutMs: HOST_PROBE_TIMEOUT_MS,
    maxOutputBytes: HOST_PROBE_OUTPUT_BYTES,
  });
  assertProviderExecutableObservationCurrent(executableObservation);
  if (outcome.terminationReason !== 'exited' || outcome.exitCode !== 0) {
    return hostWrapperEvidence(
      profile,
      context.platform,
      executableObservation,
      'incompatible',
      null,
      'not-observed',
    );
  }
  const result = readHostWrapperProbeResult(outputPath);
  return hostWrapperEvidence(
    profile,
    context.platform,
    executableObservation,
    result.authentication === 'authenticated' ? 'ready' : 'unauthenticated',
    result.providerVersion,
    result.authentication,
  );
}

async function probeAgentProviderProfileWithEffects(
  repositoryRoot: string,
  configFilePath: string,
  profileId: string,
  operation: AgentProviderProbeOperation,
  platform: NodeJS.Platform,
  effects: AgentProviderProfileProbeEffects,
): Promise<AgentProviderProfileProbeReport> {
  if (operation !== 'probe' && operation !== 'test') {
    throw probeInvalid(
      'AGENT_PROVIDER_PROBE_USAGE_INVALID',
      'Agent provider observation operation is invalid.',
    );
  }
  const repository = discoverRepository(repositoryRoot);
  const loaded = loadAgentProviderConfigFile(configFilePath, { platform });
  assertExternalHostConfigPath(
    loaded.sourcePath,
    repository.repositoryRealPath,
    repository.gitCommonDirectory,
  );
  const snapshot = assertAgentProviderConfigFileCurrent(loaded);
  const selection = resolveAgentProviderProfile(snapshot, { profileId });
  const profile = selection.profile;
  const policy = loadAiAdapterPolicy(repository.repositoryRealPath);
  const expectedDefinition = expectedDefinitionIdentity(profile, platform);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-agent-provider-probe-'),
  );
  try {
    const rawEvidence = await (profile.trustTier === 'built-in-reviewed'
      ? effects.probeBuiltIn(profile, {
          platform,
          sourceEnvironment: process.env,
          temporaryDirectory,
          operation,
        })
      : effects.probeHostWrapper(profile, {
          platform,
          sourceEnvironment: process.env,
          temporaryDirectory,
          operation,
        }));
    const evidence = admitProfileProbeEvidence(
      rawEvidence,
      profile,
      expectedDefinition,
    );
    const currentSnapshot = assertAgentProviderConfigFileCurrent(loaded);
    const currentProfile = resolveAgentProviderProfile(currentSnapshot, {
      profileId,
    }).profile;
    if (
      currentProfile.profileDigest !== profile.profileDigest ||
      canonicalJson(expectedDefinitionIdentity(currentProfile, platform)) !==
        canonicalJson(expectedDefinition)
    ) {
      throw probeStale(
        'AGENT_PROVIDER_PROBE_DEFINITION_STALE',
        'Agent provider definition changed during its probe.',
      );
    }
    const currentPolicy = loadAiAdapterPolicy(repository.repositoryRealPath);
    if (
      currentPolicy.digest !== policy.digest ||
      canonicalJson(currentPolicy.policy) !== canonicalJson(policy.policy)
    ) {
      throw probeStale(
        'AGENT_PROVIDER_PROBE_POLICY_STALE',
        'Data-authorization policy changed during the provider probe.',
      );
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      kind: 'agent-provider-profile-probe.v1' as const,
      operation,
      liveRequested: operation === 'test',
      modelLaunched: false as const,
      authority: 'observation-only' as const,
      empiricalAvailabilityAccepted: false as const,
      availabilityDecisionAuthority: 'provider-availability-pilot.v1' as const,
      sourcePath: loaded.sourcePath,
      sourceDigest: loaded.sourceDigest,
      configDigest: snapshot.configDigest,
      profileId: profile.id,
      profileDigest: profile.profileDigest,
      executableCandidate: profile.executable,
      policyDigest: policy.digest,
      dataAuthorization: profileDataAuthorization(profile, policy),
      evidence,
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function expectedDefinitionIdentity(
  profile: AgentProviderProfileSnapshot,
  platform: NodeJS.Platform,
): AgentRuntimeProbeEvidenceV1['definition'] {
  if (!profile.enabled) {
    return createAgentRuntimeUnavailableDefinitionIdentityV1({
      providerFamily: profile.family,
      status: 'host-disabled',
    });
  }
  if (profile.trustTier === 'host-wrapper') {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: 'host-wrapper-provider-definition.v1' as const,
      providerFamily: profile.family,
      protocol: profile.protocol,
      definitionDigest: profile.profileDigest,
    }) as AgentRuntimeProbeEvidenceV1['definition'];
  }
  if (!isProviderId(profile.family)) throw new AgentProviderConfigError();
  const definition = resolveBuiltInProviderDefinitionSnapshot(
    profile.family,
    platform,
  );
  if (
    definition === null ||
    definition.protocol !== profile.protocol ||
    !definition.executableCandidates.includes(profile.executable)
  ) {
    throw probeStale(
      'AGENT_PROVIDER_PROBE_DEFINITION_STALE',
      'Built-in provider profile no longer matches its code-owned definition.',
    );
  }
  return projectBuiltInProviderDefinitionIdentity(profile.family, platform);
}

function admitProfileProbeEvidence(
  rawEvidence: AgentRuntimeProbeEvidenceV1,
  profile: AgentProviderProfileSnapshot,
  expectedDefinition: AgentRuntimeProbeEvidenceV1['definition'],
): AgentRuntimeProbeEvidenceV1 {
  let evidence: AgentRuntimeProbeEvidenceV1;
  try {
    evidence =
      createHostObservedProviderProbeEvidenceAdmissionPortV1().admit(
        rawEvidence,
      );
  } catch (error) {
    if (error instanceof AgentRuntimePortContractError) {
      throw probeInvalid(
        'AGENT_PROVIDER_PROBE_EVIDENCE_INVALID',
        'Provider probe evidence was not admitted as a host observation.',
      );
    }
    throw error;
  }
  if (
    canonicalJson(evidence.definition) !== canonicalJson(expectedDefinition) ||
    evidence.providerFamily !== profile.family ||
    evidence.protocol !== expectedDefinition.protocol ||
    (evidence.executableIdentity !== null &&
      evidence.executableIdentity.candidatePath !== profile.executable)
  ) {
    throw probeStale(
      'AGENT_PROVIDER_PROBE_DEFINITION_STALE',
      'Provider probe evidence does not match the selected profile definition.',
    );
  }
  return evidence;
}

function hostWrapperEvidence(
  profile: HostWrapperProviderProfileSnapshot,
  platform: NodeJS.Platform,
  executableObservation: ProviderExecutableObservation,
  status:
    | 'ready'
    | 'absent'
    | 'unsafe-candidate'
    | 'incompatible'
    | 'unauthenticated',
  providerVersion: string | null,
  authentication: 'authenticated' | 'unauthenticated' | 'not-observed',
): AgentRuntimeProbeEvidenceV1 {
  const capabilities = createAgentRuntimeCapabilitiesV1({
    structuredStreaming: true,
    structuredOutput: true,
    resumableAfterTurn:
      profile.protocol === 'harness-jsonl-v2' &&
      profile.capabilities.includes('resumable-session') &&
      profile.resumeArgs.length > 0,
    forkable: false,
    reattachableInFlight: false,
    cancellationAck: true,
    usageReporting: 'none',
  });
  return createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass: 'host-observed',
    definition: expectedDefinitionIdentity(profile, platform),
    status,
    executableIdentity: executableObservation.identity,
    providerVersion,
    authentication,
    capabilities:
      status === 'ready' || status === 'unauthenticated' ? capabilities : null,
  });
}

function readHostWrapperProbeResult(outputPath: string): Readonly<{
  providerVersion: string;
  authentication: 'authenticated' | 'unauthenticated';
}> {
  let value: unknown;
  try {
    const stats = fs.lstatSync(outputPath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.size <= 0 ||
      stats.size > HOST_PROBE_OUTPUT_BYTES
    ) {
      throw new Error('invalid host-wrapper probe result size');
    }
    value = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as unknown;
  } catch {
    throw probeInvalid(
      'AGENT_PROVIDER_PROBE_RESULT_INVALID',
      'Host-wrapper provider probe result is invalid.',
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
    !('providerVersion' in value) ||
    typeof value.providerVersion !== 'string' ||
    value.providerVersion.length === 0 ||
    value.providerVersion.length > 256 ||
    !('authentication' in value) ||
    (value.authentication !== 'authenticated' &&
      value.authentication !== 'unauthenticated')
  ) {
    throw probeInvalid(
      'AGENT_PROVIDER_PROBE_RESULT_INVALID',
      'Host-wrapper provider probe result violates its exact contract.',
    );
  }
  return Object.freeze({
    providerVersion: value.providerVersion,
    authentication: value.authentication,
  });
}

function profileDataAuthorization(
  profile: AgentProviderProfileSnapshot,
  policy: ReturnType<typeof loadAiAdapterPolicy>,
): Readonly<{ allowed: boolean; reason: string }> {
  if (!profile.enabled)
    return Object.freeze({ allowed: false, reason: 'HOST_PROFILE_DISABLED' });
  if (!isProviderId(profile.family)) {
    return Object.freeze({
      allowed: false,
      reason: 'REPOSITORY_PROVIDER_FAMILY_UNREGISTERED',
    });
  }
  if (!policy.policy.providers[profile.family].enabled) {
    return Object.freeze({
      allowed: false,
      reason: 'REPOSITORY_PROVIDER_DISABLED',
    });
  }
  return Object.freeze({
    allowed: true,
    reason:
      profile.trustTier === 'host-wrapper'
        ? 'HOST_WRAPPER_PROVIDER_AUTHORIZED'
        : 'BUILT_IN_PROVIDER_AUTHORIZED',
  });
}

function assertExternalHostConfigPath(
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

function writeExclusiveJson(filePath: string, value: unknown): void {
  writeExclusiveFile(filePath, `${canonicalJson(value)}\n`);
}

function writeExclusiveFile(filePath: string, content: string): void {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      noFollow,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function probeStale(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}

function probeInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
