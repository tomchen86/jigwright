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
function isNamedCodedError(error, name) {
    return (error instanceof Error &&
        error.name === name &&
        'code' in error &&
        typeof error.code === 'string');
}
