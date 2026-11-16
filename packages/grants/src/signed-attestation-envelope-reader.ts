/**
 * Validates canonical signed attestation envelopes before invoking the exact
 * allowlisted verifier and producing its receipt.
 */
import crypto from 'node:crypto';

import {
  SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
  VERIFIED_SIGNED_ATTESTATION_KIND_V1,
  type VersionedSignedAttestationPayloadV1,
  type ReadAndVerifySignedAttestationEnvelopeRequestV1,
  type ReadAndVerifySignedAttestationEnvelopeResultV1,
  canonicalSignedAttestationPayloadBytesV1,
  parseSignedAttestationEnvelopeV1,
  isStringSet,
  isNonEmptyString,
  isPlainRecord,
  readerError,
} from '@jigwright/core/signed-attestation-envelope-codec';

export {
  SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
  VERIFIED_SIGNED_ATTESTATION_KIND_V1,
  type VersionedSignedAttestationPayloadV1,
  type SignedAttestationEnvelopeV1,
  type SignedAttestationPayloadCodecV1,
  type SignedAttestationVerificationReceiptV1,
  type VerifiedSignedAttestationV1,
  type ReadAndVerifySignedAttestationEnvelopeRequestV1,
  type ReadAndVerifySignedAttestationEnvelopeResultV1,
  type SignedAttestationEnvelopeReaderErrorCode,
  SignedAttestationEnvelopeReaderError,
  canonicalSignedAttestationPayloadBytesV1,
  canonicalSignedAttestationEnvelopeBytesV1,
  parseSignedAttestationEnvelopeV1,
} from '@jigwright/core/signed-attestation-envelope-codec';

/**
 * Parse, run caller-owned domain/policy validation, then invoke one exact
 * verifier namespace and return a typed receipt. There is no namespace retry.
 */
export function readAndVerifySignedAttestationEnvelopeV1<
  Payload extends VersionedSignedAttestationPayloadV1,
  SignatureNamespace extends string,
>(
  request: ReadAndVerifySignedAttestationEnvelopeRequestV1<
    Payload,
    SignatureNamespace
  >,
): ReadAndVerifySignedAttestationEnvelopeResultV1<Payload, SignatureNamespace> {
  if (
    !isPlainRecord(request) ||
    typeof request.validatePayload !== 'function' ||
    typeof request.signer !== 'function' ||
    !isNonEmptyString(request.signatureNamespace) ||
    !isStringSet(request.allowedSignatureNamespaces) ||
    typeof request.verifier?.verify !== 'function'
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_READER_INPUT_INVALID',
      'Signed attestation reader request is invalid.',
    );
  }
  if (
    request.readerContractVersion !==
    SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_READER_CONTRACT_UNSUPPORTED',
      'Signed attestation reader contract version is unsupported.',
    );
  }
  if (
    !request.allowedSignatureNamespaces.includes(request.signatureNamespace)
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNATURE_NAMESPACE_UNSUPPORTED',
      'Signed attestation signature namespace is unsupported.',
    );
  }

  const envelope = parseSignedAttestationEnvelopeV1(request.raw, request.codec);
  request.validatePayload(envelope.payload);
  const signer = request.signer(envelope.payload);
  if (!isNonEmptyString(signer)) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNER_INVALID',
      'Signed attestation signer is invalid.',
    );
  }
  const canonicalPayload = canonicalSignedAttestationPayloadBytesV1(
    envelope.payload,
    request.codec,
  );
  try {
    request.verifier.verify(
      canonicalPayload,
      envelope.signature,
      signer,
      request.signatureNamespace,
    );
  } catch (cause) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNATURE_INVALID',
      'Signed attestation signature is invalid.',
      cause,
    );
  }

  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    readerContractVersion:
      SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
    payloadVersion: 1 as const,
    signatureNamespace: request.signatureNamespace,
    signer,
    signedPayloadDigest: sha256(canonicalPayload),
    signatureDigest: sha256(envelope.signature),
  });
  const verification = Object.freeze({
    kind: VERIFIED_SIGNED_ATTESTATION_KIND_V1,
    receipt,
    receiptDigest: sha256(`${JSON.stringify(receipt)}\n`),
  });
  return Object.freeze({ envelope, verification });
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
