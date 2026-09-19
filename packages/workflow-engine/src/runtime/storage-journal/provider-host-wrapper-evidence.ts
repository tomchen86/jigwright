/**
 * Validates host-wrapper probe and turn artifacts against execution and retention evidence.
 *
 * Invariants:
 * - Each host phase keeps its exact artifact membership and terminal-state bindings.
 * - Retained empty markers and live files are checked against the same authenticated receipts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  type ProviderInvocationRequest,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertPrivateFile,
  MAX_HUMAN_RESOLUTION_BYTES,
  sameStablePrivateFile,
  walkPrivateDirectory,
} from './investigation-private-files.ts';
import {
  hasExactKeys,
  isDigest,
  isRecord,
  sha256,
} from '../../modules/investigation/domain/investigation-store-values.ts';
import {
  PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS,
  providerRetentionArtifact,
  readCompleteProviderRetentionReceipt,
} from './provider-retention-receipt.ts';
import { type ProviderInvocationRuntimeEvidence } from './provider-runtime-evidence-contract.ts';

const HOST_WRAPPER_PROBE_DIRECTORY = 'host-wrapper-probe-runtime';

const HOST_WRAPPER_PROBE_FILES = ['probe-result.json', 'request.json'] as const;

const HOST_WRAPPER_TURN_DIRECTORY = 'host-wrapper-runtime';

const HOST_WRAPPER_TURN_FILES = [
  'request.json',
  'semantic-output.json',
] as const;

export const HOST_WRAPPER_DIRECTORIES = [
  HOST_WRAPPER_PROBE_DIRECTORY,
  HOST_WRAPPER_TURN_DIRECTORY,
] as const;

const MAX_HOST_WRAPPER_PROBE_BYTES = 64 * 1_024;

type HostWrapperArtifact = Readonly<{
  content: Buffer;
  digest: string;
  value: Record<string, unknown> | null;
}>;

export function digestHostWrapperRuntimeEntries(
  paths: InvestigationRuntimePaths,
  invocationDirectory: string,
  request: ProviderInvocationRequest,
  runtimeEvidence: ProviderInvocationRuntimeEvidence,
  retentionReceipt: ReturnType<typeof readCompleteProviderRetentionReceipt>,
  makeError: () => WorkflowError,
): Array<{ name: string; digest: string }> {
  if (runtimeEvidence.state === 'prepared') {
    throw makeError();
  }
  const probeDirectory = path.join(
    invocationDirectory,
    HOST_WRAPPER_PROBE_DIRECTORY,
  );
  const turnDirectory = path.join(
    invocationDirectory,
    HOST_WRAPPER_TURN_DIRECTORY,
  );
  const retainedArtifacts =
    retentionReceipt === null
      ? []
      : PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.map((name) => ({
          name,
          artifact: providerRetentionArtifact(retentionReceipt, name),
        })).filter(
          (
            entry,
          ): entry is {
            name: (typeof PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS)[number];
            artifact: NonNullable<typeof entry.artifact>;
          } => entry.artifact !== null,
        );
  if (retainedArtifacts.length > 0) {
    return digestRetainedHostWrapperRuntimeEntries(
      paths,
      probeDirectory,
      turnDirectory,
      runtimeEvidence,
      retainedArtifacts,
      makeError,
    );
  }
  const probe = readHostWrapperDirectoryPhase(
    paths,
    probeDirectory,
    HOST_WRAPPER_PROBE_FILES,
    ['request.json', 'probe-result.json'],
    new Map([
      ['request.json', MAX_HOST_WRAPPER_PROBE_BYTES],
      ['probe-result.json', MAX_HOST_WRAPPER_PROBE_BYTES],
    ]),
    new Set(['request.json']),
    makeError,
  );
  const turnStats = fs.lstatSync(turnDirectory, { throwIfNoEntry: false });
  const turn =
    turnStats === undefined
      ? null
      : readHostWrapperDirectoryPhase(
          paths,
          turnDirectory,
          HOST_WRAPPER_TURN_FILES,
          ['request.json', 'semantic-output.json'],
          new Map([
            ['request.json', MAX_HUMAN_RESOLUTION_BYTES],
            [
              'semantic-output.json',
              Math.min(
                MAX_HUMAN_RESOLUTION_BYTES,
                request.limits.aggregateOutputBytes,
              ),
            ],
          ]),
          new Set(['request.json']),
          makeError,
        );

  const probeRequest = probe.get('request.json')?.value;
  const probeResult = probe.get('probe-result.json')?.value;
  const hostBinding =
    runtimeEvidence.runtimeReceipt?.schemaVersion === 4
      ? runtimeEvidence.runtimeReceipt.hostExecutionBinding
      : null;
  if (hostBinding === null && runtimeEvidence.state !== 'leased') {
    throw makeError();
  }
  const acceptanceBinding =
    runtimeEvidence.runtimeReceipt?.schemaVersion === 4
      ? runtimeEvidence.runtimeReceipt.acceptanceBinding
      : null;
  if (
    hostBinding !== null &&
    ((hostBinding.phase === 'assignment-admitted' &&
      (runtimeEvidence.state !== 'failed' ||
        runtimeEvidence.runtimeReceipt?.schemaVersion !== 4 ||
        runtimeEvidence.runtimeReceipt.protocolReceipt !== null ||
        turn !== null ||
        isAuthenticatedHostWrapperProbeResult(probeResult))) ||
      (hostBinding.phase !== 'assignment-admitted' &&
        (probeRequest === undefined ||
          probeResult === undefined ||
          hostBinding.probe === null)) ||
      (hostBinding.phase === 'probe-attested' && turn !== null))
  ) {
    throw makeError();
  }
  const expectedProbeOutputPath = path.join(
    probeDirectory,
    'probe-result.json',
  );
  if (probeRequest === undefined || probeRequest === null) {
    if (turn !== null || runtimeEvidence.state === 'succeeded') {
      throw makeError();
    }
    return hostWrapperArtifactDigests([[HOST_WRAPPER_PROBE_DIRECTORY, probe]]);
  }
  if (
    !hasExactKeys(probeRequest, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'executionAttemptId',
      'acceptanceBindingDigest',
      'assignmentBindingDigest',
      'providerFamily',
      'profileDigest',
      'providerDefinitionBindingDigest',
      'outputFile',
    ]) ||
    probeRequest.schemaVersion !== 1 ||
    probeRequest.kind !== 'agent-runtime-host-wrapper-probe-request.v1' ||
    probeRequest.invocationId !== request.invocationId ||
    probeRequest.requestDigest !== request.requestDigest ||
    !isDigest(probeRequest.acceptanceBindingDigest) ||
    !isDigest(probeRequest.assignmentBindingDigest) ||
    (acceptanceBinding !== null &&
      (probeRequest.executionAttemptId !==
        acceptanceBinding.executionAttemptId ||
        probeRequest.acceptanceBindingDigest !==
          acceptanceBinding.bindingDigest)) ||
    (hostBinding !== null &&
      probeRequest.assignmentBindingDigest !==
        hostBinding.assignmentBindingDigest) ||
    probeRequest.providerFamily !== request.providerId ||
    (hostBinding !== null &&
      (probeRequest.providerFamily !==
        hostBinding.assignmentBinding.providerProfileSnapshot.family ||
        probeRequest.profileDigest !==
          hostBinding.assignmentBinding.providerProfileSnapshot
            .profileDigest)) ||
    !isDigest(probeRequest.profileDigest) ||
    !isDigest(probeRequest.providerDefinitionBindingDigest) ||
    probeRequest.outputFile !== expectedProbeOutputPath
  ) {
    throw makeError();
  }
  if (
    hostBinding?.probe !== null &&
    hostBinding !== null &&
    (probe.get('request.json')?.digest !==
      hostBinding.probe.probeRequestFileDigest ||
      probe.get('probe-result.json')?.digest !==
        hostBinding.probe.probeResultFileDigest ||
      hostBinding.probe.providerDefinitionBindingDigest !==
        probeRequest.providerDefinitionBindingDigest ||
      !isRecord(probeResult) ||
      probeResult.providerVersion !== hostBinding.probe.providerVersion)
  ) {
    throw makeError();
  }

  if (turn === null) {
    if (
      runtimeEvidence.state === 'succeeded' ||
      hostBinding?.phase === 'native-terminal'
    ) {
      throw makeError();
    }
    return hostWrapperArtifactDigests([[HOST_WRAPPER_PROBE_DIRECTORY, probe]]);
  }
  if (
    (hostBinding !== null &&
      (hostBinding.phase !== 'native-terminal' ||
        hostBinding.probe === null)) ||
    !isAuthenticatedHostWrapperProbeResult(probeResult)
  ) {
    throw makeError();
  }

  const turnRequest = turn.get('request.json')?.value;
  const expectedSemanticOutputPath = path.join(
    turnDirectory,
    'semantic-output.json',
  );
  if (turnRequest === undefined || turnRequest === null) {
    if (runtimeEvidence.state === 'succeeded') throw makeError();
    return hostWrapperArtifactDigests([
      [HOST_WRAPPER_PROBE_DIRECTORY, probe],
      [HOST_WRAPPER_TURN_DIRECTORY, turn],
    ]);
  }
  if (
    !hasExactKeys(turnRequest, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'action',
      'prompt',
      'outputFile',
    ]) ||
    turnRequest.schemaVersion !== 1 ||
    turnRequest.kind !== 'agent-runtime-host-wrapper-turn-request.v1' ||
    turnRequest.invocationId !== request.invocationId ||
    turnRequest.requestDigest !== request.requestDigest ||
    (turnRequest.action !== 'start' && turnRequest.action !== 'resume') ||
    typeof turnRequest.prompt !== 'string' ||
    Buffer.byteLength(turnRequest.prompt, 'utf8') >
      MAX_HUMAN_RESOLUTION_BYTES ||
    turnRequest.outputFile !== expectedSemanticOutputPath
  ) {
    throw makeError();
  }
  let prompt: unknown;
  try {
    prompt = JSON.parse(turnRequest.prompt);
  } catch {
    throw makeError();
  }
  if (
    !isRecord(prompt) ||
    !hasExactKeys(prompt, ['schemaVersion', 'kind', 'request']) ||
    prompt.schemaVersion !== 1 ||
    prompt.kind !== 'agent-runtime-host-wrapper-request.v1' ||
    canonicalJson(prompt) !== turnRequest.prompt ||
    !isRecord(prompt.request)
  ) {
    throw makeError();
  }
  let promptRequest: ProviderInvocationRequest;
  try {
    promptRequest = recreateProviderInvocationRequest(prompt.request);
  } catch {
    throw makeError();
  }
  if (canonicalJson(promptRequest) !== canonicalJson(request)) {
    throw makeError();
  }
  const terminalProtocolReceipt =
    runtimeEvidence.runtimeReceipt?.schemaVersion === 4
      ? runtimeEvidence.runtimeReceipt.protocolReceipt
      : null;
  if (
    terminalProtocolReceipt?.kind ===
      'provider-wrapper-session-protocol-receipt' &&
    (terminalProtocolReceipt.sessionAction !== turnRequest.action ||
      (turnRequest.action === 'start'
        ? terminalProtocolReceipt.nativeSessionIdentityMode !==
            'provider-observed' ||
          terminalProtocolReceipt.expectedNativeSessionIdDigest !== null
        : terminalProtocolReceipt.nativeSessionIdentityMode !==
            'engine-supplied' ||
          terminalProtocolReceipt.expectedNativeSessionIdDigest === null))
  ) {
    throw makeError();
  }
  const semanticOutput = turn.get('semantic-output.json')?.value;
  if (runtimeEvidence.state === 'succeeded') {
    if (semanticOutput === undefined || semanticOutput === null) {
      throw makeError();
    }
    assertSucceededHostWrapperStateBindings(
      runtimeEvidence,
      request,
      probeRequest.profileDigest,
      turnRequest.action,
      semanticOutput,
      makeError,
    );
  }

  return hostWrapperArtifactDigests([
    [HOST_WRAPPER_PROBE_DIRECTORY, probe],
    [HOST_WRAPPER_TURN_DIRECTORY, turn],
  ]);
}

function assertEmptyHostWrapperRetentionMarker(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    !walkPrivateDirectory(paths, directory, makeError, false)
  ) {
    throw makeError();
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    throw makeError();
  }
  if (names.length !== 0) throw makeError();
}

function readHostWrapperDirectoryPhase<Name extends string>(
  paths: InvestigationRuntimePaths,
  directory: string,
  expectedFiles: readonly Name[],
  creationOrder: readonly Name[],
  maxBytesByName: ReadonlyMap<Name, number>,
  canonicalJsonFiles: ReadonlySet<Name>,
  makeError: () => WorkflowError,
): Map<Name, HostWrapperArtifact> {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    !walkPrivateDirectory(paths, directory, makeError, false)
  ) {
    throw makeError();
  }
  let observedFiles: string[];
  try {
    observedFiles = fs.readdirSync(directory).sort();
  } catch {
    throw makeError();
  }
  const allowedFileSets = Array.from(
    { length: creationOrder.length + 1 },
    (_, length) => [...creationOrder.slice(0, length)].sort(),
  );
  if (
    !allowedFileSets.some(
      (allowed) => canonicalJson(allowed) === canonicalJson(observedFiles),
    ) ||
    observedFiles.some((name) => !expectedFiles.includes(name as Name))
  ) {
    throw makeError();
  }
  return new Map(
    observedFiles.map((observedName) => {
      const name = observedName as Name;
      return [
        name,
        readBoundedPrivateHostWrapperArtifact(
          path.join(directory, name),
          maxBytesByName.get(name) ?? 0,
          canonicalJsonFiles.has(name),
          makeError,
        ),
      ];
    }),
  );
}

function readBoundedPrivateHostWrapperArtifact(
  filePath: string,
  maxBytes: number,
  canonicalRequired: boolean,
  makeError: () => WorkflowError,
): HostWrapperArtifact {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw makeError();
  }
  const absolute = path.resolve(filePath);
  const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!before || absolute !== filePath || before.size > maxBytes) {
    throw makeError();
  }
  assertPrivateFile(before, makeError);
  let descriptor: number | undefined;
  let content: Buffer;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const opened = fs.fstatSync(descriptor);
    assertPrivateFile(opened, makeError);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maxBytes
    ) {
      throw makeError();
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      offset !== opened.size ||
      !afterPath ||
      !sameStablePrivateFile(opened, afterDescriptor) ||
      !sameStablePrivateFile(opened, afterPath)
    ) {
      throw makeError();
    }
    content = buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw makeError();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let value: unknown;
  try {
    value = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    value = null;
  }
  const parsedRecord = isRecord(value) ? value : null;
  const canonical =
    parsedRecord !== null &&
    Buffer.from(`${canonicalJson(parsedRecord)}\n`, 'utf8').equals(content);
  if (canonicalRequired && !canonical) {
    throw makeError();
  }
  return {
    content,
    digest: sha256(content),
    value: parsedRecord,
  };
}

function isAuthenticatedHostWrapperProbeResult(
  value: Record<string, unknown> | null | undefined,
): boolean {
  return (
    value !== null &&
    value !== undefined &&
    hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'providerVersion',
      'authentication',
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === 'agent-runtime-host-wrapper-probe-result.v1' &&
    value.authentication === 'authenticated' &&
    typeof value.providerVersion === 'string' &&
    value.providerVersion.length > 0 &&
    Buffer.byteLength(value.providerVersion, 'utf8') <= 256
  );
}

function hostWrapperArtifactDigests(
  directories: readonly Readonly<
    [string, ReadonlyMap<string, HostWrapperArtifact>]
  >[],
): Array<{ name: string; digest: string }> {
  return directories
    .flatMap(([directory, artifacts]) =>
      [...artifacts.entries()].map(([name, artifact]) => ({
        name: `${directory}/${name}`,
        digest: artifact.digest,
      })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertSucceededHostWrapperStateBindings(
  runtimeEvidence: ProviderInvocationRuntimeEvidence,
  request: ProviderInvocationRequest,
  profileDigest: unknown,
  action: unknown,
  semanticOutput: Record<string, unknown>,
  makeError: () => WorkflowError,
): void {
  const result = runtimeEvidence.result;
  const runtimeObservation = result?.runtimeObservation;
  const providerDefinitionSnapshot =
    runtimeObservation?.providerDefinitionSnapshot;
  const runtimeReceipt = runtimeEvidence.runtimeReceipt;
  const protocolReceipt =
    runtimeReceipt?.schemaVersion === 4 ? runtimeReceipt.protocolReceipt : null;
  const hostExecutionBinding =
    runtimeReceipt?.schemaVersion === 4
      ? runtimeReceipt.hostExecutionBinding
      : null;
  if (
    result === null ||
    canonicalJson(result.output) !== canonicalJson(semanticOutput) ||
    providerDefinitionSnapshot === undefined ||
    providerDefinitionSnapshot.kind !== 'agent-provider-profile-snapshot' ||
    providerDefinitionSnapshot.trustTier !== 'host-wrapper' ||
    providerDefinitionSnapshot.family !== request.providerId ||
    providerDefinitionSnapshot.profileDigest !== profileDigest ||
    hostExecutionBinding?.phase !== 'native-terminal' ||
    hostExecutionBinding.probe?.providerDefinitionBindingDigest !==
      runtimeObservation?.providerDefinitionBindingDigest ||
    protocolReceipt === null ||
    protocolReceipt.kind !== 'provider-wrapper-session-protocol-receipt' ||
    protocolReceipt.protocol !== 'harness-jsonl-v2' ||
    protocolReceipt.sessionAction !== action
  ) {
    throw makeError();
  }
}

function digestRetainedHostWrapperRuntimeEntries(
  paths: InvestigationRuntimePaths,
  probeDirectory: string,
  turnDirectory: string,
  runtimeEvidence: ProviderInvocationRuntimeEvidence,
  retainedArtifacts: Array<{
    name: (typeof PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS)[number];
    artifact: NonNullable<ReturnType<typeof providerRetentionArtifact>>;
  }>,
  makeError: () => WorkflowError,
): Array<{ name: string; digest: string }> {
  const hostBinding =
    runtimeEvidence.runtimeReceipt?.schemaVersion === 4
      ? runtimeEvidence.runtimeReceipt.hostExecutionBinding
      : null;
  if (hostBinding === null) throw makeError();
  const retainedNames = new Set(retainedArtifacts.map(({ name }) => name));
  const hasProbeRequest = retainedNames.has(
    'host-wrapper-probe-runtime/request.json',
  );
  const hasProbeResult = retainedNames.has(
    'host-wrapper-probe-runtime/probe-result.json',
  );
  const hasTurnRequest = retainedNames.has('host-wrapper-runtime/request.json');
  const hasSemanticOutput = retainedNames.has(
    'host-wrapper-runtime/semantic-output.json',
  );
  const retainedAssignmentFailure =
    hostBinding.phase === 'assignment-admitted' &&
    runtimeEvidence.state === 'failed' &&
    runtimeEvidence.runtimeReceipt?.schemaVersion === 4 &&
    runtimeEvidence.runtimeReceipt.protocolReceipt === null &&
    hasProbeRequest &&
    hasProbeResult &&
    !hasTurnRequest &&
    !hasSemanticOutput;
  if (
    hasProbeRequest !== hasProbeResult ||
    (hostBinding.phase === 'assignment-admitted' &&
      !retainedAssignmentFailure) ||
    !hasProbeRequest ||
    (hostBinding.phase === 'probe-attested' &&
      (hasTurnRequest || hasSemanticOutput)) ||
    (hostBinding.phase === 'native-terminal' && !hasTurnRequest) ||
    (runtimeEvidence.state === 'succeeded' &&
      (!hasSemanticOutput ||
        runtimeEvidence.runtimeReceipt?.schemaVersion !== 4 ||
        runtimeEvidence.runtimeReceipt.protocolReceipt?.kind !==
          'provider-wrapper-session-protocol-receipt' ||
        runtimeEvidence.result?.runtimeObservation
          ?.providerDefinitionBindingDigest !==
          hostBinding.probe?.providerDefinitionBindingDigest))
  ) {
    throw makeError();
  }
  if (
    hostBinding.probe !== null &&
    retainedArtifacts.some(({ name, artifact }) =>
      name === 'host-wrapper-probe-runtime/request.json'
        ? artifact.digest !== hostBinding.probe!.probeRequestFileDigest
        : name === 'host-wrapper-probe-runtime/probe-result.json'
          ? artifact.digest !== hostBinding.probe!.probeResultFileDigest
          : false,
    )
  ) {
    throw makeError();
  }
  assertEmptyHostWrapperRetentionMarker(paths, probeDirectory, makeError);
  assertEmptyHostWrapperRetentionMarker(paths, turnDirectory, makeError);
  return retainedArtifacts
    .map(({ name, artifact }) => ({ name, digest: artifact.digest }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
