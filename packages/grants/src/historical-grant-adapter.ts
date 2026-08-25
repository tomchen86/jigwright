import crypto from 'node:crypto';

import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  parseCollaborationGrantEnvelopeV1,
  readAndVerifyCollaborationGrantEnvelopeV1,
  selectCollaborationGrantSignatureNamespaceV1,
  type CollaborationGrantPayloadCodecV1,
  type VersionedCollaborationGrantPayload,
} from './collaboration-grant-envelope-reader.ts';
import type { GrantSignatureVerifierPortV1 } from './grant-envelope-verifier.ts';

export const HISTORICAL_GRANT_ADAPTER_CONTRACT_VERSION_V1 =
  'historical-grant-adapter.v1' as const;
export const HISTORICAL_GRANT_INSPECTION_KIND_V1 =
  'jigwright.historical-grant-inspection.v1' as const;
export const VERIFIED_HISTORICAL_GRANT_EVIDENCE_KIND_V1 =
  'jigwright.verified-historical-grant-evidence.v1' as const;
export const HISTORICAL_GRANT_TERMINAL_CLEANUP_KIND_V1 =
  'jigwright.historical-grant-terminal-cleanup.v1' as const;
export const HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1 =
  'role-independence-degradation-only' as const;

const HISTORICAL_EVIDENCE_FAMILY = 'legacy-collaboration-grant' as const;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HistoricalGrantStoreStateV1 =
  'available' | 'reserved' | 'consumed' | 'failed' | 'expired' | 'revoked';

export type HistoricalGrantTerminalStateV1 = Extract<
  HistoricalGrantStoreStateV1,
  'consumed' | 'failed' | 'expired' | 'revoked'
>;

export type HistoricalGrantStoredEvidenceV1 = Readonly<{
  state: HistoricalGrantStoreStateV1;
  raw: string;
}>;

export type HistoricalGrantTerminalCleanupRequestV1 = Readonly<{
  evidenceId: string;
  expectedState: HistoricalGrantTerminalStateV1;
  expectedEvidenceDigest: `sha256:${string}`;
}>;

export type HistoricalGrantTerminalCleanupResultV1 = Readonly<{
  removedResiduals: number;
  terminalPreserved: true;
}>;

/**
 * Storage remains consumer-owned. This port can only read evidence or remove
 * redundant nonterminal copies after an exact terminal tombstone exists.
 * It has no operation for creating, reserving, consuming, revoking, or
 * deleting authority records.
 */
export type HistoricalGrantStorePortV1 = Readonly<{
  readEvidence(evidenceId: string): HistoricalGrantStoredEvidenceV1;
  cleanupTerminalResiduals(
    request: HistoricalGrantTerminalCleanupRequestV1,
  ): HistoricalGrantTerminalCleanupResultV1;
}>;

export type HistoricalCollaborationGrantPayloadV1 =
  VersionedCollaborationGrantPayload &
    Readonly<{
      grantId: string;
      authorizedEffect: typeof HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1;
      signer: string;
    }>;

export type HistoricalGrantInspectionV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof HISTORICAL_GRANT_INSPECTION_KIND_V1;
  evidenceFamily: typeof HISTORICAL_EVIDENCE_FAMILY;
  evidenceId: string;
  payloadVersion: 1 | 2;
  signatureNamespace:
    | typeof COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
    | typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
  authorizedEffect: typeof HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1;
  state: HistoricalGrantStoreStateV1;
  evidenceDigest: `sha256:${string}`;
  authorityScope: 'historical-only';
}>;

/**
 * Deliberately not shaped like CentralGrantCompletedAuthorityRefV1, a
 * PlanReview result, or the generic verified-capability object. Runtime
 * branding additionally prevents a copied object from authorizing cleanup.
 */
export type VerifiedHistoricalGrantEvidenceV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof VERIFIED_HISTORICAL_GRANT_EVIDENCE_KIND_V1;
  evidenceFamily: typeof HISTORICAL_EVIDENCE_FAMILY;
  evidenceId: string;
  payloadVersion: 1 | 2;
  signatureNamespace:
    | typeof COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
    | typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
  authorizedEffect: typeof HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1;
  state: HistoricalGrantStoreStateV1;
  evidenceDigest: `sha256:${string}`;
  signedPayloadDigest: `sha256:${string}`;
  signatureDigest: `sha256:${string}`;
  historicalVerificationReceiptDigest: `sha256:${string}`;
  authorityScope: 'historical-only';
  currentAuthority: false;
  planReviewAuthority: false;
}>;

export type HistoricalGrantTerminalCleanupReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof HISTORICAL_GRANT_TERMINAL_CLEANUP_KIND_V1;
  evidenceFamily: typeof HISTORICAL_EVIDENCE_FAMILY;
  evidenceId: string;
  state: HistoricalGrantTerminalStateV1;
  evidenceDigest: `sha256:${string}`;
  removedResiduals: number;
  terminalPreserved: true;
  authorityScope: 'historical-only';
}>;

export type HistoricalGrantAdapterV1 = Readonly<{
  contractVersion: typeof HISTORICAL_GRANT_ADAPTER_CONTRACT_VERSION_V1;
  capabilities: readonly ['inspect', 'verify', 'cleanup'];
  authorityScope: 'historical-only';
  inspect(evidenceId: string): HistoricalGrantInspectionV1;
  verify(evidenceId: string): VerifiedHistoricalGrantEvidenceV1;
  cleanup(
    verification: VerifiedHistoricalGrantEvidenceV1,
  ): HistoricalGrantTerminalCleanupReceiptV1;
}>;

export type HistoricalGrantAdapterErrorCode =
  | 'HISTORICAL_GRANT_ADAPTER_INPUT_INVALID'
  | 'HISTORICAL_GRANT_STORE_RECORD_INVALID'
  | 'HISTORICAL_GRANT_EVIDENCE_ID_MISMATCH'
  | 'HISTORICAL_GRANT_VERIFICATION_REQUIRED'
  | 'HISTORICAL_GRANT_CLEANUP_STATE_INVALID'
  | 'HISTORICAL_GRANT_EVIDENCE_CHANGED'
  | 'HISTORICAL_GRANT_CLEANUP_RESULT_INVALID';

export class HistoricalGrantAdapterError extends Error {
  readonly code: HistoricalGrantAdapterErrorCode;

  constructor(
    code: HistoricalGrantAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HistoricalGrantAdapterError';
    this.code = code;
  }
}

export type CreateHistoricalCollaborationGrantAdapterOptionsV1<
  Payload extends HistoricalCollaborationGrantPayloadV1,
> = Readonly<{
  codec: CollaborationGrantPayloadCodecV1<Payload>;
  validatePayload(payload: Payload): void;
  verifier: GrantSignatureVerifierPortV1;
  store: HistoricalGrantStorePortV1;
}>;

type VerifiedBinding = Readonly<{
  adapterIdentity: object;
  inspection: HistoricalGrantInspectionV1;
}>;

const verifiedEvidence = new WeakMap<object, VerifiedBinding>();

/**
 * Compose the production historical Collaboration reader. Verification is
 * exact and namespace-selecting, but its result is intentionally
 * historical-only. The sole mutation is CAS-bound cleanup of redundant copies
 * after a terminal record has already been persisted by the legacy store.
 */
export function createHistoricalCollaborationGrantAdapterV1<
  Payload extends HistoricalCollaborationGrantPayloadV1,
>(
  options: CreateHistoricalCollaborationGrantAdapterOptionsV1<Payload>,
): HistoricalGrantAdapterV1 {
  assertOptions(options);
  const adapterIdentity = Object.freeze({});

  const inspect = (evidenceId: string): HistoricalGrantInspectionV1 =>
    readInspection(options, evidenceId).inspection;

  const verify = (evidenceId: string): VerifiedHistoricalGrantEvidenceV1 => {
    const { stored, inspection } = readInspection(options, evidenceId);
    const result = readAndVerifyCollaborationGrantEnvelopeV1({
      readerContractVersion:
        COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
      raw: stored.raw,
      codec: options.codec,
      validatePayload(payload) {
        assertHistoricalPayload(payload, evidenceId);
        options.validatePayload(payload);
      },
      authorizedEffect: (payload) => payload.authorizedEffect,
      signer: (payload) => payload.signer,
      allowedAuthorizedEffects: [
        HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1,
      ],
      verifier: options.verifier,
    });
    const receipt = result.verification.receipt;
    const value = deepFreeze({
      schemaVersion: 1 as const,
      kind: VERIFIED_HISTORICAL_GRANT_EVIDENCE_KIND_V1,
      evidenceFamily: HISTORICAL_EVIDENCE_FAMILY,
      evidenceId: inspection.evidenceId,
      payloadVersion: inspection.payloadVersion,
      signatureNamespace: inspection.signatureNamespace,
      authorizedEffect: inspection.authorizedEffect,
      state: inspection.state,
      evidenceDigest: inspection.evidenceDigest,
      signedPayloadDigest: prefixedDigest(receipt.signedPayloadDigest),
      signatureDigest: prefixedDigest(receipt.signatureDigest),
      historicalVerificationReceiptDigest: prefixedDigest(
        result.verification.receiptDigest,
      ),
      authorityScope: 'historical-only' as const,
      currentAuthority: false as const,
      planReviewAuthority: false as const,
    });
    verifiedEvidence.set(value, { adapterIdentity, inspection });
    return value;
  };

  const cleanup = (
    verification: VerifiedHistoricalGrantEvidenceV1,
  ): HistoricalGrantTerminalCleanupReceiptV1 => {
    const binding = isObject(verification)
      ? verifiedEvidence.get(verification)
      : undefined;
    if (!binding || binding.adapterIdentity !== adapterIdentity) {
      throw adapterError(
        'HISTORICAL_GRANT_VERIFICATION_REQUIRED',
        "Historical Grant terminal cleanup requires this adapter's exact verification result.",
      );
    }
    if (!isTerminalState(binding.inspection.state)) {
      throw adapterError(
        'HISTORICAL_GRANT_CLEANUP_STATE_INVALID',
        'Only an already-terminal historical Grant may have residual copies cleaned.',
      );
    }

    const current = readInspection(options, binding.inspection.evidenceId);
    if (
      current.inspection.state !== binding.inspection.state ||
      current.inspection.evidenceDigest !== binding.inspection.evidenceDigest
    ) {
      throw adapterError(
        'HISTORICAL_GRANT_EVIDENCE_CHANGED',
        'Historical Grant evidence changed after verification.',
      );
    }
    const expectedState = binding.inspection.state;
    const result = options.store.cleanupTerminalResiduals({
      evidenceId: binding.inspection.evidenceId,
      expectedState,
      expectedEvidenceDigest: binding.inspection.evidenceDigest,
    });
    if (
      !isPlainRecord(result) ||
      !hasExactKeys(result, ['removedResiduals', 'terminalPreserved']) ||
      !Number.isSafeInteger(result.removedResiduals) ||
      result.removedResiduals < 0 ||
      result.terminalPreserved !== true
    ) {
      throw adapterError(
        'HISTORICAL_GRANT_CLEANUP_RESULT_INVALID',
        'Historical Grant cleanup did not preserve the terminal record.',
      );
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      kind: HISTORICAL_GRANT_TERMINAL_CLEANUP_KIND_V1,
      evidenceFamily: HISTORICAL_EVIDENCE_FAMILY,
      evidenceId: binding.inspection.evidenceId,
      state: expectedState,
      evidenceDigest: binding.inspection.evidenceDigest,
      removedResiduals: result.removedResiduals,
      terminalPreserved: true as const,
      authorityScope: 'historical-only' as const,
    });
  };

  return Object.freeze({
    contractVersion: HISTORICAL_GRANT_ADAPTER_CONTRACT_VERSION_V1,
    capabilities: Object.freeze(['inspect', 'verify', 'cleanup'] as const),
    authorityScope: 'historical-only' as const,
    inspect,
    verify,
    cleanup,
  });
}

function readInspection<Payload extends HistoricalCollaborationGrantPayloadV1>(
  options: CreateHistoricalCollaborationGrantAdapterOptionsV1<Payload>,
  evidenceId: string,
): Readonly<{
  stored: HistoricalGrantStoredEvidenceV1;
  envelope: Readonly<{ payload: Payload; signature: string }>;
  inspection: HistoricalGrantInspectionV1;
}> {
  assertEvidenceId(evidenceId);
  const stored = options.store.readEvidence(evidenceId);
  assertStoredEvidence(stored);
  const envelope = parseCollaborationGrantEnvelopeV1(stored.raw, options.codec);
  assertHistoricalPayload(envelope.payload, evidenceId);
  const signatureNamespace = selectCollaborationGrantSignatureNamespaceV1(
    envelope.payload,
  );
  return deepFreeze({
    stored,
    envelope,
    inspection: {
      schemaVersion: 1 as const,
      kind: HISTORICAL_GRANT_INSPECTION_KIND_V1,
      evidenceFamily: HISTORICAL_EVIDENCE_FAMILY,
      evidenceId,
      payloadVersion: envelope.payload.version,
      signatureNamespace,
      authorizedEffect: HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1,
      state: stored.state,
      evidenceDigest: sha256(stored.raw),
      authorityScope: 'historical-only' as const,
    },
  });
}

function assertOptions<Payload extends HistoricalCollaborationGrantPayloadV1>(
  value: CreateHistoricalCollaborationGrantAdapterOptionsV1<Payload>,
): void {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['codec', 'validatePayload', 'verifier', 'store']) ||
    typeof value.validatePayload !== 'function' ||
    typeof value.verifier?.verify !== 'function' ||
    typeof value.store?.readEvidence !== 'function' ||
    typeof value.store.cleanupTerminalResiduals !== 'function'
  ) {
    throw adapterError(
      'HISTORICAL_GRANT_ADAPTER_INPUT_INVALID',
      'Historical Grant adapter composition is invalid.',
    );
  }
}

function assertHistoricalPayload(
  value: HistoricalCollaborationGrantPayloadV1,
  evidenceId: string,
): void {
  if (
    !isPlainRecord(value) ||
    !GRANT_ID.test(String(value.grantId)) ||
    value.authorizedEffect !==
      HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1 ||
    typeof value.signer !== 'string' ||
    value.signer.trim().length === 0
  ) {
    throw adapterError(
      'HISTORICAL_GRANT_STORE_RECORD_INVALID',
      'Historical Collaboration Grant payload is invalid.',
    );
  }
  if (value.grantId !== evidenceId) {
    throw adapterError(
      'HISTORICAL_GRANT_EVIDENCE_ID_MISMATCH',
      'Historical Grant store identity does not match its signed payload.',
    );
  }
}

function assertEvidenceId(value: string): void {
  if (typeof value !== 'string' || !GRANT_ID.test(value)) {
    throw adapterError(
      'HISTORICAL_GRANT_ADAPTER_INPUT_INVALID',
      'Historical Grant evidence ID is invalid.',
    );
  }
}

function assertStoredEvidence(value: HistoricalGrantStoredEvidenceV1): void {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['state', 'raw']) ||
    !isStoreState(value.state) ||
    typeof value.raw !== 'string'
  ) {
    throw adapterError(
      'HISTORICAL_GRANT_STORE_RECORD_INVALID',
      'Historical Grant store returned an invalid record.',
    );
  }
}

function isStoreState(value: unknown): value is HistoricalGrantStoreStateV1 {
  return [
    'available',
    'reserved',
    'consumed',
    'failed',
    'expired',
    'revoked',
  ].includes(String(value));
}

function isTerminalState(
  value: HistoricalGrantStoreStateV1,
): value is HistoricalGrantTerminalStateV1 {
  return ['consumed', 'failed', 'expired', 'revoked'].includes(value);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function prefixedDigest(value: string): `sha256:${string}` {
  return `sha256:${value}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function adapterError(
  code: HistoricalGrantAdapterErrorCode,
  message: string,
): HistoricalGrantAdapterError {
  return new HistoricalGrantAdapterError(code, message);
}
