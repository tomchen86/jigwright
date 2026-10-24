import { collaborationGrantCodec } from '../runtime/grants/grant-services.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { createDirectHumanReviewAttestation } from './collaboration-grant-issuance-production.ts';
import { roleResultAdmission } from './role-admission-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { resolveCurrentTaskStrategyCorrection } from './task-strategy-correction-production.ts';

import type {
  TaskDiffReviewCompletionOperations,
  TaskDiffReviewProviderOperations,
} from '../modules/lifecycle/task-diff-review-contracts.ts';
import type { TaskDiffReviewCapabilities } from '../runtime/review-lifecycle/task-diff-review-capabilities.ts';
import {
  assertCurrentTaskDiffReviewSatisfied as assertCurrentTaskDiffReviewSatisfiedOperation,
  assertTaskDiffReviewCompletionGateSatisfied as assertTaskDiffReviewCompletionGateSatisfiedOperation,
  assertTaskDiffReviewProviderOwnerCurrent as assertTaskDiffReviewProviderOwnerCurrentOperation,
  deriveProtectedTaskApplyTaskDiffGrantContinuation as deriveProtectedTaskApplyTaskDiffGrantContinuationOperation,
  deriveProtectedTaskApplyTaskDiffProviderGrantContinuation as deriveProtectedTaskApplyTaskDiffProviderGrantContinuationOperation,
  loadTaskDiffDocumentationReviewCapture as loadTaskDiffDocumentationReviewCaptureOperation,
} from '../runtime/review-lifecycle/task-diff-review-completion.ts';
import { withTaskDiffReviewProviderLifecycleOperation } from '../runtime/review-lifecycle/task-diff-review-context.ts';
import {
  reconcileExternalTaskDiffReview as reconcileExternalTaskDiffReviewOperation,
  resumeDirectHumanTaskDiffReview as resumeDirectHumanTaskDiffReviewOperation,
  submitExternalTaskDiffReviewContinuation as submitExternalTaskDiffReviewContinuationOperation,
  submitExternalTaskDiffReview as submitExternalTaskDiffReviewOperation,
} from '../runtime/review-lifecycle/task-diff-review-external-commands.ts';
import { loadAuthenticatedExternalTaskDiffTerminalAssurance as loadAuthenticatedExternalTaskDiffTerminalAssuranceOperation } from '../runtime/review-lifecycle/task-diff-review-external-continuation-binding.ts';
import { inspectTaskDiffReviewStatus as inspectTaskDiffReviewStatusOperation } from '../runtime/review-lifecycle/task-diff-review-inspection.ts';
import {
  loadCurrentAuthenticatedTaskDiffReview as loadCurrentAuthenticatedTaskDiffReviewOperation,
  loadCurrentExternalTaskDiffTerminalAssurance as loadCurrentExternalTaskDiffTerminalAssuranceOperation,
} from '../runtime/review-lifecycle/task-diff-review-lineage.ts';
import {
  beginTaskDiffReviewContinuationFromInput as beginTaskDiffReviewContinuationFromInputOperation,
  beginTaskDiffReviewContinuation as beginTaskDiffReviewContinuationOperation,
  beginTaskDiffReview as beginTaskDiffReviewOperation,
  reconcileTaskDiffReviewContinuation as reconcileTaskDiffReviewContinuationOperation,
  reconcileTaskDiffReview as reconcileTaskDiffReviewOperation,
} from '../runtime/review-lifecycle/task-diff-review-provider-commands.ts';
import { inspectTaskDiffReviewSubject as inspectTaskDiffReviewSubjectOperation } from '../runtime/review-lifecycle/task-diff-review-subject.ts';

// Preserve distinct method reads in the original module-construction order.
const {
  admitConsumedRoleResultReplay: externalBindingAdmitConsumedRoleResultReplay,
} = roleResultAdmission;
const {
  collaborationGrantEnvelopeDigest:
    externalBindingCollaborationGrantEnvelopeDigest,
} = collaborationGrantCodec;
const {
  admitConsumedRoleResultReplay:
    externalContinuationBindingAdmitConsumedRoleResultReplay,
} = roleResultAdmission;
const {
  admitConsumedRoleResultReplay: providerBindingAdmitConsumedRoleResultReplay,
  admitRoleResult: providerBindingAdmitRoleResult,
} = roleResultAdmission;
const {
  parseCollaborationGrantEnvelope:
    providerBindingParseCollaborationGrantEnvelope,
  canonicalCollaborationGrantEnvelope:
    providerBindingCanonicalCollaborationGrantEnvelope,
} = collaborationGrantCodec;
const {
  authorizeTaskMandateProviderReservationUnderLifecycleLock:
    providerReservationsAuthorizeTaskMandateProviderReservationUnderLifecycleLock,
} = taskMandateOperations;
const {
  authorizeGrantedOrdinaryRole:
    providerReservationsAuthorizeGrantedOrdinaryRole,
} = roleResultAdmission;
const { admitRoleResult: providerCommandsAdmitRoleResult } =
  roleResultAdmission;
const {
  authorizeGrantedOrdinaryRole: externalCommandsAuthorizeGrantedOrdinaryRole,
  admitRoleResult: externalCommandsAdmitRoleResult,
  admitConsumedRoleResultReplay: externalCommandsAdmitConsumedRoleResultReplay,
} = roleResultAdmission;
const {
  collaborationGrantEnvelopeDigest:
    externalCommandsCollaborationGrantEnvelopeDigest,
} = collaborationGrantCodec;
const capabilities = {
  changeContract: productionChangeContract,
  resolveCurrentTaskStrategyCorrection,
  createDirectHumanReviewAttestation,
  externalBindingAdmitConsumedRoleResultReplay,
  externalBindingCollaborationGrantEnvelopeDigest,
  externalContinuationBindingAdmitConsumedRoleResultReplay,
  providerBindingAdmitConsumedRoleResultReplay,
  providerBindingAdmitRoleResult,
  providerBindingParseCollaborationGrantEnvelope,
  providerBindingCanonicalCollaborationGrantEnvelope,
  providerReservationsAuthorizeTaskMandateProviderReservationUnderLifecycleLock,
  providerReservationsAuthorizeGrantedOrdinaryRole,
  providerCommandsAdmitRoleResult,
  externalCommandsAuthorizeGrantedOrdinaryRole,
  externalCommandsAdmitRoleResult,
  externalCommandsAdmitConsumedRoleResultReplay,
  externalCommandsCollaborationGrantEnvelopeDigest,
} satisfies TaskDiffReviewCapabilities;
const operations = {
  withTaskDiffReviewProviderLifecycleOperation,
  beginTaskDiffReview: beginTaskDiffReviewOperation.bind(
    undefined,
    capabilities,
  ),
  submitExternalTaskDiffReview: submitExternalTaskDiffReviewOperation.bind(
    undefined,
    capabilities,
  ),
  submitExternalTaskDiffReviewContinuation:
    submitExternalTaskDiffReviewContinuationOperation.bind(
      undefined,
      capabilities,
    ),
  reconcileExternalTaskDiffReview:
    reconcileExternalTaskDiffReviewOperation.bind(undefined, capabilities),
  resumeDirectHumanTaskDiffReview:
    resumeDirectHumanTaskDiffReviewOperation.bind(undefined, capabilities),
  loadCurrentExternalTaskDiffTerminalAssurance:
    loadCurrentExternalTaskDiffTerminalAssuranceOperation.bind(
      undefined,
      capabilities,
    ),
  loadAuthenticatedExternalTaskDiffTerminalAssurance:
    loadAuthenticatedExternalTaskDiffTerminalAssuranceOperation.bind(
      undefined,
      capabilities,
    ),
  inspectTaskDiffReviewStatus: inspectTaskDiffReviewStatusOperation.bind(
    undefined,
    capabilities,
  ),
  loadCurrentAuthenticatedTaskDiffReview:
    loadCurrentAuthenticatedTaskDiffReviewOperation.bind(
      undefined,
      capabilities,
    ),
  beginTaskDiffReviewContinuationFromInput:
    beginTaskDiffReviewContinuationFromInputOperation.bind(
      undefined,
      capabilities,
    ),
  beginTaskDiffReviewContinuation:
    beginTaskDiffReviewContinuationOperation.bind(undefined, capabilities),
  reconcileTaskDiffReviewContinuation:
    reconcileTaskDiffReviewContinuationOperation.bind(undefined, capabilities),
  reconcileTaskDiffReview: reconcileTaskDiffReviewOperation.bind(
    undefined,
    capabilities,
  ),
  assertCurrentTaskDiffReviewSatisfied:
    assertCurrentTaskDiffReviewSatisfiedOperation.bind(undefined, capabilities),
  assertTaskDiffReviewCompletionGateSatisfied:
    assertTaskDiffReviewCompletionGateSatisfiedOperation.bind(
      undefined,
      capabilities,
    ),
  loadTaskDiffDocumentationReviewCapture:
    loadTaskDiffDocumentationReviewCaptureOperation.bind(
      undefined,
      capabilities,
    ),
  assertTaskDiffReviewProviderOwnerCurrent:
    assertTaskDiffReviewProviderOwnerCurrentOperation.bind(
      undefined,
      capabilities,
    ),
  inspectTaskDiffReviewSubject: inspectTaskDiffReviewSubjectOperation.bind(
    undefined,
    capabilities,
  ),
  deriveProtectedTaskApplyTaskDiffProviderGrantContinuation:
    deriveProtectedTaskApplyTaskDiffProviderGrantContinuationOperation.bind(
      undefined,
      capabilities,
    ),
  deriveProtectedTaskApplyTaskDiffGrantContinuation:
    deriveProtectedTaskApplyTaskDiffGrantContinuationOperation.bind(
      undefined,
      capabilities,
    ),
};
export const taskDiffReview =
  operations satisfies TaskDiffReviewCompletionOperations &
    TaskDiffReviewProviderOperations;
export const {
  beginTaskDiffReview,
  submitExternalTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
  reconcileExternalTaskDiffReview,
  resumeDirectHumanTaskDiffReview,
  loadCurrentExternalTaskDiffTerminalAssurance,
  loadAuthenticatedExternalTaskDiffTerminalAssurance,
  inspectTaskDiffReviewStatus,
  loadCurrentAuthenticatedTaskDiffReview,
  beginTaskDiffReviewContinuationFromInput,
  beginTaskDiffReviewContinuation,
  reconcileTaskDiffReviewContinuation,
  reconcileTaskDiffReview,
  assertCurrentTaskDiffReviewSatisfied,
  assertTaskDiffReviewCompletionGateSatisfied,
  loadTaskDiffDocumentationReviewCapture,
  assertTaskDiffReviewProviderOwnerCurrent,
  inspectTaskDiffReviewSubject,
  deriveProtectedTaskApplyTaskDiffProviderGrantContinuation,
  deriveProtectedTaskApplyTaskDiffGrantContinuation,
} = taskDiffReview;
export { withTaskDiffReviewProviderLifecycleOperation };
