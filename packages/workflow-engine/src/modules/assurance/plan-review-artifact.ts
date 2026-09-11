import { artifactInvalid } from '../planning-provider/change-contract-errors.ts';
import { parsePlanReviewEvidenceArtifact } from '../planning-provider/planning-artifact-parsers.ts';
import type { PlanReviewArtifact } from '../planning-provider/planning-artifact-types.ts';

import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  assertCurrentPlanReviewProviderResultNode,
  readPlanReviewNode,
  readPlanReviewTargetSnapshotNode,
} from './plan-review.ts';
import type { RoleResultAdmission } from '../provider-orchestration/role-result-admission.ts';
export type PlanReviewArtifactParser = (
  value: unknown,
  expectedChangeId: string,
) => PlanReviewArtifact;

function optionalArtifactKeys(
  value: unknown,
  allowed: readonly string[],
): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return allowed.filter((key) => Object.hasOwn(value, key));
}

function parseOptionalRoleResults(value: unknown): unknown[] | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, 'roleResults')) {
    return undefined;
  }
  if (!Array.isArray(value.roleResults) || value.roleResults.length === 0) {
    throw artifactInvalid(
      'INVALID_PLAN_REVIEW_ARTIFACT',
      'Tracked role results must be a non-empty array when present.',
    );
  }
  return structuredClone(value.roleResults);
}
export function parsePlanReviewArtifact(
  admission: Pick<RoleResultAdmission, 'assertAdmittedRoleResultRecord'>,
  value: unknown,
  expectedChangeId: string,
): PlanReviewArtifact {
  const optionalKeys = optionalArtifactKeys(value, ['roleResults']);
  const artifact = parsePlanReviewEvidenceArtifact(value, expectedChangeId, [
    'changeId',
    'currentRefs',
    'kind',
    'nodes',
    'schemaVersion',
    ...optionalKeys,
  ]);
  const roleResults = parseOptionalRoleResults(value);
  try {
    if (roleResults === undefined) {
      return {
        ...artifact,
        kind: 'plan-review-artifact',
      };
    }
    const reviewNode = artifact.nodes.find(
      ({ nodeId }) => nodeId === artifact.currentRefs.planReview,
    );
    if (reviewNode === undefined) {
      throw new TypeError('Current PlanReview node is unavailable.');
    }
    const review = readPlanReviewNode(reviewNode);
    const providerResultNode = artifact.nodes.find(
      ({ nodeId }) => nodeId === review.providerResultNodeId,
    );
    if (
      providerResultNode === undefined ||
      providerResultNode.resultDigest !== review.providerResultResultDigest
    ) {
      throw new TypeError('Current PlanReview provider result is unavailable.');
    }
    const targetSnapshotNode = artifact.nodes.find(
      ({ nodeId }) =>
        nodeId === providerResultNode.provenanceParentNodeIds.targetSnapshot,
    );
    if (targetSnapshotNode === undefined) {
      throw new TypeError('Current PlanReview target snapshot is unavailable.');
    }
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
      throw new TypeError(
        'Current PlanReview target snapshot does not match its review.',
      );
    }
    const matchingRoleResults = roleResults.filter(
      (value) =>
        isRecord(value) &&
        isRecord(value.content) &&
        value.content.nodeId === providerResultNode.nodeId &&
        value.content.resultDigest === providerResultNode.resultDigest,
    );
    const roleResult = admission.assertAdmittedRoleResultRecord(
      matchingRoleResults[0],
    );
    if (
      matchingRoleResults.length !== 1 ||
      !Object.hasOwn(roleResult, 'providerInvocation')
    ) {
      throw new TypeError(
        'Current PlanReview provider admission is unavailable.',
      );
    }
    assertCurrentPlanReviewProviderResultNode(
      providerResultNode,
      roleResult.providerInvocation,
      roleResult.content,
      reviewNode.exactInputDigests.submission,
    );
  } catch {
    throw artifactInvalid(
      'INVALID_PLAN_REVIEW_ARTIFACT',
      'plan-review-artifact does not select current provider evidence.',
    );
  }
  return {
    ...artifact,
    kind: 'plan-review-artifact',
    ...(roleResults ? { roleResults } : {}),
  };
}
