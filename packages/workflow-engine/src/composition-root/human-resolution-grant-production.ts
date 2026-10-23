/** Binds live human-resolution Grant revocation to its verifier and revoker. */
import { revokeHumanResolutionGrant as revoke } from '../runtime/grant-management/human-resolution-grant-management.ts';
import {
  revokeStoredHumanResolutionGrant,
  verifyHumanResolutionGrantForRevocation,
} from './human-revocation-production.ts';

export {
  inspectHumanResolutionGrants,
  inspectHumanResolutionGrantPublicationRecoveries,
  discardHumanResolutionGrantPublication,
} from '../runtime/grant-management/human-resolution-grant-management.ts';

export const revokeHumanResolutionGrant = revoke.bind(
  undefined,
  verifyHumanResolutionGrantForRevocation,
  revokeStoredHumanResolutionGrant,
);
