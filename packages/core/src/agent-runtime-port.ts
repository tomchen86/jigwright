import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { isRecord } from './contract-values.ts';

const BARE_DIGEST = /^[0-9a-f]{64}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const PROVIDER_FAMILY = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSIONED_KIND = /^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$/u;
const PROTOCOL = /^[a-z][a-z0-9.-]{0,127}$/u;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const UNAVAILABLE_DEFINITION_KIND =
  'unavailable-agent-runtime-definition.v1' as const;
const UNAVAILABLE_HOST_DISABLED_PROTOCOL =
  'unavailable-host-disabled-v1' as const;
const UNAVAILABLE_UNSUPPORTED_PLATFORM_PROTOCOL =
  'unavailable-unsupported-platform-v1' as const;
// Type-only provenance. It never participates in canonical runtime bytes.
declare const AGENT_RUNTIME_DEFINITION_IDENTITY_PROVENANCE: unique symbol;

export const AGENT_RUNTIME_OUTPUT_SCHEMA_DIGEST_V1_GRAMMAR =
  '^[0-9a-f]{64}$' as const;
const OUTPUT_SCHEMA_DIGEST = new RegExp(
  AGENT_RUNTIME_OUTPUT_SCHEMA_DIGEST_V1_GRAMMAR,
  'u',
);

export const AGENT_RUNTIME_PORT_V1_CONTRACT_VERSION =
  'jigwright.agent-runtime-port.v1' as const;

export const AGENT_RUNTIME_PORT_V1_LIMITS = Object.freeze({
  maxTimeoutMs: 3_600_000,
  maxAggregateOutputBytes: 1_048_576,
  maxEventCount: 4_096,
  maxPromptBytes: 1_048_576,
  maxSemanticProgressBytes: 4_096,
});

export class AgentRuntimePortContractError extends TypeError {
  readonly code = 'AGENT_RUNTIME_PORT_INVALID';

  constructor() {
    super('Agent runtime port input or evidence is invalid.');
    this.name = 'AgentRuntimePortContractError';
  }
}

export type AgentRuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentRuntimeJsonValue[]
  | { readonly [key: string]: AgentRuntimeJsonValue };

export type AgentRuntimeLaunchDefinitionSourceV1 = Readonly<{
  [AGENT_RUNTIME_DEFINITION_IDENTITY_PROVENANCE]: 'launch';
}>;

export type AgentRuntimeDefinitionIdentityV1 = Readonly<{
  schemaVersion: number;
  kind: string;
  providerFamily: string;
  protocol: string;
  definitionDigest: string;
}> &
  AgentRuntimeLaunchDefinitionSourceV1;

export type AgentRuntimeUnavailableDefinitionStatusV1 =
  'host-disabled' | 'unsupported-platform';

export type AgentRuntimeUnavailableDefinitionIdentityV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof UNAVAILABLE_DEFINITION_KIND;
  providerFamily: string;
  protocol:
    | typeof UNAVAILABLE_HOST_DISABLED_PROTOCOL
    | typeof UNAVAILABLE_UNSUPPORTED_PLATFORM_PROTOCOL;
  definitionDigest: string;
  [AGENT_RUNTIME_DEFINITION_IDENTITY_PROVENANCE]: 'unavailable';
}>;

export type AgentRuntimeProbeDefinitionIdentityV1 =
  | AgentRuntimeDefinitionIdentityV1
  | AgentRuntimeUnavailableDefinitionIdentityV1;

export type AgentRuntimeCapabilitiesV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-capabilities.v1';
  structuredStreaming: boolean;
  structuredOutput: boolean;
  resumableAfterTurn: boolean;
  forkable: boolean;
  reattachableInFlight: boolean;
  cancellationAck: boolean;
  usageReporting: 'actual' | 'reservation-only' | 'none';
  capabilityDigest: string;
}>;

export type AgentRuntimeExecutableIdentityV1 = Readonly<{
  candidatePath: string;
  realPath: string;
  device: string;
  inode: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeNs: string;
  sha256: string;
}>;

export type AgentRuntimeProbeStatusV1 =
  | 'ready'
  | 'host-disabled'
  | 'unsupported-platform'
  | 'absent'
  | 'unsafe-candidate'
  | 'incompatible'
  | 'unauthenticated';

export type AgentRuntimeProbeEvidenceV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-probe-evidence.v1';
  authority: 'observation-only';
  observationClass: 'host-observed' | 'synthetic-fixture';
  definition: AgentRuntimeProbeDefinitionIdentityV1;
  providerFamily: string;
  protocol: string;
  status: AgentRuntimeProbeStatusV1;
  executableIdentity: AgentRuntimeExecutableIdentityV1 | null;
  providerVersion: string | null;
  authentication: 'authenticated' | 'unauthenticated' | 'not-observed';
  capabilities: AgentRuntimeCapabilitiesV1 | null;
  evidenceDigest: string;
}>;

/**
 * A synchronous, effect-free admission boundary for runtime probe evidence.
 * The port can validate and return evidence only; it cannot decide provider
 * availability, persist a record, launch a process, or exercise authority.
 */
export type ProviderProbeEvidenceAdmissionPortV1 = Readonly<{
  admit(evidence: AgentRuntimeProbeEvidenceV1): AgentRuntimeProbeEvidenceV1;
}>;

export type AgentRuntimeAttemptBindingV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-attempt-binding.v1';
  operationId: string;
  workflowId: string;
  workflowEpoch: number;
  workflowContextDigest: string;
  jobId: string;
  attemptId: string;
  leaseGeneration: number;
  engineSessionId: string;
  invocationId: string;
  requestDigest: string;
  providerProfileId: string;
  /** Immutable host profile identity selected before this Attempt. */
  providerProfileDigest: string;
  /** Exact absolute executable candidate selected by that profile. */
  executableCandidate: string;
  definitionDigest: string;
  dataAuthorizationPolicyDigest: string;
  inputManifestDigest: string;
  targetDigest: string;
  assignmentDigest: string;
  outputSchemaDigest: string;
  effect: 'repository-read-only';
  bindingDigest: string;
}>;

export type AgentRuntimeGovernedInputV1 =
  | Readonly<{
      id: string;
      path: string;
      kind?: 'file';
    }>
  | Readonly<{
      id: string;
      path: string;
      kind: 'directory-closure';
      expectedFiles: readonly string[];
      mutableContentPaths: readonly string[];
    }>;

export type AgentRuntimeOutputContractV1 = Readonly<{
  slot: 'primary';
  schema: AgentRuntimeJsonValue;
  validate(value: unknown): boolean;
}>;

export type AgentRuntimeLimitsV1 = Readonly<{
  timeoutMs: number;
  aggregateOutputBytes: number;
  maxEventCount: number;
}>;

export type AgentRuntimePrivateSessionIdentityV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-private-session-identity.v1';
  action: 'start' | 'resume';
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  continuityToken: string | null;
  protocolReceiptDigest: string;
}>;

export type AgentRuntimeCommonInputV1 = Readonly<{
  binding: AgentRuntimeAttemptBindingV1;
  repositoryRoot: string;
  workingDirectory: string;
  runtimeDirectory: string;
  prompt: string;
  output: AgentRuntimeOutputContractV1;
  governedInputs: readonly AgentRuntimeGovernedInputV1[];
  limits: AgentRuntimeLimitsV1;
  privateSessionIdentitySink(
    identity: AgentRuntimePrivateSessionIdentityV1,
  ): void;
}>;

export type AgentRuntimeStartInputV1 = AgentRuntimeCommonInputV1 &
  Readonly<{
    action: 'start';
    mode: 'single-shot' | 'provider-observed-native';
  }>;

export type AgentRuntimeResumeInputV1 = AgentRuntimeCommonInputV1 &
  Readonly<{
    action: 'resume';
    mode: 'engine-supplied-native';
    nativeSessionId: string;
    nativeSessionIdDigest: string;
    predecessorCompletionDigest: string;
    continuityToken: string | null;
  }>;

export type AgentRuntimeProcessActivityEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'process-activity';
  activity:
    | 'spawned'
    | 'stdout'
    | 'stderr'
    | 'exited'
    | 'timed-out'
    | 'output-limit'
    | 'spawn-error'
    | 'protocol-error';
  elapsedMs: number;
  bytes: number | null;
}>;

export type AgentRuntimeProviderActivityEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'provider-activity';
  phase: 'starting' | 'tool' | 'model' | 'finalizing';
  elapsedMs: number;
}>;

export type AgentRuntimeSemanticProgressEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'semantic-progress';
  summary: string;
  elapsedMs: number;
}>;

export type AgentRuntimeUsageEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'usage';
  basis: 'actual' | 'reservation-only';
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  elapsedMs: number;
}>;

export type AgentRuntimeSessionStartedEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'session-started';
  action: 'start' | 'resume';
  nativeSessionIdDigest: string;
  continuityTokenDigest: string | null;
  protocolReceiptDigest: string;
  elapsedMs: number;
}>;

export type AgentRuntimeProjectionObservationV1 = Readonly<{
  unchanged: true;
  changedCategories: readonly [];
  beforeDigest: string;
  afterDigest: string;
}>;

export type AgentRuntimeCompletionObservationV1 = Readonly<{
  observationClass: 'host-observed' | 'synthetic-fixture';
  definitionDigest: string;
  executable: AgentRuntimeExecutableIdentityV1;
  providerVersion: string | null;
  assurance: 'unchanged-governed-projection';
  projection: AgentRuntimeProjectionObservationV1;
  sameUserProcessConfined: false;
  residuals: readonly string[];
  protocolEvidence: AgentRuntimeJsonValue | null;
}>;

export type AgentRuntimeCompletedEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'completed';
  outputSlot: 'primary';
  output: AgentRuntimeJsonValue;
  observation: AgentRuntimeCompletionObservationV1;
  elapsedMs: number;
}>;

export type AgentRuntimeFailedEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'failed';
  phase:
    'preflight' | 'launch' | 'protocol' | 'output' | 'projection' | 'identity';
  code: string;
  launched: boolean;
  elapsedMs: number;
}>;

export type AgentRuntimeCancelledEventV1 = Readonly<{
  schemaVersion: 1;
  type: 'cancelled';
  acknowledged: boolean;
  forced: boolean;
  elapsedMs: number;
}>;

export type AgentRuntimeEventV1 =
  | AgentRuntimeProcessActivityEventV1
  | AgentRuntimeProviderActivityEventV1
  | AgentRuntimeSemanticProgressEventV1
  | AgentRuntimeUsageEventV1
  | AgentRuntimeSessionStartedEventV1
  | AgentRuntimeCompletedEventV1
  | AgentRuntimeFailedEventV1
  | AgentRuntimeCancelledEventV1;

export type AgentRuntimeEventPayloadV1 =
  | Readonly<{
      type: 'process-activity';
      activity: AgentRuntimeProcessActivityEventV1['activity'];
      elapsedMs: number;
      bytes?: number;
    }>
  | Readonly<{
      type: 'provider-activity';
      phase: AgentRuntimeProviderActivityEventV1['phase'];
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'semantic-progress';
      summary: string;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'usage';
      basis: AgentRuntimeUsageEventV1['basis'];
      inputTokens: number | null;
      outputTokens: number | null;
      costMicros: number | null;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'session-started';
      action: 'start' | 'resume';
      nativeSessionIdDigest: string;
      continuityTokenDigest: string | null;
      protocolReceiptDigest: string;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'completed';
      output: unknown;
      observation: AgentRuntimeCompletionObservationV1;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'failed';
      phase: AgentRuntimeFailedEventV1['phase'];
      code: string;
      launched: boolean;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'cancelled';
      acknowledged: boolean;
      forced: boolean;
      elapsedMs: number;
    }>;

export type AgentRuntimeCancelInputV1 = Readonly<{
  binding: AgentRuntimeAttemptBindingV1;
  reason: AgentRuntimeCancelReasonV1;
}>;

export type AgentRuntimeCancelReasonV1 =
  'caller-requested' | 'deadline' | 'lease-lost' | 'shutdown';

export type AgentRuntimeCancelResultV1 =
  | Readonly<{
      status: 'cancelled';
      acknowledged: boolean;
      forced: boolean;
    }>
  | Readonly<{ status: 'already-terminal' }>
  | Readonly<{ status: 'not-active' }>
  | Readonly<{ status: 'cancellation-unconfirmed' }>;

export interface AgentRuntimePortV1<
  Definition extends AgentRuntimeLaunchDefinitionSourceV1 =
    AgentRuntimeDefinitionIdentityV1,
  StartInput extends AgentRuntimeStartInputV1 = AgentRuntimeStartInputV1,
  ResumeInput extends AgentRuntimeResumeInputV1 = AgentRuntimeResumeInputV1,
> {
  readonly contractVersion: typeof AGENT_RUNTIME_PORT_V1_CONTRACT_VERSION;
  probe(snapshot: Definition): Promise<AgentRuntimeProbeEvidenceV1>;
  readonly start: (
    snapshot: Definition,
    input: StartInput,
  ) => AsyncIterable<AgentRuntimeEventV1>;
  readonly resume: (
    snapshot: Definition,
    input: ResumeInput,
  ) => AsyncIterable<AgentRuntimeEventV1>;
  cancel(input: AgentRuntimeCancelInputV1): Promise<AgentRuntimeCancelResultV1>;
}

export function assertAgentRuntimeDefinitionIdentityV1(
  value: unknown,
): AgentRuntimeDefinitionIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'providerFamily',
      'protocol',
      'definitionDigest',
    ]) ||
    !isPositiveSafeInteger(value.schemaVersion) ||
    typeof value.kind !== 'string' ||
    !VERSIONED_KIND.test(value.kind) ||
    typeof value.providerFamily !== 'string' ||
    !PROVIDER_FAMILY.test(value.providerFamily) ||
    typeof value.protocol !== 'string' ||
    !PROTOCOL.test(value.protocol) ||
    value.kind === UNAVAILABLE_DEFINITION_KIND ||
    value.protocol === UNAVAILABLE_HOST_DISABLED_PROTOCOL ||
    value.protocol === UNAVAILABLE_UNSUPPORTED_PLATFORM_PROTOCOL ||
    typeof value.definitionDigest !== 'string' ||
    !BARE_DIGEST.test(value.definitionDigest)
  ) {
    throw invalidContract();
  }
  if (Object.isFrozen(value)) {
    return value as AgentRuntimeDefinitionIdentityV1;
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    providerFamily: value.providerFamily,
    protocol: value.protocol,
    definitionDigest: value.definitionDigest,
  }) as unknown as AgentRuntimeDefinitionIdentityV1;
}

export function createAgentRuntimeUnavailableDefinitionIdentityV1(
  input: Readonly<{
    providerFamily: string;
    status: AgentRuntimeUnavailableDefinitionStatusV1;
  }>,
): AgentRuntimeUnavailableDefinitionIdentityV1 {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['providerFamily', 'status']) ||
    typeof input.providerFamily !== 'string' ||
    !PROVIDER_FAMILY.test(input.providerFamily) ||
    (input.status !== 'host-disabled' &&
      input.status !== 'unsupported-platform')
  ) {
    throw invalidContract();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: UNAVAILABLE_DEFINITION_KIND,
    providerFamily: input.providerFamily,
    protocol:
      input.status === 'host-disabled'
        ? UNAVAILABLE_HOST_DISABLED_PROTOCOL
        : UNAVAILABLE_UNSUPPORTED_PLATFORM_PROTOCOL,
  };
  return Object.freeze({
    ...body,
    definitionDigest: sha256(
      canonicalJson({
        domain: 'jigwright.unavailable-agent-runtime-definition.v1',
        status: input.status,
        ...body,
      }),
    ),
  }) as unknown as AgentRuntimeUnavailableDefinitionIdentityV1;
}

export function assertAgentRuntimeUnavailableDefinitionIdentityV1(
  value: unknown,
): AgentRuntimeUnavailableDefinitionIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'providerFamily',
      'protocol',
      'definitionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== UNAVAILABLE_DEFINITION_KIND ||
    typeof value.providerFamily !== 'string' ||
    !PROVIDER_FAMILY.test(value.providerFamily) ||
    (value.protocol !== UNAVAILABLE_HOST_DISABLED_PROTOCOL &&
      value.protocol !== UNAVAILABLE_UNSUPPORTED_PLATFORM_PROTOCOL) ||
    typeof value.definitionDigest !== 'string' ||
    !BARE_DIGEST.test(value.definitionDigest)
  ) {
    throw invalidContract();
  }
  const expected = createAgentRuntimeUnavailableDefinitionIdentityV1({
    providerFamily: value.providerFamily,
    status:
      value.protocol === UNAVAILABLE_HOST_DISABLED_PROTOCOL
        ? 'host-disabled'
        : 'unsupported-platform',
  });
  if (expected.definitionDigest !== value.definitionDigest) {
    throw invalidContract();
  }
  return Object.isFrozen(value)
    ? (value as AgentRuntimeUnavailableDefinitionIdentityV1)
    : expected;
}

function assertAgentRuntimeProbeDefinitionIdentityV1(
  value: unknown,
): AgentRuntimeProbeDefinitionIdentityV1 {
  return isRecord(value) && value.kind === UNAVAILABLE_DEFINITION_KIND
    ? assertAgentRuntimeUnavailableDefinitionIdentityV1(value)
    : assertAgentRuntimeDefinitionIdentityV1(value);
}

export function createAgentRuntimeCapabilitiesV1(
  input: Omit<
    AgentRuntimeCapabilitiesV1,
    'schemaVersion' | 'kind' | 'capabilityDigest'
  >,
): AgentRuntimeCapabilitiesV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: 'agent-runtime-capabilities.v1' as const,
    structuredStreaming: input.structuredStreaming,
    structuredOutput: input.structuredOutput,
    resumableAfterTurn: input.resumableAfterTurn,
    forkable: input.forkable,
    reattachableInFlight: input.reattachableInFlight,
    cancellationAck: input.cancellationAck,
    usageReporting: input.usageReporting,
  };
  assertCapabilitiesBody(body);
  return Object.freeze({
    ...body,
    capabilityDigest: domainDigest(
      'jigwright.agent-runtime-capabilities.v1',
      body,
    ),
  });
}

export function assertAgentRuntimeCapabilitiesV1(
  value: unknown,
): AgentRuntimeCapabilitiesV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'structuredStreaming',
      'structuredOutput',
      'resumableAfterTurn',
      'forkable',
      'reattachableInFlight',
      'cancellationAck',
      'usageReporting',
      'capabilityDigest',
    ]) ||
    typeof value.capabilityDigest !== 'string' ||
    !BARE_DIGEST.test(value.capabilityDigest)
  ) {
    throw invalidContract();
  }
  const { capabilityDigest, ...body } = value;
  assertCapabilitiesBody(body);
  if (
    domainDigest('jigwright.agent-runtime-capabilities.v1', body) !==
    capabilityDigest
  ) {
    throw invalidContract();
  }
  if (Object.isFrozen(value)) return value as AgentRuntimeCapabilitiesV1;
  return createAgentRuntimeCapabilitiesV1(
    body as unknown as Omit<
      AgentRuntimeCapabilitiesV1,
      'schemaVersion' | 'kind' | 'capabilityDigest'
    >,
  );
}

export function createAgentRuntimeProbeEvidenceV1(
  input: Omit<
    AgentRuntimeProbeEvidenceV1,
    | 'schemaVersion'
    | 'kind'
    | 'definition'
    | 'providerFamily'
    | 'protocol'
    | 'evidenceDigest'
  > &
    Readonly<{ definition: unknown }>,
): AgentRuntimeProbeEvidenceV1 {
  const definition = assertAgentRuntimeProbeDefinitionIdentityV1(
    input.definition,
  );
  const executableIdentity = normalizeExecutableIdentity(
    input.executableIdentity,
  );
  const capabilities =
    input.capabilities === null
      ? null
      : assertAgentRuntimeCapabilitiesV1(input.capabilities);
  const body = {
    schemaVersion: 1 as const,
    kind: 'agent-runtime-probe-evidence.v1' as const,
    authority: input.authority,
    observationClass: input.observationClass,
    definition,
    providerFamily: definition.providerFamily,
    protocol: definition.protocol,
    status: input.status,
    executableIdentity,
    providerVersion: input.providerVersion,
    authentication: input.authentication,
    capabilities,
  };
  assertProbeBody(body);
  return deepFreeze({
    ...body,
    evidenceDigest: domainDigest(
      'jigwright.agent-runtime-probe-evidence.v1',
      body,
    ),
  });
}

export function assertAgentRuntimeProbeEvidenceV1(
  value: unknown,
): AgentRuntimeProbeEvidenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'authority',
      'observationClass',
      'definition',
      'providerFamily',
      'protocol',
      'status',
      'executableIdentity',
      'providerVersion',
      'authentication',
      'capabilities',
      'evidenceDigest',
    ]) ||
    typeof value.evidenceDigest !== 'string' ||
    !BARE_DIGEST.test(value.evidenceDigest)
  ) {
    throw invalidContract();
  }
  const admitted = createAgentRuntimeProbeEvidenceV1({
    authority: value.authority as never,
    observationClass: value.observationClass as never,
    definition: value.definition as never,
    status: value.status as never,
    executableIdentity: value.executableIdentity as never,
    providerVersion: value.providerVersion as never,
    authentication: value.authentication as never,
    capabilities: value.capabilities as never,
  });
  if (
    admitted.providerFamily !== value.providerFamily ||
    admitted.protocol !== value.protocol ||
    admitted.evidenceDigest !== value.evidenceDigest
  ) {
    throw invalidContract();
  }
  return admitted;
}

/** Production admission is permanently bound to host-observed evidence. */
export function createHostObservedProviderProbeEvidenceAdmissionPortV1(): ProviderProbeEvidenceAdmissionPortV1 {
  return createProviderProbeEvidenceAdmissionPortV1('host-observed');
}

/** Deterministic fixture admission can never be mistaken for host evidence. */
export function createSyntheticFixtureProviderProbeEvidenceAdmissionPortV1(): ProviderProbeEvidenceAdmissionPortV1 {
  return createProviderProbeEvidenceAdmissionPortV1('synthetic-fixture');
}

function createProviderProbeEvidenceAdmissionPortV1(
  expectedObservationClass: AgentRuntimeProbeEvidenceV1['observationClass'],
): ProviderProbeEvidenceAdmissionPortV1 {
  return Object.freeze({
    admit(evidence: AgentRuntimeProbeEvidenceV1) {
      const admitted = assertAgentRuntimeProbeEvidenceV1(evidence);
      if (admitted.observationClass !== expectedObservationClass) {
        throw invalidContract();
      }
      return admitted;
    },
  });
}

export function createAgentRuntimeAttemptBindingV1(
  input: Omit<
    AgentRuntimeAttemptBindingV1,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): AgentRuntimeAttemptBindingV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: 'agent-runtime-attempt-binding.v1' as const,
    operationId: input.operationId,
    workflowId: input.workflowId,
    workflowEpoch: input.workflowEpoch,
    workflowContextDigest: input.workflowContextDigest,
    jobId: input.jobId,
    attemptId: input.attemptId,
    leaseGeneration: input.leaseGeneration,
    engineSessionId: input.engineSessionId,
    invocationId: input.invocationId,
    requestDigest: input.requestDigest,
    providerProfileId: input.providerProfileId,
    providerProfileDigest: input.providerProfileDigest,
    executableCandidate: input.executableCandidate,
    definitionDigest: input.definitionDigest,
    dataAuthorizationPolicyDigest: input.dataAuthorizationPolicyDigest,
    inputManifestDigest: input.inputManifestDigest,
    targetDigest: input.targetDigest,
    assignmentDigest: input.assignmentDigest,
    outputSchemaDigest: input.outputSchemaDigest,
    effect: input.effect,
  };
  assertBindingBody(body);
  return Object.freeze({
    ...body,
    bindingDigest: domainDigest(
      'jigwright.agent-runtime-attempt-binding.v1',
      body,
    ),
  });
}

export function assertAgentRuntimeAttemptBindingV1(
  value: unknown,
): AgentRuntimeAttemptBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'operationId',
      'workflowId',
      'workflowEpoch',
      'workflowContextDigest',
      'jobId',
      'attemptId',
      'leaseGeneration',
      'engineSessionId',
      'invocationId',
      'requestDigest',
      'providerProfileId',
      'providerProfileDigest',
      'executableCandidate',
      'definitionDigest',
      'dataAuthorizationPolicyDigest',
      'inputManifestDigest',
      'targetDigest',
      'assignmentDigest',
      'outputSchemaDigest',
      'effect',
      'bindingDigest',
    ]) ||
    typeof value.bindingDigest !== 'string' ||
    !BARE_DIGEST.test(value.bindingDigest)
  ) {
    throw invalidContract();
  }
  const { bindingDigest, ...body } = value;
  assertBindingBody(body);
  if (
    domainDigest('jigwright.agent-runtime-attempt-binding.v1', body) !==
    bindingDigest
  ) {
    throw invalidContract();
  }
  if (Object.isFrozen(value)) return value as AgentRuntimeAttemptBindingV1;
  return createAgentRuntimeAttemptBindingV1(
    body as unknown as Omit<
      AgentRuntimeAttemptBindingV1,
      'schemaVersion' | 'kind' | 'bindingDigest'
    >,
  );
}

export function assertAgentRuntimeStartInputV1(
  value: unknown,
): AgentRuntimeStartInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'mode',
      'binding',
      'repositoryRoot',
      'workingDirectory',
      'runtimeDirectory',
      'prompt',
      'output',
      'governedInputs',
      'limits',
      'privateSessionIdentitySink',
    ]) ||
    value.action !== 'start' ||
    (value.mode !== 'single-shot' && value.mode !== 'provider-observed-native')
  ) {
    throw invalidContract();
  }
  return normalizeCommonInput(value) as AgentRuntimeStartInputV1;
}

export function assertAgentRuntimeResumeInputV1(
  value: unknown,
): AgentRuntimeResumeInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action',
      'mode',
      'binding',
      'repositoryRoot',
      'workingDirectory',
      'runtimeDirectory',
      'prompt',
      'output',
      'governedInputs',
      'limits',
      'privateSessionIdentitySink',
      'nativeSessionId',
      'nativeSessionIdDigest',
      'predecessorCompletionDigest',
      'continuityToken',
    ]) ||
    value.action !== 'resume' ||
    value.mode !== 'engine-supplied-native' ||
    !isPrivateSecret(value.nativeSessionId) ||
    typeof value.nativeSessionIdDigest !== 'string' ||
    value.nativeSessionIdDigest !==
      agentRuntimeNativeSessionIdDigestV1(value.nativeSessionId) ||
    typeof value.predecessorCompletionDigest !== 'string' ||
    !DIGEST.test(value.predecessorCompletionDigest) ||
    (value.continuityToken !== null && !isPrivateSecret(value.continuityToken))
  ) {
    throw invalidContract();
  }
  return normalizeCommonInput(value) as AgentRuntimeResumeInputV1;
}

export function assertAgentRuntimeCancelInputV1(
  value: unknown,
): AgentRuntimeCancelInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['binding', 'reason']) ||
    !['caller-requested', 'deadline', 'lease-lost', 'shutdown'].includes(
      String(value.reason),
    )
  ) {
    throw invalidContract();
  }
  return Object.freeze({
    binding: assertAgentRuntimeAttemptBindingV1(value.binding),
    reason: value.reason as AgentRuntimeCancelReasonV1,
  });
}

export function createAgentRuntimeCancelResultV1(
  binding: AgentRuntimeAttemptBindingV1,
  result: Readonly<{
    status: AgentRuntimeCancelResultV1['status'];
    acknowledged: boolean;
    forced: boolean;
  }>,
): AgentRuntimeCancelResultV1 {
  assertAgentRuntimeAttemptBindingV1(binding);
  if (
    ![
      'cancelled',
      'already-terminal',
      'not-active',
      'cancellation-unconfirmed',
    ].includes(result.status) ||
    typeof result.acknowledged !== 'boolean' ||
    typeof result.forced !== 'boolean' ||
    (result.acknowledged && result.forced) ||
    (result.status !== 'cancelled' && (result.acknowledged || result.forced)) ||
    (result.status === 'cancelled' && !result.acknowledged && !result.forced)
  ) {
    throw invalidContract();
  }
  return result.status === 'cancelled'
    ? Object.freeze({
        status: result.status,
        acknowledged: result.acknowledged,
        forced: result.forced,
      })
    : Object.freeze({ status: result.status });
}

export function createAgentRuntimeEventV1(
  payload: AgentRuntimeEventPayloadV1,
): AgentRuntimeEventV1 {
  if (!isRecord(payload)) throw invalidContract();
  if (payload.type === 'process-activity') {
    if (
      !hasOnlyKeys(payload, ['type', 'activity', 'elapsedMs', 'bytes']) ||
      ![
        'spawned',
        'stdout',
        'stderr',
        'exited',
        'timed-out',
        'output-limit',
        'spawn-error',
        'protocol-error',
      ].includes(payload.activity) ||
      !isNonNegativeSafeInteger(payload.elapsedMs) ||
      (payload.bytes !== undefined && !isNonNegativeSafeInteger(payload.bytes))
    ) {
      throw invalidContract();
    }
    return Object.freeze({
      schemaVersion: 1,
      type: payload.type,
      activity: payload.activity,
      elapsedMs: payload.elapsedMs,
      bytes: payload.bytes ?? null,
    });
  }
  if (payload.type === 'provider-activity') {
    if (
      !hasExactKeys(payload, ['type', 'phase', 'elapsedMs']) ||
      !['starting', 'tool', 'model', 'finalizing'].includes(payload.phase) ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
  }
  if (payload.type === 'semantic-progress') {
    if (
      !hasExactKeys(payload, ['type', 'summary', 'elapsedMs']) ||
      typeof payload.summary !== 'string' ||
      payload.summary.length === 0 ||
      Buffer.byteLength(payload.summary, 'utf8') >
        AGENT_RUNTIME_PORT_V1_LIMITS.maxSemanticProgressBytes ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
  }
  if (payload.type === 'usage') {
    if (
      !hasExactKeys(payload, [
        'type',
        'basis',
        'inputTokens',
        'outputTokens',
        'costMicros',
        'elapsedMs',
      ]) ||
      !['actual', 'reservation-only'].includes(payload.basis) ||
      !isNullableNonNegativeSafeInteger(payload.inputTokens) ||
      !isNullableNonNegativeSafeInteger(payload.outputTokens) ||
      !isNullableNonNegativeSafeInteger(payload.costMicros) ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
  }
  if (payload.type === 'session-started') {
    if (
      !hasExactKeys(payload, [
        'type',
        'action',
        'nativeSessionIdDigest',
        'continuityTokenDigest',
        'protocolReceiptDigest',
        'elapsedMs',
      ]) ||
      !['start', 'resume'].includes(payload.action) ||
      !BARE_DIGEST.test(payload.nativeSessionIdDigest) ||
      (payload.continuityTokenDigest !== null &&
        !BARE_DIGEST.test(payload.continuityTokenDigest)) ||
      !BARE_DIGEST.test(payload.protocolReceiptDigest) ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
  }
  if (payload.type === 'completed') {
    if (
      !hasExactKeys(payload, ['type', 'output', 'observation', 'elapsedMs']) ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    const output = normalizeJsonValue(payload.output);
    const observation = normalizeCompletionObservation(payload.observation);
    return deepFreeze({
      schemaVersion: 1 as const,
      type: payload.type,
      outputSlot: 'primary' as const,
      output,
      observation,
      elapsedMs: payload.elapsedMs,
    });
  }
  if (payload.type === 'failed') {
    if (
      !hasExactKeys(payload, [
        'type',
        'phase',
        'code',
        'launched',
        'elapsedMs',
      ]) ||
      ![
        'preflight',
        'launch',
        'protocol',
        'output',
        'projection',
        'identity',
      ].includes(payload.phase) ||
      !REASON_CODE.test(payload.code) ||
      typeof payload.launched !== 'boolean' ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
  }
  if (payload.type === 'cancelled') {
    if (
      !hasExactKeys(payload, ['type', 'acknowledged', 'forced', 'elapsedMs']) ||
      typeof payload.acknowledged !== 'boolean' ||
      typeof payload.forced !== 'boolean' ||
      payload.acknowledged === payload.forced ||
      !isNonNegativeSafeInteger(payload.elapsedMs)
    ) {
      throw invalidContract();
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
  }
  throw invalidContract();
}

/** Preserve the landed harness-jsonl-v2 digest bytes without exposing the ID. */
export function agentRuntimeNativeSessionIdDigestV1(
  nativeSessionId: string,
): string {
  if (!isPrivateSecret(nativeSessionId)) throw invalidContract();
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-native-session-identity',
      nativeSessionId,
    }),
  );
}

export function agentRuntimeContinuityTokenDigestV1(
  continuityToken: string,
): string {
  if (!isPrivateSecret(continuityToken)) throw invalidContract();
  return domainDigest(
    'jigwright.agent-runtime-continuity-token.v1',
    continuityToken,
  );
}

export function agentRuntimeOutputSchemaDigestV1(schema: unknown): string {
  const admitted = normalizeJsonValue(schema);
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'agent-runtime-output-schema.v1',
      schema: admitted,
    }),
  );
}

function assertCapabilitiesBody(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'structuredStreaming',
      'structuredOutput',
      'resumableAfterTurn',
      'forkable',
      'reattachableInFlight',
      'cancellationAck',
      'usageReporting',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-capabilities.v1' ||
    typeof value.structuredStreaming !== 'boolean' ||
    typeof value.structuredOutput !== 'boolean' ||
    typeof value.resumableAfterTurn !== 'boolean' ||
    typeof value.forkable !== 'boolean' ||
    typeof value.reattachableInFlight !== 'boolean' ||
    typeof value.cancellationAck !== 'boolean' ||
    !['actual', 'reservation-only', 'none'].includes(
      String(value.usageReporting),
    )
  ) {
    throw invalidContract();
  }
}

function assertProbeBody(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'authority',
      'observationClass',
      'definition',
      'providerFamily',
      'protocol',
      'status',
      'executableIdentity',
      'providerVersion',
      'authentication',
      'capabilities',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-probe-evidence.v1' ||
    value.authority !== 'observation-only' ||
    (value.observationClass !== 'host-observed' &&
      value.observationClass !== 'synthetic-fixture') ||
    ![
      'ready',
      'host-disabled',
      'unsupported-platform',
      'absent',
      'unsafe-candidate',
      'incompatible',
      'unauthenticated',
    ].includes(String(value.status)) ||
    typeof value.providerFamily !== 'string' ||
    typeof value.protocol !== 'string' ||
    (value.providerVersion !== null &&
      (typeof value.providerVersion !== 'string' ||
        value.providerVersion.length === 0 ||
        value.providerVersion.length > 256)) ||
    !['authenticated', 'unauthenticated', 'not-observed'].includes(
      String(value.authentication),
    )
  ) {
    throw invalidContract();
  }
  const definition = assertAgentRuntimeProbeDefinitionIdentityV1(
    value.definition,
  );
  if (
    value.providerFamily !== definition.providerFamily ||
    value.protocol !== definition.protocol
  ) {
    throw invalidContract();
  }
  const unavailableStatus = unavailableDefinitionStatus(definition);
  const platformUnavailable =
    value.status === 'host-disabled' || value.status === 'unsupported-platform';
  if (
    platformUnavailable &&
    (value.observationClass !== 'host-observed' ||
      unavailableStatus !== value.status ||
      value.executableIdentity !== null ||
      value.providerVersion !== null ||
      value.authentication !== 'not-observed' ||
      value.capabilities !== null)
  ) {
    throw invalidContract();
  }
  if (!platformUnavailable && unavailableStatus !== null) {
    throw invalidContract();
  }
  const syntheticReady =
    value.observationClass === 'synthetic-fixture' && value.status === 'ready';
  const hostReady =
    value.observationClass === 'host-observed' && value.status === 'ready';
  if (
    syntheticReady &&
    (value.executableIdentity === null ||
      value.providerVersion === null ||
      value.authentication !== 'not-observed' ||
      value.capabilities === null)
  ) {
    throw invalidContract();
  }
  if (
    hostReady &&
    (value.executableIdentity === null ||
      value.providerVersion === null ||
      value.authentication !== 'authenticated' ||
      value.capabilities === null)
  ) {
    throw invalidContract();
  }
  if (value.status === 'unauthenticated') {
    if (
      value.observationClass !== 'host-observed' ||
      value.executableIdentity === null ||
      value.providerVersion === null ||
      value.authentication !== 'unauthenticated' ||
      value.capabilities === null
    ) {
      throw invalidContract();
    }
  } else if (value.authentication === 'unauthenticated') {
    throw invalidContract();
  }
  if (
    value.status !== 'ready' &&
    value.observationClass === 'synthetic-fixture'
  ) {
    throw invalidContract();
  }
  if (
    (value.status === 'absent' || value.status === 'unsafe-candidate') &&
    (value.observationClass !== 'host-observed' ||
      value.executableIdentity !== null ||
      value.providerVersion !== null ||
      value.authentication !== 'not-observed' ||
      value.capabilities !== null)
  ) {
    throw invalidContract();
  }
  if (
    value.status === 'incompatible' &&
    (value.observationClass !== 'host-observed' ||
      value.executableIdentity === null ||
      value.authentication !== 'not-observed' ||
      value.capabilities !== null)
  ) {
    throw invalidContract();
  }
}

function unavailableDefinitionStatus(
  definition: AgentRuntimeProbeDefinitionIdentityV1,
): AgentRuntimeUnavailableDefinitionStatusV1 | null {
  if (definition.kind !== UNAVAILABLE_DEFINITION_KIND) return null;
  return definition.protocol === UNAVAILABLE_HOST_DISABLED_PROTOCOL
    ? 'host-disabled'
    : 'unsupported-platform';
}

function assertBindingBody(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'operationId',
      'workflowId',
      'workflowEpoch',
      'workflowContextDigest',
      'jobId',
      'attemptId',
      'leaseGeneration',
      'engineSessionId',
      'invocationId',
      'requestDigest',
      'providerProfileId',
      'providerProfileDigest',
      'executableCandidate',
      'definitionDigest',
      'dataAuthorizationPolicyDigest',
      'inputManifestDigest',
      'targetDigest',
      'assignmentDigest',
      'outputSchemaDigest',
      'effect',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-attempt-binding.v1' ||
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.workflowId) ||
    !isNonNegativeSafeInteger(value.workflowEpoch) ||
    !isDigest(value.workflowContextDigest) ||
    !isIdentifier(value.jobId) ||
    !isIdentifier(value.attemptId) ||
    !isPositiveSafeInteger(value.leaseGeneration) ||
    !isIdentifier(value.engineSessionId) ||
    !isIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isIdentifier(value.providerProfileId) ||
    !isDigest(value.providerProfileDigest) ||
    !isAbsolutePath(value.executableCandidate) ||
    typeof value.definitionDigest !== 'string' ||
    !BARE_DIGEST.test(value.definitionDigest) ||
    !isDigest(value.dataAuthorizationPolicyDigest) ||
    !isDigest(value.inputManifestDigest) ||
    !isDigest(value.targetDigest) ||
    !isDigest(value.assignmentDigest) ||
    typeof value.outputSchemaDigest !== 'string' ||
    !OUTPUT_SCHEMA_DIGEST.test(value.outputSchemaDigest) ||
    value.effect !== 'repository-read-only'
  ) {
    throw invalidContract();
  }
}

function normalizeCommonInput(
  value: Record<string, unknown>,
): AgentRuntimeCommonInputV1 {
  const binding = assertAgentRuntimeAttemptBindingV1(value.binding);
  if (
    !isAbsolutePath(value.repositoryRoot) ||
    !isAbsolutePath(value.workingDirectory) ||
    !isAbsolutePath(value.runtimeDirectory) ||
    !isSameOrDescendantPath(value.repositoryRoot, value.workingDirectory) ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    Buffer.byteLength(value.prompt, 'utf8') >
      AGENT_RUNTIME_PORT_V1_LIMITS.maxPromptBytes ||
    !isRecord(value.output) ||
    !hasExactKeys(value.output, ['slot', 'schema', 'validate']) ||
    value.output.slot !== 'primary' ||
    typeof value.output.validate !== 'function' ||
    !Array.isArray(value.governedInputs) ||
    !isRecord(value.limits) ||
    !hasExactKeys(value.limits, [
      'timeoutMs',
      'aggregateOutputBytes',
      'maxEventCount',
    ]) ||
    !isBoundedPositiveInteger(
      value.limits.timeoutMs,
      AGENT_RUNTIME_PORT_V1_LIMITS.maxTimeoutMs,
    ) ||
    !isBoundedPositiveInteger(
      value.limits.aggregateOutputBytes,
      AGENT_RUNTIME_PORT_V1_LIMITS.maxAggregateOutputBytes,
    ) ||
    !isBoundedPositiveInteger(
      value.limits.maxEventCount,
      AGENT_RUNTIME_PORT_V1_LIMITS.maxEventCount,
    ) ||
    typeof value.privateSessionIdentitySink !== 'function'
  ) {
    throw invalidContract();
  }
  const schema = normalizeJsonValue(value.output.schema);
  if (binding.outputSchemaDigest !== agentRuntimeOutputSchemaDigestV1(schema)) {
    throw invalidContract();
  }
  const governedInputs = value.governedInputs.map((entry) => {
    if (
      !isRecord(entry) ||
      !isIdentifier(entry.id) ||
      !isAbsolutePath(entry.path)
    ) {
      throw invalidContract();
    }
    if (entry.kind === 'directory-closure') {
      if (
        !hasExactKeys(entry, [
          'id',
          'path',
          'kind',
          'expectedFiles',
          'mutableContentPaths',
        ]) ||
        !Array.isArray(entry.expectedFiles) ||
        !Array.isArray(entry.mutableContentPaths) ||
        !entry.expectedFiles.every(isPortableRelativePath) ||
        !entry.mutableContentPaths.every(isPortableRelativePath) ||
        !isSortedUniqueDirectoryPaths(
          entry.expectedFiles as string[],
          entry.path,
        ) ||
        !isSortedUniqueDirectoryPaths(
          entry.mutableContentPaths as string[],
          entry.path,
        ) ||
        !isDirectoryPathSubset(
          entry.mutableContentPaths as string[],
          entry.expectedFiles as string[],
          entry.path,
        )
      ) {
        throw invalidContract();
      }
      return Object.freeze({
        id: entry.id,
        path: entry.path,
        kind: 'directory-closure' as const,
        expectedFiles: Object.freeze([...(entry.expectedFiles as string[])]),
        mutableContentPaths: Object.freeze([
          ...(entry.mutableContentPaths as string[]),
        ]),
      });
    }
    if (
      !hasOnlyKeys(entry, ['id', 'path', 'kind']) ||
      (entry.kind !== undefined && entry.kind !== 'file')
    ) {
      throw invalidContract();
    }
    return Object.freeze({
      id: entry.id,
      path: entry.path,
      kind: 'file' as const,
    });
  });
  if (
    new Set(governedInputs.map((entry) => entry.id)).size !==
      governedInputs.length ||
    new Set(governedInputs.map((entry) => absolutePathIdentity(entry.path)))
      .size !== governedInputs.length
  ) {
    throw invalidContract();
  }
  return Object.freeze({
    ...value,
    binding,
    output: Object.freeze({
      slot: 'primary',
      schema,
      validate: value.output.validate as (candidate: unknown) => boolean,
    }),
    governedInputs: Object.freeze(governedInputs),
    limits: Object.freeze({
      timeoutMs: value.limits.timeoutMs as number,
      aggregateOutputBytes: value.limits.aggregateOutputBytes as number,
      maxEventCount: value.limits.maxEventCount as number,
    }),
  }) as AgentRuntimeCommonInputV1;
}

function normalizeExecutableIdentity(
  value: unknown,
): AgentRuntimeExecutableIdentityV1 | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    !isAbsolutePath(value.candidatePath) ||
    !isAbsolutePath(value.realPath) ||
    !isUnsignedIntegerString(value.device) ||
    !isUnsignedIntegerString(value.inode) ||
    !isNonNegativeSafeInteger(value.mode) ||
    !isNonNegativeSafeInteger(value.uid) ||
    !isNonNegativeSafeInteger(value.gid) ||
    !isNonNegativeSafeInteger(value.size) ||
    !isUnsignedIntegerString(value.mtimeNs) ||
    typeof value.sha256 !== 'string' ||
    !BARE_DIGEST.test(value.sha256)
  ) {
    throw invalidContract();
  }
  return Object.freeze({
    candidatePath: value.candidatePath,
    realPath: value.realPath,
    device: value.device,
    inode: value.inode,
    mode: value.mode,
    uid: value.uid,
    gid: value.gid,
    size: value.size,
    mtimeNs: value.mtimeNs,
    sha256: value.sha256,
  });
}

function normalizeCompletionObservation(
  value: unknown,
): AgentRuntimeCompletionObservationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'observationClass',
      'definitionDigest',
      'executable',
      'providerVersion',
      'assurance',
      'projection',
      'sameUserProcessConfined',
      'residuals',
      'protocolEvidence',
    ]) ||
    !['host-observed', 'synthetic-fixture'].includes(
      String(value.observationClass),
    ) ||
    typeof value.definitionDigest !== 'string' ||
    !BARE_DIGEST.test(value.definitionDigest) ||
    (value.providerVersion !== null &&
      (typeof value.providerVersion !== 'string' ||
        value.providerVersion.length === 0 ||
        value.providerVersion.length > 256)) ||
    value.assurance !== 'unchanged-governed-projection' ||
    value.sameUserProcessConfined !== false ||
    !Array.isArray(value.residuals) ||
    !value.residuals.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= 256 &&
        entry.trim() === entry,
    ) ||
    new Set(value.residuals).size !== value.residuals.length ||
    !isRecord(value.projection) ||
    !hasExactKeys(value.projection, [
      'unchanged',
      'changedCategories',
      'beforeDigest',
      'afterDigest',
    ]) ||
    value.projection.unchanged !== true ||
    !Array.isArray(value.projection.changedCategories) ||
    value.projection.changedCategories.length !== 0 ||
    !isDigest(value.projection.beforeDigest) ||
    value.projection.beforeDigest !== value.projection.afterDigest
  ) {
    throw invalidContract();
  }
  const executable = normalizeExecutableIdentity(value.executable);
  if (executable === null) throw invalidContract();
  const protocolEvidence =
    value.protocolEvidence === null
      ? null
      : normalizeJsonValue(value.protocolEvidence);
  return deepFreeze({
    observationClass: value.observationClass as
      'host-observed' | 'synthetic-fixture',
    definitionDigest: value.definitionDigest,
    executable,
    providerVersion: value.providerVersion as string | null,
    assurance: 'unchanged-governed-projection',
    projection: Object.freeze({
      unchanged: true,
      changedCategories: Object.freeze([]) as readonly [],
      beforeDigest: value.projection.beforeDigest,
      afterDigest: value.projection.afterDigest as string,
    }),
    sameUserProcessConfined: false,
    residuals: Object.freeze([...(value.residuals as string[])]),
    protocolEvidence,
  });
}

function normalizeJsonValue(value: unknown): AgentRuntimeJsonValue {
  try {
    return deepFreeze(
      JSON.parse(canonicalJson(value)) as AgentRuntimeJsonValue,
    );
  } catch {
    throw invalidContract();
  }
}

function domainDigest(domain: string, value: unknown): string {
  return sha256(`${domain}\n${canonicalJson(value)}`);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableNonNegativeSafeInteger(
  value: unknown,
): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  return isPositiveSafeInteger(value) && value <= maximum;
}

function isAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  if (value.startsWith('/')) {
    const root = path.posix.parse(value).root;
    return (
      path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      (!value.endsWith('/') || value === root)
    );
  }
  if (value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) {
    return false;
  }
  if (!path.win32.isAbsolute(value)) return false;
  if (!/^(?:[A-Z]:\\|\\\\[^\\]+\\[^\\]+)/u.test(value)) return false;
  const root = path.win32.parse(value).root;
  return (
    path.win32.normalize(value) === value &&
    (!value.endsWith('\\') || value === root) &&
    !hasUnsafeWindowsPathSegment(value)
  );
}

function hasUnsafeWindowsPathSegment(value: string): boolean {
  const relativeSegments = value.startsWith('\\\\')
    ? value.slice(2).split('\\')
    : value.slice(3).split('\\');
  return relativeSegments.some(isUnsafeWindowsSegment);
}

function isUnsafeWindowsSegment(segment: string): boolean {
  if (segment === '') return false;
  if (/[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) return true;
  const basename = segment.split('.')[0]!.replace(/[ .]+$/u, '');
  return /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(
    basename,
  );
}

function absolutePathStyle(value: string): 'posix' | 'win32' {
  return value.startsWith('/') ? 'posix' : 'win32';
}

function absolutePathIdentity(value: string): string {
  return absolutePathStyle(value) === 'win32' ? value.toLowerCase() : value;
}

function isSameOrDescendantPath(root: string, candidate: string): boolean {
  if (absolutePathStyle(root) !== absolutePathStyle(candidate)) return false;
  const rootIdentity = absolutePathIdentity(root);
  const candidateIdentity = absolutePathIdentity(candidate);
  if (candidateIdentity === rootIdentity) return true;
  const separator = absolutePathStyle(root) === 'win32' ? '\\' : '/';
  return candidateIdentity.startsWith(
    rootIdentity.endsWith(separator)
      ? rootIdentity
      : `${rootIdentity}${separator}`,
  );
}

function isUnsignedIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isPortableRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value
      .split('/')
      .some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) &&
    path.posix.normalize(value) === value
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isSortedUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

function isSortedUniqueDirectoryPaths(
  values: readonly string[],
  parentPath: string,
): boolean {
  const windows = absolutePathStyle(parentPath) === 'win32';
  if (
    windows &&
    values.some((value) => value.split('/').some(isUnsafeWindowsSegment))
  ) {
    return false;
  }
  const identities = values.map((value) =>
    windows ? value.toLowerCase() : value,
  );
  return isSortedUnique(values) && new Set(identities).size === values.length;
}

function isDirectoryPathSubset(
  subset: readonly string[],
  superset: readonly string[],
  parentPath: string,
): boolean {
  const identity = (value: string): string =>
    absolutePathStyle(parentPath) === 'win32' ? value.toLowerCase() : value;
  const expected = new Set(superset.map(identity));
  return subset.every((value) => expected.has(identity(value)));
}

function isPrivateSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 4_096 &&
    value.trim() === value &&
    !hasControlCharacter(value)
  );
}

function invalidContract(): AgentRuntimePortContractError {
  return new AgentRuntimePortContractError();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}
