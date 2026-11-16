/** Supplied authority/contract capabilities, including distinct construction-time method captures. */
import type { TaskStrategyCorrectionProjection } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type {
  CollaborationGrantCodec,
  DirectHumanReviewAttestationIssuer,
} from '../../modules/authority/collaboration-grant-codec.ts';
import type { TaskMandateProviderAdmission } from '../../modules/authority/task-mandate-access-contract.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
export type TaskDiffReviewCapabilities = Readonly<{
  changeContract: ChangeContractServices;
  resolveCurrentTaskStrategyCorrection: (
    inspection: SessionInspection,
  ) => TaskStrategyCorrectionProjection;
  createDirectHumanReviewAttestation: DirectHumanReviewAttestationIssuer;
  externalBindingAdmitConsumedRoleResultReplay: RoleAdmissionServices['admitConsumedRoleResultReplay'];
  externalBindingCollaborationGrantEnvelopeDigest: CollaborationGrantCodec['collaborationGrantEnvelopeDigest'];
  externalContinuationBindingAdmitConsumedRoleResultReplay: RoleAdmissionServices['admitConsumedRoleResultReplay'];
  providerBindingAdmitConsumedRoleResultReplay: RoleAdmissionServices['admitConsumedRoleResultReplay'];
  providerBindingAdmitRoleResult: RoleAdmissionServices['admitRoleResult'];
  providerBindingParseCollaborationGrantEnvelope: CollaborationGrantCodec['parseCollaborationGrantEnvelope'];
  providerBindingCanonicalCollaborationGrantEnvelope: CollaborationGrantCodec['canonicalCollaborationGrantEnvelope'];
  providerReservationsAuthorizeTaskMandateProviderReservationUnderLifecycleLock: TaskMandateProviderAdmission['authorizeTaskMandateProviderReservationUnderLifecycleLock'];
  providerReservationsAuthorizeGrantedOrdinaryRole: RoleAdmissionServices['authorizeGrantedOrdinaryRole'];
  providerCommandsAdmitRoleResult: RoleAdmissionServices['admitRoleResult'];
  externalCommandsAuthorizeGrantedOrdinaryRole: RoleAdmissionServices['authorizeGrantedOrdinaryRole'];
  externalCommandsAdmitRoleResult: RoleAdmissionServices['admitRoleResult'];
  externalCommandsAdmitConsumedRoleResultReplay: RoleAdmissionServices['admitConsumedRoleResultReplay'];
  externalCommandsCollaborationGrantEnvelopeDigest: CollaborationGrantCodec['collaborationGrantEnvelopeDigest'];
}>;
