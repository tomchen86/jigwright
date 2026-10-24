/** Shared attestation request and grant admission errors. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
export const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function invalidRequest(message: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_INVALID',
    message,
    ExitCode.guard,
  );
}

export function grantMissing(identity: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_GRANT_MISSING',
    `No protected maintainer grant is bound to ${identity}.`,
    ExitCode.guard,
  );
}

export function grantInvalid(grantId: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_GRANT_INVALID',
    `Maintainer grant ${grantId} does not match its attested binding.`,
    ExitCode.guard,
  );
}
