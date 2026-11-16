/**
 * Defines TaskDiffReview identity, replay-capability guards and refusal values.
 * Verifier guards retain the canonical module's branded capability identity.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type AuthoritativeCollaborationGrantVerifier,
  assertAuthoritativeCollaborationGrantVerifier,
  type ConsumedCollaborationGrantReplayVerifier,
  assertConsumedCollaborationGrantReplayVerifier,
} from '../authority/grant-verifier-port.ts';
import type {
  AdmittedRoleResult,
  ConsumedRoleResultReplayPort,
} from '../provider-orchestration/role-admission-contracts.ts';
import type { CollaborationGrantExpectedBinding } from '../authority/collaboration-grant-codec.ts';
import { sha256 } from './task-diff-review-binding-record.ts';

export type TaskDiffReviewConsumedReplayValidation = Readonly<{
  consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
}>;

export function protectedTaskApplyReviewAuthorizationInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_REVIEW_AUTHORIZATION_INVALID',
    'TaskDiffReview cannot cross a protected Apply barrier without the exact current prepared Grant journal binding.',
    ExitCode.guard,
  );
}

export function resolveAuthoritativeCollaborationGrantVerifier(
  candidate: unknown,
): AuthoritativeCollaborationGrantVerifier {
  assertAuthoritativeCollaborationGrantVerifier(candidate);
  return candidate;
}

export function resolveConsumedCollaborationGrantReplayVerifier(
  candidate: unknown,
): ConsumedCollaborationGrantReplayVerifier {
  assertConsumedCollaborationGrantReplayVerifier(candidate);
  return candidate;
}

export function resolveConsumedRoleResultReplayPort(
  validation: TaskDiffReviewConsumedReplayValidation | undefined,
): ConsumedRoleResultReplayPort {
  const replayPort = validation?.consumedRoleResultReplay;
  if (replayPort === undefined || typeof replayPort.verify !== 'function') {
    throw workflowError(
      'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
      'The terminal-only Collaboration Grant replay verifier is unavailable.',
      ExitCode.guard,
    );
  }
  return replayPort;
}

export function isExternalRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertStoredAdmittedRoleResultDigest(
  roleResult: AdmittedRoleResult,
): void {
  const { resultDigest, ...semantic } = roleResult;
  if (
    resultDigest !==
    sha256(canonicalJson({ schema: 'admitted-role-result.v1', ...semantic }))
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

export function collaborationTransitionDigest(
  expectedBinding: CollaborationGrantExpectedBinding,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'collaboration-role-transition',
      expectedBinding,
    }),
  );
}

export function reviewNotReady() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_READY',
    'TaskDiffReview is unavailable until finalize freezes a checked candidate tree.',
    ExitCode.staleState,
  );
}

export function reviewNotStarted() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_STARTED',
    'TaskDiffReview has no durable provider reservation for this session.',
    ExitCode.staleState,
  );
}

export function reviewNotSatisfied() {
  return workflowError(
    'TASK_DIFF_REVIEW_NOT_SATISFIED',
    'TaskDiffReview has no current, provider-bound result for this candidate.',
    ExitCode.verification,
  );
}

export function continuationNotStarted() {
  return workflowError(
    'TASK_DIFF_REVIEW_CONTINUATION_NOT_STARTED',
    'TaskDiffReview challenge continuation has no durable provider reservation for this response.',
    ExitCode.staleState,
  );
}

export function candidateDiverged() {
  return workflowError(
    'TASK_DIFF_REVIEW_CANDIDATE_DIVERGED',
    'TaskDiffReview candidate state no longer matches the durable finalize transaction.',
    ExitCode.staleState,
  );
}

export function taskDiffReviewLineageConflict() {
  return workflowError(
    'TASK_DIFF_REVIEW_LINEAGE_CONFLICT',
    'TaskDiffReview predecessor and supersession records do not form one exact append-only chain.',
    ExitCode.guard,
  );
}

export function taskDiffReviewSupersessionReconciliationRequired() {
  return workflowError(
    'TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED',
    'A durable successor TaskDiffReview result requires deterministic supersession reconciliation.',
    ExitCode.staleState,
  );
}

export function taskDiffReviewPriorChallengeOpen() {
  return workflowError(
    'TASK_DIFF_REVIEW_PRIOR_CHALLENGE_OPEN',
    'The prior TaskDiffReview challenge set lacks authenticated Final Assurance and cannot authorize candidate re-review.',
    ExitCode.verification,
  );
}

export function externalTaskDiffInputStale() {
  return workflowError(
    'TASK_DIFF_REVIEW_EXTERNAL_INPUT_STALE',
    'External TaskDiffReview input does not bind the exact current subject.',
    ExitCode.staleState,
  );
}

export function directHumanTaskDiffResumeInvalid() {
  return workflowError(
    'TASK_DIFF_DIRECT_HUMAN_RESUME_INVALID',
    'Direct-human TaskDiffReview resume requires the exact durable pause, authority-free input, and reserved or consumed signed grant.',
    ExitCode.guard,
  );
}

export function externalTaskDiffLineageDeferred() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_REVIEW_LINEAGE_DEFERRED',
    'External TaskDiffReview currently requires an initial full-scope review; mixed-source delta lineage is a separate lifecycle transition.',
    ExitCode.guard,
  );
}

export function externalTaskDiffAuthorityInvalid() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_REVIEW_AUTHORITY_INVALID',
    'External TaskDiffReview authority does not replay from the exact submission, consumed grant, admitted role result, and evidence node.',
    ExitCode.verification,
  );
}

export function externalTaskDiffReconciliationNotAvailable() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_RECONCILIATION_NOT_AVAILABLE',
    'External TaskDiffReview reconciliation requires one exact consumed Grant and its durable reservation.',
    ExitCode.staleState,
  );
}
