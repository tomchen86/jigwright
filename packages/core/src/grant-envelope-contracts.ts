/**
 * Defines Grant verification requests, protocol identifiers and unbranded
 * receipts. Branded capabilities remain owned by the optional Grant
 * verifier.
 */
import type { GrantVerifierPort } from './grant-verifier-port.ts';

export const GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1 =
  'jigwright.grant-envelope-verifier.v1' as const;

export const VERIFIED_GRANT_CAPABILITY_KIND_V1 =
  'jigwright.verified-grant-capability.v1' as const;

export type GrantSignatureVerifierPortV1 = GrantVerifierPort;

export type GrantEnvelopeVerificationRequestV1<
  AuthorizedEffect extends string,
  SignatureNamespace extends string,
> = Readonly<{
  contractVersion: string;
  canonicalPayload: string;
  signature: string;
  signer: string;
  signatureNamespace: SignatureNamespace;
  authorizedEffect: AuthorizedEffect;
  allowedSignatureNamespaces: readonly string[];
  allowedAuthorizedEffects: readonly string[];
  verifier: GrantSignatureVerifierPortV1;
}>;

export type GrantVerificationReceiptV1<
  AuthorizedEffect extends string,
  SignatureNamespace extends string,
> = Readonly<{
  schemaVersion: 1;
  verifierContractVersion: typeof GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1;
  signatureNamespace: SignatureNamespace;
  authorizedEffect: AuthorizedEffect;
  signer: string;
  signedPayloadDigest: string;
  signatureDigest: string;
}>;

export type GrantEnvelopeVerificationErrorCode =
  | 'GRANT_VERIFICATION_INPUT_INVALID'
  | 'GRANT_VERIFIER_CONTRACT_UNSUPPORTED'
  | 'GRANT_SIGNATURE_NAMESPACE_UNSUPPORTED'
  | 'GRANT_AUTHORIZED_EFFECT_UNSUPPORTED'
  | 'GRANT_SIGNATURE_INVALID';
