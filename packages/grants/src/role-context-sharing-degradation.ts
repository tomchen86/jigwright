/**
 * Verifies role-context-sharing Grant bindings and domain admission before minting
 * a branded capability through the optional Grant verifier.
 */
import {
  GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
  GrantEnvelopeVerificationError,
  verifyGrantEnvelopeV1,
  type VerifiedGrantCapabilityV1,
} from './grant-envelope-verifier.ts';

import {
  ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  VERIFIED_ROLE_CONTEXT_SHARING_GRANT_KIND_V1,
  type RoleContextSharingGrantEnvelopeV1,
  type VerifyRoleContextSharingGrantRequestV1,
  canonicalRoleContextSharingGrantPayloadV1,
  parseRoleContextSharingGrantEnvelopeV1,
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalBinding,
  isPlainRecord,
  roleContextError,
  deepFreeze,
} from '@jigwright/core/role-context-sharing-grant-codec';

export {
  ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  VERIFIED_ROLE_CONTEXT_SHARING_GRANT_KIND_V1,
  ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1,
  type RoleContextSharingRolePairV1,
  type RoleContextSharingGrantPayloadV1,
  type RoleContextSharingGrantEnvelopeV1,
  type RoleContextSharingGrantExpectedBindingV1,
  type VerifyRoleContextSharingGrantRequestV1,
  type RoleContextSharingGrantErrorCode,
  RoleContextSharingGrantError,
  canonicalRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
  parseRoleContextSharingGrantEnvelopeV1,
  bindingFromRoleContextSharingGrantPayloadV1,
} from '@jigwright/core/role-context-sharing-grant-codec';

export type VerifiedRoleContextSharingGrantCapabilityV1 = Readonly<{
  kind: typeof VERIFIED_ROLE_CONTEXT_SHARING_GRANT_KIND_V1;
  envelope: RoleContextSharingGrantEnvelopeV1;
  verification: VerifiedGrantCapabilityV1<
    typeof ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    typeof ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1
  >;
}>;

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
