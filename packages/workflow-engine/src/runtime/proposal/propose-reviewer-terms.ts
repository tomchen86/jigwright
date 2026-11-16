import type {
  InvestigationSession,
  StoredInvestigationCheckpoint,
} from '../../modules/investigation/domain/investigation-session-types.ts';
import type {
  ConsumedRoleReplayPort,
  AdmittedRoleResult,
} from '../../modules/provider-orchestration/role-admission-contracts.ts';
import type { ReviewerTermSourceRecord } from '../../modules/proposal/propose-types.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { readEvidenceNode } from '../storage-journal/evidence-node-store.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import { PROPOSE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  isRecord,
  hasExactKeys,
  isBaseline,
  sha256,
} from '../../modules/proposal/propose-values.ts';
import {
  readPlanReviewNode,
  assertCurrentPlanReviewProviderResultNode,
  readPlanReviewTargetSnapshotNode,
} from '../../modules/assurance/plan-review.ts';
import { replayCurrentPlanReviewRoleResult } from '../../modules/assurance/planning-assurance-validator.ts';
import { assertStoredReviewerTermDelta } from '../../modules/assurance/plan-review-terms.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { normalizeInvestigationTerm } from '../../modules/investigation/domain/investigation-terms.ts';
import {
  assertInvestigationCheckpointEnvelope,
  checkpointContributionDigest,
} from '../../modules/investigation/domain/investigation-checkpoint-contract.ts';
import { readHumanResolutionNode } from '../storage-journal/human-resolution-nodes.ts';
export function createReviewerTerms({
  planningEvidence,
}: {
  planningEvidence: ProposeDecisionServices['planningEvidence'];
}) {
  function readReviewerTermSource(
    paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    nodeId: string | null,
    session: InvestigationSession,
    repositoryRoot: string,
    consumedPlanReviewReplay?: ConsumedRoleReplayPort,
  ): ReviewerTermSourceRecord | null {
    if (nodeId === null) {
      return null;
    }
    const sourceNode = readEvidenceNode(paths, nodeId);
    if (
      sourceNode.type === 'investigation-reviewer-term-source' &&
      sourceNode.nodeSchema !== 'investigation.reviewer-term-source.v3'
    ) {
      throw workflowError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Reviewer-term source schema ${sourceNode.nodeSchema} is unsupported; only investigation.reviewer-term-source.v3 is current.`,
        ExitCode.guard,
        {
          details: {
            schema: sourceNode.nodeSchema,
            supportedSchema: 'investigation.reviewer-term-source.v3',
          },
        },
      );
    }
    return readReviewerTermSourceV3(
      paths,
      sourceNode,
      session,
      repositoryRoot,
      consumedPlanReviewReplay,
    );
  }

  function readReviewerTermSourceV3(
    paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    sourceNode: EvidenceNode,
    session: InvestigationSession,
    repositoryRoot: string,
    consumedPlanReviewReplay?: ConsumedRoleReplayPort,
  ): ReviewerTermSourceRecord {
    const output = sourceNode.output;
    if (
      sourceNode.type !== 'investigation-reviewer-term-source' ||
      sourceNode.nodeSchema !== 'investigation.reviewer-term-source.v3' ||
      sourceNode.evaluator !== 'workflow-propose.reviewer-term-source.v3' ||
      sourceNode.outputSchema !==
        'investigation.reviewer-term-source-output.v3' ||
      sourceNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
      !isRecord(output) ||
      !hasExactKeys(output, [
        'investigationId',
        'baseline',
        'providerResultNode',
        'reviewNode',
        'roleResult',
        'terms',
        'priorGroupDispositions',
        'priorWhyAnswers',
        'previousReviewerTermSourceNodeId',
        'authorizationResolutionNodeId',
      ]) ||
      !isRecord(output.providerResultNode) ||
      !isRecord(output.reviewNode) ||
      !isRecord(output.roleResult) ||
      !isRecord(output.priorGroupDispositions) ||
      !isRecord(output.priorWhyAnswers) ||
      !Array.isArray(output.terms) ||
      (output.previousReviewerTermSourceNodeId !== null &&
        typeof output.previousReviewerTermSourceNodeId !== 'string') ||
      (output.authorizationResolutionNodeId !== null &&
        typeof output.authorizationResolutionNodeId !== 'string')
    ) {
      throw invalidReviewerTermSource();
    }
    const previous = readReviewerTermSource(
      paths,
      output.previousReviewerTermSourceNodeId,
      session,
      repositoryRoot,
      consumedPlanReviewReplay,
    );
    const embeddedProviderResultNode =
      output.providerResultNode as EvidenceNode;
    const reviewNode = output.reviewNode as EvidenceNode;
    const review = readPlanReviewNode(reviewNode);
    let roleResult: AdmittedRoleResult;
    try {
      roleResult = replayCurrentPlanReviewRoleResult(
        planningEvidence,
        output.roleResult,
        {
          repositoryRoot,
          changeId: session.changeId,
          baselineCommit: session.baseline.head,
          baselineTree: session.baseline.tree,
          subjectDigest: review.subjectDigest,
          planningGenerationId: review.planningGenerationId,
        },
        consumedPlanReviewReplay,
      );
    } catch {
      throw invalidReviewerTermSource();
    }
    const { providerResultNode, targetSnapshotNode } =
      readReviewerTermProviderResult(
        paths,
        embeddedProviderResultNode,
        review,
        roleResult.providerInvocation,
        roleResult.content,
        reviewNode.exactInputDigests.submission,
      );
    const rawPriorGroupDispositions = output.priorGroupDispositions as Record<
      string,
      unknown
    >;
    const rawPriorWhyAnswers = output.priorWhyAnswers as Record<
      string,
      unknown
    >;
    if (
      !hasExactKeys(rawPriorGroupDispositions, [
        'envelopeDigest',
        'contributionDigest',
        'envelope',
      ]) ||
      !hasExactKeys(rawPriorWhyAnswers, [
        'envelopeDigest',
        'contributionDigest',
        'envelope',
      ])
    ) {
      throw invalidReviewerTermSource();
    }
    const priorGroupEnvelope = assertInvestigationCheckpointEnvelope(
      rawPriorGroupDispositions.envelope,
    );
    const priorWhyEnvelope = assertInvestigationCheckpointEnvelope(
      rawPriorWhyAnswers.envelope,
    );
    const priorGroupDispositions: StoredInvestigationCheckpoint = {
      envelopeDigest: String(rawPriorGroupDispositions.envelopeDigest),
      contributionDigest: String(rawPriorGroupDispositions.contributionDigest),
      envelope: priorGroupEnvelope,
    };
    const priorWhyAnswers: StoredInvestigationCheckpoint = {
      envelopeDigest: String(rawPriorWhyAnswers.envelopeDigest),
      contributionDigest: String(rawPriorWhyAnswers.contributionDigest),
      envelope: priorWhyEnvelope,
    };
    let terms: ReviewerTermSourceRecord['terms'];
    try {
      terms = assertStoredReviewerTermDelta({
        proposedTerms: review.proposedTerms,
        priorReviewerTerms: previous?.terms ?? [],
        storedTerms: output.terms as ReviewerTermSourceRecord['terms'],
      });
    } catch {
      throw invalidReviewerTermSource();
    }
    const previousNodeId = output.previousReviewerTermSourceNodeId as
      string | null;
    const authorizationNodeId = output.authorizationResolutionNodeId as
      string | null;
    const exactRoles = [
      'baseline',
      'terms',
      'roleResult',
      'priorGroupDispositions',
      'priorWhyAnswers',
      ...(previousNodeId === null ? [] : ['previousReviewerTerms']),
      ...(authorizationNodeId === null ? [] : ['humanResolution']),
    ];
    const parentRoles = [
      'review',
      'providerResult',
      ...(previousNodeId === null ? [] : ['previousReviewerTerms']),
    ];
    if (
      output.investigationId !== session.investigationId ||
      !isBaseline(output.baseline) ||
      canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
      providerResultNode.nodeId !== review.providerResultNodeId ||
      providerResultNode.resultDigest !== review.providerResultResultDigest ||
      roleResult.content.nodeId !== providerResultNode.nodeId ||
      roleResult.content.resultDigest !== providerResultNode.resultDigest ||
      !hasExactKeys(sourceNode.exactInputDigests, exactRoles) ||
      !hasExactKeys(sourceNode.semanticParentResultDigests, parentRoles) ||
      !hasExactKeys(sourceNode.provenanceParentNodeIds, parentRoles) ||
      sourceNode.exactInputDigests.baseline !==
        sha256(canonicalJson(output.baseline)) ||
      sourceNode.exactInputDigests.terms !== sha256(canonicalJson(terms)) ||
      sourceNode.exactInputDigests.roleResult !== roleResult.resultDigest ||
      sourceNode.exactInputDigests.priorGroupDispositions !==
        priorGroupDispositions.envelopeDigest ||
      sourceNode.exactInputDigests.priorWhyAnswers !==
        priorWhyAnswers.envelopeDigest ||
      sourceNode.provenanceParentNodeIds.review !== reviewNode.nodeId ||
      sourceNode.semanticParentResultDigests.review !==
        reviewNode.resultDigest ||
      sourceNode.provenanceParentNodeIds.providerResult !==
        providerResultNode.nodeId ||
      sourceNode.semanticParentResultDigests.providerResult !==
        providerResultNode.resultDigest ||
      priorGroupDispositions.envelopeDigest !==
        sha256(canonicalJson(priorGroupEnvelope)) ||
      priorWhyAnswers.envelopeDigest !==
        sha256(canonicalJson(priorWhyEnvelope)) ||
      priorGroupDispositions.contributionDigest !==
        checkpointContributionDigest(priorGroupEnvelope) ||
      priorWhyAnswers.contributionDigest !==
        checkpointContributionDigest(priorWhyEnvelope) ||
      priorGroupEnvelope.kind !== 'group-dispositions' ||
      priorWhyEnvelope.kind !== 'why-answers' ||
      priorGroupEnvelope.investigationId !== session.investigationId ||
      priorWhyEnvelope.investigationId !== session.investigationId ||
      priorGroupEnvelope.changeId !== session.changeId ||
      priorWhyEnvelope.changeId !== session.changeId ||
      priorGroupEnvelope.intentDigest !== session.intentDigest ||
      priorWhyEnvelope.intentDigest !== session.intentDigest ||
      priorGroupEnvelope.blindManifestDigest !== session.blindManifestDigest ||
      priorWhyEnvelope.blindManifestDigest !== session.blindManifestDigest ||
      canonicalJson(priorGroupEnvelope.baseline) !==
        canonicalJson(output.baseline) ||
      canonicalJson(priorWhyEnvelope.baseline) !==
        canonicalJson(output.baseline) ||
      previousNodeId !== (previous?.sourceNode.nodeId ?? null) ||
      (previous !== null &&
        (sourceNode.exactInputDigests.previousReviewerTerms !==
          previous.sourceNode.nodeId ||
          sourceNode.provenanceParentNodeIds.previousReviewerTerms !==
            previous.sourceNode.nodeId ||
          sourceNode.semanticParentResultDigests.previousReviewerTerms !==
            previous.sourceNode.resultDigest)) ||
      providerResultNode.exactInputDigests.targetSnapshot !==
        targetSnapshotNode.nodeId ||
      providerResultNode.semanticParentResultDigests.targetSnapshot !==
        targetSnapshotNode.resultDigest
    ) {
      throw invalidReviewerTermSource();
    }
    if (authorizationNodeId !== null) {
      const authorization = readHumanResolutionNode(paths, authorizationNodeId);
      if (
        authorization.target.workflowId !== session.investigationId ||
        authorization.target.changeId !== session.changeId ||
        authorization.decision.kind !== 'resume-with-capability' ||
        sourceNode.exactInputDigests.humanResolution !== authorization.nodeId
      ) {
        throw invalidReviewerTermSource();
      }
    }
    const cumulative = new Map<
      string,
      ReviewerTermSourceRecord['terms'][number]
    >();
    for (const term of [...(previous?.terms ?? []), ...terms]) {
      cumulative.set(normalizeInvestigationTerm(term).termId, term);
    }
    return {
      sourceNode,
      providerResultNode,
      reviewNode,
      targetSnapshotNode,
      evidenceNodes: [
        ...(previous?.evidenceNodes ?? []),
        ...(targetSnapshotNode === null ? [] : [targetSnapshotNode]),
        providerResultNode,
        reviewNode,
        sourceNode,
      ],
      roleResult,
      priorGroupDispositions,
      priorWhyAnswers,
      sourceNodeIds: [...(previous?.sourceNodeIds ?? []), sourceNode.nodeId],
      reopenCount: (previous?.reopenCount ?? 0) + 1,
      terms: [...cumulative.values()],
    };
  }
  return { readReviewerTermSource };
}

function readReviewerTermProviderResult(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  value: EvidenceNode,
  review: ReturnType<typeof readPlanReviewNode>,
  providerInvocation: AdmittedRoleResult['providerInvocation'],
  roleResultContent: AdmittedRoleResult['content'],
  reviewSubmissionDigest: string,
): { providerResultNode: EvidenceNode; targetSnapshotNode: EvidenceNode } {
  try {
    const providerResultNode = assertCurrentPlanReviewProviderResultNode(
      value,
      providerInvocation,
      roleResultContent,
      reviewSubmissionDigest,
    );
    if (providerResultNode.exactInputDigests.subject !== review.subjectDigest) {
      throw invalidReviewerTermSource();
    }
    const targetSnapshotNode = readEvidenceNode(
      paths,
      providerResultNode.provenanceParentNodeIds.targetSnapshot!,
    );
    const targetSnapshot = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
    if (
      providerResultNode.exactInputDigests.targetSnapshot !==
        targetSnapshotNode.nodeId ||
      providerResultNode.semanticParentResultDigests.targetSnapshot !==
        targetSnapshotNode.resultDigest ||
      targetSnapshotNode.policyDigest !== review.policyDigest ||
      targetSnapshot.subjectDigest !== review.subjectDigest ||
      targetSnapshot.planningGenerationId !== review.planningGenerationId ||
      targetSnapshot.planTargetDigest !== review.planTargetDigest
    ) {
      throw invalidReviewerTermSource();
    }
    return { providerResultNode, targetSnapshotNode };
  } catch {
    throw invalidReviewerTermSource();
  }
}

function invalidReviewerTermSource() {
  return workflowError(
    'INVESTIGATION_REVIEWER_TERM_SOURCE_INVALID',
    'Reviewer-term source evidence is malformed or no longer bound.',
    ExitCode.staleState,
  );
}
