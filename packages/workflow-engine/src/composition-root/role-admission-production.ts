/** Binds role admission to the optional Grant codec and private consumed-use reader. */
import { createRoleScheduler } from '../modules/provider-orchestration/role-scheduler.ts';
import {
  collaborationGrantCodec,
  collaborationGrantUseValidator,
} from '../runtime/grants/grant-services.ts';
import {
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
} from '../runtime/grants/optional-grants-package.ts';
import { consumedCollaborationGrantUseForReplay } from '../runtime/storage-journal/collaboration-grant-consumption.ts';

export const roleResultAdmission = createRoleScheduler({
  ...collaborationGrantCodec,
  ...collaborationGrantUseValidator,
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
  consumedCollaborationGrantUseForReplay,
});
export const {
  authorizeGrantedOrdinaryRole,
  assertAdmittedRoleResultRecord,
  admitRoleResult,
  admitConsumedRoleResultReplay,
  admitRoleContextSharingResult,
  normalizeRoleContextSharingResultAdmissionBinding,
  admitConsumedRoleContextSharingResultReplay,
  isGrantedSameProviderRoleAssignment,
} = roleResultAdmission;
