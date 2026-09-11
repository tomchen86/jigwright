/**
 * Encodes quarantine Grants, markers, receipts and record chains for
 * recovery state.
 *
 * Invariants:
 * - A quarantine grant's grantId is content-addressed as
 *   quarantine-<enter|release>-<digest of the canonical id-less payload>
 *   and is re-derived and checked on normalize.
 * - A quarantine grant's lifetime must be positive and at most
 *   RECOVERY_QUARANTINE_GRANT_TTL_MS (five minutes).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { HumanSignatureVerifier as PersistenceHumanSignatureVerifier } from './intervention-control-values.ts';
import type {
  RecoveryAuthoritySha256Digest,
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
} from './recovery-authority-contract.ts';

export const RECOVERY_QUARANTINE_ENTER_NAMESPACE =
  'HARNESS_RECOVERY_ENTER_QUARANTINE_V1';

export const RECOVERY_QUARANTINE_RELEASE_NAMESPACE =
  'HARNESS_RECOVERY_RELEASE_QUARANTINE_V1';

export const RECOVERY_QUARANTINE_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Substrate only: these APIs persist signed quarantine state, but no production
 * launcher currently reads the marker and this module therefore does not by
 * itself fence workflow execution.
 */
export const PRIVATE_DIRECTORY_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

export const MAX_RECORD_BYTES = 1024 * 1024;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const GRANT_ID = /^quarantine-(?:enter|release)-[0-9a-f]{64}$/;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@+:/-]{0,511}$/;

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export const TEMPORARY =
  /^\.([a-z0-9][a-z0-9-]*\.json)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;

export interface RecoveryQuarantineCommonBinding {
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  humanSigner: string;
  signerFingerprint: string;
  issuedAt: string;
}

interface RecoveryQuarantineGrantCommon extends RecoveryQuarantineCommonBinding {
  grantId: string;
  expiresAt: string;
  uses: 1;
  oneShot: true;
}

export interface RecoveryQuarantineEnterGrantPayload extends RecoveryQuarantineGrantCommon {
  kind: 'recovery-quarantine-enter-grant.v1';
  operation: 'enter-quarantine';
}

export interface RecoveryQuarantineReleaseGrantPayload extends RecoveryQuarantineGrantCommon {
  kind: 'recovery-quarantine-release-grant.v1';
  operation: 'release-quarantine';
  activeMarkerDigest: RecoveryAuthoritySha256Digest;
}

export type RecoveryQuarantineGrantPayload =
  RecoveryQuarantineEnterGrantPayload | RecoveryQuarantineReleaseGrantPayload;

export interface RecoveryQuarantineEnvelope {
  payload: RecoveryQuarantineGrantPayload;
  signature: string;
}

export interface RecoveryQuarantineMarker {
  kind: 'recovery-quarantine-marker.v1';
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  enterGrantId: string;
  enterEnvelopeDigest: RecoveryAuthoritySha256Digest;
  enteredAt: string;
  markerDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryQuarantineReservation {
  kind: 'recovery-quarantine-reservation.v1';
  grantId: string;
  operation: RecoveryQuarantineGrantPayload['operation'];
  envelope: RecoveryQuarantineEnvelope;
  envelopeDigest: RecoveryAuthoritySha256Digest;
  reservedAt: string;
  reservationDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryQuarantineReceipt {
  kind: 'recovery-quarantine-receipt.v1';
  grantId: string;
  operation: RecoveryQuarantineGrantPayload['operation'];
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  markerDigest: RecoveryAuthoritySha256Digest;
  result: 'quarantine-entered' | 'quarantine-released';
  completedAt: string;
  receiptDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryQuarantineTerminal {
  kind: 'recovery-quarantine-terminal.v1';
  state: 'consumed';
  grantId: string;
  operation: RecoveryQuarantineGrantPayload['operation'];
  envelopeDigest: RecoveryAuthoritySha256Digest;
  receiptDigest: RecoveryAuthoritySha256Digest;
  markerDigest: RecoveryAuthoritySha256Digest;
  consumedAt: string;
  terminalDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryQuarantineAuditRecord {
  kind: 'recovery-quarantine-audit.v1';
  recordId: RecoveryAuthoritySha256Digest;
  grantId: string;
  operation: RecoveryQuarantineGrantPayload['operation'];
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  humanSigner: string;
  signerFingerprint: string;
  event: 'quarantine-entered' | 'quarantine-released';
  markerDigest: RecoveryAuthoritySha256Digest;
  envelopeDigest: RecoveryAuthoritySha256Digest;
  receiptDigest: RecoveryAuthoritySha256Digest;
  terminalDigest: RecoveryAuthoritySha256Digest;
  recordedAt: string;
  recordDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryQuarantineAuditAcknowledgement {
  kind: 'recovery-quarantine-audit-ack.v1';
  grantId: string;
  recordId: RecoveryAuthoritySha256Digest;
  recordDigest: RecoveryAuthoritySha256Digest;
  acknowledgedAt: string;
  acknowledgementDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryQuarantineGrantRecord {
  state: 'reserved' | 'receipt-durable' | 'consumed' | 'audited';
  reservation: RecoveryQuarantineReservation;
  receipt: RecoveryQuarantineReceipt | null;
  terminal: RecoveryQuarantineTerminal | null;
  audit: RecoveryQuarantineAuditRecord | null;
  auditAcknowledgement: RecoveryQuarantineAuditAcknowledgement | null;
}

export interface RecoveryQuarantineReleaseClaim {
  kind: 'recovery-quarantine-release-claim.v1';
  markerDigest: RecoveryAuthoritySha256Digest;
  releaseGrantId: string;
  releaseEnvelopeDigest: RecoveryAuthoritySha256Digest;
  claimedAt: string;
  claimDigest: RecoveryAuthoritySha256Digest;
}

export type RecoveryQuarantineFaultPhase =
  | 'reservation-published'
  | 'reservation-durable'
  | 'marker-published'
  | 'marker-durable'
  | 'release-claim-published'
  | 'release-claim-durable'
  | 'receipt-published'
  | 'receipt-durable'
  | 'terminal-published'
  | 'terminal-durable'
  | 'release-durable'
  | 'audit-published'
  | 'audit-appended'
  | 'audit-ack-published';

export interface RecoveryQuarantineDependencies {
  authorityDescriptor: RecoveryAuthorityDescriptorV1;
  authorityExpectations: RecoveryAuthorityExpectations;
  externalAuditRoot: string;
  now: Date;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
  appendAudit(record: RecoveryQuarantineAuditRecord): void;
  hooks?: {
    afterPhase(phase: RecoveryQuarantineFaultPhase): void;
  };
}

export interface RecoveryQuarantineEnterResult {
  marker: RecoveryQuarantineMarker;
  markerPath: string;
  receipt: RecoveryQuarantineReceipt;
  record: RecoveryQuarantineGrantRecord;
}

export interface RecoveryQuarantineReleaseResult {
  receipt: RecoveryQuarantineReceipt;
  record: RecoveryQuarantineGrantRecord;
}

export function createRecoveryQuarantineEnterGrantPayload(
  input: RecoveryQuarantineCommonBinding,
): RecoveryQuarantineEnterGrantPayload {
  const common = normalizeCreationBinding(input);
  const payloadWithoutId = {
    kind: 'recovery-quarantine-enter-grant.v1' as const,
    operation: 'enter-quarantine' as const,
    ...common,
    expiresAt: expiresAt(common.issuedAt),
    uses: 1 as const,
    oneShot: true as const,
  };
  return normalizeEnterPayload({
    ...payloadWithoutId,
    grantId: grantId('enter', payloadWithoutId),
  });
}

export function createRecoveryQuarantineReleaseGrantPayload(
  input: RecoveryQuarantineCommonBinding & {
    activeMarkerDigest: RecoveryAuthoritySha256Digest;
  },
): RecoveryQuarantineReleaseGrantPayload {
  const common = normalizeCreationBinding(input);
  assertDigest(input.activeMarkerDigest, 'RECOVERY_QUARANTINE_GRANT_INVALID');
  const payloadWithoutId = {
    kind: 'recovery-quarantine-release-grant.v1' as const,
    operation: 'release-quarantine' as const,
    ...common,
    activeMarkerDigest: input.activeMarkerDigest,
    expiresAt: expiresAt(common.issuedAt),
    uses: 1 as const,
    oneShot: true as const,
  };
  return normalizeReleasePayload({
    ...payloadWithoutId,
    grantId: grantId('release', payloadWithoutId),
  });
}

export function canonicalRecoveryQuarantineGrantPayload(
  payload: RecoveryQuarantineGrantPayload,
): string {
  return canonicalJson(normalizeGrantPayload(payload));
}

export interface QuarantinePaths {
  state: string;
  grants: string;
  releaseClaims: string;
  marker: string;
}

export interface QuarantineGrantPaths extends QuarantinePaths {
  grantDirectory: string;
  reservation: string;
  receipt: string;
  terminal: string;
  audit: string;
  auditAcknowledgement: string;
  releaseClaim: string;
}

export interface BegunOperation {
  storageRoot: string;
  payload: RecoveryQuarantineGrantPayload;
  reservation: RecoveryQuarantineReservation;
  record: RecoveryQuarantineGrantRecord;
  paths: QuarantineGrantPaths;
}

export function createMarker(
  payload: RecoveryQuarantineEnterGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
): RecoveryQuarantineMarker {
  const markerPayload = {
    kind: 'recovery-quarantine-marker.v1' as const,
    repositoryId: payload.repositoryId,
    authorityDescriptorDigest: payload.authorityDescriptorDigest,
    authorityGeneration: payload.authorityGeneration,
    recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
    externalAuditRoot: payload.externalAuditRoot,
    enterGrantId: payload.grantId,
    enterEnvelopeDigest: envelopeDigest,
    enteredAt: payload.issuedAt,
  };
  return deepFreeze({
    ...markerPayload,
    markerDigest: canonicalDigest(markerPayload),
  });
}

export function createReservation(
  envelope: RecoveryQuarantineEnvelope,
  reservedAt: string,
): RecoveryQuarantineReservation {
  const payload = normalizeGrantPayload(envelope.payload);
  const reservationPayload = {
    kind: 'recovery-quarantine-reservation.v1' as const,
    grantId: payload.grantId,
    operation: payload.operation,
    envelope: structuredClone(envelope),
    envelopeDigest: canonicalDigest(envelope),
    reservedAt: exactIso(reservedAt, 'RECOVERY_QUARANTINE_RECORD_INVALID'),
  };
  return deepFreeze({
    ...reservationPayload,
    reservationDigest: canonicalDigest(reservationPayload),
  });
}

export function createReceipt(
  payload: RecoveryQuarantineGrantPayload,
  markerDigest: RecoveryAuthoritySha256Digest,
  completedAt: string,
): RecoveryQuarantineReceipt {
  const receiptPayload = {
    kind: 'recovery-quarantine-receipt.v1' as const,
    grantId: payload.grantId,
    operation: payload.operation,
    repositoryId: payload.repositoryId,
    authorityDescriptorDigest: payload.authorityDescriptorDigest,
    authorityGeneration: payload.authorityGeneration,
    recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
    externalAuditRoot: payload.externalAuditRoot,
    markerDigest,
    result:
      payload.operation === 'enter-quarantine'
        ? ('quarantine-entered' as const)
        : ('quarantine-released' as const),
    completedAt: exactIso(completedAt, 'RECOVERY_QUARANTINE_RECORD_INVALID'),
  };
  return deepFreeze({
    ...receiptPayload,
    receiptDigest: canonicalDigest(receiptPayload),
  });
}

export function createTerminal(
  payload: RecoveryQuarantineGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
  receipt: RecoveryQuarantineReceipt,
): RecoveryQuarantineTerminal {
  const terminalPayload = {
    kind: 'recovery-quarantine-terminal.v1' as const,
    state: 'consumed' as const,
    grantId: payload.grantId,
    operation: payload.operation,
    envelopeDigest,
    receiptDigest: receipt.receiptDigest,
    markerDigest: receipt.markerDigest,
    consumedAt: receipt.completedAt,
  };
  return deepFreeze({
    ...terminalPayload,
    terminalDigest: canonicalDigest(terminalPayload),
  });
}

export function createReleaseClaim(
  payload: RecoveryQuarantineReleaseGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
  claimedAt: string,
): RecoveryQuarantineReleaseClaim {
  const claimPayload = {
    kind: 'recovery-quarantine-release-claim.v1' as const,
    markerDigest: payload.activeMarkerDigest,
    releaseGrantId: payload.grantId,
    releaseEnvelopeDigest: envelopeDigest,
    claimedAt,
  };
  return deepFreeze({
    ...claimPayload,
    claimDigest: canonicalDigest(claimPayload),
  });
}

export function createAuditRecord(
  payload: RecoveryQuarantineGrantPayload,
  envelopeDigest: RecoveryAuthoritySha256Digest,
  receipt: RecoveryQuarantineReceipt,
  terminal: RecoveryQuarantineTerminal,
): RecoveryQuarantineAuditRecord {
  const event = receipt.result;
  const recordId = canonicalDigest({
    kind: 'recovery-quarantine-audit-id.v1',
    grantId: payload.grantId,
    event,
    receiptDigest: receipt.receiptDigest,
  });
  const auditPayload = {
    kind: 'recovery-quarantine-audit.v1' as const,
    recordId,
    grantId: payload.grantId,
    operation: payload.operation,
    repositoryId: payload.repositoryId,
    authorityDescriptorDigest: payload.authorityDescriptorDigest,
    authorityGeneration: payload.authorityGeneration,
    recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
    externalAuditRoot: payload.externalAuditRoot,
    humanSigner: payload.humanSigner,
    signerFingerprint: payload.signerFingerprint,
    event,
    markerDigest: receipt.markerDigest,
    envelopeDigest,
    receiptDigest: receipt.receiptDigest,
    terminalDigest: terminal.terminalDigest,
    recordedAt: terminal.consumedAt,
  };
  return deepFreeze({
    ...auditPayload,
    recordDigest: canonicalDigest(auditPayload),
  });
}

export function createAuditAcknowledgement(
  audit: RecoveryQuarantineAuditRecord,
  acknowledgedAt: string,
): RecoveryQuarantineAuditAcknowledgement {
  const acknowledgementPayload = {
    kind: 'recovery-quarantine-audit-ack.v1' as const,
    grantId: audit.grantId,
    recordId: audit.recordId,
    recordDigest: audit.recordDigest,
    acknowledgedAt: exactIso(
      acknowledgedAt,
      'RECOVERY_QUARANTINE_RECORD_INVALID',
    ),
  };
  return deepFreeze({
    ...acknowledgementPayload,
    acknowledgementDigest: canonicalDigest(acknowledgementPayload),
  });
}

function normalizeCreationBinding(
  input: RecoveryQuarantineCommonBinding,
): RecoveryQuarantineCommonBinding {
  if (
    !isRecord(input) ||
    !isIdentifier(input.repositoryId) ||
    !isDigest(input.authorityDescriptorDigest) ||
    !Number.isSafeInteger(input.authorityGeneration) ||
    input.authorityGeneration < 1 ||
    !isDigest(input.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(input.externalAuditRoot) ||
    !isIdentifier(input.humanSigner) ||
    typeof input.signerFingerprint !== 'string' ||
    !FINGERPRINT.test(input.signerFingerprint)
  ) {
    throw grantInvalid();
  }
  return {
    repositoryId: input.repositoryId,
    authorityDescriptorDigest: input.authorityDescriptorDigest,
    authorityGeneration: input.authorityGeneration,
    recoveryRuntimeDigest: input.recoveryRuntimeDigest,
    externalAuditRoot: input.externalAuditRoot,
    humanSigner: input.humanSigner,
    signerFingerprint: input.signerFingerprint,
    issuedAt: exactIso(input.issuedAt, 'RECOVERY_QUARANTINE_GRANT_INVALID'),
  };
}

export function normalizeGrantPayload(
  raw: unknown,
): RecoveryQuarantineGrantPayload {
  if (!isRecord(raw)) throw grantInvalid();
  if (raw.operation === 'enter-quarantine') return normalizeEnterPayload(raw);
  if (raw.operation === 'release-quarantine')
    return normalizeReleasePayload(raw);
  throw grantInvalid();
}

function normalizeEnterPayload(
  raw: unknown,
): RecoveryQuarantineEnterGrantPayload {
  const keys = [
    'authorityDescriptorDigest',
    'authorityGeneration',
    'expiresAt',
    'externalAuditRoot',
    'grantId',
    'humanSigner',
    'issuedAt',
    'kind',
    'oneShot',
    'operation',
    'recoveryRuntimeDigest',
    'repositoryId',
    'signerFingerprint',
    'uses',
  ];
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, keys) ||
    raw.kind !== 'recovery-quarantine-enter-grant.v1' ||
    raw.operation !== 'enter-quarantine'
  ) {
    throw grantInvalid();
  }
  const common = normalizeGrantCommon(raw);
  const payloadWithoutId = {
    kind: 'recovery-quarantine-enter-grant.v1' as const,
    operation: 'enter-quarantine' as const,
    repositoryId: common.repositoryId,
    authorityDescriptorDigest: common.authorityDescriptorDigest,
    authorityGeneration: common.authorityGeneration,
    recoveryRuntimeDigest: common.recoveryRuntimeDigest,
    externalAuditRoot: common.externalAuditRoot,
    humanSigner: common.humanSigner,
    signerFingerprint: common.signerFingerprint,
    issuedAt: common.issuedAt,
    expiresAt: common.expiresAt,
    uses: 1 as const,
    oneShot: true as const,
  };
  const expectedId = grantId('enter', payloadWithoutId);
  if (raw.grantId !== expectedId) throw grantInvalid();
  return { ...payloadWithoutId, grantId: expectedId };
}

function normalizeReleasePayload(
  raw: unknown,
): RecoveryQuarantineReleaseGrantPayload {
  const keys = [
    'activeMarkerDigest',
    'authorityDescriptorDigest',
    'authorityGeneration',
    'expiresAt',
    'externalAuditRoot',
    'grantId',
    'humanSigner',
    'issuedAt',
    'kind',
    'oneShot',
    'operation',
    'recoveryRuntimeDigest',
    'repositoryId',
    'signerFingerprint',
    'uses',
  ];
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, keys) ||
    raw.kind !== 'recovery-quarantine-release-grant.v1' ||
    raw.operation !== 'release-quarantine' ||
    !isDigest(raw.activeMarkerDigest)
  ) {
    throw grantInvalid();
  }
  const common = normalizeGrantCommon(raw);
  const payloadWithoutId = {
    kind: 'recovery-quarantine-release-grant.v1' as const,
    operation: 'release-quarantine' as const,
    repositoryId: common.repositoryId,
    authorityDescriptorDigest: common.authorityDescriptorDigest,
    authorityGeneration: common.authorityGeneration,
    recoveryRuntimeDigest: common.recoveryRuntimeDigest,
    externalAuditRoot: common.externalAuditRoot,
    humanSigner: common.humanSigner,
    signerFingerprint: common.signerFingerprint,
    issuedAt: common.issuedAt,
    expiresAt: common.expiresAt,
    uses: 1 as const,
    oneShot: true as const,
    activeMarkerDigest: raw.activeMarkerDigest,
  };
  const expectedId = grantId('release', payloadWithoutId);
  if (raw.grantId !== expectedId) throw grantInvalid();
  return { ...payloadWithoutId, grantId: expectedId };
}

function normalizeGrantCommon(raw: Record<string, unknown>): {
  repositoryId: string;
  authorityDescriptorDigest: RecoveryAuthoritySha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: RecoveryAuthoritySha256Digest;
  externalAuditRoot: string;
  humanSigner: string;
  signerFingerprint: string;
  issuedAt: string;
  expiresAt: string;
} {
  if (
    !isIdentifier(raw.repositoryId) ||
    !isDigest(raw.authorityDescriptorDigest) ||
    !Number.isSafeInteger(raw.authorityGeneration) ||
    Number(raw.authorityGeneration) < 1 ||
    !isDigest(raw.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(raw.externalAuditRoot) ||
    !isIdentifier(raw.humanSigner) ||
    typeof raw.signerFingerprint !== 'string' ||
    !FINGERPRINT.test(raw.signerFingerprint) ||
    raw.uses !== 1 ||
    raw.oneShot !== true
  ) {
    throw grantInvalid();
  }
  const issuedAt = exactIso(raw.issuedAt, 'RECOVERY_QUARANTINE_GRANT_INVALID');
  const expiresAtValue = exactIso(
    raw.expiresAt,
    'RECOVERY_QUARANTINE_GRANT_INVALID',
  );
  const ttl = Date.parse(expiresAtValue) - Date.parse(issuedAt);
  if (ttl <= 0 || ttl > RECOVERY_QUARANTINE_GRANT_TTL_MS) {
    throw quarantineError(
      'RECOVERY_QUARANTINE_GRANT_TTL_INVALID',
      'Recovery Quarantine Grant must have a positive lifetime of at most five minutes.',
      ExitCode.guard,
    );
  }
  return {
    repositoryId: raw.repositoryId,
    authorityDescriptorDigest: raw.authorityDescriptorDigest,
    authorityGeneration: Number(raw.authorityGeneration),
    recoveryRuntimeDigest: raw.recoveryRuntimeDigest,
    externalAuditRoot: raw.externalAuditRoot,
    humanSigner: raw.humanSigner,
    signerFingerprint: raw.signerFingerprint,
    issuedAt,
    expiresAt: expiresAtValue,
  };
}

export function normalizeMarker(raw: unknown): RecoveryQuarantineMarker {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'authorityDescriptorDigest',
      'authorityGeneration',
      'enterEnvelopeDigest',
      'enterGrantId',
      'enteredAt',
      'externalAuditRoot',
      'kind',
      'markerDigest',
      'recoveryRuntimeDigest',
      'repositoryId',
    ]) ||
    raw.kind !== 'recovery-quarantine-marker.v1' ||
    !isIdentifier(raw.repositoryId) ||
    !isDigest(raw.authorityDescriptorDigest) ||
    !Number.isSafeInteger(raw.authorityGeneration) ||
    Number(raw.authorityGeneration) < 1 ||
    !isDigest(raw.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(raw.externalAuditRoot) ||
    typeof raw.enterGrantId !== 'string' ||
    !GRANT_ID.test(raw.enterGrantId) ||
    !raw.enterGrantId.startsWith('quarantine-enter-') ||
    !isDigest(raw.enterEnvelopeDigest) ||
    !isDigest(raw.markerDigest)
  ) {
    throw stateCorrupt();
  }
  const enteredAt = exactIso(
    raw.enteredAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const { markerDigest, ...payload } = raw;
  if (markerDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return structuredClone({ ...raw, enteredAt }) as RecoveryQuarantineMarker;
}

export function normalizeReservation(
  raw: unknown,
): RecoveryQuarantineReservation {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'envelope',
      'envelopeDigest',
      'grantId',
      'kind',
      'operation',
      'reservationDigest',
      'reservedAt',
    ]) ||
    raw.kind !== 'recovery-quarantine-reservation.v1' ||
    !isRecord(raw.envelope) ||
    !hasExactKeys(raw.envelope, ['payload', 'signature']) ||
    typeof raw.envelope.signature !== 'string' ||
    raw.envelope.signature.length === 0 ||
    !isDigest(raw.envelopeDigest) ||
    !isDigest(raw.reservationDigest)
  ) {
    throw stateCorrupt();
  }
  const payload = normalizeGrantPayload(raw.envelope.payload);
  if (
    raw.grantId !== payload.grantId ||
    raw.operation !== payload.operation ||
    raw.envelopeDigest !== canonicalDigest(raw.envelope)
  ) {
    throw stateCorrupt();
  }
  const reservedAt = exactIso(
    raw.reservedAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const { reservationDigest, ...recordPayload } = raw;
  if (reservationDigest !== canonicalDigest(recordPayload))
    throw stateCorrupt();
  return structuredClone({
    ...raw,
    envelope: { payload, signature: raw.envelope.signature },
    reservedAt,
  }) as RecoveryQuarantineReservation;
}

export function normalizeReceipt(raw: unknown): RecoveryQuarantineReceipt {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'authorityDescriptorDigest',
      'authorityGeneration',
      'completedAt',
      'externalAuditRoot',
      'grantId',
      'kind',
      'markerDigest',
      'operation',
      'receiptDigest',
      'recoveryRuntimeDigest',
      'repositoryId',
      'result',
    ]) ||
    raw.kind !== 'recovery-quarantine-receipt.v1' ||
    typeof raw.grantId !== 'string' ||
    !GRANT_ID.test(raw.grantId) ||
    !['enter-quarantine', 'release-quarantine'].includes(
      String(raw.operation),
    ) ||
    !isIdentifier(raw.repositoryId) ||
    !isDigest(raw.authorityDescriptorDigest) ||
    !Number.isSafeInteger(raw.authorityGeneration) ||
    Number(raw.authorityGeneration) < 1 ||
    !isDigest(raw.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(raw.externalAuditRoot) ||
    !isDigest(raw.markerDigest) ||
    !['quarantine-entered', 'quarantine-released'].includes(
      String(raw.result),
    ) ||
    !isDigest(raw.receiptDigest)
  ) {
    throw stateCorrupt();
  }
  const completedAt = exactIso(
    raw.completedAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const { receiptDigest, ...payload } = raw;
  if (receiptDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return structuredClone({ ...raw, completedAt }) as RecoveryQuarantineReceipt;
}

export function normalizeTerminal(raw: unknown): RecoveryQuarantineTerminal {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'consumedAt',
      'envelopeDigest',
      'grantId',
      'kind',
      'markerDigest',
      'operation',
      'receiptDigest',
      'state',
      'terminalDigest',
    ]) ||
    raw.kind !== 'recovery-quarantine-terminal.v1' ||
    raw.state !== 'consumed' ||
    typeof raw.grantId !== 'string' ||
    !GRANT_ID.test(raw.grantId) ||
    !['enter-quarantine', 'release-quarantine'].includes(
      String(raw.operation),
    ) ||
    !isDigest(raw.envelopeDigest) ||
    !isDigest(raw.receiptDigest) ||
    !isDigest(raw.markerDigest) ||
    !isDigest(raw.terminalDigest)
  ) {
    throw stateCorrupt();
  }
  const consumedAt = exactIso(
    raw.consumedAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const { terminalDigest, ...payload } = raw;
  if (terminalDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return structuredClone({ ...raw, consumedAt }) as RecoveryQuarantineTerminal;
}

export function normalizeAudit(raw: unknown): RecoveryQuarantineAuditRecord {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'authorityDescriptorDigest',
      'authorityGeneration',
      'envelopeDigest',
      'event',
      'externalAuditRoot',
      'grantId',
      'humanSigner',
      'kind',
      'markerDigest',
      'operation',
      'receiptDigest',
      'recordDigest',
      'recordId',
      'recordedAt',
      'recoveryRuntimeDigest',
      'repositoryId',
      'signerFingerprint',
      'terminalDigest',
    ]) ||
    raw.kind !== 'recovery-quarantine-audit.v1' ||
    typeof raw.grantId !== 'string' ||
    !GRANT_ID.test(raw.grantId) ||
    !['enter-quarantine', 'release-quarantine'].includes(
      String(raw.operation),
    ) ||
    !isIdentifier(raw.repositoryId) ||
    !isDigest(raw.authorityDescriptorDigest) ||
    !Number.isSafeInteger(raw.authorityGeneration) ||
    Number(raw.authorityGeneration) < 1 ||
    !isDigest(raw.recoveryRuntimeDigest) ||
    !isExactAbsolutePath(raw.externalAuditRoot) ||
    !isIdentifier(raw.humanSigner) ||
    typeof raw.signerFingerprint !== 'string' ||
    !FINGERPRINT.test(raw.signerFingerprint) ||
    !['quarantine-entered', 'quarantine-released'].includes(
      String(raw.event),
    ) ||
    !isDigest(raw.markerDigest) ||
    !isDigest(raw.envelopeDigest) ||
    !isDigest(raw.receiptDigest) ||
    !isDigest(raw.terminalDigest) ||
    !isDigest(raw.recordId) ||
    !isDigest(raw.recordDigest)
  ) {
    throw stateCorrupt();
  }
  const operation =
    raw.operation as RecoveryQuarantineGrantPayload['operation'];
  const event = raw.event as RecoveryQuarantineAuditRecord['event'];
  if (
    (operation === 'enter-quarantine' && event !== 'quarantine-entered') ||
    (operation === 'release-quarantine' && event !== 'quarantine-released') ||
    (operation === 'enter-quarantine' &&
      !raw.grantId.startsWith('quarantine-enter-')) ||
    (operation === 'release-quarantine' &&
      !raw.grantId.startsWith('quarantine-release-'))
  ) {
    throw stateCorrupt();
  }
  const recordedAt = exactIso(
    raw.recordedAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const expectedRecordId = canonicalDigest({
    kind: 'recovery-quarantine-audit-id.v1',
    grantId: raw.grantId,
    event,
    receiptDigest: raw.receiptDigest,
  });
  if (raw.recordId !== expectedRecordId) throw stateCorrupt();
  const { recordDigest, ...payload } = raw;
  if (recordDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return structuredClone({
    ...raw,
    operation,
    event,
    recordedAt,
  }) as RecoveryQuarantineAuditRecord;
}

export function normalizeAuditAcknowledgement(
  raw: unknown,
): RecoveryQuarantineAuditAcknowledgement {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'acknowledgedAt',
      'acknowledgementDigest',
      'grantId',
      'kind',
      'recordDigest',
      'recordId',
    ]) ||
    raw.kind !== 'recovery-quarantine-audit-ack.v1' ||
    typeof raw.grantId !== 'string' ||
    !GRANT_ID.test(raw.grantId) ||
    !isDigest(raw.recordId) ||
    !isDigest(raw.recordDigest) ||
    !isDigest(raw.acknowledgementDigest)
  ) {
    throw stateCorrupt();
  }
  const acknowledgedAt = exactIso(
    raw.acknowledgedAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const { acknowledgementDigest, ...payload } = raw;
  if (acknowledgementDigest !== canonicalDigest(payload)) {
    throw stateCorrupt();
  }
  return structuredClone({
    ...raw,
    acknowledgedAt,
  }) as RecoveryQuarantineAuditAcknowledgement;
}

export function normalizeReleaseClaim(
  raw: unknown,
): RecoveryQuarantineReleaseClaim {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'claimDigest',
      'claimedAt',
      'kind',
      'markerDigest',
      'releaseEnvelopeDigest',
      'releaseGrantId',
    ]) ||
    raw.kind !== 'recovery-quarantine-release-claim.v1' ||
    !isDigest(raw.markerDigest) ||
    typeof raw.releaseGrantId !== 'string' ||
    !raw.releaseGrantId.startsWith('quarantine-release-') ||
    !GRANT_ID.test(raw.releaseGrantId) ||
    !isDigest(raw.releaseEnvelopeDigest) ||
    !isDigest(raw.claimDigest)
  ) {
    throw stateCorrupt();
  }
  const claimedAt = exactIso(
    raw.claimedAt,
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
  );
  const { claimDigest, ...payload } = raw;
  if (claimDigest !== canonicalDigest(payload)) throw stateCorrupt();
  return structuredClone({
    ...raw,
    claimedAt,
  }) as RecoveryQuarantineReleaseClaim;
}

export function assertRecordChain(
  reservation: RecoveryQuarantineReservation,
  receipt: RecoveryQuarantineReceipt | null,
  terminal: RecoveryQuarantineTerminal | null,
  audit: RecoveryQuarantineAuditRecord | null,
  acknowledgement: RecoveryQuarantineAuditAcknowledgement | null,
): void {
  const payload = reservation.envelope.payload;
  const reservedAt = Date.parse(reservation.reservedAt);
  if (
    reservedAt < Date.parse(payload.issuedAt) ||
    reservedAt >= Date.parse(payload.expiresAt)
  ) {
    throw stateCorrupt();
  }
  const expectedMarkerDigest =
    payload.operation === 'enter-quarantine'
      ? createMarker(payload, reservation.envelopeDigest).markerDigest
      : payload.activeMarkerDigest;
  if (receipt !== null) {
    if (Date.parse(receipt.completedAt) < reservedAt) throw stateCorrupt();
    const expectedReceipt = createReceipt(
      payload,
      expectedMarkerDigest,
      receipt.completedAt,
    );
    if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
      throw stateCorrupt();
    }
  }
  if (terminal !== null) {
    if (receipt === null) throw stateCorrupt();
    const expectedTerminal = createTerminal(
      payload,
      reservation.envelopeDigest,
      receipt,
    );
    if (canonicalJson(terminal) !== canonicalJson(expectedTerminal)) {
      throw stateCorrupt();
    }
  }
  if (audit !== null) {
    if (receipt === null || terminal === null) throw stateCorrupt();
    const expectedAudit = createAuditRecord(
      payload,
      reservation.envelopeDigest,
      receipt,
      terminal,
    );
    if (canonicalJson(audit) !== canonicalJson(expectedAudit)) {
      throw stateCorrupt();
    }
  }
  if (acknowledgement !== null) {
    if (audit === null) throw stateCorrupt();
    if (
      Date.parse(acknowledgement.acknowledgedAt) < Date.parse(audit.recordedAt)
    ) {
      throw stateCorrupt();
    }
    const expectedAcknowledgement = createAuditAcknowledgement(
      audit,
      acknowledgement.acknowledgedAt,
    );
    if (
      canonicalJson(acknowledgement) !== canonicalJson(expectedAcknowledgement)
    ) {
      throw stateCorrupt();
    }
  }
}

export function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw quarantineError(
      'RECOVERY_QUARANTINE_TIME_INVALID',
      'Recovery Quarantine requires a valid injected time.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(value.getTime());
}

function expiresAt(issuedAt: string): string {
  const timestamp = Date.parse(
    exactIso(issuedAt, 'RECOVERY_QUARANTINE_GRANT_INVALID'),
  );
  const result = new Date(timestamp + RECOVERY_QUARANTINE_GRANT_TTL_MS);
  if (!Number.isFinite(result.getTime())) throw grantInvalid();
  return result.toISOString();
}

function grantId(kind: 'enter' | 'release', value: unknown): string {
  return `quarantine-${kind}-${digestHex(canonicalJson(value))}`;
}

function canonicalDigest(value: unknown): RecoveryAuthoritySha256Digest {
  return `sha256:${digestHex(canonicalJson(value))}`;
}

export function digestHex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is RecoveryAuthoritySha256Digest {
  if (!isDigest(value)) {
    throw quarantineError(
      code,
      'Recovery Quarantine digest is malformed.',
      ExitCode.guard,
    );
  }
}

function isDigest(value: unknown): value is RecoveryAuthoritySha256Digest {
  return typeof value === 'string' && DIGEST.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export function isExactAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function exactIso(value: unknown, code: string): string {
  if (typeof value !== 'string') {
    throw quarantineError(
      code,
      'Recovery Quarantine timestamp is malformed.',
      ExitCode.guard,
    );
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw quarantineError(
      code,
      'Recovery Quarantine timestamp is malformed.',
      ExitCode.guard,
    );
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function assertCanonicalEqual(
  observed: unknown,
  expected: unknown,
): void {
  if (canonicalJson(observed) !== canonicalJson(expected)) throw stateCorrupt();
}

export function quarantineError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

export function grantInvalid() {
  return quarantineError(
    'RECOVERY_QUARANTINE_GRANT_INVALID',
    'Recovery Quarantine Grant does not match its exact schema or intrinsic bindings.',
    ExitCode.guard,
  );
}

export function stateCorrupt() {
  return quarantineError(
    'RECOVERY_QUARANTINE_STATE_CORRUPT',
    'Recovery Quarantine durable state failed integrity verification.',
    ExitCode.verification,
  );
}

export function storeUnsafe() {
  return quarantineError(
    'RECOVERY_QUARANTINE_STORE_UNSAFE',
    'Recovery Quarantine durable store is unavailable or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}

export function alreadyConsumed() {
  return quarantineError(
    'RECOVERY_QUARANTINE_GRANT_ALREADY_CONSUMED',
    'Recovery Quarantine Grant is one-shot and has already been consumed.',
    ExitCode.conflict,
  );
}

export function hasWorkflowCode(error: unknown, code?: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    (code === undefined || error.code === code)
  );
}

export function isNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
