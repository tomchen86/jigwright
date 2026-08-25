import {
  GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
  GrantEnvelopeVerificationError,
  verifyGrantEnvelopeV1,
  type GrantSignatureVerifierPortV1,
  type VerifiedGrantCapabilityV1,
} from './grant-envelope-verifier.ts';

export const ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1 =
  'jigwright.role-context-sharing-grant-reader.v1' as const;
export const ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1 =
  'workflow.role-context-sharing-grant.v1' as const;
export const ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1 =
  'role-context-sharing-degradation' as const;
export const VERIFIED_ROLE_CONTEXT_SHARING_GRANT_KIND_V1 =
  'jigwright.verified-role-context-sharing-grant.v1' as const;

export const ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1 = Object.freeze([
  'author-builder',
  'author-reviewer',
  'builder-reviewer',
] as const);

export type RoleContextSharingRolePairV1 =
  (typeof ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1)[number];

export type RoleContextSharingGrantPayloadV1 = Readonly<{
  version: 1;
  signatureNamespace: typeof ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  policyBlob: string;
  roleContextSharingPolicyDigest: string;
  centralRoleConfigurationDigest: string;
  changeOverrideDigest: string;
  providerRegistryDigest: string;
  eligibilityPolicyDigest: string;
  changeId: string;
  taskId: string | null;
  baselineCommit: string;
  baselineTree: string;
  targetDigest: string;
  lifecyclePhase: string;
  subjectDigest: string;
  planningGeneration: string;
  rolePairs: readonly RoleContextSharingRolePairV1[];
  contextGeneration: number;
  sessionGeneration: number;
  sharedEngineSessionId: string;
  providerDefinitionDigest: string;
  authorizedEffect: typeof ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  signer: string;
}>;

export type RoleContextSharingGrantEnvelopeV1 = Readonly<{
  payload: RoleContextSharingGrantPayloadV1;
  signature: string;
}>;

export type RoleContextSharingGrantExpectedBindingV1 = Pick<
  RoleContextSharingGrantPayloadV1,
  | 'repositoryId'
  | 'repositoryOrigin'
  | 'policyBlob'
  | 'roleContextSharingPolicyDigest'
  | 'centralRoleConfigurationDigest'
  | 'changeOverrideDigest'
  | 'providerRegistryDigest'
  | 'eligibilityPolicyDigest'
  | 'changeId'
  | 'taskId'
  | 'baselineCommit'
  | 'baselineTree'
  | 'targetDigest'
  | 'lifecyclePhase'
  | 'subjectDigest'
  | 'planningGeneration'
  | 'rolePairs'
  | 'contextGeneration'
  | 'sessionGeneration'
  | 'sharedEngineSessionId'
  | 'providerDefinitionDigest'
  | 'reason'
>;

export type VerifiedRoleContextSharingGrantCapabilityV1 = Readonly<{
  kind: typeof VERIFIED_ROLE_CONTEXT_SHARING_GRANT_KIND_V1;
  envelope: RoleContextSharingGrantEnvelopeV1;
  verification: VerifiedGrantCapabilityV1<
    typeof ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    typeof ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1
  >;
}>;

export type VerifyRoleContextSharingGrantRequestV1 = Readonly<{
  readerContractVersion: string;
  raw: string;
  expected: RoleContextSharingGrantExpectedBindingV1;
  validatePayload(payload: RoleContextSharingGrantPayloadV1): void;
  verifier: GrantSignatureVerifierPortV1;
}>;

export type RoleContextSharingGrantErrorCode =
  | 'ROLE_CONTEXT_SHARING_GRANT_INPUT_INVALID'
  | 'ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_UNSUPPORTED'
  | 'ROLE_CONTEXT_SHARING_GRANT_ENVELOPE_INVALID'
  | 'ROLE_CONTEXT_SHARING_GRANT_PAYLOAD_VERSION_UNSUPPORTED'
  | 'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_UNSUPPORTED'
  | 'ROLE_CONTEXT_SHARING_GRANT_EFFECT_UNSUPPORTED'
  | 'ROLE_CONTEXT_SHARING_GRANT_PAIR_SET_INVALID'
  | 'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH'
  | 'ROLE_CONTEXT_SHARING_GRANT_NON_CANONICAL'
  | 'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID';

export class RoleContextSharingGrantError extends Error {
  readonly code: RoleContextSharingGrantErrorCode;

  constructor(
    code: RoleContextSharingGrantErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RoleContextSharingGrantError';
    this.code = code;
  }
}

const MAX_ENVELOPE_BYTES = 32_768;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANGE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

const PAYLOAD_KEYS = [
  'version',
  'signatureNamespace',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'policyBlob',
  'roleContextSharingPolicyDigest',
  'centralRoleConfigurationDigest',
  'changeOverrideDigest',
  'providerRegistryDigest',
  'eligibilityPolicyDigest',
  'changeId',
  'taskId',
  'baselineCommit',
  'baselineTree',
  'targetDigest',
  'lifecyclePhase',
  'subjectDigest',
  'planningGeneration',
  'rolePairs',
  'contextGeneration',
  'sessionGeneration',
  'sharedEngineSessionId',
  'providerDefinitionDigest',
  'authorizedEffect',
  'reason',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'signer',
] as const;

const BINDING_KEYS = [
  'repositoryId',
  'repositoryOrigin',
  'policyBlob',
  'roleContextSharingPolicyDigest',
  'centralRoleConfigurationDigest',
  'changeOverrideDigest',
  'providerRegistryDigest',
  'eligibilityPolicyDigest',
  'changeId',
  'taskId',
  'baselineCommit',
  'baselineTree',
  'targetDigest',
  'lifecyclePhase',
  'subjectDigest',
  'planningGeneration',
  'rolePairs',
  'contextGeneration',
  'sessionGeneration',
  'sharedEngineSessionId',
  'providerDefinitionDigest',
  'reason',
] as const;

export function canonicalRoleContextSharingGrantPayloadV1(
  input: RoleContextSharingGrantPayloadV1,
): string {
  const payload = assertPayload(input);
  return `${JSON.stringify(projectPayload(payload))}\n`;
}

export function canonicalRoleContextSharingGrantEnvelopeV1(
  input: RoleContextSharingGrantEnvelopeV1,
): string {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['payload', 'signature']) ||
    !isNonEmptyString(input.signature) ||
    input.signature.length > 16_384
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_ENVELOPE_INVALID',
      'Role-context-sharing grant envelope is invalid.',
    );
  }
  const payload = JSON.parse(
    canonicalRoleContextSharingGrantPayloadV1(input.payload),
  ) as RoleContextSharingGrantPayloadV1;
  return `${JSON.stringify({ payload, signature: input.signature })}\n`;
}

export function parseRoleContextSharingGrantEnvelopeV1(
  raw: string,
): RoleContextSharingGrantEnvelopeV1 {
  if (typeof raw !== 'string' || raw.length > MAX_ENVELOPE_BYTES) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_INPUT_INVALID',
      'Role-context-sharing grant input is invalid.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_ENVELOPE_INVALID',
      'Role-context-sharing grant envelope is not valid JSON.',
      cause,
    );
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    !isPlainRecord(value.payload) ||
    !isNonEmptyString(value.signature) ||
    value.signature.length > 16_384
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_ENVELOPE_INVALID',
      'Role-context-sharing grant envelope shape is invalid.',
    );
  }
  const payload = assertPayload(value.payload);
  const envelope = { payload, signature: value.signature };
  if (canonicalRoleContextSharingGrantEnvelopeV1(envelope) !== raw) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_NON_CANONICAL',
      'Role-context-sharing grant envelope bytes are not canonical.',
    );
  }
  return deepFreeze(envelope);
}

export function bindingFromRoleContextSharingGrantPayloadV1(
  payload: RoleContextSharingGrantPayloadV1,
): RoleContextSharingGrantExpectedBindingV1 {
  const valid = assertPayload(payload);
  return deepFreeze(projectBinding(valid));
}

export function verifyRoleContextSharingGrantCapabilityV1(
  request: VerifyRoleContextSharingGrantRequestV1,
): VerifiedRoleContextSharingGrantCapabilityV1 {
  if (
    !isPlainRecord(request) ||
    typeof request.validatePayload !== 'function' ||
    typeof request.verifier?.verify !== 'function'
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_INPUT_INVALID',
      'Role-context-sharing grant verification request is invalid.',
    );
  }
  if (
    request.readerContractVersion !==
    ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_UNSUPPORTED',
      'Role-context-sharing grant reader contract is unsupported.',
    );
  }
  const envelope = parseRoleContextSharingGrantEnvelopeV1(request.raw);
  if (
    canonicalBinding(
      bindingFromRoleContextSharingGrantPayloadV1(envelope.payload),
    ) !== canonicalBinding(request.expected)
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH',
      'Role-context-sharing grant does not match the exact requested binding.',
    );
  }
  request.validatePayload(envelope.payload);
  try {
    const verification = verifyGrantEnvelopeV1({
      contractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
      canonicalPayload: canonicalRoleContextSharingGrantPayloadV1(
        envelope.payload,
      ),
      signature: envelope.signature,
      signer: envelope.payload.signer,
      signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
      authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
      allowedSignatureNamespaces: [
        ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
      ],
      allowedAuthorizedEffects: [ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1],
      verifier: request.verifier,
    });
    return deepFreeze({
      kind: VERIFIED_ROLE_CONTEXT_SHARING_GRANT_KIND_V1,
      envelope,
      verification,
    });
  } catch (cause) {
    if (
      cause instanceof GrantEnvelopeVerificationError &&
      cause.code === 'GRANT_SIGNATURE_INVALID'
    ) {
      throw roleContextError(
        'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID',
        'Role-context-sharing grant signature is invalid.',
        cause,
      );
    }
    throw cause;
  }
}

function assertPayload(value: unknown): RoleContextSharingGrantPayloadV1 {
  if (!isPlainRecord(value)) {
    throw invalidEnvelope();
  }
  if (value.version !== 1) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_PAYLOAD_VERSION_UNSUPPORTED',
      'Role-context-sharing grant payload version is unsupported.',
    );
  }
  if (
    value.signatureNamespace !==
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_UNSUPPORTED',
      'Role-context-sharing grant signature namespace is unsupported.',
    );
  }
  if (value.authorizedEffect !== ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_EFFECT_UNSUPPORTED',
      'Role-context-sharing grant authorized effect is unsupported.',
    );
  }
  if (!hasExactKeys(value, PAYLOAD_KEYS)) {
    throw invalidEnvelope();
  }
  assertCanonicalRolePairs(value.rolePairs);
  if (
    !isNonEmptyString(value.repositoryId) ||
    !isNonEmptyString(value.repositoryOrigin) ||
    !FULL_OID.test(asString(value.policyBlob)) ||
    !isDigest(value.roleContextSharingPolicyDigest) ||
    !isDigest(value.centralRoleConfigurationDigest) ||
    !isDigest(value.changeOverrideDigest) ||
    !isDigest(value.providerRegistryDigest) ||
    !isDigest(value.eligibilityPolicyDigest) ||
    !UUID_V4.test(asString(value.grantId)) ||
    !CHANGE_ID.test(asString(value.changeId)) ||
    (value.taskId !== null && !SAFE_ID.test(asString(value.taskId))) ||
    !FULL_OID.test(asString(value.baselineCommit)) ||
    !FULL_OID.test(asString(value.baselineTree)) ||
    !isDigest(value.targetDigest) ||
    !SAFE_ID.test(asString(value.lifecyclePhase)) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.planningGeneration) ||
    !isPositiveInteger(value.contextGeneration) ||
    !isPositiveInteger(value.sessionGeneration) ||
    !SAFE_ID.test(asString(value.sharedEngineSessionId)) ||
    !isDigest(value.providerDefinitionDigest) ||
    !isBoundedString(value.reason, 12, 1000) ||
    !isExactTimestamp(value.issuedAt) ||
    !isExactTimestamp(value.expiresAt) ||
    value.maxUses !== 1 ||
    !SAFE_ID.test(asString(value.signer))
  ) {
    throw invalidEnvelope();
  }
  return deepFreeze(projectPayload(value as RoleContextSharingGrantPayloadV1));
}

function canonicalBinding(
  value: RoleContextSharingGrantExpectedBindingV1,
): string {
  if (!isPlainRecord(value) || !hasExactKeys(value, BINDING_KEYS)) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_INPUT_INVALID',
      'Role-context-sharing expected binding is invalid.',
    );
  }
  const projected = projectBinding(
    value as RoleContextSharingGrantExpectedBindingV1,
  );
  const synthetic = {
    version: 1 as const,
    signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ...projected,
    authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    issuedAt: '2000-01-01T00:00:00.000Z',
    expiresAt: '2000-01-01T00:00:00.000Z',
    maxUses: 1 as const,
    signer: 'binding-validator',
  };
  assertPayload(synthetic);
  return JSON.stringify(projected);
}

function projectPayload(
  value: RoleContextSharingGrantPayloadV1,
): RoleContextSharingGrantPayloadV1 {
  return {
    version: 1,
    signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    grantId: value.grantId,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    policyBlob: value.policyBlob,
    roleContextSharingPolicyDigest: value.roleContextSharingPolicyDigest,
    centralRoleConfigurationDigest: value.centralRoleConfigurationDigest,
    changeOverrideDigest: value.changeOverrideDigest,
    providerRegistryDigest: value.providerRegistryDigest,
    eligibilityPolicyDigest: value.eligibilityPolicyDigest,
    changeId: value.changeId,
    taskId: value.taskId,
    baselineCommit: value.baselineCommit,
    baselineTree: value.baselineTree,
    targetDigest: value.targetDigest,
    lifecyclePhase: value.lifecyclePhase,
    subjectDigest: value.subjectDigest,
    planningGeneration: value.planningGeneration,
    rolePairs: [...value.rolePairs],
    contextGeneration: value.contextGeneration,
    sessionGeneration: value.sessionGeneration,
    sharedEngineSessionId: value.sharedEngineSessionId,
    providerDefinitionDigest: value.providerDefinitionDigest,
    authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    reason: value.reason,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    maxUses: 1,
    signer: value.signer,
  };
}

function projectBinding(
  value: RoleContextSharingGrantExpectedBindingV1,
): RoleContextSharingGrantExpectedBindingV1 {
  return {
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    policyBlob: value.policyBlob,
    roleContextSharingPolicyDigest: value.roleContextSharingPolicyDigest,
    centralRoleConfigurationDigest: value.centralRoleConfigurationDigest,
    changeOverrideDigest: value.changeOverrideDigest,
    providerRegistryDigest: value.providerRegistryDigest,
    eligibilityPolicyDigest: value.eligibilityPolicyDigest,
    changeId: value.changeId,
    taskId: value.taskId,
    baselineCommit: value.baselineCommit,
    baselineTree: value.baselineTree,
    targetDigest: value.targetDigest,
    lifecyclePhase: value.lifecyclePhase,
    subjectDigest: value.subjectDigest,
    planningGeneration: value.planningGeneration,
    rolePairs: [...value.rolePairs],
    contextGeneration: value.contextGeneration,
    sessionGeneration: value.sessionGeneration,
    sharedEngineSessionId: value.sharedEngineSessionId,
    providerDefinitionDigest: value.providerDefinitionDigest,
    reason: value.reason,
  };
}

function assertCanonicalRolePairs(
  value: unknown,
): asserts value is readonly RoleContextSharingRolePairV1[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1.length ||
    value.some(
      (pair) =>
        typeof pair !== 'string' ||
        !ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1.includes(
          pair as RoleContextSharingRolePairV1,
        ),
    ) ||
    new Set(value).size !== value.length ||
    value.some(
      (pair, index) =>
        pair !==
        ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1.filter((candidate) =>
          value.includes(candidate),
        )[index],
    )
  ) {
    throw roleContextError(
      'ROLE_CONTEXT_SHARING_GRANT_PAIR_SET_INVALID',
      'Role-context-sharing role pairs must be nonempty, unique, and canonical.',
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function invalidEnvelope(): RoleContextSharingGrantError {
  return roleContextError(
    'ROLE_CONTEXT_SHARING_GRANT_ENVELOPE_INVALID',
    'Role-context-sharing grant payload is invalid.',
  );
}

function roleContextError(
  code: RoleContextSharingGrantErrorCode,
  message: string,
  cause?: unknown,
): RoleContextSharingGrantError {
  return new RoleContextSharingGrantError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
