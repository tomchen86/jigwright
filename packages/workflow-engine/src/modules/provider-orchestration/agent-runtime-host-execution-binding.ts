import crypto from 'node:crypto';

import type { ProviderExecutableIdentity } from '@jigwright/agent-runtime/provider-executable-identity';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertAgentRuntimeAssignmentBindingV1,
  type AgentRuntimeAssignmentBindingV1,
} from './agent-runtime-assignment-binding.ts';
import {
  assertProviderNativeSessionClaimV1,
  type ProviderNativeSessionClaimV1,
} from './provider-native-session.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u;

/** Exact pre-claim evidence for the bounded host-wrapper availability probe. */
export type AgentRuntimeHostProbeEvidenceV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-host-probe-evidence.v1';
  invocationId: string;
  requestDigest: string;
  executionAttemptId: string;
  acceptanceBindingDigest: string;
  assignmentBindingDigest: string;
  providerProfileDigest: string;
  executable: ProviderExecutableIdentity;
  providerDefinitionBindingDigest: string;
  providerVersion: string;
  probeRequestFileDigest: string;
  probeResultFileDigest: string;
  governedBeforeDigest: string;
  governedAfterDigest: string;
}>;

export type AgentRuntimeHostExecutionPhaseV1 =
  'assignment-admitted' | 'probe-attested' | 'native-terminal';

/**
 * Durable public host-wrapper authority. The assignment is always present, so
 * failures before a native-session claim remain bound to the selected profile.
 * Raw native provider identities never enter this value.
 */
export type AgentRuntimeHostExecutionBindingV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-host-execution-binding.v1';
  phase: AgentRuntimeHostExecutionPhaseV1;
  assignmentBinding: AgentRuntimeAssignmentBindingV1;
  assignmentBindingDigest: string;
  probe: AgentRuntimeHostProbeEvidenceV1 | null;
  nativeSessionClaim: ProviderNativeSessionClaimV1 | null;
  nativeSessionCompletionDigest: string | null;
  bindingDigest: string;
}>;

export function createAgentRuntimeHostProbeEvidenceV1(
  input: Omit<AgentRuntimeHostProbeEvidenceV1, 'schemaVersion' | 'kind'>,
): AgentRuntimeHostProbeEvidenceV1 {
  return assertAgentRuntimeHostProbeEvidenceV1({
    schemaVersion: 1,
    kind: 'agent-runtime-host-probe-evidence.v1',
    ...structuredClone(input),
  });
}

export function assertAgentRuntimeHostProbeEvidenceV1(
  value: unknown,
): AgentRuntimeHostProbeEvidenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'executionAttemptId',
      'acceptanceBindingDigest',
      'assignmentBindingDigest',
      'providerProfileDigest',
      'executable',
      'providerDefinitionBindingDigest',
      'providerVersion',
      'probeRequestFileDigest',
      'probeResultFileDigest',
      'governedBeforeDigest',
      'governedAfterDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-host-probe-evidence.v1' ||
    !isIdentifier(value.invocationId) ||
    !isIdentifier(value.executionAttemptId) ||
    ![
      value.requestDigest,
      value.acceptanceBindingDigest,
      value.assignmentBindingDigest,
      value.providerProfileDigest,
      value.providerDefinitionBindingDigest,
      value.probeRequestFileDigest,
      value.probeResultFileDigest,
      value.governedBeforeDigest,
      value.governedAfterDigest,
    ].every(isDigest) ||
    !isProviderExecutableIdentity(value.executable) ||
    value.governedBeforeDigest !== value.governedAfterDigest ||
    typeof value.providerVersion !== 'string' ||
    value.providerVersion.length === 0 ||
    Buffer.byteLength(value.providerVersion, 'utf8') > 256
  ) {
    throw invalidHostBinding();
  }
  return deepFreeze(structuredClone(value) as AgentRuntimeHostProbeEvidenceV1);
}

export function createAgentRuntimeHostExecutionBindingV1(
  input: Readonly<{
    assignmentBinding: AgentRuntimeAssignmentBindingV1;
    probe: AgentRuntimeHostProbeEvidenceV1 | null;
    nativeSessionClaim: ProviderNativeSessionClaimV1 | null;
    nativeSessionCompletionDigest: string | null;
  }>,
): AgentRuntimeHostExecutionBindingV1 {
  const assignmentBinding = assertAgentRuntimeAssignmentBindingV1(
    input.assignmentBinding,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'agent-runtime-host-execution-binding.v1' as const,
    phase: phaseFor(input),
    assignmentBinding,
    assignmentBindingDigest: assignmentBinding.bindingDigest,
    probe:
      input.probe === null
        ? null
        : assertAgentRuntimeHostProbeEvidenceV1(input.probe),
    nativeSessionClaim:
      input.nativeSessionClaim === null
        ? null
        : assertProviderNativeSessionClaimV1(input.nativeSessionClaim),
    nativeSessionCompletionDigest: input.nativeSessionCompletionDigest,
  };
  return assertAgentRuntimeHostExecutionBindingV1({
    ...body,
    bindingDigest: hostBindingDigest(body),
  });
}

export function assertAgentRuntimeHostExecutionBindingV1(
  value: unknown,
): AgentRuntimeHostExecutionBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'phase',
      'assignmentBinding',
      'assignmentBindingDigest',
      'probe',
      'nativeSessionClaim',
      'nativeSessionCompletionDigest',
      'bindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-host-execution-binding.v1' ||
    !['assignment-admitted', 'probe-attested', 'native-terminal'].includes(
      String(value.phase),
    ) ||
    !isDigest(value.assignmentBindingDigest) ||
    !isNullableDigest(value.nativeSessionCompletionDigest) ||
    !isDigest(value.bindingDigest)
  ) {
    throw invalidHostBinding();
  }
  const assignmentBinding = assertAgentRuntimeAssignmentBindingV1(
    value.assignmentBinding,
  );
  const probe =
    value.probe === null
      ? null
      : assertAgentRuntimeHostProbeEvidenceV1(value.probe);
  const nativeSessionClaim =
    value.nativeSessionClaim === null
      ? null
      : assertProviderNativeSessionClaimV1(value.nativeSessionClaim);
  if (
    value.assignmentBindingDigest !== assignmentBinding.bindingDigest ||
    value.phase !==
      phaseFor({
        probe,
        nativeSessionClaim,
        nativeSessionCompletionDigest: value.nativeSessionCompletionDigest,
      }) ||
    (probe !== null &&
      (probe.assignmentBindingDigest !== assignmentBinding.bindingDigest ||
        probe.providerProfileDigest !==
          assignmentBinding.providerProfileSnapshot.profileDigest ||
        probe.executable.candidatePath !==
          assignmentBinding.providerProfileSnapshot.executable ||
        probe.providerDefinitionBindingDigest !==
          providerDefinitionExecutableBindingDigest(
            probe.providerProfileDigest,
            probe.executable,
          ))) ||
    (nativeSessionClaim !== null &&
      (nativeSessionClaim.scope.changeId !== assignmentBinding.changeId ||
        nativeSessionClaim.scope.planningGeneration !==
          assignmentBinding.planningGeneration ||
        nativeSessionClaim.scope.assignmentRecordDigest !==
          assignmentBinding.recordDigest ||
        nativeSessionClaim.scope.logicalProviderId !==
          assignmentBinding.logicalProviderId ||
        nativeSessionClaim.scope.profileId !==
          assignmentBinding.providerProfileId ||
        nativeSessionClaim.scope.profileDigest !==
          assignmentBinding.providerProfileSnapshot.profileDigest ||
        nativeSessionClaim.scope.providerDefinitionDigest !==
          assignmentBinding.definitionDigest))
  ) {
    throw invalidHostBinding();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'agent-runtime-host-execution-binding.v1' as const,
    phase: value.phase as AgentRuntimeHostExecutionPhaseV1,
    assignmentBinding,
    assignmentBindingDigest: value.assignmentBindingDigest,
    probe,
    nativeSessionClaim,
    nativeSessionCompletionDigest: value.nativeSessionCompletionDigest,
  };
  if (hostBindingDigest(body) !== value.bindingDigest) {
    throw invalidHostBinding();
  }
  return deepFreeze({ ...body, bindingDigest: value.bindingDigest });
}

export function providerDefinitionExecutableBindingDigest(
  definitionDigest: string,
  executable: ProviderExecutableIdentity,
): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        providerDefinitionDigest: definitionDigest,
        executable,
      }),
    )
    .digest('hex');
}

export function isProviderExecutableIdentity(
  value: unknown,
): value is ProviderExecutableIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'candidatePath',
      'realPath',
      'device',
      'inode',
      'mode',
      'uid',
      'gid',
      'size',
      'mtimeNs',
      'sha256',
    ]) &&
    typeof value.candidatePath === 'string' &&
    value.candidatePath.length > 0 &&
    typeof value.realPath === 'string' &&
    value.realPath.length > 0 &&
    typeof value.device === 'string' &&
    value.device.length > 0 &&
    typeof value.inode === 'string' &&
    value.inode.length > 0 &&
    Number.isSafeInteger(value.mode) &&
    Number.isSafeInteger(value.uid) &&
    Number.isSafeInteger(value.gid) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.mtimeNs === 'string' &&
    value.mtimeNs.length > 0 &&
    isDigest(value.sha256)
  );
}

function phaseFor(
  input: Readonly<{
    probe: AgentRuntimeHostProbeEvidenceV1 | null;
    nativeSessionClaim: ProviderNativeSessionClaimV1 | null;
    nativeSessionCompletionDigest: string | null;
  }>,
): AgentRuntimeHostExecutionPhaseV1 {
  if (
    (input.nativeSessionClaim === null) !==
    (input.nativeSessionCompletionDigest === null)
  ) {
    throw invalidHostBinding();
  }
  if (input.nativeSessionClaim !== null) {
    if (
      input.probe === null ||
      !isDigest(input.nativeSessionCompletionDigest)
    ) {
      throw invalidHostBinding();
    }
    return 'native-terminal';
  }
  return input.probe === null ? 'assignment-admitted' : 'probe-attested';
}

function hostBindingDigest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(
      `workflow.agent-runtime-host-execution-binding.v1\n${canonicalJson(value)}`,
    )
    .digest('hex');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function invalidHostBinding(): TypeError {
  return new TypeError('Agent Runtime host execution binding is invalid.');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
