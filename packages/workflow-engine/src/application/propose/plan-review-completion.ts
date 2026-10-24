import type { PlanningTransitionExecutionServices } from '../../modules/lifecycle/planning-execution-epoch.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertAuthorizedPlanReviewChallengeClosure,
  createAuthorizedPlanReviewDispositionNode,
  createPlanReviewDispositionNode,
  readPlanReviewNode,
} from '../../modules/assurance/plan-review.ts';
import type {
  AuthorizedPlanReviewDispositionEntry,
  PlanReviewDispositionEntry,
} from '../../modules/assurance/plan-review.ts';
import {
  assertClassSampleAuditsComplete,
  classSampleSeed,
} from '../../modules/investigation/domain/class-sample-audit.ts';
import { materializePlanReviewResult } from './plan-review-result.ts';
import {
  readPlanReviewReservation,
  readTrackedPlanReview,
  writeTrackedPlanReview,
} from './plan-review-store.ts';
import { commitPlanningTransitionUnderAuthority } from './planning-transition.ts';
import {
  assertCurrentExemptionContext,
  currentRevisingTaskSession,
  getProposeLifecycleStatus,
  loadMaintainerPolicyAtCommit,
  withProposeTransitionAuthority,
} from './propose-context.ts';
import { dispatchMandatedProviderInvocation } from './propose-provider-lifecycle.ts';
import type { HeldChangeTransitionAuthority } from '../../runtime/session-workspace/planning-lock.ts';
import type { ProposeRuntime } from './propose-runtime.ts';
import {
  getProposeStatus,
  getProposeStatusInternal,
  renderProposeOutputWithPlanningAuthority,
} from './propose-status.ts';
import type {
  PlanReviewDispositionsEnvelope,
  PlanReviewProgressEnvelope,
  ProposeLifecycleStatus,
  ProposeOutput,
  ProposeResumeOptions,
} from '../../modules/proposal/propose-types.ts';
export function resumePlanReview(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  input: PlanReviewProgressEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const status = getProposeLifecycleStatus(
    services,
    cwd,
    input.investigationId,
  );
  if (status.changeId !== input.changeId) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'PlanReview progress belongs to another investigation.',
      ExitCode.staleState,
    );
  }
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const reservation = readPlanReviewReservation(
    services,
    context.runtime,
    status,
  );
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
  let invocation = services.provider.readProviderInvocation(
    context.runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'prepared') {
    if (options.providerDriver || options.providerDispatcher) {
      dispatchMandatedProviderInvocation(
        services,
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
    invocation = services.provider.readProviderInvocation(
      context.runtime,
      reservation.request.invocationId,
    );
  }
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    return getProposeStatus(
      services,
      cwd,
      status.investigationId,
      options.collaborationGrantValidation,
    );
  }
  const admitted = withProposeTransitionAuthority(
    services,
    cwd,
    context.lifecycleRuntime,
    status.changeId,
    (assertOwned) => {
      assertOwned();
      const lockedStatus = getProposeLifecycleStatus(
        services,
        cwd,
        input.investigationId,
      );
      const lockedContext =
        services.workspace.loadInvestigationRuntimeContext(cwd);
      if (lockedStatus.state === 'investigation-exempt') {
        assertCurrentExemptionContext(services, lockedContext, lockedStatus);
      }
      const lockedReservation = readPlanReviewReservation(
        services,
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
      const lockedInvocation = services.provider.readProviderInvocation(
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
        services,
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
          services,
          cwd,
          lockedStatus,
          assertOwned,
        ),
      };
    },
  );
  if (admitted.outcome === 'pending') {
    return getProposeStatus(
      services,
      cwd,
      status.investigationId,
      options.collaborationGrantValidation,
    );
  }
  if (admitted.outcome === 'reopened') {
    return renderProposeOutputWithPlanningAuthority(
      services,
      cwd,
      admitted.status,
      null,
      options.collaborationGrantValidation,
    );
  }
  if (admitted.outcome === 'blocked') {
    return renderProposeOutputWithPlanningAuthority(
      services,
      cwd,
      admitted.status,
      null,
      options.collaborationGrantValidation,
    );
  }
  if (admitted.outcome === 'findings') {
    return getProposeStatus(
      services,
      cwd,
      admitted.investigationId,
      options.collaborationGrantValidation,
    );
  }
  return admitted.output;
}

export function completePlanReviewDispositions(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  input: PlanReviewDispositionsEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const initialContext =
    services.workspace.loadInvestigationRuntimeContext(cwd);
  return withProposeTransitionAuthority(
    services,
    cwd,
    initialContext.lifecycleRuntime,
    input.changeId,
    (assertOwned) => {
      assertOwned();
      const status = getProposeLifecycleStatus(
        services,
        cwd,
        input.investigationId,
      );
      const context = services.workspace.loadInvestigationRuntimeContext(cwd);
      if (status.state === 'investigation-exempt') {
        assertCurrentExemptionContext(services, context, status);
      }
      const reservation = readPlanReviewReservation(
        services,
        context.runtime,
        status,
      );
      const tracked =
        reservation === null
          ? null
          : readTrackedPlanReview(
              services,
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
          : services.investigation.readInvestigationSession(
              context.runtime,
              input.investigationId,
            );
      const dispositionNode =
        session !== null
          ? (() => {
              const policy = loadMaintainerPolicyAtCommit(
                services,
                context.git.repositoryRoot,
                reservation.subject.investigationBaseline.head,
              );
              const signer =
                options.challengeDispositionAuthority?.signer ??
                services.grants.createInteractiveSshSigner(
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
                baselineCommit: reservation.subject.investigationBaseline.head,
                baselineTree: reservation.subject.investigationBaseline.tree,
                subjectDigest: reservation.subject.subjectDigest,
                planningGenerationId: reservation.subject.planningGenerationId,
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
                services.planningEvidence.verifyChallengeClosureSignature,
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
              dispositions: input.dispositions as PlanReviewDispositionEntry[],
            });
      if (status.state === 'investigation-exempt') {
        assertCurrentExemptionContext(
          services,
          services.workspace.loadInvestigationRuntimeContext(cwd),
          status,
        );
      }
      writeTrackedPlanReview(
        services,
        context.git.repositoryRoot,
        status.changeId,
        {
          nodes: tracked.nodes,
          roleResult: tracked.roleResult,
          dispositionNode,
        },
      );
      assertOwned();
      return commitCompletedPlanningUnderAuthority(
        planningExecution,
        services,
        cwd,
        status,
        assertOwned,
      );
    },
  );
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
  services: Pick<ProposeRuntime, 'investigation' | 'workspace'>,
  cwd: string,
  status: ProposeLifecycleStatus,
): void {
  const session = services.investigation.readInvestigationSession(
    services.workspace.loadInvestigationRuntimeContext(cwd).runtime,
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

function commitCompletedPlanningUnderAuthority(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  status: ProposeLifecycleStatus,
  assertOwned: HeldChangeTransitionAuthority,
): ProposeOutput {
  assertOwned();
  const before = getProposeStatusInternal(
    services,
    cwd,
    status.investigationId,
    undefined,
    assertOwned,
  );
  if (status.state === 'investigation-exempt') {
    const context = services.workspace.loadInvestigationRuntimeContext(cwd);
    assertCurrentExemptionContext(services, context, status);
    services.investigation.retireCurrentProposeExemptionSession(
      context.runtime,
      status,
      assertOwned,
    );
  }
  if (status.state !== 'investigation-exempt') {
    // An exemption has no groups, so no class and nothing to have sampled.
    assertClassSamplesAudited(services, cwd, status);
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
    services.managedDocuments,
    services.loadChangeContract,
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
