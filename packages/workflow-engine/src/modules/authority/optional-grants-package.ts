import { createRequire } from 'node:module';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
type CollaborationGrantEnvelopeReaderModule =
  typeof import('@jigwright/grants/collaboration-grant-envelope-reader');
type GrantEnvelopeVerifierModule =
  typeof import('@jigwright/grants/grant-envelope-verifier');
type GrantLifecycleModule = typeof import('@jigwright/grants/grant-lifecycle');
type RoleContextSharingDegradationModule =
  typeof import('@jigwright/grants/role-context-sharing-degradation');
type SignedAttestationEnvelopeReaderModule =
  typeof import('@jigwright/grants/signed-attestation-envelope-reader');

type OptionalGrantModule =
  | CollaborationGrantEnvelopeReaderModule
  | GrantEnvelopeVerifierModule
  | GrantLifecycleModule
  | RoleContextSharingDegradationModule
  | SignedAttestationEnvelopeReaderModule;

export type CollaborationGrantPayloadCodecV1<
  Payload extends
    import('@jigwright/grants/collaboration-grant-envelope-reader').VersionedCollaborationGrantPayload,
> =
  import('@jigwright/grants/collaboration-grant-envelope-reader').CollaborationGrantPayloadCodecV1<Payload>;
export type VerifiedGrantCapabilityV1<
  AuthorizedEffect extends string = string,
  SignatureNamespace extends string = string,
> = import('@jigwright/grants/grant-envelope-verifier').VerifiedGrantCapabilityV1<
  AuthorizedEffect,
  SignatureNamespace
>;
export type SignedAttestationPayloadCodecV1<
  Payload extends
    import('@jigwright/grants/signed-attestation-envelope-reader').VersionedSignedAttestationPayloadV1,
> =
  import('@jigwright/grants/signed-attestation-envelope-reader').SignedAttestationPayloadCodecV1<Payload>;
export type GrantLifecycleAuditReceiptV1 =
  import('@jigwright/grants/grant-lifecycle').GrantLifecycleAuditReceiptV1;
export type GrantLifecycleClockPortV1 =
  import('@jigwright/grants/grant-lifecycle').GrantLifecycleClockPortV1;
export type GrantLifecycleState =
  import('@jigwright/grants/grant-lifecycle').GrantLifecycleState;
export type GrantLifecycleStoragePortV1<Validation, Persisted> =
  import('@jigwright/grants/grant-lifecycle').GrantLifecycleStoragePortV1<
    Validation,
    Persisted
  >;
export type GrantLifecycleTransitionResultV1<Persisted> =
  import('@jigwright/grants/grant-lifecycle').GrantLifecycleTransitionResultV1<Persisted>;
export type RoleContextSharingGrantEnvelopeV1 =
  import('@jigwright/grants/role-context-sharing-degradation').RoleContextSharingGrantEnvelopeV1;
export type RoleContextSharingGrantExpectedBindingV1 =
  import('@jigwright/grants/role-context-sharing-degradation').RoleContextSharingGrantExpectedBindingV1;
export type RoleContextSharingGrantPayloadV1 =
  import('@jigwright/grants/role-context-sharing-degradation').RoleContextSharingGrantPayloadV1;
export type RoleContextSharingRolePairV1 =
  import('@jigwright/grants/role-context-sharing-degradation').RoleContextSharingRolePairV1;
export type VerifiedRoleContextSharingGrantCapabilityV1 =
  import('@jigwright/grants/role-context-sharing-degradation').VerifiedRoleContextSharingGrantCapabilityV1;

const optionalRequire = createRequire(import.meta.url);
const loadedModules = new Map<string, OptionalGrantModule>();

export const COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1 =
  'jigwright.collaboration-grant-envelope-reader.v1' as const;
export const COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE =
  'workflow.collaboration-grant.v1' as const;
export const COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE =
  'workflow.collaboration-grant.v2' as const;
export const GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1 =
  'jigwright.grant-envelope-verifier.v1' as const;
export const GRANT_LIFECYCLE_CONTRACT_VERSION_V1 =
  'jigwright.grant-lifecycle.v1' as const;
export const GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1 =
  'jigwright.grant-lifecycle-audit-receipt.v1' as const;
export const ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1 =
  'jigwright.role-context-sharing-grant-reader.v1' as const;
export const ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1 =
  'workflow.role-context-sharing-grant.v1' as const;
export const ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1 =
  'role-context-sharing-degradation' as const;
export const ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1 = Object.freeze([
  'author-builder',
  'author-reviewer',
  'builder-reviewer',
] as const);
export const SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1 =
  'jigwright.signed-attestation-envelope-reader.v1' as const;

export const canonicalCollaborationGrantEnvelopeBytesV1 = delegate(
  loadCollaborationGrantEnvelopeReader,
  'canonicalCollaborationGrantEnvelopeBytesV1',
);
export const canonicalCollaborationGrantPayloadBytesV1 = delegate(
  loadCollaborationGrantEnvelopeReader,
  'canonicalCollaborationGrantPayloadBytesV1',
);
export const parseCollaborationGrantEnvelopeV1 = delegate(
  loadCollaborationGrantEnvelopeReader,
  'parseCollaborationGrantEnvelopeV1',
);
export const readAndVerifyCollaborationGrantEnvelopeV1 = delegate(
  loadCollaborationGrantEnvelopeReader,
  'readAndVerifyCollaborationGrantEnvelopeV1',
);
export const selectCollaborationGrantSignatureNamespaceV1 = delegate(
  loadCollaborationGrantEnvelopeReader,
  'selectCollaborationGrantSignatureNamespaceV1',
);

export const executeGrantLifecycleTransitionV1 = delegate(
  loadGrantLifecycle,
  'executeGrantLifecycleTransitionV1',
);

export const bindingFromRoleContextSharingGrantPayloadV1 = delegate(
  loadRoleContextSharingDegradation,
  'bindingFromRoleContextSharingGrantPayloadV1',
);
export const canonicalRoleContextSharingGrantEnvelopeV1 = delegate(
  loadRoleContextSharingDegradation,
  'canonicalRoleContextSharingGrantEnvelopeV1',
);
export const canonicalRoleContextSharingGrantPayloadV1 = delegate(
  loadRoleContextSharingDegradation,
  'canonicalRoleContextSharingGrantPayloadV1',
);
export const verifyRoleContextSharingGrantCapabilityV1 = delegate(
  loadRoleContextSharingDegradation,
  'verifyRoleContextSharingGrantCapabilityV1',
);

export const canonicalSignedAttestationEnvelopeBytesV1 = delegate(
  loadSignedAttestationEnvelopeReader,
  'canonicalSignedAttestationEnvelopeBytesV1',
);
export const canonicalSignedAttestationPayloadBytesV1 = delegate(
  loadSignedAttestationEnvelopeReader,
  'canonicalSignedAttestationPayloadBytesV1',
);
export const parseSignedAttestationEnvelopeV1 = delegate(
  loadSignedAttestationEnvelopeReader,
  'parseSignedAttestationEnvelopeV1',
);
export const readAndVerifySignedAttestationEnvelopeV1 = delegate(
  loadSignedAttestationEnvelopeReader,
  'readAndVerifySignedAttestationEnvelopeV1',
);

export function assertOptionalGrantsPackageAvailable(): void {
  loadGrantEnvelopeVerifier();
}

export function isCollaborationGrantEnvelopeReaderError(
  error: unknown,
): error is Error & { readonly code: string } {
  return isNamedCodedError(error, 'CollaborationGrantEnvelopeReaderError');
}

export function isGrantLifecycleTransitionError(
  error: unknown,
): error is Error & { readonly code: string } {
  return isNamedCodedError(error, 'GrantLifecycleTransitionError');
}

export function isRoleContextSharingGrantError(
  error: unknown,
): error is Error & { readonly code: string } {
  return isNamedCodedError(error, 'RoleContextSharingGrantError');
}

export function isSignedAttestationEnvelopeReaderError(
  error: unknown,
): error is Error & { readonly code: string } {
  return isNamedCodedError(error, 'SignedAttestationEnvelopeReaderError');
}

function loadCollaborationGrantEnvelopeReader(): CollaborationGrantEnvelopeReaderModule {
  return loadOptionalModule(
    '@jigwright/grants/collaboration-grant-envelope-reader',
  );
}

function loadGrantEnvelopeVerifier(): GrantEnvelopeVerifierModule {
  return loadOptionalModule('@jigwright/grants/grant-envelope-verifier');
}

function loadGrantLifecycle(): GrantLifecycleModule {
  return loadOptionalModule('@jigwright/grants/grant-lifecycle');
}

function loadRoleContextSharingDegradation(): RoleContextSharingDegradationModule {
  return loadOptionalModule(
    '@jigwright/grants/role-context-sharing-degradation',
  );
}

function loadSignedAttestationEnvelopeReader(): SignedAttestationEnvelopeReaderModule {
  return loadOptionalModule(
    '@jigwright/grants/signed-attestation-envelope-reader',
  );
}

function loadOptionalModule<Module extends OptionalGrantModule>(
  specifier: string,
): Module {
  const loaded = loadedModules.get(specifier);
  if (loaded !== undefined) return loaded as Module;
  try {
    const resolved = optionalRequire(specifier) as Module;
    loadedModules.set(specifier, resolved);
    return resolved;
  } catch (error) {
    if (isMissingOptionalGrantsPackage(error)) {
      throw workflowError(
        'JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE',
        'This route requires the optional @jigwright/grants package. Install that package before using grant functionality.',
        ExitCode.guard,
        { details: { packageName: '@jigwright/grants' } },
      );
    }
    throw error;
  }
}

function delegate<Module extends OptionalGrantModule, Key extends keyof Module>(
  load: () => Module,
  key: Key,
): Module[Key] {
  return ((...args: unknown[]) => {
    const implementation = load()[key];
    if (typeof implementation !== 'function') {
      throw workflowError(
        'JIGWRIGHT_OPTIONAL_GRANTS_EXPORT_INVALID',
        `The optional @jigwright/grants export ${String(key)} is unavailable.`,
        ExitCode.verification,
      );
    }
    return (implementation as unknown as (...values: unknown[]) => unknown)(
      ...args,
    );
  }) as unknown as Module[Key];
}

function isMissingOptionalGrantsPackage(error: unknown): boolean {
  if (
    error === null ||
    typeof error !== 'object' ||
    !('code' in error) ||
    !('message' in error)
  ) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    message.includes('@jigwright/grants')
  );
}

function isNamedCodedError(
  error: unknown,
  name: string,
): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    error.name === name &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
