/**
 * Defines public Central Grant contracts and validates canonical challenge,
 * approval and record documents.
 *
 * Invariants:
 * - Record bytes must exactly equal canonical JSON plus a newline, and
 *   terminal outcomes must agree with record state.
 */

import crypto from 'node:crypto';

import { canonicalJson } from '@jigwright/core/canonical-json';
import type {
  CentralGrantChallengeV1 as CoreCentralGrantChallengeV1,
  CentralGrantChoiceV1 as CoreCentralGrantChoiceV1,
  CentralGrantDigest,
} from '@jigwright/core/central-grant-port';

export type {
  CentralGrantChallengePortV1,
  CentralGrantChallengeRefV1,
  CentralGrantCompletedAuthorityRefV1,
  CentralGrantDigest,
  CentralGrantRequestInputV1,
  CentralGrantRequestPortV1,
  CentralGrantStateBindingV1,
  CentralGrantTransitionCandidateV1,
  CentralGrantTransitionDefinitionPortV1,
  CentralGrantTransitionRegistryPortV1,
} from '@jigwright/core/central-grant-port';

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_NONCE = /^[A-Za-z0-9._:-]{16,256}$/;
const MODULE_VERSION = /^[1-9][0-9]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const MODULE_IDENTITY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/;
const MAX_CHALLENGE_TTL_MS = 30 * 60_000;
const MAX_REASON_LENGTH = 2048;
const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_PORTABLE_PAYLOAD_BYTES = 65_536;
const MAX_SIGNATURE_BYTES = 16_384;
const SIGNATURE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const CENTRAL_GRANT_PUBLIC_CONTRACT_VERSION =
  'jigwright.central-grant.public.v1' as const;
export const CENTRAL_GRANT_CHALLENGE_KIND = 'grant-challenge.v1' as const;
export const CENTRAL_GRANT_APPROVAL_SUBJECT_KIND =
  'grant-approval-subject.v1' as const;
export const CENTRAL_GRANT_RECORD_KIND = 'grant-record.v1' as const;

export const APPROVAL_CLAIMS = [
  'fresh-local-device-owner',
  'ssh-signature',
] as const;

export type ApprovalClaim = (typeof APPROVAL_CLAIMS)[number];
export type CentralGrantApprovalMethod = 'human-presence' | 'ssh';
export type CentralGrantChoiceV1 =
  CoreCentralGrantChoiceV1<CentralGrantApprovalMethod>;
export type CentralGrantChallengeV1<TFacts = unknown> =
  CoreCentralGrantChallengeV1<TFacts, CentralGrantApprovalMethod>;

export type CentralGrantApprovalSubjectV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof CENTRAL_GRANT_APPROVAL_SUBJECT_KIND;
  challengeDigest: CentralGrantDigest;
  choiceId: CentralGrantDigest;
  approvalMethod: CentralGrantApprovalMethod;
  reasonCode: string;
  reason: string;
  reasonDigest: CentralGrantDigest;
  stateDigest: CentralGrantDigest;
  expiresAt: string;
  sessionNonce: string;
}>;

/** Public policy bytes intentionally match the already-landed live V2 type. */
export type GrantPolicyV2 = Readonly<{
  schemaVersion: 2;
  defaultProfile: 'local-presence';
  profiles: Readonly<
    Record<string, Readonly<{ requiredClaims: readonly ApprovalClaim[] }>>
  >;
  approvalModules: readonly Readonly<{
    moduleId: string;
    version: string;
    allowedClaims: readonly ApprovalClaim[];
    configurationDigest: CentralGrantDigest;
  }>[];
  optionalSsh?: Readonly<{
    signatureNamespace: string;
    trustedSigners: readonly Readonly<{
      identity: string;
      publicKey: string;
      fingerprint: string;
    }>[];
  }>;
}>;

export type CentralGrantProofModuleSummaryV1 = Readonly<{
  moduleId: string;
  version: string;
  claim: ApprovalClaim;
  proofDigest: CentralGrantDigest;
  identity: string | null;
  portableEvidence: CentralGrantSshPortableApprovalEvidenceV1 | null;
}>;

export type CentralGrantSshPortableApprovalEvidenceV1 = Readonly<{
  schemaVersion: 1;
  kind: 'grant-proof-ssh-portable-evidence.v1';
  payload: string;
  signature: string;
  signatureNamespace: string;
  identity: string;
  verifiedAt: string;
}>;

export type CentralGrantAuditRecordV1 = Readonly<{
  approvalMethod: CentralGrantApprovalMethod;
  authorityClass: 'local-device-owner' | 'ssh-credential';
  identity: string | null;
  identityAssurance: 'not-asserted' | 'policy-trusted-ssh-key';
  presenceAssurance: 'fresh-os-authentication' | 'not-asserted';
  proofModules: readonly string[];
}>;

export type CentralGrantTransitionOutcomeV1 = Readonly<{
  outcome: 'completed' | 'failed';
  details: unknown;
}>;

type CanonicalGrantRecordBaseV1<TState extends string> = Readonly<{
  schemaVersion: 1;
  kind: typeof CENTRAL_GRANT_RECORD_KIND;
  state: TState;
  challenge: CentralGrantChallengeV1;
  recordedAt: string;
}>;

export type PendingCanonicalGrantRecordV1 =
  CanonicalGrantRecordBaseV1<'pending'>;

export type PreparedCanonicalGrantRecordV1 =
  CanonicalGrantRecordBaseV1<'prepared'> &
    Readonly<{
      operationId: string;
      approvalSubject: CentralGrantApprovalSubjectV1;
      proofModules: readonly CentralGrantProofModuleSummaryV1[];
      preparedAt: string;
    }>;

export type TerminalCanonicalGrantRecordV1 = Omit<
  PreparedCanonicalGrantRecordV1,
  'state'
> &
  Readonly<{
    state: 'completed' | 'failed';
    poststateDigest: CentralGrantDigest;
    outcome: CentralGrantTransitionOutcomeV1;
    completedAt: string;
    audit: CentralGrantAuditRecordV1;
  }>;

export type CanonicalGrantRecordV1 =
  | PendingCanonicalGrantRecordV1
  | PreparedCanonicalGrantRecordV1
  | TerminalCanonicalGrantRecordV1;

export type CentralGrantProofModulePortV1 = Readonly<{
  contractVersion: 'grant-proof-module.v1';
  moduleId: string;
  version: string;
  allowedClaims: readonly ApprovalClaim[];
  configurationDigest: CentralGrantDigest;
  verify(
    subject: CentralGrantApprovalSubjectV1,
    proof: unknown,
  ): Readonly<{ claim: ApprovalClaim; proofDigest: CentralGrantDigest }>;
}>;

/** Parse the exact canonical newline-terminated bytes persisted by GrantStore. */
export function parseCanonicalGrantRecordV1(
  document: string,
): CanonicalGrantRecordV1 {
  if (
    typeof document !== 'string' ||
    Buffer.byteLength(document) > MAX_DOCUMENT_BYTES
  ) {
    throw invalidDocument();
  }
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch {
    throw invalidDocument();
  }
  const record = assertCanonicalGrantRecordV1(value);
  if (document !== `${canonicalJson(record)}\n`) throw invalidDocument();
  return record;
}

export function assertCanonicalGrantRecordV1(
  value: unknown,
): CanonicalGrantRecordV1 {
  if (!isRecord(value) || typeof value.state !== 'string') {
    throw invalidDocument();
  }
  const state = value.state;
  const preparedKeys = [
    'operationId',
    'approvalSubject',
    'proofModules',
    'preparedAt',
  ];
  const terminalKeys = ['poststateDigest', 'outcome', 'completedAt', 'audit'];
  const extraKeys =
    state === 'pending'
      ? []
      : state === 'prepared'
        ? preparedKeys
        : state === 'completed' || state === 'failed'
          ? [...preparedKeys, ...terminalKeys]
          : null;
  if (
    extraKeys === null ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'state',
      'challenge',
      'recordedAt',
      ...extraKeys,
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== CENTRAL_GRANT_RECORD_KIND ||
    typeof value.recordedAt !== 'string'
  ) {
    throw invalidDocument();
  }
  const challenge = assertChallenge(value.challenge);
  if (value.recordedAt !== challenge.issuedAt) throw invalidDocument();
  const base = {
    schemaVersion: 1 as const,
    kind: CENTRAL_GRANT_RECORD_KIND,
    state: 'pending' as const,
    challenge,
    recordedAt: challenge.issuedAt,
  };
  if (state === 'pending') return freezeCanonical(base);

  const prepared = assertPreparedFields(value, base);
  if (state === 'prepared') return prepared;
  if (
    typeof value.poststateDigest !== 'string' ||
    !SHA256_DIGEST.test(value.poststateDigest) ||
    typeof value.completedAt !== 'string'
  ) {
    throw invalidDocument();
  }
  const completedAt = exactTimestamp(value.completedAt);
  if (completedAt.getTime() < exactTimestamp(prepared.preparedAt).getTime()) {
    throw invalidDocument();
  }
  const outcome = assertOutcome(value.outcome);
  if (outcome.outcome !== state) throw invalidDocument();
  return freezeCanonical({
    ...prepared,
    state,
    poststateDigest: value.poststateDigest as CentralGrantDigest,
    outcome,
    completedAt: completedAt.toISOString(),
    audit: assertAudit(value.audit, prepared),
  }) as TerminalCanonicalGrantRecordV1;
}

export function assertCentralGrantPublicDocumentV1(
  value: unknown,
):
  | CentralGrantChallengeV1
  | CentralGrantApprovalSubjectV1
  | CanonicalGrantRecordV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Central Grant public schema version is unsupported.');
  }
  if (value.kind === CENTRAL_GRANT_CHALLENGE_KIND) {
    return assertChallenge(value);
  }
  if (value.kind === CENTRAL_GRANT_APPROVAL_SUBJECT_KIND) {
    return assertApprovalSubject(value);
  }
  if (value.kind === CENTRAL_GRANT_RECORD_KIND) {
    return assertCanonicalGrantRecordV1(value);
  }
  throw new Error('Central Grant public document kind is unsupported.');
}

function assertPreparedFields(
  value: Record<string, unknown>,
  base: PendingCanonicalGrantRecordV1,
): PreparedCanonicalGrantRecordV1 {
  if (
    typeof value.operationId !== 'string' ||
    !UUID_V4.test(value.operationId) ||
    !Array.isArray(value.proofModules) ||
    typeof value.preparedAt !== 'string'
  ) {
    throw invalidDocument();
  }
  const approvalSubject = assertSubjectForChallenge(
    base.challenge,
    value.approvalSubject,
  );
  const proofModules = assertProofModules(value.proofModules, approvalSubject);
  assertProofMethod(approvalSubject, proofModules);
  const preparedAt = exactTimestamp(value.preparedAt);
  const issuedAt = exactTimestamp(base.challenge.issuedAt);
  const expiresAt = exactTimestamp(base.challenge.expiresAt);
  if (
    preparedAt.getTime() < issuedAt.getTime() ||
    preparedAt.getTime() > expiresAt.getTime()
  ) {
    throw invalidDocument();
  }
  return freezeCanonical({
    ...base,
    state: 'prepared' as const,
    operationId: value.operationId,
    approvalSubject,
    proofModules,
    preparedAt: preparedAt.toISOString(),
  });
}

function assertChallenge(value: unknown): CentralGrantChallengeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'challengeId',
      'sourceModuleId',
      'failureCode',
      'facts',
      'factsDigest',
      'stateBinding',
      'choices',
      'issuedAt',
      'expiresAt',
      'challengeDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== CENTRAL_GRANT_CHALLENGE_KIND ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.sourceModuleId !== 'string' ||
    !STABLE_ID.test(value.sourceModuleId) ||
    typeof value.failureCode !== 'string' ||
    !STABLE_ID.test(value.failureCode) ||
    typeof value.factsDigest !== 'string' ||
    !SHA256_DIGEST.test(value.factsDigest) ||
    !isRecord(value.stateBinding) ||
    !hasExactKeys(value.stateBinding, ['kind', 'digest']) ||
    typeof value.stateBinding.kind !== 'string' ||
    !STABLE_ID.test(value.stateBinding.kind) ||
    typeof value.stateBinding.digest !== 'string' ||
    !SHA256_DIGEST.test(value.stateBinding.digest) ||
    !Array.isArray(value.choices) ||
    value.choices.length < 1 ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.challengeDigest !== 'string' ||
    !SHA256_DIGEST.test(value.challengeDigest)
  ) {
    throw invalidDocument();
  }
  const issuedAt = exactTimestamp(value.issuedAt);
  const expiresAt = exactTimestamp(value.expiresAt);
  if (
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > MAX_CHALLENGE_TTL_MS
  ) {
    throw invalidDocument();
  }
  const facts = freezeCanonical(value.facts);
  if (sha256(canonicalJson(facts)) !== value.factsDigest) {
    throw invalidDocument();
  }
  const choices = value.choices.map(assertChoice);
  if (
    new Set(choices.map(({ choiceId }) => choiceId)).size !== choices.length ||
    !choices.some(({ resolutionKind }) => resolutionKind === 'non-retry')
  ) {
    throw invalidDocument();
  }
  const payload = {
    schemaVersion: 1 as const,
    kind: CENTRAL_GRANT_CHALLENGE_KIND,
    challengeId: value.challengeId,
    sourceModuleId: value.sourceModuleId,
    failureCode: value.failureCode,
    facts,
    factsDigest: value.factsDigest as CentralGrantDigest,
    stateBinding: freezeCanonical({
      kind: value.stateBinding.kind,
      digest: value.stateBinding.digest as CentralGrantDigest,
    }),
    choices,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  if (sha256(canonicalJson(payload)) !== value.challengeDigest) {
    throw invalidDocument();
  }
  return freezeCanonical({
    ...payload,
    challengeDigest: value.challengeDigest as CentralGrantDigest,
  });
}

function assertChoice(value: unknown): CentralGrantChoiceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'choiceId',
      'transitionId',
      'parameters',
      'parameterDigest',
      'parameterSchemaDigest',
      'consequenceDigest',
      'resolutionKind',
      'allowedApprovalMethods',
      'allowedReasonCodes',
      'reasonRequired',
      'proposedReason',
    ]) ||
    typeof value.choiceId !== 'string' ||
    !SHA256_DIGEST.test(value.choiceId) ||
    typeof value.transitionId !== 'string' ||
    !STABLE_ID.test(value.transitionId) ||
    typeof value.parameterDigest !== 'string' ||
    !SHA256_DIGEST.test(value.parameterDigest) ||
    typeof value.parameterSchemaDigest !== 'string' ||
    !SHA256_DIGEST.test(value.parameterSchemaDigest) ||
    typeof value.consequenceDigest !== 'string' ||
    !SHA256_DIGEST.test(value.consequenceDigest) ||
    (value.resolutionKind !== 'retry' &&
      value.resolutionKind !== 'non-retry') ||
    !hasCanonicalApprovalMethods(value.allowedApprovalMethods) ||
    !Array.isArray(value.allowedReasonCodes) ||
    value.allowedReasonCodes.length < 1 ||
    !value.allowedReasonCodes.every(
      (reasonCode) =>
        typeof reasonCode === 'string' && STABLE_ID.test(reasonCode),
    ) ||
    new Set(value.allowedReasonCodes).size !==
      value.allowedReasonCodes.length ||
    typeof value.reasonRequired !== 'boolean' ||
    typeof value.proposedReason !== 'string'
  ) {
    throw invalidDocument();
  }
  const parameters = freezeCanonical(value.parameters);
  if (sha256(canonicalJson(parameters)) !== value.parameterDigest) {
    throw invalidDocument();
  }
  const proposedReason = canonicalReason(value.proposedReason, true);
  const payload = {
    transitionId: value.transitionId,
    parameters,
    parameterDigest: value.parameterDigest as CentralGrantDigest,
    parameterSchemaDigest: value.parameterSchemaDigest as CentralGrantDigest,
    consequenceDigest: value.consequenceDigest as CentralGrantDigest,
    resolutionKind: value.resolutionKind as 'retry' | 'non-retry',
    allowedApprovalMethods: Object.freeze([
      ...value.allowedApprovalMethods,
    ]) as readonly CentralGrantApprovalMethod[],
    allowedReasonCodes: Object.freeze([
      ...value.allowedReasonCodes,
    ]) as readonly string[],
    reasonRequired: value.reasonRequired,
    proposedReason,
  };
  if (sha256(canonicalJson(payload)) !== value.choiceId) {
    throw invalidDocument();
  }
  return freezeCanonical({
    choiceId: value.choiceId as CentralGrantDigest,
    ...payload,
  });
}

function assertApprovalSubject(value: unknown): CentralGrantApprovalSubjectV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'challengeDigest',
      'choiceId',
      'approvalMethod',
      'reasonCode',
      'reason',
      'reasonDigest',
      'stateDigest',
      'expiresAt',
      'sessionNonce',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== CENTRAL_GRANT_APPROVAL_SUBJECT_KIND ||
    typeof value.challengeDigest !== 'string' ||
    !SHA256_DIGEST.test(value.challengeDigest) ||
    typeof value.choiceId !== 'string' ||
    !SHA256_DIGEST.test(value.choiceId) ||
    (value.approvalMethod !== 'human-presence' &&
      value.approvalMethod !== 'ssh') ||
    typeof value.reasonCode !== 'string' ||
    !STABLE_ID.test(value.reasonCode) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length > MAX_REASON_LENGTH ||
    /[\0\r]/u.test(value.reason) ||
    typeof value.reasonDigest !== 'string' ||
    !SHA256_DIGEST.test(value.reasonDigest) ||
    sha256(canonicalJson(value.reason)) !== value.reasonDigest ||
    typeof value.stateDigest !== 'string' ||
    !SHA256_DIGEST.test(value.stateDigest) ||
    typeof value.expiresAt !== 'string' ||
    typeof value.sessionNonce !== 'string' ||
    !SESSION_NONCE.test(value.sessionNonce)
  ) {
    throw invalidDocument();
  }
  const expiresAt = exactTimestamp(value.expiresAt);
  return freezeCanonical({
    schemaVersion: 1 as const,
    kind: CENTRAL_GRANT_APPROVAL_SUBJECT_KIND,
    challengeDigest: value.challengeDigest as CentralGrantDigest,
    choiceId: value.choiceId as CentralGrantDigest,
    approvalMethod: value.approvalMethod,
    reasonCode: value.reasonCode,
    reason: value.reason,
    reasonDigest: value.reasonDigest as CentralGrantDigest,
    stateDigest: value.stateDigest as CentralGrantDigest,
    expiresAt: expiresAt.toISOString(),
    sessionNonce: value.sessionNonce,
  });
}

function assertSubjectForChallenge(
  challenge: CentralGrantChallengeV1,
  value: unknown,
): CentralGrantApprovalSubjectV1 {
  const subject = assertApprovalSubject(value);
  const choice = challenge.choices.find(
    ({ choiceId }) => choiceId === subject.choiceId,
  );
  if (
    subject.challengeDigest !== challenge.challengeDigest ||
    choice === undefined ||
    !choice.allowedApprovalMethods.includes(subject.approvalMethod) ||
    !choice.allowedReasonCodes.includes(subject.reasonCode) ||
    (choice.reasonRequired && subject.reason.length < 1) ||
    subject.stateDigest !== challenge.stateBinding.digest ||
    subject.expiresAt !== challenge.expiresAt
  ) {
    throw invalidDocument();
  }
  return subject;
}

function assertProofModules(
  value: unknown[],
  subject: CentralGrantApprovalSubjectV1,
): readonly CentralGrantProofModuleSummaryV1[] {
  if (value.length < 1) throw invalidDocument();
  const identities = new Set<string>();
  return freezeCanonical(
    value.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, [
          'moduleId',
          'version',
          'claim',
          'proofDigest',
          'identity',
          'portableEvidence',
        ]) ||
        typeof candidate.moduleId !== 'string' ||
        !STABLE_ID.test(candidate.moduleId) ||
        typeof candidate.version !== 'string' ||
        !MODULE_VERSION.test(candidate.version) ||
        !APPROVAL_CLAIMS.includes(candidate.claim as ApprovalClaim) ||
        typeof candidate.proofDigest !== 'string' ||
        !SHA256_DIGEST.test(candidate.proofDigest) ||
        !(
          candidate.identity === null ||
          (typeof candidate.identity === 'string' &&
            IDENTITY.test(candidate.identity))
        )
      ) {
        throw invalidDocument();
      }
      const identity = `${candidate.moduleId}@${candidate.version}:${candidate.claim}`;
      if (identities.has(identity)) throw invalidDocument();
      identities.add(identity);
      const portableEvidence =
        candidate.portableEvidence === null
          ? null
          : assertSshPortableApprovalEvidence(candidate.portableEvidence);
      const isSshProof =
        candidate.moduleId === 'grant-proof-ssh' &&
        candidate.version === '1' &&
        candidate.claim === 'ssh-signature';
      if (
        isSshProof
          ? portableEvidence === null ||
            candidate.identity !== portableEvidence.identity ||
            candidate.proofDigest !== sha256(canonicalJson(portableEvidence)) ||
            sha256(canonicalJson(subject)) !==
              portableEvidenceApprovalSubjectDigest(portableEvidence)
          : portableEvidence !== null
      ) {
        throw invalidDocument();
      }
      return {
        moduleId: candidate.moduleId,
        version: candidate.version,
        claim: candidate.claim as ApprovalClaim,
        proofDigest: candidate.proofDigest as CentralGrantDigest,
        identity: candidate.identity,
        portableEvidence,
      };
    }),
  );
}

function assertProofMethod(
  subject: CentralGrantApprovalSubjectV1,
  proofs: readonly CentralGrantProofModuleSummaryV1[],
): void {
  if (proofs.length !== 1) throw invalidDocument();
  const proof = proofs[0]!;
  if (
    subject.approvalMethod === 'human-presence'
      ? proof.claim !== 'fresh-local-device-owner' ||
        proof.identity !== null ||
        proof.portableEvidence !== null
      : proof.moduleId !== 'grant-proof-ssh' ||
        proof.version !== '1' ||
        proof.claim !== 'ssh-signature' ||
        typeof proof.identity !== 'string' ||
        proof.portableEvidence === null
  ) {
    throw invalidDocument();
  }
}

function assertSshPortableApprovalEvidence(
  value: unknown,
): CentralGrantSshPortableApprovalEvidenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'payload',
      'signature',
      'signatureNamespace',
      'identity',
      'verifiedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'grant-proof-ssh-portable-evidence.v1' ||
    typeof value.payload !== 'string' ||
    Buffer.byteLength(value.payload) > MAX_PORTABLE_PAYLOAD_BYTES ||
    typeof value.signature !== 'string' ||
    Buffer.byteLength(value.signature) < 1 ||
    Buffer.byteLength(value.signature) > MAX_SIGNATURE_BYTES ||
    /[\0\r]/u.test(value.signature) ||
    typeof value.signatureNamespace !== 'string' ||
    !SIGNATURE_NAMESPACE.test(value.signatureNamespace) ||
    typeof value.identity !== 'string' ||
    !IDENTITY.test(value.identity) ||
    typeof value.verifiedAt !== 'string'
  ) {
    throw invalidDocument();
  }
  exactTimestamp(value.verifiedAt);
  let payload: unknown;
  try {
    payload = JSON.parse(value.payload) as unknown;
  } catch {
    throw invalidDocument();
  }
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      'schemaVersion',
      'kind',
      'approvalSubject',
      'approvalSubjectDigest',
      'signerIdentity',
    ]) ||
    payload.schemaVersion !== 1 ||
    payload.kind !== 'grant-proof-ssh-subject.v1' ||
    typeof payload.approvalSubjectDigest !== 'string' ||
    !SHA256_DIGEST.test(payload.approvalSubjectDigest) ||
    typeof payload.signerIdentity !== 'string' ||
    payload.signerIdentity !== value.identity
  ) {
    throw invalidDocument();
  }
  const subject = assertApprovalSubject(payload.approvalSubject);
  if (
    subject.approvalMethod !== 'ssh' ||
    sha256(canonicalJson(subject)) !== payload.approvalSubjectDigest ||
    value.payload !==
      canonicalJson({
        schemaVersion: 1,
        kind: 'grant-proof-ssh-subject.v1',
        approvalSubject: subject,
        approvalSubjectDigest: payload.approvalSubjectDigest,
        signerIdentity: payload.signerIdentity,
      })
  ) {
    throw invalidDocument();
  }
  return freezeCanonical({
    schemaVersion: 1,
    kind: 'grant-proof-ssh-portable-evidence.v1',
    payload: value.payload,
    signature: value.signature,
    signatureNamespace: value.signatureNamespace,
    identity: value.identity,
    verifiedAt: value.verifiedAt,
  });
}

function portableEvidenceApprovalSubjectDigest(
  value: CentralGrantSshPortableApprovalEvidenceV1,
): CentralGrantDigest {
  const payload = JSON.parse(value.payload) as {
    approvalSubjectDigest: CentralGrantDigest;
  };
  return payload.approvalSubjectDigest;
}

function hasCanonicalApprovalMethods(
  value: unknown,
): value is readonly CentralGrantApprovalMethod[] {
  return (
    Array.isArray(value) &&
    (value.length === 1 || value.length === 2) &&
    value.every((method) => method === 'human-presence' || method === 'ssh') &&
    new Set(value).size === value.length &&
    (value.length === 1 ||
      (value[0] === 'human-presence' && value[1] === 'ssh'))
  );
}

function assertOutcome(value: unknown): CentralGrantTransitionOutcomeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['outcome', 'details']) ||
    (value.outcome !== 'completed' && value.outcome !== 'failed')
  ) {
    throw invalidDocument();
  }
  return freezeCanonical({ outcome: value.outcome, details: value.details });
}

function assertAudit(
  value: unknown,
  prepared: PreparedCanonicalGrantRecordV1,
): CentralGrantAuditRecordV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'approvalMethod',
      'authorityClass',
      'identity',
      'identityAssurance',
      'presenceAssurance',
      'proofModules',
    ]) ||
    value.approvalMethod !== prepared.approvalSubject.approvalMethod ||
    !Array.isArray(value.proofModules) ||
    !value.proofModules.every(
      (module) => typeof module === 'string' && MODULE_IDENTITY.test(module),
    ) ||
    !sameStrings(
      value.proofModules,
      prepared.proofModules.map(
        ({ moduleId, version }) => `${moduleId}@${version}`,
      ),
    ) ||
    !auditMatchesMethod(value, prepared)
  ) {
    throw invalidDocument();
  }
  return freezeCanonical(value) as unknown as CentralGrantAuditRecordV1;
}

function auditMatchesMethod(
  value: Record<string, unknown>,
  prepared: PreparedCanonicalGrantRecordV1,
): boolean {
  if (value.approvalMethod === 'human-presence') {
    return (
      value.authorityClass === 'local-device-owner' &&
      value.identity === null &&
      value.identityAssurance === 'not-asserted' &&
      value.presenceAssurance === 'fresh-os-authentication'
    );
  }
  const sshIdentity = prepared.proofModules[0]?.identity;
  return (
    value.approvalMethod === 'ssh' &&
    value.authorityClass === 'ssh-credential' &&
    typeof value.identity === 'string' &&
    value.identity === sshIdentity &&
    IDENTITY.test(value.identity) &&
    value.identityAssurance === 'policy-trusted-ssh-key' &&
    value.presenceAssurance === 'not-asserted'
  );
}

function exactTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidDocument();
  }
  return parsed;
}

function canonicalReason(value: string, required: boolean): string {
  const normalized = value.trim();
  if (
    (required && normalized.length < 1) ||
    normalized !== value ||
    normalized.length > MAX_REASON_LENGTH ||
    /[\0\r]/u.test(normalized)
  ) {
    throw invalidDocument();
  }
  return normalized;
}

function freezeCanonical<T>(value: T): T {
  let cloned: T;
  try {
    cloned = JSON.parse(canonicalJson(value)) as T;
  } catch {
    throw invalidDocument();
  }
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function sha256(value: string): CentralGrantDigest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return sameStrings(Object.keys(value), expected);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((entry, index) => entry === sortedRight[index])
  );
}

function invalidDocument(): Error {
  return new Error('Central Grant public document is malformed.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
