/**
 * Defines shared task diff review command, status, and replay contracts.
 *
 * Invariants:
 * - Lifecycle states carry their own required provider or external
 *   authority fields.
 */
import type {
  TaskDiffReviewReservationRecord,
  TaskDiffReviewResultBinding,
  TaskDiffReviewContinuationReservationRecord,
} from '../assurance/task-diff-review-binding-record.ts';

import type {
  TaskDiffExternalContinuationBinding,
  TaskDiffExternalContinuationReservation,
  TaskDiffExternalReviewBinding,
  TaskDiffExternalReviewReservation,
} from '../assurance/task-diff-external-record.ts';
// Shared lifecycle contracts for review commands, inspection, and replay.

import type { TaskDiffReviewSubject } from '../assurance/task-diff-review-record.ts';
import {
  type CollaborationGrantRequest,
  type DirectHumanReviewAttestation,
} from '../authority/collaboration-grant-codec.ts';
import {
  type AdmittedRoleResult,
  type ConsumedRoleResultReplayPort,
} from '../provider-orchestration/role-admission-contracts.ts';
import {
  type GrantedRoleAssignment,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
} from '../provider-orchestration/role-assignment.ts';

import type {
  TaskDiffAuthenticatedReviewerAuthority,
  TaskDiffFinalAssuranceRecord,
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewRecord,
} from '../assurance/task-diff-review-artifact-record.ts';
import { type TaskDiffReviewLineageEntry } from '../assurance/task-diff-review-lineage.ts';
import { type ConsumedCollaborationGrantReplayVerifier } from '../authority/grant-verifier-port.ts';
import {
  type AssertExactStateSet,
  type ExactStateSet,
  type ManagedTaskDiffReviewState,
} from './managed-workflow-state-contract.ts';
import type { DocumentationReviewCapture } from '../assurance/documentation-closure.ts';
import type { TaskDiffReviewConsumedReplayValidation } from '../assurance/task-diff-review-values.ts';
import type { ProviderInvocationRecord } from '../provider-orchestration/provider-invocation-record.ts';

export type BeginTaskDiffReviewOptions = Readonly<{
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: unknown;
    consumedReplayVerifier?: unknown;
    directHumanReviewAttestation?: DirectHumanReviewAttestation;
  }>;
}>;

export type ReconcileTaskDiffReviewOptions = Readonly<{
  collaborationGrantValidation?: Readonly<{
    now?: Date;
    verifier?: unknown;
    consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
  }>;
  testCrashAfter?: 'result-binding-persisted';
}>;

export type SubmitExternalTaskDiffReviewOptions = Readonly<{
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: unknown;
    consumedReplayVerifier?: unknown;
    directHumanReviewAttestation?: DirectHumanReviewAttestation;
  }>;
  testCrashAfter?: 'grant-reserved' | 'grant-consumed';
}>;

export type SubmitExternalTaskDiffReviewContinuationOptions = Readonly<{
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: unknown;
    consumedReplayVerifier?: unknown;
    directHumanReviewAttestation?: DirectHumanReviewAttestation;
  }>;
  testCrashAfter?: 'grant-reserved' | 'grant-consumed';
}>;

export type ReconcileTaskDiffReviewContinuationOptions = Readonly<{
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
  testCrashAfter?: 'advisory-result-persisted';
}>;

export type TaskDiffReviewCompletionGateOptions = Readonly<{
  projectedTaskIds?: readonly string[];
  projectionSourceDigest?: string;
  authorizedTransitionPaths?: readonly string[];
  transactionId?: string;
  candidateTree?: string;
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
}>;

export type TaskDiffReviewLifecycleStatus =
  | Readonly<{
      state: 'not-required';
      sessionId: string;
      subject: TaskDiffReviewSubject;
    }>
  | Readonly<{
      state: 'ready';
      sessionId: string;
      subject: TaskDiffReviewSubject;
    }>
  | TaskDiffReviewCollaborationGrantRequiredStatus
  | Readonly<{
      state: 'external-grant-resume-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
    }>
  | Readonly<{
      state: 'direct-human-attestation-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      reviewScopeDigest: string;
      submissionRecordDigest: string;
      reviewNodeId: string;
      reviewResultDigest: string;
    }>
  | Readonly<{
      state: 'external-reconciliation-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantState: 'reserved' | 'consumed';
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      reviewScopeDigest: string;
      submissionRecordDigest: string;
      reviewNodeId: string;
      reviewResultDigest: string;
    }>
  | Readonly<{
      state:
        | 'satisfied'
        | 'challenge-response-required'
        | 'challenge-closure-required'
        | 'changes-required';
      source: 'external';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: GrantedRoleAssignment;
      review: TaskDiffReviewRecord;
      finalAssurance: TaskDiffFinalAssuranceRecord | null;
    }>
  | Readonly<{
      state:
        'waiting-for-provider' | 'provider-succeeded-awaiting-reconciliation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
    }>
  | Readonly<{
      state: 'provider-failed';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      failure: NonNullable<ProviderInvocationRecord['failure']>;
    }>
  | Readonly<{
      state:
        | 'satisfied'
        | 'challenge-response-required'
        | 'challenge-closure-required'
        | 'changes-required';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      review: TaskDiffReviewRecord;
      finalAssurance: TaskDiffFinalAssuranceRecord | null;
    }>;

export type TaskDiffReviewCollaborationGrantRequiredStatus = Readonly<{
  state: 'collaboration-grant-required';
  sessionId: string;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  inputSchema: Readonly<{
    schemaVersion: 1;
    kind: 'collaboration-grant-selection';
    lifecyclePhase: 'task-diff-review';
    conflictingRole: 'task-diff-reviewer';
    grantRequest: CollaborationGrantRequest | null;
    allowedDegradedForms: readonly (
      'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review'
    )[];
    resumeOption: '--grant <grant-id>';
  }>;
}>;

export type TaskDiffReviewContinuationLifecycleStatus = Readonly<{
  state:
    | 'waiting-for-provider'
    | 'provider-succeeded-awaiting-reconciliation'
    | 'provider-failed'
    | 'challenge-closure-required'
    | 'satisfied'
    | 'changes-required';
  sessionId: string;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  assignment: ProviderRoleAssignment;
  ownerInvestigationId: string;
  invocationId: string;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  finalAssurance: TaskDiffFinalAssuranceRecord | null;
  failure: NonNullable<ProviderInvocationRecord['failure']> | null;
}>;

export type TaskDiffReviewExternalContinuationLifecycleStatus =
  | Readonly<{
      state: 'collaboration-grant-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      targetDigest: string;
      inputSchema: Readonly<{
        schemaVersion: 1;
        kind: 'collaboration-grant-selection';
        lifecyclePhase: 'task-diff-review';
        conflictingRole: 'task-diff-reviewer';
        grantRequest: null;
        targetDigest: string;
        subjectDigest: string;
        reviewRecordDigest: string;
        responseDigest: string;
        allowedDegradedForms: readonly (
          'caller-supplied' | 'direct-human-review'
        )[];
        resumeOption: '--grant <grant-id>';
      }>;
    }>
  | Readonly<{
      state: 'direct-human-attestation-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      contentNodeId: string;
      contentResultDigest: string;
      reviewNodeId: string;
      reviewResultDigest: string;
    }>
  | Readonly<{
      state: 'external-reconciliation-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantState: 'reserved' | 'consumed';
      grantId: string;
      grantEnvelopeDigest: string;
      transitionDigest: string;
      reservationDigest: string;
      inputDigest: string;
      contentNodeId: string;
      contentResultDigest: string;
    }>
  | Readonly<{
      state: 'satisfied' | 'changes-required';
      source: 'external-continuation';
      sessionId: string;
      subject: TaskDiffReviewSubject;
      implementationActor: RecordedRoleParticipant;
      review: TaskDiffReviewRecord;
      response: TaskDiffReviewChallengeResponseRecord;
      finalAssurance: TaskDiffFinalAssuranceRecord;
    }>;

export type TaskDiffReviewInspectionStatus =
  | TaskDiffReviewLifecycleStatus
  | TaskDiffReviewContinuationLifecycleStatus
  | TaskDiffReviewExternalContinuationLifecycleStatus;

export type TaskDiffReviewStateContract = AssertExactStateSet<
  ExactStateSet<
    TaskDiffReviewInspectionStatus['state'],
    ManagedTaskDiffReviewState
  >
>;

export type CurrentAuthenticatedTaskDiffReview = Readonly<{
  source: 'provider' | 'external';
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  implementationActor: RecordedRoleParticipant;
  authenticatedReviewAuthority: TaskDiffAuthenticatedReviewerAuthority;
  reviewResultNodeId: string;
  reviewResultDigest: string;
}>;

export type ReplayedTaskDiffReviewTerminal = Readonly<{
  state: 'satisfied' | 'challenge-open' | 'changes-required';
  finalAssurance: TaskDiffFinalAssuranceRecord | null;
  commitmentDigest: string | null;
  closureSource: 'provider' | 'external' | null;
}>;

export type TaskDiffReviewReplayMode = 'inspect' | 'governing';

export type ReconcileExternalTaskDiffReviewOptions = Readonly<{
  consumedReplayVerifier?: ConsumedCollaborationGrantReplayVerifier;
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
}>;

export type AuthenticatedExternalTaskDiffContinuation = Readonly<{
  reservation: TaskDiffExternalContinuationReservation;
  binding: TaskDiffExternalContinuationBinding;
  roleResult: AdmittedRoleResult;
  authority: TaskDiffAuthenticatedReviewerAuthority;
  createdAt: string;
}>;

export type CurrentExternalTaskDiffTerminalAssurance = Readonly<{
  source: 'external-continuation';
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  finalAssurance: TaskDiffFinalAssuranceRecord;
  continuationAuthorityNodeId: string;
  continuationAuthorityResultDigest: string;
}>;

export type CurrentExternalTaskDiffReview = Readonly<{
  binding: TaskDiffExternalReviewBinding;
  reservation: TaskDiffExternalReviewReservation;
  implementationActor: RecordedRoleParticipant;
  assignment: GrantedRoleAssignment;
  roleResult: AdmittedRoleResult;
  review: TaskDiffReviewRecord;
}>;

export type CurrentTaskDiffReviewForProviderContinuation =
  CurrentAuthenticatedTaskDiffReview;

export type LoadedTaskDiffReviewLineageSource = TaskDiffReviewLineageEntry &
  Readonly<
    | {
        source: 'provider';
        provider: Readonly<{
          reservation: TaskDiffReviewReservationRecord;
          binding: TaskDiffReviewResultBinding;
        }>;
      }
    | {
        source: 'external';
        external: CurrentExternalTaskDiffReview;
      }
  >;

export type LoadedTaskDiffReviewLineageEntry =
  LoadedTaskDiffReviewLineageSource &
    Readonly<{ terminal: ReplayedTaskDiffReviewTerminal }>;

export type TaskDiffReviewSupersessionRecoveryTarget = Readonly<{
  predecessorReviewRecordDigest: string;
  successorReviewRecordDigest: string;
}>;

export type ProtectedTaskApplyTaskDiffGrantContinuation = Readonly<{
  sessionId: string;
  parentChallengeId: string;
  subjectDigest: string;
}>;

export type ProtectedTaskApplyTaskDiffProviderGrantContinuation = Readonly<{
  invocationId: string;
  repositoryId: string;
  changeId: string;
  sessionId: string;
  parentChallengeId: string;
  subjectDigest: string;
}>;
export type TaskDiffReviewCompletionOperations = Readonly<{
  assertTaskDiffReviewCompletionGateSatisfied: (
    cwd: string,
    requestedSessionId: string,
    options?: TaskDiffReviewCompletionGateOptions,
  ) => TaskDiffReviewRecord | null;
  loadTaskDiffDocumentationReviewCapture: (
    cwd: string,
    requestedSessionId: string,
  ) => DocumentationReviewCapture | null;
}>;
export type TaskDiffReviewProviderOperations = Readonly<{
  assertTaskDiffReviewProviderOwnerCurrent: (
    cwd: string,
    requestedInvocationId: string,
    validation?: TaskDiffReviewConsumedReplayValidation,
  ) =>
    | TaskDiffReviewReservationRecord
    | TaskDiffReviewContinuationReservationRecord;
  withTaskDiffReviewProviderLifecycleOperation: <T>(
    cwd: string,
    requestedSessionId: string,
    operation: (assertOwned: () => void) => T,
  ) => T;
}>;
