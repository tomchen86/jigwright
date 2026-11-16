/** Owns the canonical maintainer Grant ID pattern and its exact admission error. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertMaintainerGrantId(requestedGrantId: string): string {
  if (
    typeof requestedGrantId !== 'string' ||
    !GRANT_ID.test(requestedGrantId)
  ) {
    throw invalidGrant('Maintainer grant ID is invalid.');
  }
  return requestedGrantId;
}

function invalidGrant(message: string) {
  return workflowError('MAINTAINER_GRANT_INVALID', message, ExitCode.guard);
}
