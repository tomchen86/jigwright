/** Binds Collaboration Grant issuance and direct-human review to the production signer. */
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import { createCollaborationGrantIssuance } from '../runtime/grants/collaboration-grant-issuance.ts';
import { collaborationGrantStorePaths } from '../runtime/storage-journal/collaboration-grant-private-files.ts';
import { storeAvailableCollaborationGrant } from '../runtime/storage-journal/collaboration-grant-reservation.ts';

export const {
  issueCollaborationGrant,
  prepareCollaborationGrantIssue,
  createDirectHumanReviewAttestation,
} = createCollaborationGrantIssuance({
  createSigner: createInteractiveSshSigner,
  collaborationGrantStorePaths,
  storeAvailableCollaborationGrant,
});
