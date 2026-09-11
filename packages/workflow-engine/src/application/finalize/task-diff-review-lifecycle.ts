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
  listCollaborationGrantInspections,
  readCollaborationGrantInspection,
  readExactConsumedCollaborationGrantUse,
  readReservedCollaborationGrant,
  reserveCollaborationGrantUnderLifecycleLock,
  selectAndReserveCollaborationGrantUnderLifecycleLock,
  verifyExactConsumedCollaborationGrantCrashReplay,
  validateCollaborationGrantUseProjection,
  type CollaborationGrantUseProjection,
  type CollaborationGrantSelectionCoreBinding,
  type VerifiedConsumedCollaborationGrantReplay,
} from '../../runtime/storage-journal/collaboration-grant-store.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../../runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../../adapters/planning/investigation/evidence-node.ts';
import type { DocumentationReviewCapture } from '../../runtime/managed-documents/contracts/documentation-closure.ts';
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
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from '../../composition-root/lifecycle-context.ts';
import { completionDocumentPaths } from '../../runtime/managed-documents/validation/managed-documents.ts';
import {
  createProviderInvocation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
  type TaskDiffReviewContinuationManifest,
  type TaskDiffReviewManifest,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
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
const common = createTaskDiffReviewCommonModule(runtime);
const subject = createTaskDiffReviewSubjectModule(runtime, common);
const externalBinding = createTaskDiffReviewExternalBindingModule(
  runtime,
  common,
  subject,
);
const externalContinuationBinding =
  createTaskDiffReviewExternalContinuationBindingModule(
    runtime,
    common,
    externalBinding,
  );
const providerBinding = createTaskDiffReviewProviderBindingModule(
  runtime,
  common,
  subject,
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
);
const externalCommands = createTaskDiffReviewExternalCommandsModule(
  runtime,
  common,
  subject,
  externalBinding,
  externalContinuationBinding,
  lineage,
  inspection,
);
const completion = createTaskDiffReviewCompletionModule(
  runtime,
  common,
  subject,
  externalBinding,
  externalContinuationBinding,
  providerBinding,
  lineage,
  inspection,
);
export const withTaskDiffReviewProviderLifecycleOperation =
  common.withTaskDiffReviewProviderLifecycleOperation;
export const beginTaskDiffReview = providerCommands.beginTaskDiffReview;
export const submitExternalTaskDiffReview =
  externalCommands.submitExternalTaskDiffReview;
export const submitExternalTaskDiffReviewContinuation =
  externalCommands.submitExternalTaskDiffReviewContinuation;
export const reconcileExternalTaskDiffReview =
  externalCommands.reconcileExternalTaskDiffReview;
export const resumeDirectHumanTaskDiffReview =
  externalCommands.resumeDirectHumanTaskDiffReview;
export const loadCurrentExternalTaskDiffTerminalAssurance =
  lineage.loadCurrentExternalTaskDiffTerminalAssurance;
export const loadAuthenticatedExternalTaskDiffTerminalAssurance =
  externalContinuationBinding.loadAuthenticatedExternalTaskDiffTerminalAssurance;
export const inspectTaskDiffReviewStatus =
  inspection.inspectTaskDiffReviewStatus;
export const loadCurrentAuthenticatedTaskDiffReview =
  lineage.loadCurrentAuthenticatedTaskDiffReview;
export const beginTaskDiffReviewContinuationFromInput =
  providerCommands.beginTaskDiffReviewContinuationFromInput;
export const beginTaskDiffReviewContinuation =
  providerCommands.beginTaskDiffReviewContinuation;
export const reconcileTaskDiffReviewContinuation =
  providerCommands.reconcileTaskDiffReviewContinuation;
export const reconcileTaskDiffReview = providerCommands.reconcileTaskDiffReview;
export const assertCurrentTaskDiffReviewSatisfied =
  completion.assertCurrentTaskDiffReviewSatisfied;
export const assertTaskDiffReviewCompletionGateSatisfied =
  completion.assertTaskDiffReviewCompletionGateSatisfied;
export const loadTaskDiffDocumentationReviewCapture =
  completion.loadTaskDiffDocumentationReviewCapture;
export const assertTaskDiffReviewProviderOwnerCurrent =
  completion.assertTaskDiffReviewProviderOwnerCurrent;
export const inspectTaskDiffReviewSubject =
  subject.inspectTaskDiffReviewSubject;
export const deriveProtectedTaskApplyTaskDiffProviderGrantContinuation =
  completion.deriveProtectedTaskApplyTaskDiffProviderGrantContinuation;
export const deriveProtectedTaskApplyTaskDiffGrantContinuation =
  completion.deriveProtectedTaskApplyTaskDiffGrantContinuation;
