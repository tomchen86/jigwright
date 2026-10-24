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

export function isGrantUseUniquenessError(
  error: unknown,
): error is Error & { readonly code: string } {
  return isNamedCodedError(error, 'GrantUseUniquenessError');
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
