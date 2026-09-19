import type { TaskMandateProviderAdmission } from '../../modules/authority/task-mandate-access-contract.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type { TaskStrategyCorrectionProjection } from '../../runtime/storage-journal/task-strategy-patch-store.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { DocumentationReviewCapture } from '../../modules/assurance/documentation-closure.ts';

import type { ChangeRoutingAdmissionReader } from '../../modules/lifecycle/change-routing.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import type {
  CollaborationGrantCodec,
  DirectHumanReviewAttestationIssuer,
} from '../../modules/authority/collaboration-grant-codec.ts';
/**
 * Composes task diff review modules and exposes their production
 * entrypoints.
 *
 * Invariants:
 * - Public commands delegate to modules built from the shared runtime
 *   bindings.
 */
// Public review entrypoints and production dependencies. Internal modules retain
// the existing transaction ordering through a single immutable set of bindings.
import { parseAiAdapterPolicyDocument } from '../../runtime/provider-execution/ai-adapter-policy.ts';
import {
  consumeCollaborationGrantUnderLifecycleLock,
  failCollaborationReservationUnderLifecycleLock,
  readExactConsumedCollaborationGrantUse,
  verifyExactConsumedCollaborationGrantCrashReplay,
} from '../../runtime/storage-journal/collaboration-grant-consumption.ts';
import {
  listCollaborationGrantInspections,
  readCollaborationGrantInspection,
} from '../../runtime/storage-journal/collaboration-grant-records.ts';
import {
  readReservedCollaborationGrant,
  reserveCollaborationGrantUnderLifecycleLock,
  selectAndReserveCollaborationGrantUnderLifecycleLock,
} from '../../runtime/storage-journal/collaboration-grant-reservation.ts';
import { validateCollaborationGrantUseProjection } from '../../runtime/grants/grant-services.ts';
import {
  type CollaborationGrantUseProjection,
  type CollaborationGrantSelectionCoreBinding,
  type VerifiedConsumedCollaborationGrantReplay,
} from '../../modules/authority/collaboration-grant-records.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../../runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';

import { readFinalizeTransaction } from '../../runtime/repository-transaction/finalize-transaction.ts';
import {
  findCurrentExecutionTaskCommits,
  listStagedPaths,
  previewExactStaging,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  fingerprintUnstagedRepositoryProjection,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../../runtime/repository-observation/investigation-runtime-context.ts';
import { loadActiveSessionContext } from '../../runtime/repository-observation/workflow-session-context.ts';
import { completionDocumentPaths } from '../../runtime/managed-documents/validation/managed-documents.ts';
import {
  createProviderInvocation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import type {
  TaskDiffReviewContinuationManifest,
  TaskDiffReviewManifest,
} from '../../modules/assurance/provider-review-manifests.ts';
import {
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
} from '../../runtime/storage-journal/report-validation.ts';
import {
  listActiveWorkflowSessionIds,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  type RepositoryLifecycleOperationOptions,
} from '../../runtime/session-workspace/session-store.ts';
import {
  createTaskDiffExternalChallengeResponse,
  createTaskDiffExternalClosureSubmission,
  createTaskDiffExternalContinuationBinding,
  createTaskDiffExternalContinuationReservation,
  createTaskDiffExternalReviewBinding,
  createTaskDiffExternalReviewReservation,
  createTaskDiffExternalReviewSubmission,
  listAllTaskDiffExternalContinuationBindings,
  listAllTaskDiffExternalContinuationReservations,
  listTaskDiffExternalContinuationReservations,
  listTaskDiffExternalReviewBindings,
  listTaskDiffExternalReviewReservations,
  readTaskDiffExternalChallengeResponse,
  readTaskDiffExternalContinuationBinding,
  readTaskDiffExternalContinuationReservation,
  readTaskDiffExternalClosureSubmission,
  readTaskDiffExternalReviewBinding,
  readTaskDiffExternalReviewReservation,
  readTaskDiffExternalReviewSubmission,
  taskDiffExternalContinuationTargetDigest,
  type TaskDiffExternalContinuationBinding,
  type TaskDiffExternalContinuationReservation,
  type TaskDiffExternalReviewBinding,
  type TaskDiffExternalReviewReservation,
} from '../../runtime/storage-journal/task-diff-review-external-store.ts';
import {
  createTaskDiffFinalAssuranceBinding,
  createTaskDiffReviewLineageSupersession,
  createTaskDiffReviewContinuationReservation,
  createTaskDiffReviewContinuationResultBinding,
  createTaskDiffReviewReservation,
  createTaskDiffReviewResultBinding,
  listAllTaskDiffReviewResultBindings,
  listAllTaskDiffReviewReservations,
  listAllTaskDiffReviewContinuationReservations,
  listAllTaskDiffReviewContinuationResultBindings,
  listTaskDiffReviewResultBindings,
  listTaskDiffReviewLineageSupersessions,
  readTaskDiffFinalAssuranceBinding,
  readTaskDiffReviewContinuationReservation,
  readTaskDiffReviewContinuationResultBinding,
  readTaskDiffReviewReservation,
  readTaskDiffReviewResultBinding,
  type TaskDiffReviewContinuationReservationRecord,
  type TaskDiffReviewContinuationResultBinding,
  type TaskDiffReviewReservationRecord,
  type TaskDiffReviewResultBinding,
} from '../../runtime/storage-journal/task-diff-review-store.ts';
import { readTaskStrategyGreenFailureRecord } from '../../runtime/storage-journal/task-strategy-correction-store.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationResultBinding,
} from '../../runtime/storage-journal/task-strategy-provider-store.ts';
import { readTaskStrategyTransaction } from '../../runtime/storage-journal/task-strategy-store.ts';
import { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import { createTaskDiffReviewSubjectModule } from './task-diff-review-subject.ts';
import { createTaskDiffReviewExternalBindingModule } from './task-diff-review-external-binding.ts';
import { createTaskDiffReviewExternalContinuationBindingModule } from './task-diff-review-external-continuation-binding.ts';
import { createTaskDiffReviewProviderBindingModule } from './task-diff-review-provider-binding.ts';
import { createTaskDiffReviewLineageModule } from './task-diff-review-lineage.ts';
import { createTaskDiffReviewInspectionModule } from './task-diff-review-inspection.ts';
import { createTaskDiffReviewProviderReservationsModule } from './task-diff-review-provider-reservations.ts';
import { createTaskDiffReviewProviderCommandsModule } from './task-diff-review-provider-commands.ts';
import { createTaskDiffReviewExternalCommandsModule } from './task-diff-review-external-commands.ts';
import { createTaskDiffReviewCompletionModule } from './task-diff-review-completion.ts';
export type {
  BeginTaskDiffReviewOptions,
  ReconcileTaskDiffReviewOptions,
  SubmitExternalTaskDiffReviewOptions,
  SubmitExternalTaskDiffReviewContinuationOptions,
  ReconcileTaskDiffReviewContinuationOptions,
  TaskDiffReviewCompletionGateOptions,
  TaskDiffReviewLifecycleStatus,
  TaskDiffReviewCollaborationGrantRequiredStatus,
  TaskDiffReviewContinuationLifecycleStatus,
  TaskDiffReviewExternalContinuationLifecycleStatus,
  TaskDiffReviewInspectionStatus,
  TaskDiffReviewStateContract,
  CurrentAuthenticatedTaskDiffReview,
  ReconcileExternalTaskDiffReviewOptions,
  CurrentExternalTaskDiffTerminalAssurance,
  ProtectedTaskApplyTaskDiffGrantContinuation,
  ProtectedTaskApplyTaskDiffProviderGrantContinuation,
} from './task-diff-review-contracts.ts';
const runtime = {
  parseAiAdapterPolicyDocument,
  consumeCollaborationGrantUnderLifecycleLock,
  failCollaborationReservationUnderLifecycleLock,
  listCollaborationGrantInspections,
  readCollaborationGrantInspection,
  readExactConsumedCollaborationGrantUse,
  readReservedCollaborationGrant,
  reserveCollaborationGrantUnderLifecycleLock,
  selectAndReserveCollaborationGrantUnderLifecycleLock,
  verifyExactConsumedCollaborationGrantCrashReplay,
  validateCollaborationGrantUseProjection,
  readEvidenceNode,
  writeEvidenceNode,
  createEvidenceNode,
  readFinalizeTransaction,
  findCurrentExecutionTaskCommits,
  listStagedPaths,
  previewExactStaging,
  fingerprintUnstagedRepositoryProjection,
  runGit,
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
  completionDocumentPaths,
  createProviderInvocation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  assertInspectionReport,
  assertReportChecks,
  readSessionReport,
  listActiveWorkflowSessionIds,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  createTaskDiffExternalChallengeResponse,
  createTaskDiffExternalClosureSubmission,
  createTaskDiffExternalContinuationBinding,
  createTaskDiffExternalContinuationReservation,
  createTaskDiffExternalReviewBinding,
  createTaskDiffExternalReviewReservation,
  createTaskDiffExternalReviewSubmission,
  listAllTaskDiffExternalContinuationBindings,
  listAllTaskDiffExternalContinuationReservations,
  listTaskDiffExternalContinuationReservations,
  listTaskDiffExternalReviewBindings,
  listTaskDiffExternalReviewReservations,
  readTaskDiffExternalChallengeResponse,
  readTaskDiffExternalContinuationBinding,
  readTaskDiffExternalContinuationReservation,
  readTaskDiffExternalClosureSubmission,
  readTaskDiffExternalReviewBinding,
  readTaskDiffExternalReviewReservation,
  readTaskDiffExternalReviewSubmission,
  taskDiffExternalContinuationTargetDigest,
  createTaskDiffFinalAssuranceBinding,
  createTaskDiffReviewLineageSupersession,
  createTaskDiffReviewContinuationReservation,
  createTaskDiffReviewContinuationResultBinding,
  createTaskDiffReviewReservation,
  createTaskDiffReviewResultBinding,
  listAllTaskDiffReviewResultBindings,
  listAllTaskDiffReviewReservations,
  listAllTaskDiffReviewContinuationReservations,
  listAllTaskDiffReviewContinuationResultBindings,
  listTaskDiffReviewResultBindings,
  listTaskDiffReviewLineageSupersessions,
  readTaskDiffFinalAssuranceBinding,
  readTaskDiffReviewContinuationReservation,
  readTaskDiffReviewContinuationResultBinding,
  readTaskDiffReviewReservation,
  readTaskDiffReviewResultBinding,
  readTaskStrategyGreenFailureRecord,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyTransaction,
};
export type TaskDiffReviewRuntimeBindings = typeof runtime;
export type TaskDiffReviewRuntimeData = {
  CollaborationGrantUseProjection: CollaborationGrantUseProjection;
  CollaborationGrantSelectionCoreBinding: CollaborationGrantSelectionCoreBinding;
  VerifiedConsumedCollaborationGrantReplay: VerifiedConsumedCollaborationGrantReplay;
  DocumentationReviewCapture: DocumentationReviewCapture;
  TaskDiffReviewContinuationManifest: TaskDiffReviewContinuationManifest;
  TaskDiffReviewManifest: TaskDiffReviewManifest;
  RepositoryLifecycleOperationOptions: RepositoryLifecycleOperationOptions;
  TaskDiffExternalContinuationBinding: TaskDiffExternalContinuationBinding;
  TaskDiffExternalContinuationReservation: TaskDiffExternalContinuationReservation;
  TaskDiffExternalReviewBinding: TaskDiffExternalReviewBinding;
  TaskDiffExternalReviewReservation: TaskDiffExternalReviewReservation;
  TaskDiffReviewContinuationReservationRecord: TaskDiffReviewContinuationReservationRecord;
  TaskDiffReviewContinuationResultBinding: TaskDiffReviewContinuationResultBinding;
  TaskDiffReviewReservationRecord: TaskDiffReviewReservationRecord;
  TaskDiffReviewResultBinding: TaskDiffReviewResultBinding;
};
export type TaskDiffReviewGrantServices = Readonly<{
  taskMandate: Pick<
    TaskMandateProviderAdmission,
    'authorizeTaskMandateProviderReservationUnderLifecycleLock'
  >;
  roleResultAdmission: Pick<
    RoleAdmissionServices,
    | 'authorizeGrantedOrdinaryRole'
    | 'admitRoleResult'
    | 'admitConsumedRoleResultReplay'
  >;
  collaborationGrants: Pick<
    CollaborationGrantCodec,
    | 'collaborationGrantEnvelopeDigest'
    | 'parseCollaborationGrantEnvelope'
    | 'canonicalCollaborationGrantEnvelope'
  >;
  createDirectHumanReviewAttestation: DirectHumanReviewAttestationIssuer;
}>;

export function createTaskDiffReviewLifecycle(
  resolveCurrentTaskStrategyCorrection: (
    inspection: SessionInspection,
  ) => TaskStrategyCorrectionProjection,
  changeContract: ChangeContractServices,
  services: TaskDiffReviewGrantServices,
) {
  const common = createTaskDiffReviewCommonModule(runtime);
  const subject = createTaskDiffReviewSubjectModule(
    resolveCurrentTaskStrategyCorrection,
    changeContract,
    runtime,
    common,
  );
  const externalBinding = createTaskDiffReviewExternalBindingModule(
    runtime,
    common,
    subject,
    services.collaborationGrants,
    services.roleResultAdmission,
  );
  const externalContinuationBinding =
    createTaskDiffReviewExternalContinuationBindingModule(
      runtime,
      common,
      externalBinding,
      services.roleResultAdmission,
    );
  const providerBinding = createTaskDiffReviewProviderBindingModule(
    runtime,
    common,
    subject,
    services.collaborationGrants,
    services.roleResultAdmission,
  );
  const lineage = createTaskDiffReviewLineageModule(
    runtime,
    common,
    subject,
    externalBinding,
    externalContinuationBinding,
    providerBinding,
  );
  const inspection = createTaskDiffReviewInspectionModule(
    runtime,
    common,
    subject,
    externalBinding,
    externalContinuationBinding,
    providerBinding,
    lineage,
  );
  const providerReservations = createTaskDiffReviewProviderReservationsModule(
    runtime,
    common,
    providerBinding,
    services.roleResultAdmission,
    services.taskMandate,
  );
  const providerCommands = createTaskDiffReviewProviderCommandsModule(
    runtime,
    common,
    subject,
    externalBinding,
    providerBinding,
    lineage,
    inspection,
    providerReservations,
    services.roleResultAdmission,
  );
  const externalCommands = createTaskDiffReviewExternalCommandsModule(
    runtime,
    common,
    subject,
    externalBinding,
    externalContinuationBinding,
    lineage,
    inspection,
    services.collaborationGrants,
    services.createDirectHumanReviewAttestation,
    services.roleResultAdmission,
  );
  const completion = createTaskDiffReviewCompletionModule(
    changeContract,
    runtime,
    common,
    subject,
    externalBinding,
    externalContinuationBinding,
    providerBinding,
    lineage,
    inspection,
  );
  const withTaskDiffReviewProviderLifecycleOperation =
    common.withTaskDiffReviewProviderLifecycleOperation;
  const beginTaskDiffReview = providerCommands.beginTaskDiffReview;
  const submitExternalTaskDiffReview =
    externalCommands.submitExternalTaskDiffReview;
  const submitExternalTaskDiffReviewContinuation =
    externalCommands.submitExternalTaskDiffReviewContinuation;
  const reconcileExternalTaskDiffReview =
    externalCommands.reconcileExternalTaskDiffReview;
  const resumeDirectHumanTaskDiffReview =
    externalCommands.resumeDirectHumanTaskDiffReview;
  const loadCurrentExternalTaskDiffTerminalAssurance =
    lineage.loadCurrentExternalTaskDiffTerminalAssurance;
  const loadAuthenticatedExternalTaskDiffTerminalAssurance =
    externalContinuationBinding.loadAuthenticatedExternalTaskDiffTerminalAssurance;
  const inspectTaskDiffReviewStatus = inspection.inspectTaskDiffReviewStatus;
  const loadCurrentAuthenticatedTaskDiffReview =
    lineage.loadCurrentAuthenticatedTaskDiffReview;
  const beginTaskDiffReviewContinuationFromInput =
    providerCommands.beginTaskDiffReviewContinuationFromInput;
  const beginTaskDiffReviewContinuation =
    providerCommands.beginTaskDiffReviewContinuation;
  const reconcileTaskDiffReviewContinuation =
    providerCommands.reconcileTaskDiffReviewContinuation;
  const reconcileTaskDiffReview = providerCommands.reconcileTaskDiffReview;
  const assertCurrentTaskDiffReviewSatisfied =
    completion.assertCurrentTaskDiffReviewSatisfied;
  const assertTaskDiffReviewCompletionGateSatisfied =
    completion.assertTaskDiffReviewCompletionGateSatisfied;
  const loadTaskDiffDocumentationReviewCapture =
    completion.loadTaskDiffDocumentationReviewCapture;
  const assertTaskDiffReviewProviderOwnerCurrent =
    completion.assertTaskDiffReviewProviderOwnerCurrent;
  const inspectTaskDiffReviewSubject = subject.inspectTaskDiffReviewSubject;
  const deriveProtectedTaskApplyTaskDiffProviderGrantContinuation =
    completion.deriveProtectedTaskApplyTaskDiffProviderGrantContinuation;
  const deriveProtectedTaskApplyTaskDiffGrantContinuation =
    completion.deriveProtectedTaskApplyTaskDiffGrantContinuation;

  return {
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
  };
}
export type TaskDiffReviewOperations = ReturnType<
  typeof createTaskDiffReviewLifecycle
>;
