/**
 * Loads optional Grant implementations on demand and exposes their public
 * contract operations.
 *
 * Invariants:
 * - Successfully loaded optional submodules are cached by specifier; failed
 *   loads do not populate the cache.
 * - A missing @jigwright/grants package is surfaced as
 *   workflowError('JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE') rather than the
 *   raw module-resolution error.
 */
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

const optionalRequire = createRequire(import.meta.url);
const loadedModules = new Map<string, OptionalGrantModule>();

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
export const assertUniqueGrantUseClaimsV1 = delegate(
  loadGrantLifecycle,
  'assertUniqueGrantUseClaimsV1',
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

function loadCollaborationGrantEnvelopeReader(): CollaborationGrantEnvelopeReaderModule {
  return loadOptionalModule(
    '@jigwright/grants/collaboration-grant-envelope-reader',
    () =>
      optionalRequire(
        '@jigwright/grants/collaboration-grant-envelope-reader',
      ) as CollaborationGrantEnvelopeReaderModule,
  );
}

function loadGrantEnvelopeVerifier(): GrantEnvelopeVerifierModule {
  return loadOptionalModule(
    '@jigwright/grants/grant-envelope-verifier',
    () =>
      optionalRequire(
        '@jigwright/grants/grant-envelope-verifier',
      ) as GrantEnvelopeVerifierModule,
  );
}

function loadGrantLifecycle(): GrantLifecycleModule {
  return loadOptionalModule(
    '@jigwright/grants/grant-lifecycle',
    () =>
      optionalRequire(
        '@jigwright/grants/grant-lifecycle',
      ) as GrantLifecycleModule,
  );
}

function loadRoleContextSharingDegradation(): RoleContextSharingDegradationModule {
  return loadOptionalModule(
    '@jigwright/grants/role-context-sharing-degradation',
    () =>
      optionalRequire(
        '@jigwright/grants/role-context-sharing-degradation',
      ) as RoleContextSharingDegradationModule,
  );
}

function loadSignedAttestationEnvelopeReader(): SignedAttestationEnvelopeReaderModule {
  return loadOptionalModule(
    '@jigwright/grants/signed-attestation-envelope-reader',
    () =>
      optionalRequire(
        '@jigwright/grants/signed-attestation-envelope-reader',
      ) as SignedAttestationEnvelopeReaderModule,
  );
}

function loadOptionalModule<Module extends OptionalGrantModule>(
  specifier: string,
  load: () => Module,
): Module {
  const loaded = loadedModules.get(specifier);
  if (loaded !== undefined) return loaded as Module;
  try {
    const resolved = load();
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
