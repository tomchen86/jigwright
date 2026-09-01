import { createRequire } from 'node:module';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
const optionalRequire = createRequire(import.meta.url);
const loadedModules = new Map();
export const COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1 = 'jigwright.collaboration-grant-envelope-reader.v1';
export const COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE = 'workflow.collaboration-grant.v2';
export const GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1 = 'jigwright.grant-envelope-verifier.v1';
export const GRANT_LIFECYCLE_CONTRACT_VERSION_V1 = 'jigwright.grant-lifecycle.v1';
export const GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1 = 'jigwright.grant-lifecycle-audit-receipt.v1';
export const ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1 = 'jigwright.role-context-sharing-grant-reader.v1';
export const ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1 = 'workflow.role-context-sharing-grant.v1';
export const ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1 = 'role-context-sharing-degradation';
export const ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1 = Object.freeze([
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
]);
export const SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1 = 'jigwright.signed-attestation-envelope-reader.v1';
export const canonicalCollaborationGrantEnvelopeBytesV1 = delegate(loadCollaborationGrantEnvelopeReader, 'canonicalCollaborationGrantEnvelopeBytesV1');
export const canonicalCollaborationGrantPayloadBytesV1 = delegate(loadCollaborationGrantEnvelopeReader, 'canonicalCollaborationGrantPayloadBytesV1');
export const parseCollaborationGrantEnvelopeV1 = delegate(loadCollaborationGrantEnvelopeReader, 'parseCollaborationGrantEnvelopeV1');
export const readAndVerifyCollaborationGrantEnvelopeV1 = delegate(loadCollaborationGrantEnvelopeReader, 'readAndVerifyCollaborationGrantEnvelopeV1');
export const selectCollaborationGrantSignatureNamespaceV1 = delegate(loadCollaborationGrantEnvelopeReader, 'selectCollaborationGrantSignatureNamespaceV1');
export const executeGrantLifecycleTransitionV1 = delegate(loadGrantLifecycle, 'executeGrantLifecycleTransitionV1');
export const assertUniqueGrantUseClaimsV1 = delegate(loadGrantLifecycle, 'assertUniqueGrantUseClaimsV1');
export const bindingFromRoleContextSharingGrantPayloadV1 = delegate(loadRoleContextSharingDegradation, 'bindingFromRoleContextSharingGrantPayloadV1');
export const canonicalRoleContextSharingGrantEnvelopeV1 = delegate(loadRoleContextSharingDegradation, 'canonicalRoleContextSharingGrantEnvelopeV1');
export const canonicalRoleContextSharingGrantPayloadV1 = delegate(loadRoleContextSharingDegradation, 'canonicalRoleContextSharingGrantPayloadV1');
export const verifyRoleContextSharingGrantCapabilityV1 = delegate(loadRoleContextSharingDegradation, 'verifyRoleContextSharingGrantCapabilityV1');
export const canonicalSignedAttestationEnvelopeBytesV1 = delegate(loadSignedAttestationEnvelopeReader, 'canonicalSignedAttestationEnvelopeBytesV1');
export const canonicalSignedAttestationPayloadBytesV1 = delegate(loadSignedAttestationEnvelopeReader, 'canonicalSignedAttestationPayloadBytesV1');
export const parseSignedAttestationEnvelopeV1 = delegate(loadSignedAttestationEnvelopeReader, 'parseSignedAttestationEnvelopeV1');
export const readAndVerifySignedAttestationEnvelopeV1 = delegate(loadSignedAttestationEnvelopeReader, 'readAndVerifySignedAttestationEnvelopeV1');
export function assertOptionalGrantsPackageAvailable() {
    loadGrantEnvelopeVerifier();
}
export function isCollaborationGrantEnvelopeReaderError(error) {
    return isNamedCodedError(error, 'CollaborationGrantEnvelopeReaderError');
}
export function isGrantLifecycleTransitionError(error) {
    return isNamedCodedError(error, 'GrantLifecycleTransitionError');
}
export function isGrantUseUniquenessError(error) {
    return isNamedCodedError(error, 'GrantUseUniquenessError');
}
export function isRoleContextSharingGrantError(error) {
    return isNamedCodedError(error, 'RoleContextSharingGrantError');
}
export function isSignedAttestationEnvelopeReaderError(error) {
    return isNamedCodedError(error, 'SignedAttestationEnvelopeReaderError');
}
function loadCollaborationGrantEnvelopeReader() {
    return loadOptionalModule('@jigwright/grants/collaboration-grant-envelope-reader');
}
function loadGrantEnvelopeVerifier() {
    return loadOptionalModule('@jigwright/grants/grant-envelope-verifier');
}
function loadGrantLifecycle() {
    return loadOptionalModule('@jigwright/grants/grant-lifecycle');
}
function loadRoleContextSharingDegradation() {
    return loadOptionalModule('@jigwright/grants/role-context-sharing-degradation');
}
function loadSignedAttestationEnvelopeReader() {
    return loadOptionalModule('@jigwright/grants/signed-attestation-envelope-reader');
}
function loadOptionalModule(specifier) {
    const loaded = loadedModules.get(specifier);
    if (loaded !== undefined)
        return loaded;
    try {
        const resolved = optionalRequire(specifier);
        loadedModules.set(specifier, resolved);
        return resolved;
    }
    catch (error) {
        if (isMissingOptionalGrantsPackage(error)) {
            throw workflowError('JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE', 'This route requires the optional @jigwright/grants package. Install that package before using grant functionality.', ExitCode.guard, { details: { packageName: '@jigwright/grants' } });
        }
        throw error;
    }
}
function delegate(load, key) {
    return ((...args) => {
        const implementation = load()[key];
        if (typeof implementation !== 'function') {
            throw workflowError('JIGWRIGHT_OPTIONAL_GRANTS_EXPORT_INVALID', `The optional @jigwright/grants export ${String(key)} is unavailable.`, ExitCode.verification);
        }
        return implementation(...args);
    });
}
function isMissingOptionalGrantsPackage(error) {
    if (error === null ||
        typeof error !== 'object' ||
        !('code' in error) ||
        !('message' in error)) {
        return false;
    }
    const code = error.code;
    const message = error.message;
    return ((code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
        typeof message === 'string' &&
        message.includes('@jigwright/grants'));
}
function isNamedCodedError(error, name) {
    return (error instanceof Error &&
        error.name === name &&
        'code' in error &&
        typeof error.code === 'string');
}
