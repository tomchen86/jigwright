/** Pure planning evidence admission and exact consumed role replay rules. */

import type { AdmittedRoleResult } from '../provider-orchestration/role-admission-contracts.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { bindingFromPayload } from '../authority/collaboration-grant-codec.ts';
import { readPlanReviewNode } from './plan-review.ts';
import type { PlanReviewSubject } from './plan-review-subject.ts';
import type { PlanReviewTargetSnapshot } from './plan-review-target-snapshot-record.ts';
import type {
  PlanReviewRepositoryEvidence,
  PlanReviewPlanningEvidence,
} from './plan-review-validation.ts';
import crypto from 'node:crypto';
import type {
  CurrentPlanReviewRoleResultReplayContext,
  ConsumedPlanReviewReplayPort,
  ChangeContract,
  EvidenceNode,
} from './planning-assurance-validator.ts';

import {
  planningNotReady,
  sha256,
  isPlainRecord,
} from './planning-assurance-values.ts';
import type {
  PlanningAssuranceEvidenceObservations,
  PlanningAssuranceRoleAdmission,
} from './planning-assurance-observations.ts';
export function replayCurrentPlanReviewRoleResult(
  dependencies: PlanningAssuranceRoleAdmission,
  storedValue: unknown,
  context: CurrentPlanReviewRoleResultReplayContext,
  consumedPlanReviewReplay?: ConsumedPlanReviewReplayPort,
): AdmittedRoleResult {
  let stored: AdmittedRoleResult;
  try {
    stored =
      dependencies.roleAdmission.assertAdmittedRoleResultRecord(storedValue);
  } catch {
    throw planningNotReady('Stored PlanReview role result is malformed.');
  }
  if (stored.form === 'granted-role-context-sharing') {
    const evidence = stored.roleContextSharingUse;
    const expected = evidence?.expectedBinding;
    if (
      consumedPlanReviewReplay === undefined ||
      evidence === null ||
      expected === undefined ||
      stored.providerInvocation === null ||
      expected.changeId !== context.changeId ||
      expected.baselineCommit !== context.baselineCommit ||
      expected.baselineTree !== context.baselineTree ||
      expected.subjectDigest !== context.subjectDigest ||
      expected.targetDigest !== context.subjectDigest ||
      expected.planningGeneration !== context.planningGenerationId ||
      expected.lifecyclePhase !== 'plan-review'
    ) {
      throw planningNotReady(
        'Role-context-sharing PlanReview is bound to another transition or has no terminal replay authority.',
      );
    }
    const replay = consumedPlanReviewReplay.verifyRoleContextSharing({
      repositoryRoot: context.repositoryRoot,
      evidence,
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
    });
    if (
      replay.grantId !== evidence.grantId ||
      replay.terminalRecordDigest !== evidence.terminalRecordDigest ||
      replay.useProjectionDigest !== evidence.useProjectionDigest
    ) {
      throw planningNotReady(
        'Consumed role-context-sharing replay proof does not match the exact stored use.',
      );
    }
    const replayed =
      dependencies.roleAdmission.admitConsumedRoleContextSharingResultReplay({
        assignment: stored.assignment,
        author: stored.author,
        participant: stored.participant,
        content: stored.content,
        providerInvocation: stored.providerInvocation,
        replay,
      });
    if (canonicalJson(replayed) !== canonicalJson(stored)) {
      throw planningNotReady(
        'Stored PlanReview role result does not replay exactly.',
      );
    }
    return replayed;
  }
  let replayed: AdmittedRoleResult;
  if (stored.form === 'ordinary-provider') {
    if (
      stored.author.sessionId === null ||
      stored.assignment.sessionId === null ||
      stored.author.sessionId === stored.assignment.sessionId ||
      (stored.requiredIndependence === 'session-independent'
        ? stored.achievedIndependence !== 'provider-independent' &&
          stored.achievedIndependence !== 'session-independent'
        : stored.requiredIndependence !== 'provider-independent' ||
          stored.achievedIndependence !== 'provider-independent' ||
          stored.author.providerId === null ||
          stored.author.providerId === stored.assignment.providerId)
    ) {
      throw planningNotReady(
        'Ordinary PlanReview must record a session distinct from the plan author.',
      );
    }
    replayed = dependencies.roleAdmission.admitRoleResult({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      grantUse: null,
      grantValidation: null,
    });
  } else {
    if (consumedPlanReviewReplay === undefined || !stored.grantUse) {
      throw planningNotReady(
        'Granted PlanReview role result has no terminal replay authority.',
      );
    }
    const envelope = dependencies.grantCodec.parseCollaborationGrantEnvelope(
      dependencies.grantCodec.canonicalCollaborationGrantEnvelope(
        stored.grantUse.envelope,
      ),
    );
    if (
      envelope.payload.changeId !== context.changeId ||
      envelope.payload.baselineCommit !== context.baselineCommit ||
      envelope.payload.baselineTree !== context.baselineTree ||
      envelope.payload.targetDigest !== context.subjectDigest ||
      envelope.payload.lifecyclePhase !== 'plan-review'
    ) {
      throw planningNotReady(
        'Granted PlanReview role result is bound to another transition.',
      );
    }
    const expectedBinding = bindingFromPayload(envelope.payload);
    const replay = consumedPlanReviewReplay.verify({
      repositoryRoot: context.repositoryRoot,
      expectedBinding,
      grantUse: stored.grantUse,
      assignment: stored.assignment,
      content: stored.content,
      directHumanReviewAttestation: stored.directHumanReviewAttestation,
    });
    if (
      replay.grantId !== stored.grantUse.grantId ||
      replay.transitionDigest !== stored.grantUse.transitionDigest ||
      replay.useDigest !== sha256(canonicalJson(stored.grantUse))
    ) {
      throw planningNotReady(
        'Consumed PlanReview replay proof does not match the exact stored grant use.',
      );
    }
    replayed = dependencies.roleAdmission.admitConsumedRoleResultReplay({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      replay,
    });
  }
  if (canonicalJson(replayed) !== canonicalJson(stored)) {
    throw planningNotReady(
      'Stored PlanReview role result does not replay exactly.',
    );
  }
  return replayed;
}

export function requireCurrentPlanReviewRoleResult(
  dependencies: PlanningAssuranceRoleAdmission,
  repositoryRoot: string,
  contract: ChangeContract,
  providerResultNode: EvidenceNode,
  subject: PlanReviewSubject,
  consumedPlanReviewReplay: ConsumedPlanReviewReplayPort,
): AdmittedRoleResult {
  const candidates = contract.planReview?.roleResults ?? [];
  const matches = candidates.filter((candidate) => {
    if (!isPlainRecord(candidate) || !isPlainRecord(candidate.content)) {
      return false;
    }
    return (
      candidate.role === 'plan-reviewer' &&
      candidate.targetDigest === subject.subjectDigest &&
      candidate.content.nodeId === providerResultNode.nodeId &&
      candidate.content.resultDigest === providerResultNode.resultDigest
    );
  });
  if (matches.length !== 1) {
    throw planningNotReady(
      'Exactly one admitted role result must authorize the current PlanReview.',
    );
  }
  return replayCurrentPlanReviewRoleResult(
    dependencies,
    matches[0],
    {
      repositoryRoot,
      changeId: contract.changeId,
      baselineCommit: subject.investigationBaseline.head,
      baselineTree: subject.investigationBaseline.tree,
      subjectDigest: subject.subjectDigest,
      planningGenerationId: subject.planningGenerationId,
    },
    consumedPlanReviewReplay,
  );
}

export function resolvePlanReviewRepositoryEvidence(
  observations: PlanningAssuranceEvidenceObservations,
  repositoryRoot: string,
  tree: string,
  reviewNode: EvidenceNode,
  planningSnapshot?: PlanReviewTargetSnapshot,
): PlanReviewRepositoryEvidence {
  const review = readPlanReviewNode(reviewNode);
  const citations = [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  const paths = [
    ...new Set(
      citations
        .filter(
          (
            citation,
          ): citation is Extract<
            (typeof citations)[number],
            { kind: 'repository-location' }
          > => citation.kind === 'repository-location',
        )
        .map((citation) => citation.path),
    ),
  ].sort(compareUtf8);
  const planningPaths = new Set(
    planningSnapshot?.artifacts.map(({ path }) => path) ?? [],
  );
  return {
    tree,
    locations: paths.map((repositoryPath) => {
      if (planningPaths.has(repositoryPath)) {
        throw planningNotReady(
          'PlanReview cites a planning snapshot path through the repository namespace.',
        );
      }
      const { blobOid, content } = observations.readRepositoryCitation(
        repositoryRoot,
        tree,
        repositoryPath,
      );
      return {
        path: repositoryPath,
        blobOid,
        lineCount:
          content.length === 0
            ? 0
            : content.endsWith('\n')
              ? content.slice(0, -1).split('\n').length
              : content.split('\n').length,
      };
    }),
  };
}

export function resolvePlanReviewPlanningEvidence(
  observations: PlanningAssuranceEvidenceObservations,
  repositoryRoot: string,
  snapshot: PlanReviewTargetSnapshot,
  reviewNode: EvidenceNode,
): PlanReviewPlanningEvidence {
  const review = readPlanReviewNode(reviewNode);
  const citedPaths = [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ]
    .filter(
      (
        citation,
      ): citation is Extract<
        (typeof review.findings)[number]['evidence'][number],
        { kind: 'planning-location' }
      > => citation.kind === 'planning-location',
    )
    .map(({ path: planningPath }) => planningPath);
  const uniquePaths = [...new Set(citedPaths)].sort(compareUtf8);
  const artifacts = new Map(
    snapshot.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  const resolved = new Map<
    string,
    PlanReviewPlanningEvidence['locations'][number]
  >();
  const snapshotCommit = observations.readPlanningSnapshotOrigin(
    repositoryRoot,
    snapshot,
  );
  for (const artifact of snapshot.artifacts) {
    const content = observations.readPlanningSnapshotArtifact(
      repositoryRoot,
      snapshotCommit,
      artifact.path,
    );
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    const lineCount =
      content.length === 0
        ? 0
        : content.at(-1) === 0x0a
          ? content.toString('utf8').slice(0, -1).split('\n').length
          : content.toString('utf8').split('\n').length;
    if (
      digest !== artifact.sha256 ||
      content.byteLength !== artifact.byteLength ||
      lineCount !== artifact.lineCount
    ) {
      throw planningNotReady(
        'Current planning bytes differ from the reviewed target snapshot.',
      );
    }
    resolved.set(artifact.path, {
      path: artifact.path,
      sha256: digest,
      byteLength: content.byteLength,
      lineCount,
    });
  }
  const locations = uniquePaths.map((planningPath) => {
    const location = resolved.get(planningPath);
    if (!location || !artifacts.has(planningPath)) {
      throw planningNotReady(
        'PlanReview cites a path absent from its planning target snapshot.',
      );
    }
    return location;
  });
  return {
    snapshotDigest: snapshot.snapshotDigest,
    locations,
  };
}
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
