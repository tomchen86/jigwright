/**
 * Constructs and validates immutable evidence envelopes for propose transitions.
 *
 * Invariants:
 * - Schemas, canonical digests, and semantic and provenance parents retain identity.
 * - Manifest authority binds the current session; conflicting node bytes fail.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../../foundation/evidence-node/evidence-node.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  InvestigationTermContribution,
  InvestigationTermRawCounts,
  PreviewInvestigationTerm,
} from '../../modules/investigation/domain/investigation-terms.ts';
import type { InvestigationManifestV3 } from '../../modules/investigation/manifest/investigation-manifest.ts';
import {
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
  type ProviderProcessResult,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ActorResolution } from '../../modules/provider-orchestration/actor-identity.ts';
import type { AdmittedRoleResult } from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  DIGEST,
  hasExactKeys,
  isRecord,
  planningMaterializationStale,
  PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA,
  PROPOSE_AUTHORIZATION_SCHEMA,
  sha256,
} from './propose-common.ts';
import { investigationV3SessionSnapshotDigest } from './propose-investigation-manifest.ts';
import type {
  ExemptionProposeOutput,
  PlanReviewReservation,
  PlanReviewRetryEnvelope,
  RebuiltInvestigation,
} from './propose-types.ts';

type InvestigationSession = RebuiltInvestigation['session'];
type StoredInvestigationCheckpoint = NonNullable<
  InvestigationSession['milestones']['groupDispositions']
>;
type ProviderRetryDecisionBinding = NonNullable<
  PlanReviewReservation['retry']
>['retryDecision'];
type ProviderExecutionPolicySnapshotCurrent = NonNullable<
  PlanReviewReservation['retry']
>['executionPolicySnapshot'];

export function createTermContributionNode(
  session: Pick<InvestigationSession, 'baseline'>,
  contribution: InvestigationTermContribution,
  reviewerSourceNode: EvidenceNode | null = null,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-term-contribution',
    nodeSchema: 'investigation.term-contribution.v2',
    evaluator: 'workflow-propose.term-contribution.v2',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      contribution: sha256(canonicalJson(contribution)),
    },
    semanticParentResultDigests:
      reviewerSourceNode === null
        ? {}
        : { reviewerSource: reviewerSourceNode.resultDigest },
    provenanceParentNodeIds:
      reviewerSourceNode === null
        ? {}
        : { reviewerSource: reviewerSourceNode.nodeId },
    outputSchema: 'investigation.term-contribution-output.v2',
    output: contribution,
    runtimeMetadata: {},
  });
}

export function createReviewerTermSourceNode(input: {
  status: Pick<InvestigationSession, 'investigationId' | 'baseline'>;
  providerResultNode: EvidenceNode;
  reviewNode: EvidenceNode;
  roleResult: AdmittedRoleResult;
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
  priorGroupDispositions: StoredInvestigationCheckpoint;
  priorWhyAnswers: StoredInvestigationCheckpoint;
  previousReviewerTermSourceNode: EvidenceNode | null;
  authorizationResolutionNodeId: string | null;
}): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-reviewer-term-source',
    nodeSchema: 'investigation.reviewer-term-source.v3',
    evaluator: 'workflow-propose.reviewer-term-source.v3',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(input.status.baseline)),
      terms: sha256(canonicalJson(input.terms)),
      roleResult: input.roleResult.resultDigest,
      priorGroupDispositions: input.priorGroupDispositions.envelopeDigest,
      priorWhyAnswers: input.priorWhyAnswers.envelopeDigest,
      ...(input.previousReviewerTermSourceNode === null
        ? {}
        : {
            previousReviewerTerms: input.previousReviewerTermSourceNode.nodeId,
          }),
      ...(input.authorizationResolutionNodeId === null
        ? {}
        : {
            humanResolution: input.authorizationResolutionNodeId,
          }),
    },
    semanticParentResultDigests: {
      review: input.reviewNode.resultDigest,
      providerResult: input.providerResultNode.resultDigest,
      ...(input.previousReviewerTermSourceNode === null
        ? {}
        : {
            previousReviewerTerms:
              input.previousReviewerTermSourceNode.resultDigest,
          }),
    },
    provenanceParentNodeIds: {
      review: input.reviewNode.nodeId,
      providerResult: input.providerResultNode.nodeId,
      ...(input.previousReviewerTermSourceNode === null
        ? {}
        : {
            previousReviewerTerms: input.previousReviewerTermSourceNode.nodeId,
          }),
    },
    outputSchema: 'investigation.reviewer-term-source-output.v3',
    output: {
      investigationId: input.status.investigationId,
      baseline: input.status.baseline,
      providerResultNode: input.providerResultNode,
      reviewNode: input.reviewNode,
      roleResult: input.roleResult,
      terms: input.terms,
      priorGroupDispositions: input.priorGroupDispositions,
      priorWhyAnswers: input.priorWhyAnswers,
      previousReviewerTermSourceNodeId:
        input.previousReviewerTermSourceNode?.nodeId ?? null,
      authorizationResolutionNodeId: input.authorizationResolutionNodeId,
    },
    runtimeMetadata: {},
  });
}

export function createTermUnionNode(
  session: Pick<InvestigationSession, 'baseline'>,
  terms: PreviewInvestigationTerm[],
  rawCounts: InvestigationTermRawCounts,
  contributionNodes: EvidenceNode[],
): EvidenceNode {
  const semanticParentResultDigests: Record<string, string> = {};
  const provenanceParentNodeIds: Record<string, string> = {};
  [...contributionNodes]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .forEach((node, index) => {
      semanticParentResultDigests[`contribution-${index}`] = node.resultDigest;
      provenanceParentNodeIds[`contribution-${index}`] = node.nodeId;
    });
  return createEvidenceNode({
    type: 'investigation-term-union',
    nodeSchema: 'investigation.term-union.v2',
    evaluator: 'workflow-propose.term-union.v2',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      terms: sha256(canonicalJson(terms)),
    },
    semanticParentResultDigests,
    provenanceParentNodeIds,
    outputSchema: 'investigation.term-union-output.v2',
    output: { rawCounts, terms },
    runtimeMetadata: {},
  });
}

export function createProviderResultNode(
  session: Pick<InvestigationSession, 'baseline'>,
  request: ProviderInvocationRequest,
  result: ProviderProcessResult,
  authorizationNode: EvidenceNode,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-provider-result',
    nodeSchema: 'investigation.provider-result.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      request: request.requestDigest,
      result: result.outputDigest,
    },
    semanticParentResultDigests: {
      authorization: authorizationNode.resultDigest,
    },
    provenanceParentNodeIds: {
      authorization: authorizationNode.nodeId,
    },
    outputSchema: 'investigation.provider-result-output.v1',
    output: { request, result },
    runtimeMetadata: {},
  });
}

export function createPlanReviewReplacementReservationNode(
  reservation: PlanReviewReservation,
  previousReservationNode: EvidenceNode,
  input: PlanReviewRetryEnvelope,
  replacementRequest: ProviderInvocationRequest,
  attempt: number,
  retryDecision: ProviderRetryDecisionBinding,
  executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent,
): EvidenceNode {
  return createEvidenceNode({
    type: 'plan-review-request-reservation',
    nodeSchema: 'workflow.plan-review-request-reservation.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      request: replacementRequest.requestDigest,
      manifest: replacementRequest.inputManifestDigest,
      subject: reservation.subject.subjectDigest,
      targetSnapshot: reservation.targetSnapshotNode.nodeId,
      previousRequest: previousReservationNode.nodeId,
      failure: input.failedInvocation.failureDigest,
      retryDecision: retryDecision.evidenceDigest,
      executionPolicySnapshot: sha256(canonicalJson(executionPolicySnapshot)),
    },
    semanticParentResultDigests: {
      authorization:
        previousReservationNode.semanticParentResultDigests.authorization,
      previousRequest: previousReservationNode.resultDigest,
    },
    provenanceParentNodeIds: {
      authorization:
        previousReservationNode.provenanceParentNodeIds.authorization,
      previousRequest: previousReservationNode.nodeId,
    },
    outputSchema: 'workflow.plan-review-request-reservation-output.v3',
    output: {
      investigationId: input.investigationId,
      changeId: input.changeId,
      planning: reservation.planning,
      subject: reservation.subject,
      assignment: reservation.assignment,
      author: reservation.author,
      materializationNode: reservation.materializationNode,
      targetSnapshotNode: reservation.targetSnapshotNode,
      manifest: reservation.manifest,
      request: replacementRequest,
      grantAuthorization: reservation.grantAuthorization,
      retry: {
        attempt,
        previousReservationNodeId: previousReservationNode.nodeId,
        failedInvocation: input.failedInvocation,
        retryDecision,
        executionPolicySnapshot,
      },
    },
    runtimeMetadata: {},
  });
}

export function createInvestigationManifestAuthorityNode(
  rebuilt: Pick<RebuiltInvestigation, 'session'>,
  manifest: InvestigationManifestV3,
): EvidenceNode {
  const sessionSnapshotDigest = investigationV3SessionSnapshotDigest(
    rebuilt.session,
  );
  const investigationTargetDigest =
    manifest.investigationApproval.investigationTargetDigest;
  if (
    manifest.changeId !== rebuilt.session.changeId ||
    manifest.investigationId !== rebuilt.session.investigationId ||
    manifest.authoring.sessionRevision !== rebuilt.session.revision ||
    manifest.authoring.sessionSnapshotDigest !== sessionSnapshotDigest ||
    !DIGEST.test(manifest.manifestDigest) ||
    !DIGEST.test(investigationTargetDigest)
  ) {
    throw workflowError(
      'RECONSTRUCTION_MISMATCH',
      'Manifest authority does not bind the current investigation session.',
      ExitCode.staleState,
    );
  }
  return createEvidenceNode({
    type: 'investigation-manifest-authority',
    nodeSchema: 'investigation.manifest-authority.v1',
    evaluator: 'workflow-propose.manifest-authority.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.manifest-authority-output.v1',
    output: {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
    },
    runtimeMetadata: {},
  });
}

export type InvestigationManifestAuthorityBinding = {
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  manifestDigest: string;
  investigationTargetDigest: string;
};

export function readInvestigationManifestAuthorityNode(
  node: EvidenceNode,
): InvestigationManifestAuthorityBinding {
  const output = node.output;
  if (
    node.type !== 'investigation-manifest-authority' ||
    node.nodeSchema !== 'investigation.manifest-authority.v1' ||
    node.evaluator !== 'workflow-propose.manifest-authority.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== 'investigation.manifest-authority-output.v1' ||
    !hasExactKeys(node.exactInputDigests, [
      'manifest',
      'investigationTarget',
      'sessionSnapshot',
    ]) ||
    Object.keys(node.semanticParentResultDigests).length !== 0 ||
    Object.keys(node.provenanceParentNodeIds).length !== 0 ||
    Object.keys(node.runtimeMetadata).length !== 0 ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'manifestDigest',
      'investigationTargetDigest',
    ]) ||
    typeof output.repositoryId !== 'string' ||
    typeof output.changeId !== 'string' ||
    typeof output.investigationId !== 'string' ||
    !Number.isSafeInteger(output.sessionRevision) ||
    !DIGEST.test(String(output.sessionSnapshotDigest)) ||
    !DIGEST.test(String(output.manifestDigest)) ||
    !DIGEST.test(String(output.investigationTargetDigest)) ||
    node.exactInputDigests.manifest !== output.manifestDigest ||
    node.exactInputDigests.investigationTarget !==
      output.investigationTargetDigest ||
    node.exactInputDigests.sessionSnapshot !== output.sessionSnapshotDigest
  ) {
    throw planningMaterializationStale(
      'Investigation Manifest authority binding is invalid or stale.',
    );
  }
  return output as InvestigationManifestAuthorityBinding;
}

export function uniqueNodes(nodes: EvidenceNode[]): EvidenceNode[] {
  const byId = new Map<string, EvidenceNode>();
  for (const node of nodes) {
    const existing = byId.get(node.nodeId);
    if (existing && canonicalJson(existing) !== canonicalJson(node)) {
      throw workflowError(
        'INVESTIGATION_EVIDENCE_COLLISION',
        'Investigation evidence reuses a node ID for different bytes.',
        ExitCode.conflict,
      );
    }
    byId.set(node.nodeId, node);
  }
  return [...byId.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
}

export function createProposeAuthorizationNode({
  actorResolution,
  assignment,
  grantAuthorization,
  baseline,
  intent,
  intentDigest,
  protectedBase,
}: {
  actorResolution: Pick<
    Extract<ActorResolution, { outcome: 'resolved' }>,
    'actor' | 'signals'
  >;
  assignment: PlanReviewReservation['assignment'];
  grantAuthorization: PlanReviewReservation['grantAuthorization'];
  baseline: InvestigationSession['baseline'];
  intent: RebuiltInvestigation['intent'];
  intentDigest: string;
  protectedBase: { ref: string; commit: string };
}): EvidenceNode {
  return createEvidenceNode({
    type: 'propose-authorization',
    nodeSchema: PROPOSE_AUTHORIZATION_SCHEMA,
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      actorResolution: sha256(
        canonicalJson({
          actor: actorResolution.actor,
          signals: actorResolution.signals,
        }),
      ),
      assignment: sha256(canonicalJson(assignment)),
      grantAuthorization: sha256(canonicalJson(grantAuthorization)),
      baseline: sha256(
        canonicalJson({
          head: baseline.head,
          tree: baseline.tree,
        }),
      ),
      intent: intentDigest,
      protectedBase: sha256(
        canonicalJson({
          ref: protectedBase.ref,
          commit: protectedBase.commit,
        }),
      ),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA,
    output: {
      actor: actorResolution.actor,
      signals: actorResolution.signals,
      assignment,
      grantAuthorization,
      intent,
      baseline: {
        head: baseline.head,
        tree: baseline.tree,
      },
      protectedBase: {
        ref: protectedBase.ref,
        commit: protectedBase.commit,
      },
    },
    runtimeMetadata: {},
  });
}

export function createPlanningMaterializationNode(
  status: Pick<
    InvestigationSession,
    | 'changeId'
    | 'investigationId'
    | 'revision'
    | 'semanticRevision'
    | 'baseline'
  >,
  manifestAuthorityNode: EvidenceNode,
  artifacts: Record<string, string>,
): EvidenceNode {
  const authority = readInvestigationManifestAuthorityNode(
    manifestAuthorityNode,
  );
  if (
    authority.changeId !== status.changeId ||
    authority.investigationId !== status.investigationId ||
    authority.sessionRevision !== status.revision
  ) {
    throw planningMaterializationStale(
      'Planning materialization does not bind the current Manifest session.',
    );
  }
  return createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(status.baseline)),
      manifestAuthority: manifestAuthorityNode.nodeId,
      manifest: authority.manifestDigest,
      investigationTarget: authority.investigationTargetDigest,
      sessionSnapshot: authority.sessionSnapshotDigest,
    },
    semanticParentResultDigests: {
      manifestAuthority: manifestAuthorityNode.resultDigest,
    },
    provenanceParentNodeIds: {
      manifestAuthority: manifestAuthorityNode.nodeId,
    },
    outputSchema: 'workflow.propose-planning-materialization-output.v3',
    output: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      semanticRevision: status.semanticRevision,
      baseline: status.baseline,
      artifacts,
      manifestAuthorityNodeId: manifestAuthorityNode.nodeId,
      manifestAuthorityResultDigest: manifestAuthorityNode.resultDigest,
      manifestDigest: authority.manifestDigest,
      investigationTargetDigest: authority.investigationTargetDigest,
      sessionSnapshotDigest: authority.sessionSnapshotDigest,
    },
    runtimeMetadata: {},
  });
}

export function createExemptionPlanningMaterializationNode(
  session: Pick<
    NonNullable<ExemptionProposeOutput['investigation']>,
    | 'applicabilityNode'
    | 'baseline'
    | 'investigationId'
    | 'changeId'
    | 'revision'
  >,
  artifacts: Record<string, string>,
): EvidenceNode {
  const applicabilityNode = session.applicabilityNode;
  return createEvidenceNode({
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'workflow.propose-exemption-planning-materialization.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(session.baseline)),
      applicability: applicabilityNode.nodeId,
    },
    semanticParentResultDigests: {
      applicability: applicabilityNode.resultDigest,
    },
    provenanceParentNodeIds: {
      applicability: applicabilityNode.nodeId,
    },
    outputSchema:
      'workflow.propose-exemption-planning-materialization-output.v1',
    output: {
      investigationId: session.investigationId,
      changeId: session.changeId,
      revision: session.revision,
      baseline: session.baseline,
      artifacts,
      applicabilityNodeId: applicabilityNode.nodeId,
      applicabilityResultDigest: applicabilityNode.resultDigest,
    },
    runtimeMetadata: {},
  });
}

export function createPlanReviewAuthorizationNode({
  planning,
  assignment,
  grantAuthorization,
  roleTopology,
  targetSnapshotNode,
  materializationNode,
  materializationNodeId,
  author: recordedAuthor,
}: Pick<
  PlanReviewReservation,
  | 'planning'
  | 'assignment'
  | 'grantAuthorization'
  | 'roleTopology'
  | 'targetSnapshotNode'
  | 'materializationNode'
  | 'author'
> & {
  materializationNodeId: string;
}): EvidenceNode {
  return createEvidenceNode({
    type: 'plan-review-authorization',
    nodeSchema: 'workflow.plan-review-authorization.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      subject: planning.subject.subjectDigest,
      generation: planning.generation.planningGenerationId,
      assignment: sha256(canonicalJson(assignment)),
      grantAuthorization: sha256(canonicalJson(grantAuthorization)),
      roleTopology: sha256(canonicalJson(roleTopology)),
      targetSnapshot: targetSnapshotNode.nodeId,
    },
    semanticParentResultDigests: {
      materialization: materializationNode.resultDigest,
      targetSnapshot: targetSnapshotNode.resultDigest,
    },
    provenanceParentNodeIds: {
      materialization: materializationNodeId,
      targetSnapshot: targetSnapshotNode.nodeId,
    },
    outputSchema: 'workflow.plan-review-authorization-output.v3',
    output: {
      subject: planning.subject,
      assignment,
      author: recordedAuthor,
      grantAuthorization,
      roleTopology,
    },
    runtimeMetadata: {},
  });
}

export function createPlanReviewReservationNode({
  status,
  planning,
  assignment,
  author: recordedAuthor,
  materializationNode,
  targetSnapshotNode,
  manifest,
  request,
  grantAuthorization,
  reviewAuthorization,
}: Pick<
  PlanReviewReservation,
  | 'planning'
  | 'assignment'
  | 'author'
  | 'materializationNode'
  | 'targetSnapshotNode'
  | 'manifest'
  | 'request'
  | 'grantAuthorization'
> & {
  status: Pick<InvestigationSession, 'investigationId' | 'changeId'>;
  reviewAuthorization: EvidenceNode;
}): EvidenceNode {
  return createEvidenceNode({
    type: 'plan-review-request-reservation',
    nodeSchema: 'workflow.plan-review-request-reservation.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      request: request.requestDigest,
      manifest: request.inputManifestDigest,
      subject: planning.subject.subjectDigest,
      targetSnapshot: targetSnapshotNode.nodeId,
    },
    semanticParentResultDigests: {
      authorization: reviewAuthorization.resultDigest,
    },
    provenanceParentNodeIds: { authorization: reviewAuthorization.nodeId },
    outputSchema: 'workflow.plan-review-request-reservation-output.v3',
    output: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      planning,
      subject: planning.subject,
      assignment,
      author: recordedAuthor,
      materializationNode,
      targetSnapshotNode,
      manifest,
      request,
      grantAuthorization,
      retry: null,
    },
    runtimeMetadata: {},
  });
}
