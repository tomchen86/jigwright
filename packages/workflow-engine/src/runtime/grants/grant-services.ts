/** Binds domain Grant services to the optional package's lazy operations. */
import { createCollaborationGrantCodec } from '../../modules/authority/collaboration-grant-codec.ts';
import { createRoleContextSharingGrantServices } from '../../modules/authority/role-context-sharing-grant.ts';
import { createConsumedRoleContextSharingReplayVerifier } from '../../modules/authority/role-context-sharing-consumed-replay.ts';
import * as optionalGrants from './optional-grants-package.ts';

export const collaborationGrantCodec =
  createCollaborationGrantCodec(optionalGrants);
export const {
  canonicalCollaborationGrantPayload,
  collaborationGrantSignatureNamespace,
  canonicalCollaborationGrantEnvelope,
  collaborationGrantEnvelopeDigest,
  canonicalDirectHumanReviewPayload,
  canonicalDirectHumanReviewAttestation,
  directHumanReviewAttestationDigest,
  parseDirectHumanReviewAttestation,
  parseCollaborationGrantEnvelope,
  assertUniqueCollaborationGrantUses,
  validateDirectHumanReviewAttestation,
  validateCollaborationGrantEnvelope,
  verifyCollaborationGrantCapability,
} = collaborationGrantCodec;
export const roleContextSharingGrantServices =
  createRoleContextSharingGrantServices(optionalGrants);
export const {
  verifyRoleContextSharingGrantCapability,
  executeRoleContextSharingGrantTransitionV1,
} = roleContextSharingGrantServices;
export const verifyConsumedRoleContextSharingReplay =
  createConsumedRoleContextSharingReplayVerifier(optionalGrants);

import { createCollaborationGrantUseValidator } from '../../modules/authority/collaboration-grant-use.ts';
export const collaborationGrantUseValidator =
  createCollaborationGrantUseValidator(collaborationGrantCodec);
export const {
  validateCollaborationGrantUseProjection,
  validateCollaborationGrantUseSet,
  assertStoredUse,
  assertGrantedAssignment,
  assertDirectHumanAttestationReference,
  consumptionMatches,
} = collaborationGrantUseValidator;
