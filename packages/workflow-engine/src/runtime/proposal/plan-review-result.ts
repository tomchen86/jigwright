import type { createPlanReviewStore } from './plan-review-store.ts';
import type { createInvestigationRebuild } from './propose-investigation-rebuild.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import type {
  RoleContextSharingPlanReviewRequirementV3,
  RoleContextSharingPlanReviewAuthorizationV1,
} from '../../modules/proposal/role-context-sharing-plan-review.ts';
import type {
  ProviderRoleAssignment,
  RecordedRoleParticipant,
} from '../../modules/provider-orchestration/role-assignment.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type { RoleContextSharingGrantLifecyclePortV1 } from '../../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import type { AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import { consumeRoleContextSharingPlanReview } from './role-context-sharing-plan-review.ts';
import {
  isRoleContextSharingGrantedAssignment,
  type ProviderProcessResult,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  resolveAuthoritativeRoleContextSharingGrantVerifier,
  loadMaintainerPolicyAtCommit,
  resolveAuthoritativeCollaborationGrantVerifier,
  assertCurrentExemptionContext,
} from './propose-context.ts';
import type {
  ProposeLifecycleStatus,
  PlanReviewReservation,
  ProposeResumeOptions,
  RebuiltInvestigation,
} from '../../modules/proposal/propose-types.ts';
import type { HeldChangeTransitionAuthority } from '../session-workspace/planning-lock.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import { readPlanReviewGrantRequirement } from './plan-review-store.ts';
import {
  canonicalizePlanReviewProviderSubmission,
  createPlanReviewProviderResultNode,
  createPlanReviewNode,
  readPlanReviewNode,
} from '../../modules/assurance/plan-review.ts';

import type { InvestigationTermContribution } from '../../modules/investigation/domain/investigation-terms.ts';
import {
  deriveReviewerTermDelta,
  projectPlanReviewTerms,
} from '../../modules/assurance/plan-review-terms.ts';
import type { CollaborationGrantUseProjection } from '../../modules/authority/collaboration-grant-records.ts';
import {
  resolvePlanReviewRepositoryEvidence,
  resolvePlanReviewPlanningEvidence,
} from '../../modules/assurance/planning-assurance-validator.ts';
import { createReviewerTermSourceNode } from '../../modules/proposal/propose-evidence.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import {
  inspectReviewerTermResolutionAuthorization,
  blockInvestigationForReviewerTermsUnderAuthority,
  reopenInvestigationForReviewerTermsUnderAuthority,
  acknowledgeReviewerTermInputClosureUnderAuthority,
} from '../investigation-lifecycle/investigation-session.ts';
import { decideReviewerTermReopen } from '../../modules/investigation/domain/reviewer-term-reopen.ts';
import { consumeCollaborationGrantUnderLifecycleLock } from '../storage-journal/collaboration-grant-consumption.ts';
import { retireCurrentProposeExemptionSession } from '../storage-journal/propose-exemption-store.ts';
import { writeEvidenceNode } from '../storage-journal/evidence-node-store.ts';

/**
 * Exact production completion seam for an R-007 PlanReview. The orchestrator
 * calls this only after the fixed provider invocation has succeeded; keeping
 * consume and admission in one operation makes crash replay exercise the same
 * one-use transition instead of a test-only lifecycle helper.
 */
export function completeRoleContextSharingPlanReviewAdmission(
  roleAdmission: RoleAdmissionServices,
  input: {
    gitCommonDirectory: string;
    requirement: RoleContextSharingPlanReviewRequirementV3;
    authorization: RoleContextSharingPlanReviewAuthorizationV1;
    assignment: ProviderRoleAssignment;
    author: RecordedRoleParticipant;
    content: Parameters<
      RoleAdmissionServices['admitRoleContextSharingResult']
    >[0]['content'];
    providerInvocation: Parameters<
      RoleAdmissionServices['admitRoleContextSharingResult']
    >[0]['providerInvocation'];
    policy: ReturnType<typeof parseMaintainerPolicy>;
    verifier: unknown;
    lifecycle: RoleContextSharingGrantLifecyclePortV1;
    now?: Date;
    assertOwned: () => void;
  },
): Readonly<{
  roleResult: AdmittedRoleResult;
  consumed: ReturnType<typeof consumeRoleContextSharingPlanReview>;
}> {
  if (
    !isRoleContextSharingGrantedAssignment(input.assignment) ||
    input.authorization.kind !==
      'role-context-sharing-plan-review-authorization.v1' ||
    input.authorization.grantId !==
      input.assignment.roleContextSharingGrantId ||
    input.authorization.reservationReceiptDigest !==
      input.assignment.reservationReceiptDigest
  ) {
    throw workflowError(
      'ROLE_CONTEXT_SHARING_GRANT_ADMISSION_REQUIRED',
      'R-007 completion requires one exact role-context-sharing assignment and authorization.',
      ExitCode.guard,
    );
  }
  const participant: RecordedRoleParticipant = Object.freeze({
    providerId: input.assignment.providerId,
    sessionId: input.assignment.sessionId,
    principalId: null,
    identityAssurance: 'adapter-assigned' as const,
    engineSpawned: true,
  });
  const admissionBinding =
    roleAdmission.normalizeRoleContextSharingResultAdmissionBinding({
      assignment: input.assignment,
      author: input.author,
      participant,
      content: input.content,
      providerInvocation: input.providerInvocation,
    });
  if (
    canonicalJson(admissionBinding.author) !==
    canonicalJson(input.requirement.author)
  ) {
    throw workflowError(
      'ROLE_CONTEXT_SHARING_GRANT_ADMISSION_REQUIRED',
      'R-007 completion author no longer matches its durable requirement.',
      ExitCode.guard,
    );
  }
  const consumed = consumeRoleContextSharingPlanReview(roleAdmission, {
    gitCommonDirectory: input.gitCommonDirectory,
    requirement: input.requirement,
    authorization: input.authorization,
    assignment: admissionBinding.assignment,
    policy: input.policy,
    verifier: resolveAuthoritativeRoleContextSharingGrantVerifier(
      input.verifier,
    ),
    lifecycle: input.lifecycle,
    author: admissionBinding.author,
    participant: admissionBinding.participant,
    content: admissionBinding.content,
    providerInvocation: admissionBinding.providerInvocation,
    ...(input.now === undefined ? {} : { now: input.now }),
    assertOwned: input.assertOwned,
  });
  return Object.freeze({
    consumed,
    roleResult: roleAdmission.admitRoleContextSharingResult({
      assignment: admissionBinding.assignment,
      author: admissionBinding.author,
      participant: admissionBinding.participant,
      content: admissionBinding.content,
      providerInvocation: admissionBinding.providerInvocation,
      consumedUse: consumed.evidence,
    }),
  });
}
export function createPlanReviewResults({
  acknowledgePolicyLoader,
  inspectReviewerPolicyLoader,
  planningEvidence,
  reopenReviewerPolicyLoader,
  reviewerTermBlocker,
  roleAdmission,
  readTrackedPlanReview,
  rebuildInvestigation,
  writeTrackedPlanReview,
}: {
  acknowledgePolicyLoader: ProposeDecisionServices['loadMaintainerPolicyForResolution'];
  inspectReviewerPolicyLoader: ProposeDecisionServices['loadMaintainerPolicyForResolution'];
  planningEvidence: ProposeDecisionServices['planningEvidence'];
  reopenReviewerPolicyLoader: ProposeDecisionServices['loadMaintainerPolicyForResolution'];
  reviewerTermBlocker: ProposeDecisionServices['createInvestigationHumanActionBlocker'];
  roleAdmission: ProposeDecisionServices['roleAdmission'];
  readTrackedPlanReview: ReturnType<
    typeof createPlanReviewStore
  >['readTrackedPlanReview'];
  rebuildInvestigation: ReturnType<
    typeof createInvestigationRebuild
  >['rebuildInvestigation'];
  writeTrackedPlanReview: ReturnType<
    typeof createPlanReviewStore
  >['writeTrackedPlanReview'];
}) {
  function materializePlanReviewResult(
    cwd: string,
    status: ProposeLifecycleStatus,
    reservation: PlanReviewReservation,
    result: ProviderProcessResult,
    assertOwned: HeldChangeTransitionAuthority,
    roleContextSharingGrant?: ProposeResumeOptions['roleContextSharingGrant'],
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ):
    | {
        nodes: EvidenceNode[];
        reviewNode: EvidenceNode;
        dispositionNode: EvidenceNode | null;
        roleResult: AdmittedRoleResult;
      }
    | {
        reopenedInvestigation: InvestigationStatus;
      }
    | {
        blockedInvestigation: InvestigationStatus;
      } {
    const context = loadInvestigationRuntimeContext(cwd);
    const existing = readTrackedPlanReview(
      context.git.repositoryRoot,
      status.changeId,
      {
        subject: reservation.subject,
        consumedPlanReviewReplay: grantValidation?.consumedPlanReviewReplay,
      },
    );
    if (existing !== null) {
      return existing;
    }
    if (result.runtimeObservation === null) {
      throw workflowError(
        'PLAN_REVIEW_RUNTIME_ASSURANCE_REQUIRED',
        'An ordinary provider PlanReview requires a fixed-runner observation.',
        ExitCode.verification,
      );
    }
    // `result.output` is what the provider wrote, so it must be completed with
    // the engine-derived fields before it is a canonical submission.
    const submission = canonicalizePlanReviewProviderSubmission(result.output);
    const providerResultNode = createPlanReviewProviderResultNode({
      subject: reservation.subject,
      assignment: reservation.assignment,
      request: reservation.request,
      result,
      targetSnapshotNode: reservation.targetSnapshotNode,
    });
    const reviewNode = createPlanReviewNode({
      subject: reservation.subject,
      assignment: reservation.assignment,
      providerResultNode,
      submission,
    });
    const review = readPlanReviewNode(reviewNode);
    let reviewerRebuild: RebuiltInvestigation | null = null;
    let reviewerResolution: ReturnType<
      typeof inspectReviewerTermResolutionAuthorization
    > = { outcome: 'none', resolutionNodeId: null };
    let novelReviewerTerms = review.proposedTerms;
    let reviewerReopenPolicy: ReturnType<typeof decideReviewerTermReopen> =
      review.proposedTerms.length === 0 ? 'no-novel-terms' : 'automatic-reopen';
    if (
      review.proposedTerms.length > 0 &&
      status.state !== 'investigation-exempt'
    ) {
      reviewerRebuild = rebuildInvestigation(
        cwd,
        status.investigationId,
        'consume',
        grantValidation,
        assertOwned,
      );
      const admittedContributions = reviewerRebuild.contributionNodes.map(
        (node) => structuredClone(node.output),
      ) as InvestigationTermContribution[];
      novelReviewerTerms = deriveReviewerTermDelta({
        existingContributions: admittedContributions,
        proposedTerms: review.proposedTerms,
        engineOwnedReviewerReferences:
          reviewerRebuild.reviewerTermSourceNodeIds,
      }).novelTerms;
      if (reviewerRebuild.reviewerTermReopenCount >= 2) {
        reviewerResolution = inspectReviewerTermResolutionAuthorization(
          inspectReviewerPolicyLoader,
          cwd,
          status.investigationId,
          reviewNode.resultDigest,
        );
      }
      reviewerReopenPolicy = decideReviewerTermReopen({
        usedReopens: reviewerRebuild.reviewerTermReopenCount,
        novelTermCount: novelReviewerTerms.length,
        humanResolution: reviewerResolution,
      });
      if (reviewerReopenPolicy === 'human-action-required') {
        return {
          blockedInvestigation:
            blockInvestigationForReviewerTermsUnderAuthority(
              reviewerTermBlocker,
              cwd,
              status.changeId,
              status.investigationId,
              {
                expectedRevision: status.revision,
                pendingReviewDigest: reviewNode.resultDigest,
                usedReopens: reviewerRebuild.reviewerTermReopenCount,
                proposedTermCount: novelReviewerTerms.length,
              },
              assertOwned,
            ),
        };
      }
    }
    const content = {
      kind: 'plan-review' as const,
      nodeId: providerResultNode.nodeId,
      resultDigest: providerResultNode.resultDigest,
      outputSchema: reservation.request.outputSchema,
      evaluator: reservation.request.evaluatorVersion,
      policyDigest: reservation.request.policyDigest,
      contentDigest: providerResultNode.resultDigest,
      current: true as const,
    };
    let grantUse: CollaborationGrantUseProjection | null = null;
    let grantAdmission: NonNullable<
      Parameters<RoleAdmissionServices['admitRoleResult']>[0]['grantValidation']
    > | null = null;
    const providerInvocation = {
      invocationId: reservation.request.invocationId,
      requestDigest: reservation.request.requestDigest,
      outputDigest: result.outputDigest,
      providerId: reservation.assignment.providerId,
      sessionId: reservation.assignment.sessionId,
      targetDigest: reservation.assignment.targetDigest,
      engineSpawned: true as const,
    };
    const roleContextSharingAssignment = isRoleContextSharingGrantedAssignment(
      reservation.assignment,
    )
      ? reservation.assignment
      : null;
    let roleContextSharingAdmission: ReturnType<
      typeof completeRoleContextSharingPlanReviewAdmission
    > | null = null;
    if (roleContextSharingAssignment !== null) {
      const authorization = reservation.grantAuthorization;
      if (
        authorization === null ||
        !('kind' in authorization) ||
        authorization.kind !==
          'role-context-sharing-plan-review-authorization.v1' ||
        authorization.grantId !==
          roleContextSharingAssignment.roleContextSharingGrantId ||
        authorization.reservationReceiptDigest !==
          roleContextSharingAssignment.reservationReceiptDigest
      ) {
        throw workflowError(
          'ROLE_CONTEXT_SHARING_GRANT_ADMISSION_REQUIRED',
          'An R-007 PlanReview requires its exact durable role-context-sharing authorization.',
          ExitCode.guard,
        );
      }
      if (
        roleContextSharingGrant === undefined ||
        roleContextSharingGrant.grantId !== authorization.grantId
      ) {
        throw workflowError(
          'ROLE_CONTEXT_SHARING_GRANT_ADMISSION_REQUIRED',
          'Resume requires the exact --role-context-grant selected for this R-007 PlanReview.',
          ExitCode.guard,
        );
      }
      const durableRequirement = readPlanReviewGrantRequirement(
        context.runtime,
        status,
      );
      if (
        durableRequirement === null ||
        durableRequirement.kind !== 'role-context-sharing' ||
        durableRequirement.requirementNodeId !== authorization.requirementNodeId
      ) {
        throw workflowError(
          'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
          'The R-007 PlanReview authorization no longer matches its durable requirement.',
          ExitCode.staleState,
        );
      }
      const policy = loadMaintainerPolicyAtCommit(
        context.git.repositoryRoot,
        authorization.expectedBinding.baselineCommit,
      );
      roleContextSharingAdmission =
        completeRoleContextSharingPlanReviewAdmission(roleAdmission, {
          gitCommonDirectory: context.git.gitCommonDirectory,
          requirement: durableRequirement.requirement,
          authorization,
          assignment: roleContextSharingAssignment,
          author: reservation.author,
          content,
          providerInvocation,
          policy,
          verifier: roleContextSharingGrant.verifier,
          lifecycle: roleContextSharingGrant.lifecycle,
          ...(roleContextSharingGrant.now === undefined
            ? {}
            : { now: roleContextSharingGrant.now }),
          assertOwned,
        });
    }
    if ('grantId' in reservation.assignment) {
      if (
        reservation.grantAuthorization === null ||
        'kind' in reservation.grantAuthorization ||
        reservation.grantAuthorization.grantId !==
          reservation.assignment.grantId
      ) {
        throw workflowError(
          'COLLABORATION_GRANT_ADMISSION_REQUIRED',
          'A granted PlanReview requires its exact durable grant authorization.',
          ExitCode.guard,
        );
      }
      const policy = loadMaintainerPolicyAtCommit(
        context.git.repositoryRoot,
        reservation.grantAuthorization.expectedBinding.baselineCommit,
      );
      const verifier = resolveAuthoritativeCollaborationGrantVerifier(
        grantValidation?.verifier,
      );
      const now = grantValidation?.now ?? new Date();
      const consumed = consumeCollaborationGrantUnderLifecycleLock(
        context.git.gitCommonDirectory,
        reservation.grantAuthorization.grantId,
        {
          transitionDigest: reservation.grantAuthorization.transitionDigest,
          assignment: reservation.assignment,
          contentAdmission: {
            kind: content.kind,
            nodeId: content.nodeId,
            resultDigest: content.resultDigest,
            current: true,
          },
          now,
          verifier,
        },
        assertOwned,
      );
      if (!consumed.use) {
        throw workflowError(
          'COLLABORATION_GRANT_ADMISSION_REQUIRED',
          'The exact PlanReview collaboration grant use was not durably consumed.',
          ExitCode.staleState,
        );
      }
      grantUse = consumed.use;
      grantAdmission = {
        now,
        expectedBinding: reservation.grantAuthorization.expectedBinding,
        policy,
        verifier,
        transitionDigest: reservation.grantAuthorization.transitionDigest,
      };
    }
    const roleResult =
      roleContextSharingAssignment !== null &&
      roleContextSharingAdmission !== null
        ? roleContextSharingAdmission.roleResult
        : roleAdmission.admitRoleResult({
            assignment: reservation.assignment,
            author: reservation.author,
            participant:
              'grantId' in reservation.assignment
                ? reservation.assignment.participant
                : {
                    providerId: reservation.assignment.providerId,
                    sessionId: reservation.assignment.sessionId,
                    principalId: null,
                    identityAssurance: 'adapter-assigned',
                    engineSpawned: true,
                  },
            content,
            providerInvocation,
            grantUse,
            grantValidation: grantAdmission,
          });
    if (
      review.proposedTerms.length > 0 &&
      novelReviewerTerms.length > 0 &&
      reviewerReopenPolicy !== 'human-close-input'
    ) {
      if (status.state === 'investigation-exempt') {
        retireCurrentProposeExemptionSession(
          loadInvestigationRuntimeContext(cwd).runtime,
          status,
          assertOwned,
        );
        throw workflowError(
          'INVESTIGATION_EXEMPTION_REVIEWER_TERMS_REQUIRED',
          'Reviewer terms invalidate the zero-scan exemption and require an ordinary investigation revision.',
          ExitCode.guard,
        );
      }
      const rebuilt =
        reviewerRebuild ??
        rebuildInvestigation(
          cwd,
          status.investigationId,
          'consume',
          grantValidation,
          assertOwned,
        );
      const existingContributions = rebuilt.contributionNodes.map((node) =>
        structuredClone(node.output),
      ) as InvestigationTermContribution[];
      const projection = projectPlanReviewTerms({
        validationInput: {
          reviewNode,
          providerResultNode,
          dispositionNode: null,
          subject: reservation.planning.subject,
          generation: reservation.planning.generation,
          target: reservation.planning.target,
          expectedReviewPolicyDigest:
            reservation.planning.policies.reviewPolicyDigest,
          requiredIndependence: roleResult.requiredIndependence,
          independenceAuthorization: {
            kind: 'admitted-role-result',
            roleResult,
          },
          repositoryEvidence: resolvePlanReviewRepositoryEvidence(
            planningEvidence,
            context.git.repositoryRoot,
            reservation.planning.generation.investigationBaseline.tree,
            reviewNode,
            reservation.manifest.planningTarget,
          ),
          planningTarget: reservation.manifest.planningTarget,
          planningEvidence: resolvePlanReviewPlanningEvidence(
            planningEvidence,
            context.git.repositoryRoot,
            reservation.manifest.planningTarget,
            reviewNode,
          ),
        },
        existingContributions,
        engineOwnedReviewerReferences: rebuilt.reviewerTermSourceNodeIds,
      });
      if (projection.preview.outcome !== 'ready') {
        throw workflowError(
          'INVESTIGATION_TERM_NARROWING_REQUIRED',
          'Reviewer-proposed terms exceed the fixed investigation budgets.',
          ExitCode.guard,
          { details: { violations: projection.preview.violations } },
        );
      }
      const sourceNode = createReviewerTermSourceNode({
        status,
        providerResultNode,
        reviewNode,
        roleResult,
        terms: novelReviewerTerms,
        priorGroupDispositions: rebuilt.session.milestones.groupDispositions!,
        priorWhyAnswers: rebuilt.session.milestones.whyAnswers!,
        previousReviewerTermSourceNode: rebuilt.reviewerTermSourceNode,
        authorizationResolutionNodeId:
          reviewerResolution.outcome === 'resume'
            ? reviewerResolution.resolutionNodeId
            : null,
      });
      for (const node of [providerResultNode, reviewNode, sourceNode]) {
        writeEvidenceNode(context.runtime, node);
      }
      return {
        reopenedInvestigation:
          reopenInvestigationForReviewerTermsUnderAuthority(
            reopenReviewerPolicyLoader,
            cwd,
            status.changeId,
            status.investigationId,
            {
              expectedRevision: status.revision,
              sourceNodeId: sourceNode.nodeId,
              usedReopens: rebuilt.reviewerTermReopenCount,
              pendingReviewDigest: reviewNode.resultDigest,
              authorizationResolutionNodeId:
                reviewerResolution.outcome === 'resume'
                  ? reviewerResolution.resolutionNodeId
                  : null,
            },
            assertOwned,
          ),
      };
    }
    if (
      reviewerReopenPolicy === 'human-close-input' &&
      reviewerResolution.outcome === 'close-input'
    ) {
      acknowledgeReviewerTermInputClosureUnderAuthority(
        acknowledgePolicyLoader,
        cwd,
        status.changeId,
        status.investigationId,
        {
          expectedRevision: status.revision,
          pendingReviewDigest: reviewNode.resultDigest,
          authorizationResolutionNodeId: reviewerResolution.resolutionNodeId,
        },
        assertOwned,
      );
    }
    const tracked = {
      nodes: [reservation.targetSnapshotNode, providerResultNode, reviewNode],
      reviewNode,
      dispositionNode: null,
      roleResult,
    };
    if (status.state === 'investigation-exempt') {
      assertCurrentExemptionContext(
        loadInvestigationRuntimeContext(cwd),
        status,
      );
    }
    writeTrackedPlanReview(context.git.repositoryRoot, status.changeId, {
      nodes: tracked.nodes,
      roleResult,
      dispositionNode: null,
    });
    assertOwned();
    return tracked;
  }
  return { materializePlanReviewResult };
}
