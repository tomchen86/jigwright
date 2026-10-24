/**
 * Validates current reviewer-term evidence and reconstructs its reopening lineage.
 *
 * Invariants:
 * - Terms bind the reviewed snapshot, provider result, checkpoints, and prior source.
 * - Only the current reviewer-term schema enters reconstruction.
 * - Replay validates exact consumed role authority without consuming another grant.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertCurrentPlanReviewProviderResultNode,
  readPlanReviewNode,
  readPlanReviewTargetSnapshotNode,
} from '../../modules/assurance/plan-review.ts';
import { replayCurrentPlanReviewRoleResult } from '../../modules/assurance/planning-assurance-validator.ts';
import { normalizeInvestigationTerm } from '../../modules/investigation/domain/investigation-terms.ts';
import { assertStoredReviewerTermDelta } from '../../modules/assurance/plan-review-terms.ts';
import { PROPOSE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  AdmittedRoleResult,
  ConsumedRoleReplayPort,
} from '../../modules/provider-orchestration/role-admission-contracts.ts';
import {
  hasExactKeys,
  isBaseline,
  isRecord,
  sha256,
} from '../../modules/proposal/propose-values.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import type {
  InvestigationSession,
  StoredInvestigationCheckpoint,
} from '../../modules/investigation/domain/investigation-session-types.ts';
import type { ProposeRuntime } from './propose-runtime.ts';
import type { ReviewerTermSourceRecord } from '../../modules/proposal/propose-types.ts';
export function readReviewerTermSource(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'investigation' | 'planningEvidence'
  >,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  nodeId: string | null,
  session: InvestigationSession,
  repositoryRoot: string,
  consumedPlanReviewReplay?: ConsumedRoleReplayPort,
): ReviewerTermSourceRecord | null {
  if (nodeId === null) {
    return null;
  }
  const sourceNode = services.evidence.readEvidenceNode(paths, nodeId);
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
    services,
    paths,
    sourceNode,
    session,
    repositoryRoot,
    consumedPlanReviewReplay,
  );
}

function readReviewerTermSourceV3(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'investigation' | 'planningEvidence'
  >,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
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
    services,
    paths,
    output.previousReviewerTermSourceNodeId,
    session,
    repositoryRoot,
    consumedPlanReviewReplay,
  );
  const embeddedProviderResultNode = output.providerResultNode as EvidenceNode;
  const reviewNode = output.reviewNode as EvidenceNode;
  const review = readPlanReviewNode(reviewNode);
  let roleResult: AdmittedRoleResult;
  try {
    roleResult = replayCurrentPlanReviewRoleResult(
      services.planningEvidence,
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
      services,
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
  const rawPriorWhyAnswers = output.priorWhyAnswers as Record<string, unknown>;
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
  const priorGroupEnvelope =
    services.investigation.assertInvestigationCheckpointEnvelope(
      rawPriorGroupDispositions.envelope,
    );
  const priorWhyEnvelope =
    services.investigation.assertInvestigationCheckpointEnvelope(
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
    sourceNode.semanticParentResultDigests.review !== reviewNode.resultDigest ||
    sourceNode.provenanceParentNodeIds.providerResult !==
      providerResultNode.nodeId ||
    sourceNode.semanticParentResultDigests.providerResult !==
      providerResultNode.resultDigest ||
    priorGroupDispositions.envelopeDigest !==
      sha256(canonicalJson(priorGroupEnvelope)) ||
    priorWhyAnswers.envelopeDigest !==
      sha256(canonicalJson(priorWhyEnvelope)) ||
    priorGroupDispositions.contributionDigest !==
      services.investigation.checkpointContributionDigest(priorGroupEnvelope) ||
    priorWhyAnswers.contributionDigest !==
      services.investigation.checkpointContributionDigest(priorWhyEnvelope) ||
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
    const authorization = services.investigation.readHumanResolutionNode(
      paths,
      authorizationNodeId,
    );
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

function readReviewerTermProviderResult(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
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
    const targetSnapshotNode = services.evidence.readEvidenceNode(
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

export { createBlindSurveyRoleResult } from './propose-blind-survey-admission.ts';
