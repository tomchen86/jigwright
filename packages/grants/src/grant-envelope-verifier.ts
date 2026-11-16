/**
 * Verifies exact Grant namespace and effect allowlists, invokes the supplied
 * verifier and mints the module-private branded capability.
 */
import crypto from 'node:crypto';

import {
  GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
  VERIFIED_GRANT_CAPABILITY_KIND_V1,
  type GrantEnvelopeVerificationRequestV1,
  type GrantVerificationReceiptV1,
  type GrantEnvelopeVerificationErrorCode,
} from '@jigwright/core/grant-envelope-contracts';

export {
  GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
  VERIFIED_GRANT_CAPABILITY_KIND_V1,
  type GrantSignatureVerifierPortV1,
  type GrantEnvelopeVerificationRequestV1,
  type GrantVerificationReceiptV1,
  type GrantEnvelopeVerificationErrorCode,
} from '@jigwright/core/grant-envelope-contracts';

const verifiedGrantCapabilityBrand: unique symbol = Symbol(
  VERIFIED_GRANT_CAPABILITY_KIND_V1,
);

export type VerifiedGrantCapabilityV1<
  AuthorizedEffect extends string = string,
  SignatureNamespace extends string = string,
> = Readonly<{
  kind: typeof VERIFIED_GRANT_CAPABILITY_KIND_V1;
  [verifiedGrantCapabilityBrand]: true;
  receipt: GrantVerificationReceiptV1<AuthorizedEffect, SignatureNamespace>;
  receiptDigest: string;
}>;

export class GrantEnvelopeVerificationError extends Error {
  readonly code: GrantEnvelopeVerificationErrorCode;

  constructor(
    code: GrantEnvelopeVerificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GrantEnvelopeVerificationError';
    this.code = code;
  }
}

/**
 * Verify exact caller-canonicalized bytes against an explicit namespace and
 * effect allowlist. Domain packages remain responsible for parsing, canonical
 * byte production, policy/binding checks, and trusted verifier composition.
 */
export function verifyGrantEnvelopeV1<
  AuthorizedEffect extends string,
  SignatureNamespace extends string,
>(
  request: GrantEnvelopeVerificationRequestV1<
    AuthorizedEffect,
    SignatureNamespace
  >,
): VerifiedGrantCapabilityV1<AuthorizedEffect, SignatureNamespace> {
  if (
    !isNonEmptyString(request.canonicalPayload) ||
    !isNonEmptyString(request.signature) ||
    !isNonEmptyString(request.signer) ||
    !isNonEmptyString(request.signatureNamespace) ||
    !isNonEmptyString(request.authorizedEffect) ||
    !isStringSet(request.allowedSignatureNamespaces) ||
    !isStringSet(request.allowedAuthorizedEffects) ||
    typeof request.verifier?.verify !== 'function'
  ) {
    throw verificationError(
      'GRANT_VERIFICATION_INPUT_INVALID',
      'Grant verification input is invalid.',
    );
  }
  if (request.contractVersion !== GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1) {
    throw verificationError(
      'GRANT_VERIFIER_CONTRACT_UNSUPPORTED',
      'Grant verifier contract version is unsupported.',
    );
  }
  if (
    !request.allowedSignatureNamespaces.includes(request.signatureNamespace)
  ) {
    throw verificationError(
      'GRANT_SIGNATURE_NAMESPACE_UNSUPPORTED',
      'Grant signature namespace is unsupported.',
    );
  }
  if (!request.allowedAuthorizedEffects.includes(request.authorizedEffect)) {
    throw verificationError(
      'GRANT_AUTHORIZED_EFFECT_UNSUPPORTED',
      'Grant authorized effect is unsupported.',
    );
  }

  try {
    request.verifier.verify(
      request.canonicalPayload,
      request.signature,
      request.signer,
      request.signatureNamespace,
    );
  } catch (cause) {
    throw verificationError(
      'GRANT_SIGNATURE_INVALID',
      'Grant signature is invalid.',
      cause,
    );
  }

  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    verifierContractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
    signatureNamespace: request.signatureNamespace,
    authorizedEffect: request.authorizedEffect,
    signer: request.signer,
    signedPayloadDigest: sha256(request.canonicalPayload),
    signatureDigest: sha256(request.signature),
  });
  return Object.freeze({
    kind: VERIFIED_GRANT_CAPABILITY_KIND_V1,
    [verifiedGrantCapabilityBrand]: true as const,
    receipt,
    receiptDigest: sha256(`${JSON.stringify(receipt)}\n`),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringSet(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verificationError(
  code: GrantEnvelopeVerificationErrorCode,
  message: string,
  cause?: unknown,
): GrantEnvelopeVerificationError {
  return new GrantEnvelopeVerificationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
