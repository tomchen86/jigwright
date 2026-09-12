/**
 * Shares lifecycle locks, authority checks, and helpers across task diff
 * review modules.
 *
 * Invariants:
 * - Protected apply review requires a checked transaction matching the
 *   current session.
 */
// Lifecycle lock selection, authority checks, and shared digest helpers.
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertPreparedProtectedTaskApplyAuthorization } from './protected-task-apply-authorization.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type AuthoritativeCollaborationGrantVerifier,
  assertAuthoritativeCollaborationGrantVerifier,
  type ConsumedCollaborationGrantReplayVerifier,
  assertConsumedCollaborationGrantReplayVerifier,
} from '../../modules/authority/grant-verifier-port.ts';

import {
  type AdmittedRoleResult,
  type ConsumedRoleResultReplayPort,
} from '../../modules/provider-orchestration/role-admission-contracts.ts';
import { type CollaborationGrantExpectedBinding } from '../../modules/authority/collaboration-grant-codec.ts';

import crypto from 'node:crypto';
import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';
import type { TaskDiffReviewConsumedReplayValidation } from './task-diff-review-contracts.ts';

type RepositoryLifecycleOperationOptions =
  TaskDiffReviewRuntimeData['RepositoryLifecycleOperationOptions'];

export function createTaskDiffReviewCommonModule(
  runtime: TaskDiffReviewRuntimeBindings,
) {
  const {
    loadActiveSessionContext,
    readFinalizeTransaction,
    withRepositoryLifecycleOperation,
    parseAiAdapterPolicyDocument,
    runGit,
  } = runtime;
  function taskDiffReviewLifecycleOptions(
    context: ReturnType<typeof loadActiveSessionContext>,
    requestedSessionId: string,
  ): RepositoryLifecycleOperationOptions {
    const challengeId = protectedTaskApplyReviewChallenge(
      context,
      requestedSessionId,
    );
    return challengeId === null
      ? {}
      : { allowGrantChallengeIds: [challengeId] };
  }

  function assertTaskDiffReviewLifecycleGrantCurrent(
    context: ReturnType<typeof loadActiveSessionContext>,
    requestedSessionId: string,
  ): void {
    protectedTaskApplyReviewChallenge(context, requestedSessionId);
  }

  function protectedTaskApplyReviewChallenge(
    context: ReturnType<typeof loadActiveSessionContext>,
    requestedSessionId: string,
  ): string | null {
    if (context.session.sessionId !== requestedSessionId) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    const transaction = readFinalizeTransaction(
      context.runtime.root,
      context.session.sessionId,
    );
    if (transaction?.protectedApply === undefined) return null;
    if (
      transaction.phase !== 'checked' ||
      transaction.candidateTree === null ||
      transaction.sessionId !== context.session.sessionId ||
      transaction.changeId !== context.session.changeId ||
      transaction.taskId !== context.session.taskId ||
      transaction.repositoryRoot !== context.git.repositoryRealPath ||
      transaction.gitCommonDirectory !== context.git.gitCommonDirectory ||
      transaction.branch !== context.session.branch ||
      canonicalJson(transaction.baseline) !==
        canonicalJson(context.session.baseline)
    ) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    const binding = transaction.protectedApply;
    const { parameters } = assertPreparedProtectedTaskApplyAuthorization(
      context.runtime.root,
      binding,
    );
    const engineOwnedPaths = new Set([
      transaction.taskProjectionPath,
      ...transaction.transitionPaths,
      ...(context.session.implementationReconciliationPaths ?? []),
    ]);
    const taskPaths = transaction.changedPaths.filter(
      (changedPath) => !engineOwnedPaths.has(changedPath),
    );
    if (
      parameters.changeId !== context.session.changeId ||
      parameters.sessionId !== context.session.sessionId ||
      parameters.taskId !== context.session.taskId ||
      parameters.branch !== context.session.branch ||
      canonicalJson(parameters.baseline) !==
        canonicalJson(context.session.baseline) ||
      canonicalJson(parameters.mandateBinding) !==
        canonicalJson(context.session.mandateBinding ?? null) ||
      canonicalJson(parameters.changedPaths) !== canonicalJson(taskPaths)
    ) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    return binding.challengeId;
  }

  function protectedTaskApplyReviewAuthorizationInvalid() {
    return workflowError(
      'PROTECTED_TASK_APPLY_REVIEW_AUTHORIZATION_INVALID',
      'TaskDiffReview cannot cross a protected Apply barrier without the exact current prepared Grant journal binding.',
      ExitCode.guard,
    );
  }

  function withTaskDiffReviewProviderLifecycleOperation<T>(
    cwd: string,
    requestedSessionId: string,
    operation: (assertOwned: () => void) => T,
  ): T {
    const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
    return withRepositoryLifecycleOperation(
      initialContext.runtime,
      (assertOwned) => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        assertTaskDiffReviewLifecycleGrantCurrent(context, requestedSessionId);
        return operation(assertOwned);
      },
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function resolveAuthoritativeCollaborationGrantVerifier(
    candidate: unknown,
  ): AuthoritativeCollaborationGrantVerifier {
    assertAuthoritativeCollaborationGrantVerifier(candidate);
    return candidate;
  }

  function resolveConsumedCollaborationGrantReplayVerifier(
    candidate: unknown,
  ): ConsumedCollaborationGrantReplayVerifier {
    assertConsumedCollaborationGrantReplayVerifier(candidate);
    return candidate;
  }

  function resolveConsumedRoleResultReplayPort(
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

  function isExternalRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function assertStoredAdmittedRoleResultDigest(
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

  function collaborationTransitionDigest(
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

  function baselineAdapterPolicy(repositoryRoot: string, commit: string) {
    try {
      return parseAiAdapterPolicyDocument(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/ai-adapter-policy.json`,
        ]),
      );
    } catch (error) {
      throw workflowError(
        'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
        'TaskDiffReview could not verify its baseline adapter policy.',
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  function parseBaselineJson<T>(
    repositoryRoot: string,
    commit: string,
    relativePath: string,
    parse: (value: unknown) => T,
  ): T {
    let value: unknown;
    try {
      value = JSON.parse(
        runGit(repositoryRoot, ['show', `${commit}:${relativePath}`]),
      );
    } catch (error) {
      throw workflowError(
        'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
        `TaskDiffReview could not verify baseline ${relativePath}.`,
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    try {
      return parse(value);
    } catch (error) {
      throw workflowError(
        'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
        `TaskDiffReview baseline ${relativePath} is invalid.`,
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  function reviewNotReady() {
    return workflowError(
      'TASK_DIFF_REVIEW_NOT_READY',
      'TaskDiffReview is unavailable until finalize freezes a checked candidate tree.',
      ExitCode.staleState,
    );
  }

  function reviewNotStarted() {
    return workflowError(
      'TASK_DIFF_REVIEW_NOT_STARTED',
      'TaskDiffReview has no durable provider reservation for this session.',
      ExitCode.staleState,
    );
  }

  function reviewNotSatisfied() {
    return workflowError(
      'TASK_DIFF_REVIEW_NOT_SATISFIED',
      'TaskDiffReview has no current, provider-bound result for this candidate.',
      ExitCode.verification,
    );
  }

  function continuationNotStarted() {
    return workflowError(
      'TASK_DIFF_REVIEW_CONTINUATION_NOT_STARTED',
      'TaskDiffReview challenge continuation has no durable provider reservation for this response.',
      ExitCode.staleState,
    );
  }

  function continuationResultInvalid() {
    return workflowError(
      'TASK_DIFF_REVIEW_CONTINUATION_RESULT_INVALID',
      'TaskDiffReview challenge continuation output does not cover the exact current review and response.',
      ExitCode.verification,
    );
  }

  function candidateDiverged() {
    return workflowError(
      'TASK_DIFF_REVIEW_CANDIDATE_DIVERGED',
      'TaskDiffReview candidate state no longer matches the durable finalize transaction.',
      ExitCode.staleState,
    );
  }

  function taskDiffReviewLineageConflict() {
    return workflowError(
      'TASK_DIFF_REVIEW_LINEAGE_CONFLICT',
      'TaskDiffReview predecessor and supersession records do not form one exact append-only chain.',
      ExitCode.guard,
    );
  }

  function taskDiffReviewSupersessionReconciliationRequired() {
    return workflowError(
      'TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED',
      'A durable successor TaskDiffReview result requires deterministic supersession reconciliation.',
      ExitCode.staleState,
    );
  }

  function taskDiffReviewPriorChallengeOpen() {
    return workflowError(
      'TASK_DIFF_REVIEW_PRIOR_CHALLENGE_OPEN',
      'The prior TaskDiffReview challenge set lacks authenticated Final Assurance and cannot authorize candidate re-review.',
      ExitCode.verification,
    );
  }

  function externalTaskDiffInputStale() {
    return workflowError(
      'TASK_DIFF_REVIEW_EXTERNAL_INPUT_STALE',
      'External TaskDiffReview input does not bind the exact current subject.',
      ExitCode.staleState,
    );
  }

  function directHumanTaskDiffResumeInvalid() {
    return workflowError(
      'TASK_DIFF_DIRECT_HUMAN_RESUME_INVALID',
      'Direct-human TaskDiffReview resume requires the exact durable pause, authority-free input, and reserved or consumed signed grant.',
      ExitCode.guard,
    );
  }

  function externalTaskDiffLineageDeferred() {
    return workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_LINEAGE_DEFERRED',
      'External TaskDiffReview currently requires an initial full-scope review; mixed-source delta lineage is a separate lifecycle transition.',
      ExitCode.guard,
    );
  }

  function externalTaskDiffAuthorityInvalid() {
    return workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_AUTHORITY_INVALID',
      'External TaskDiffReview authority does not replay from the exact submission, consumed grant, admitted role result, and evidence node.',
      ExitCode.verification,
    );
  }

  function externalTaskDiffReconciliationNotAvailable() {
    return workflowError(
      'TASK_DIFF_EXTERNAL_RECONCILIATION_NOT_AVAILABLE',
      'External TaskDiffReview reconciliation requires one exact consumed Grant and its durable reservation.',
      ExitCode.staleState,
    );
  }
  return {
    taskDiffReviewLifecycleOptions,
    assertTaskDiffReviewLifecycleGrantCurrent,
    protectedTaskApplyReviewChallenge,
    protectedTaskApplyReviewAuthorizationInvalid,
    withTaskDiffReviewProviderLifecycleOperation,
    resolveAuthoritativeCollaborationGrantVerifier,
    resolveConsumedCollaborationGrantReplayVerifier,
    resolveConsumedRoleResultReplayPort,
    isExternalRecord,
    assertStoredAdmittedRoleResultDigest,
    collaborationTransitionDigest,
    baselineAdapterPolicy,
    parseBaselineJson,
    sha256,
    reviewNotReady,
    reviewNotStarted,
    reviewNotSatisfied,
    continuationNotStarted,
    candidateDiverged,
    taskDiffReviewLineageConflict,
    taskDiffReviewSupersessionReconciliationRequired,
    taskDiffReviewPriorChallengeOpen,
    externalTaskDiffInputStale,
    directHumanTaskDiffResumeInvalid,
    externalTaskDiffLineageDeferred,
    externalTaskDiffAuthorityInvalid,
    externalTaskDiffReconciliationNotAvailable,
  };
}
