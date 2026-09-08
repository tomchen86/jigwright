/**
 * Admits provider review results and incorporates their investigation consequences.
 *
 * Invariants:
 * - Engine-derived review fields and role admission bind the exact reserved subject.
 * - Granted admission preserves the exact consumed collaboration or context-sharing use.
 * - Reviewer terms preserve reopening evidence and invalidate unsupported exemptions.
 */

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  canonicalizePlanReviewProviderSubmission,
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  readPlanReviewNode,
} from '../../modules/assurance/plan-review.ts';
import {
  resolvePlanReviewPlanningEvidence,
  resolvePlanReviewRepositoryEvidence,
} from '../../modules/assurance/planning-assurance-validator.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { type RoleContextSharingGrantLifecyclePortV1 } from '../../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import { type InvestigationTermContribution } from '../../modules/investigation/domain/investigation-terms.ts';
import {
  deriveReviewerTermDelta,
  projectPlanReviewTerms,
} from '../../modules/projection/investigation-term-projection.ts';
import {
  isRoleContextSharingGrantedAssignment,
  type ProviderProcessResult,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  admitRoleContextSharingResult,
  admitRoleResult,
  type AdmittedRoleResult,
  normalizeRoleContextSharingResultAdmissionBinding,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  readPlanReviewGrantRequirement,
  readTrackedPlanReview,
  writeTrackedPlanReview,
} from './plan-review-store.ts';
import {
  assertCurrentExemptionContext,
  loadMaintainerPolicyAtCommit,
  resolveAuthoritativeCollaborationGrantVerifier,
  resolveAuthoritativeRoleContextSharingGrantVerifier,
} from './propose-context.ts';
import { createReviewerTermSourceNode } from './propose-evidence.ts';
import { rebuildInvestigation } from './propose-investigation-rebuild.ts';
import type {
  CollaborationGrantUseProjection,
  EvidenceNode,
  HeldChangeTransitionAuthority,
  InvestigationStatus,
  ProposeRuntime,
} from './propose-runtime.ts';
import {
  type PlanReviewReservation,
  type ProposeLifecycleStatus,
  type ProposeResumeOptions,
  type RebuiltInvestigation,
} from './propose-types.ts';
import {
  consumeRoleContextSharingPlanReview,
  type RoleContextSharingPlanReviewAuthorizationV1,
  type RoleContextSharingPlanReviewRequirementV3,
} from './role-context-sharing-plan-review.ts';

/**
 * Exact production completion seam for an R-007 PlanReview. The orchestrator
 * calls this only after the fixed provider invocation has succeeded; keeping
 * consume and admission in one operation makes crash replay exercise the same
 * one-use transition instead of a test-only lifecycle helper.
 */
export function completeRoleContextSharingPlanReviewAdmission(input: {
  gitCommonDirectory: string;
  requirement: RoleContextSharingPlanReviewRequirementV3;
  authorization: RoleContextSharingPlanReviewAuthorizationV1;
  assignment: ProviderRoleAssignment;
  author: RecordedRoleParticipant;
  content: Parameters<typeof admitRoleContextSharingResult>[0]['content'];
  providerInvocation: Parameters<
    typeof admitRoleContextSharingResult
  >[0]['providerInvocation'];
  policy: ReturnType<typeof parseMaintainerPolicy>;
  verifier: unknown;
  lifecycle: RoleContextSharingGrantLifecyclePortV1;
  now?: Date;
  assertOwned: () => void;
}): Readonly<{
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
  const admissionBinding = normalizeRoleContextSharingResultAdmissionBinding({
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
  const consumed = consumeRoleContextSharingPlanReview({
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
    roleResult: admitRoleContextSharingResult({
      assignment: admissionBinding.assignment,
      author: admissionBinding.author,
      participant: admissionBinding.participant,
      content: admissionBinding.content,
      providerInvocation: admissionBinding.providerInvocation,
      consumedUse: consumed.evidence,
    }),
  });
}

export function materializePlanReviewResult(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'grants' | 'investigation' | 'provider' | 'workspace'
  >,
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
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const existing = readTrackedPlanReview(
    services,
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
    ProposeRuntime['investigation']['inspectReviewerTermResolutionAuthorization']
  > = { outcome: 'none', resolutionNodeId: null };
  let novelReviewerTerms = review.proposedTerms;
  let reviewerReopenPolicy: ReturnType<
    ProposeRuntime['investigation']['decideReviewerTermReopen']
  > = review.proposedTerms.length === 0 ? 'no-novel-terms' : 'automatic-reopen';
  if (
    review.proposedTerms.length > 0 &&
    status.state !== 'investigation-exempt'
  ) {
    reviewerRebuild = rebuildInvestigation(
      services,
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
      engineOwnedReviewerReferences: reviewerRebuild.reviewerTermSourceNodeIds,
    }).novelTerms;
    if (reviewerRebuild.reviewerTermReopenCount >= 2) {
      reviewerResolution =
        services.investigation.inspectReviewerTermResolutionAuthorization(
          cwd,
          status.investigationId,
          reviewNode.resultDigest,
        );
    }
    reviewerReopenPolicy = services.investigation.decideReviewerTermReopen({
      usedReopens: reviewerRebuild.reviewerTermReopenCount,
      novelTermCount: novelReviewerTerms.length,
      humanResolution: reviewerResolution,
    });
    if (reviewerReopenPolicy === 'human-action-required') {
      return {
        blockedInvestigation:
          services.investigation.blockInvestigationForReviewerTermsUnderAuthority(
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
    Parameters<typeof admitRoleResult>[0]['grantValidation']
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
      services,
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
      services,
      context.git.repositoryRoot,
      authorization.expectedBinding.baselineCommit,
    );
    roleContextSharingAdmission = completeRoleContextSharingPlanReviewAdmission(
      {
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
      },
    );
  }
  if ('grantId' in reservation.assignment) {
    if (
      reservation.grantAuthorization === null ||
      'kind' in reservation.grantAuthorization ||
      reservation.grantAuthorization.grantId !== reservation.assignment.grantId
    ) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        'A granted PlanReview requires its exact durable grant authorization.',
        ExitCode.guard,
      );
    }
    const policy = loadMaintainerPolicyAtCommit(
      services,
      context.git.repositoryRoot,
      reservation.grantAuthorization.expectedBinding.baselineCommit,
    );
    const verifier = resolveAuthoritativeCollaborationGrantVerifier(
      grantValidation?.verifier,
    );
    const now = grantValidation?.now ?? new Date();
    const consumed =
      services.grants.consumeCollaborationGrantUnderLifecycleLock(
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
      : admitRoleResult({
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
      services.investigation.retireCurrentProposeExemptionSession(
        services.workspace.loadInvestigationRuntimeContext(cwd).runtime,
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
        services,
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
          context.git.repositoryRoot,
          reservation.planning.generation.investigationBaseline.tree,
          reviewNode,
          reservation.manifest.planningTarget,
        ),
        planningTarget: reservation.manifest.planningTarget,
        planningEvidence: resolvePlanReviewPlanningEvidence(
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
      services.evidence.writeEvidenceNode(context.runtime, node);
    }
    return {
      reopenedInvestigation:
        services.investigation.reopenInvestigationForReviewerTermsUnderAuthority(
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
    services.investigation.acknowledgeReviewerTermInputClosureUnderAuthority(
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
      roleResult,
      dispositionNode: null,
    },
  );
  assertOwned();
  return tracked;
}
