import { taskMandateOperations } from './task-mandate-production.ts';
import { productionChangeRoutingAdmissionReader } from './change-routing-observation-production.ts';
import { roleResultAdmission } from './role-admission-production.ts';
import { createTaskDiffReviewLifecycle } from '../application/finalize/task-diff-review-lifecycle.ts';
import { collaborationGrantCodec } from '../runtime/grants/grant-services.ts';
import { createDirectHumanReviewAttestation } from './collaboration-grant-issuance-production.ts';

export const taskDiffReview = createTaskDiffReviewLifecycle(
  productionChangeRoutingAdmissionReader,
  {
    taskMandate: taskMandateOperations,
    roleResultAdmission,
    collaborationGrants: collaborationGrantCodec,
    createDirectHumanReviewAttestation,
  },
);
export const {
  withTaskDiffReviewProviderLifecycleOperation,
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
