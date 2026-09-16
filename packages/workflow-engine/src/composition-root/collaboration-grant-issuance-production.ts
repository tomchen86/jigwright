/** Binds Collaboration Grant issuance and direct-human review to the production signer. */
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import { createCollaborationGrantIssuance } from '../runtime/grants/collaboration-grant-issuance.ts';

export const {
  issueCollaborationGrant,
  prepareCollaborationGrantIssue,
  createDirectHumanReviewAttestation,
} = createCollaborationGrantIssuance(createInteractiveSshSigner);
