import type { createPlanReviewResults } from './plan-review-result.ts';
import type { createPlanReviewStore } from './plan-review-store.ts';
import type { createProposeContext } from './propose-context.ts';
import type { createProposeProviderLifecycle } from './propose-provider-lifecycle.ts';
import type { createProposeStatus } from './propose-status.ts';
import type { PlanningTransitionExecutionServices } from '../../modules/lifecycle/planning-execution-epoch.ts';
import type {
  PlanReviewProgressEnvelope,
  ProposeResumeOptions,
  ProposeOutput,
  PlanReviewDispositionsEnvelope,
  ProposeLifecycleStatus,
} from '../../modules/proposal/propose-types.ts';
import {
  getProposeLifecycleStatus,
  assertCurrentExemptionContext,
  loadMaintainerPolicyAtCommit,
  currentRevisingTaskSession,
} from './propose-context.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { readPlanReviewReservation } from './plan-review-store.ts';

import {
  readPlanReviewNode,
  createAuthorizedPlanReviewDispositionNode,
  type AuthorizedPlanReviewDispositionEntry,
  assertAuthorizedPlanReviewChallengeClosure,
  createPlanReviewDispositionNode,
  type PlanReviewDispositionEntry,
} from '../../modules/assurance/plan-review.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-state.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { readInvestigationSession } from '../storage-journal/investigation-session-records.ts';
import {
  assertClassSampleAuditsComplete,
  classSampleSeed,
} from '../../modules/investigation/domain/class-sample-audit.ts';
import type { HeldChangeTransitionAuthority } from '../session-workspace/planning-lock.ts';
import { commitPlanningTransitionUnderAuthority } from '../planning-transition/planning-transition.ts';
import { retireCurrentProposeExemptionSession } from '../storage-journal/propose-exemption-store.ts';
export function createPlanReviewCompletion({
  createInteractiveSshSigner,
  loadChangeContract,
  managedDocuments,
  planningEvidence,
  dispatchMandatedProviderInvocation,
  getProposeStatus,
  getProposeStatusInternal,
  materializePlanReviewResult,
  readTrackedPlanReview,
  renderProposeOutputWithPlanningAuthority,
  withProposeTransitionAuthority,
  writeTrackedPlanReview,
}: {
  createInteractiveSshSigner: ProposeDecisionServices['createInteractiveSshSigner'];
  loadChangeContract: ProposeDecisionServices['loadChangeContract'];
  managedDocuments: ProposeDecisionServices['managedDocuments'];
  planningEvidence: ProposeDecisionServices['planningEvidence'];
  dispatchMandatedProviderInvocation: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchMandatedProviderInvocation'];
  getProposeStatus: ReturnType<typeof createProposeStatus>['getProposeStatus'];
  getProposeStatusInternal: ReturnType<
    typeof createProposeStatus
  >['getProposeStatusInternal'];
  materializePlanReviewResult: ReturnType<
    typeof createPlanReviewResults
  >['materializePlanReviewResult'];
  readTrackedPlanReview: ReturnType<
    typeof createPlanReviewStore
  >['readTrackedPlanReview'];
  renderProposeOutputWithPlanningAuthority: ReturnType<
    typeof createProposeStatus
  >['renderProposeOutputWithPlanningAuthority'];
  withProposeTransitionAuthority: ReturnType<
    typeof createProposeContext
  >['withProposeTransitionAuthority'];
  writeTrackedPlanReview: ReturnType<
    typeof createPlanReviewStore
  >['writeTrackedPlanReview'];
}) {
  function resumePlanReview(
    planningExecution: PlanningTransitionExecutionServices,
    cwd: string,
    input: PlanReviewProgressEnvelope,
    options: ProposeResumeOptions,
  ): ProposeOutput {
    const status = getProposeLifecycleStatus(cwd, input.investigationId);
    if (status.changeId !== input.changeId) {
      throw workflowError(
        'PROPOSE_INPUT_STALE',
        'PlanReview progress belongs to another investigation.',
        ExitCode.staleState,
      );
    }
    const context = loadInvestigationRuntimeContext(cwd);
    const reservation = readPlanReviewReservation(context.runtime, status);
    if (
      reservation === null ||
      reservation.subject.subjectDigest !== input.subjectDigest ||
      reservation.request.invocationId !== input.invocationId ||
      reservation.request.requestDigest !== input.requestDigest
    ) {
      throw workflowError(
        'PROPOSE_INPUT_STALE',
        'PlanReview progress is not bound to the current exact request.',
        ExitCode.staleState,
      );
    }
    let invocation = readProviderInvocation(
      context.runtime,
      reservation.request.invocationId,
    );
    if (invocation.state === 'prepared') {
      if (options.providerDriver || options.providerDispatcher) {
        dispatchMandatedProviderInvocation(
          cwd,
          reservation.request.invocationId,
          (runtime, request) => {
            if (options.providerDriver) {
              options.providerDriver({ paths: runtime, request });
            } else if (options.providerDispatcher) {
              options.providerDispatcher(cwd, request.invocationId);
            }
          },
        );
      }
      invocation = readProviderInvocation(
        context.runtime,
        reservation.request.invocationId,
      );
    }
    if (invocation.state !== 'succeeded' || invocation.result === null) {
      return getProposeStatus(
        cwd,
        status.investigationId,
        options.collaborationGrantValidation,
      );
    }
    const admitted = withProposeTransitionAuthority(
      cwd,
      context.lifecycleRuntime,
      status.changeId,
      (assertOwned) => {
        assertOwned();
        const lockedStatus = getProposeLifecycleStatus(
          cwd,
          input.investigationId,
        );
        const lockedContext = loadInvestigationRuntimeContext(cwd);
        if (lockedStatus.state === 'investigation-exempt') {
          assertCurrentExemptionContext(lockedContext, lockedStatus);
        }
        const lockedReservation = readPlanReviewReservation(
          lockedContext.runtime,
          lockedStatus,
        );
        if (
          lockedStatus.changeId !== input.changeId ||
          lockedReservation === null ||
          lockedReservation.subject.subjectDigest !== input.subjectDigest ||
          lockedReservation.request.invocationId !== input.invocationId ||
          lockedReservation.request.requestDigest !== input.requestDigest
        ) {
          throw workflowError(
            'PROPOSE_INPUT_STALE',
            'PlanReview progress changed before admission.',
            ExitCode.staleState,
          );
        }
        const lockedInvocation = readProviderInvocation(
          lockedContext.runtime,
          lockedReservation.request.invocationId,
        );
        if (
          lockedInvocation.state !== 'succeeded' ||
          lockedInvocation.result === null
        ) {
          return { outcome: 'pending' as const };
        }
        const tracked = materializePlanReviewResult(
          cwd,
          lockedStatus,
          lockedReservation,
          lockedInvocation.result,
          assertOwned,
          options.roleContextSharingGrant,
          options.collaborationGrantValidation,
        );
        if ('reopenedInvestigation' in tracked) {
          return {
            outcome: 'reopened' as const,
            status: tracked.reopenedInvestigation,
          };
        }
        if ('blockedInvestigation' in tracked) {
          return {
            outcome: 'blocked' as const,
            status: tracked.blockedInvestigation,
          };
        }
        const review = readPlanReviewNode(tracked.reviewNode);
        if (review.findings.length > 0) {
          return {
            outcome: 'findings' as const,
            investigationId: lockedStatus.investigationId,
          };
        }
        return {
          outcome: 'complete' as const,
          output: commitCompletedPlanningUnderAuthority(
            planningExecution,
            cwd,
            lockedStatus,
            assertOwned,
          ),
        };
      },
    );
    if (admitted.outcome === 'pending') {
      return getProposeStatus(
        cwd,
        status.investigationId,
        options.collaborationGrantValidation,
      );
    }
    if (admitted.outcome === 'reopened') {
      return renderProposeOutputWithPlanningAuthority(
        cwd,
        admitted.status,
        null,
        options.collaborationGrantValidation,
      );
    }
    if (admitted.outcome === 'blocked') {
      return renderProposeOutputWithPlanningAuthority(
        cwd,
        admitted.status,
        null,
        options.collaborationGrantValidation,
      );
    }
    if (admitted.outcome === 'findings') {
      return getProposeStatus(
        cwd,
        admitted.investigationId,
        options.collaborationGrantValidation,
      );
    }
    return admitted.output;
  }

  function completePlanReviewDispositions(
    planningExecution: PlanningTransitionExecutionServices,
    cwd: string,
    input: PlanReviewDispositionsEnvelope,
    options: ProposeResumeOptions,
  ): ProposeOutput {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    return withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      input.changeId,
      (assertOwned) => {
        assertOwned();
        const status = getProposeLifecycleStatus(cwd, input.investigationId);
        const context = loadInvestigationRuntimeContext(cwd);
        if (status.state === 'investigation-exempt') {
          assertCurrentExemptionContext(context, status);
        }
        const reservation = readPlanReviewReservation(context.runtime, status);
        const tracked =
          reservation === null
            ? null
            : readTrackedPlanReview(
                context.git.repositoryRoot,
                status.changeId,
                {
                  subject: reservation.subject,
                  consumedPlanReviewReplay:
                    options.collaborationGrantValidation
                      ?.consumedPlanReviewReplay,
                },
              );
        if (
          status.changeId !== input.changeId ||
          reservation === null ||
          reservation.subject.subjectDigest !== input.subjectDigest ||
          tracked === null ||
          tracked.reviewNode.nodeId !== input.reviewNodeId ||
          tracked.reviewNode.resultDigest !== input.reviewResultDigest ||
          tracked.dispositionNode !== null ||
          canonicalJson(tracked.roleResult.author) !==
            canonicalJson(reservation.author)
        ) {
          throw workflowError(
            'PROPOSE_INPUT_STALE',
            'PlanReview dispositions are not bound to the current review.',
            ExitCode.staleState,
          );
        }
        const session =
          status.state === 'investigation-exempt'
            ? null
            : readInvestigationSession(context.runtime, input.investigationId);
        const dispositionNode =
          session !== null
            ? (() => {
                const policy = loadMaintainerPolicyAtCommit(
                  context.git.repositoryRoot,
                  reservation.subject.investigationBaseline.head,
                );
                const signer =
                  options.challengeDispositionAuthority?.signer ??
                  createInteractiveSshSigner(
                    context.git.repositoryRoot,
                    policy,
                  );
                const authorId =
                  tracked.roleResult.author.principalId ??
                  tracked.roleResult.author.providerId;
                if (authorId === null) {
                  throw workflowError(
                    'PLAN_REVIEW_CHALLENGE_AUTHORITY_INVALID',
                    'The reviewed plan has no authenticated author identity.',
                    ExitCode.guard,
                  );
                }
                const binding = {
                  repositoryId: policy.repository.id,
                  changeId: status.changeId,
                  investigationId: status.investigationId,
                  baselineCommit:
                    reservation.subject.investigationBaseline.head,
                  baselineTree: reservation.subject.investigationBaseline.tree,
                  subjectDigest: reservation.subject.subjectDigest,
                  planningGenerationId:
                    reservation.subject.planningGenerationId,
                  authorId,
                };
                const node = createAuthorizedPlanReviewDispositionNode({
                  reviewNode: tracked.reviewNode,
                  policyDigest: reservation.subject.reviewPolicyDigest,
                  dispositions:
                    input.dispositions as AuthorizedPlanReviewDispositionEntry[],
                  binding,
                  role:
                    options.challengeDispositionAuthority?.role ??
                    (input.dispositions.some(
                      ({ decision }) => decision === 'waived',
                    )
                      ? 'domain-owner'
                      : 'reviewer'),
                  issuedAt:
                    options.challengeDispositionAuthority?.now ?? new Date(),
                  signer,
                });
                assertAuthorizedPlanReviewChallengeClosure(
                  planningEvidence.verifyChallengeClosureSignature,
                  {
                    dispositionNode: node,
                    reviewNode: tracked.reviewNode,
                    expected: binding,
                    policy,
                  },
                );
                return node;
              })()
            : createPlanReviewDispositionNode({
                reviewNode: tracked.reviewNode,
                policyDigest: reservation.subject.reviewPolicyDigest,
                dispositions:
                  input.dispositions as PlanReviewDispositionEntry[],
              });
        if (status.state === 'investigation-exempt') {
          assertCurrentExemptionContext(
            loadInvestigationRuntimeContext(cwd),
            status,
          );
        }
        writeTrackedPlanReview(context.git.repositoryRoot, status.changeId, {
          nodes: tracked.nodes,
          roleResult: tracked.roleResult,
          dispositionNode,
        });
        assertOwned();
        return commitCompletedPlanningUnderAuthority(
          planningExecution,
          cwd,
          status,
          assertOwned,
        );
      },
    );
  }

  function commitCompletedPlanningUnderAuthority(
    planningExecution: PlanningTransitionExecutionServices,
    cwd: string,
    status: ProposeLifecycleStatus,
    assertOwned: HeldChangeTransitionAuthority,
  ): ProposeOutput {
    assertOwned();
    const before = getProposeStatusInternal(
      cwd,
      status.investigationId,
      undefined,
      assertOwned,
    );
    if (status.state === 'investigation-exempt') {
      const context = loadInvestigationRuntimeContext(cwd);
      assertCurrentExemptionContext(context, status);
      retireCurrentProposeExemptionSession(
        context.runtime,
        status,
        assertOwned,
      );
    }
    if (status.state !== 'investigation-exempt') {
      // An exemption has no groups, so no class and nothing to have sampled.
      assertClassSamplesAudited(cwd, status);
    }
    const revising = currentRevisingTaskSession(cwd, status.changeId);
    if (revising !== null) {
      return {
        ...before,
        state: 'revision-plan-reviewed',
        nextAction: 'resume-task',
        inputSchema: null,
        planningTransition: null,
      };
    }
    const planningTransition = commitPlanningTransitionUnderAuthority(
      planningExecution,
      managedDocuments,
      loadChangeContract,
      cwd,
      status.changeId,
      assertOwned,
    );
    return {
      ...before,
      state: 'planning-complete',
      nextAction: 'planning-complete',
      inputSchema: null,
      planningTransition,
    };
  }
  return { resumePlanReview, completePlanReviewDispositions };
}

/**
 * Refuses to commit a plan whose class equivalence judgements have not been
 * checked by hand.
 *
 * Every other guard on a class is mechanical, and none of them can tell whether
 * the rationale an author wrote is true of what those hits do. That is what the
 * sample is for, so an unfinished sample is an unfinished plan. A class the
 * audit rejected is not folded at all: it owes an individual disposition per
 * member, and the plan cannot commit until it has one.
 */
function assertClassSamplesAudited(
  cwd: string,
  status: ProposeLifecycleStatus,
): void {
  const session = readInvestigationSession(
    loadInvestigationRuntimeContext(cwd).runtime,
    status.investigationId,
  );
  const stored = session.milestones.groupDispositions?.envelope;
  if (stored === undefined || stored.kind !== 'group-dispositions') return;
  const classes = stored.payload.classes ?? [];
  if (classes.length === 0) return;

  assertClassSampleAuditsComplete(
    classSampleSeed(status.investigationId),
    classes,
    stored.payload.sampleAudits ?? [],
  );
}
