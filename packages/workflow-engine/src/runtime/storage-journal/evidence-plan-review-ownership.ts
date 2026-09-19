/**
 * Resolves PlanReview invocation ownership and validates request and retry evidence chains.
 *
 * Invariants:
 * - Review requests and retries retain exact subjects, generations, and predecessor bindings.
 * - Recursive retry validation preserves the existing dependency and authorization checks.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type EvidenceNode,
  assertStoredEvidenceNode,
} from '../../foundation/evidence-node/evidence-node.ts';
import {
  assertPlanReviewSubject,
  readPlanReviewTargetSnapshotNode,
} from '../../modules/assurance/plan-review.ts';
import {
  PROPOSE_POLICY_DIGEST,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import { assertPlanReviewAuthorizationGrantOwnership } from './evidence-plan-review-grants.ts';
import {
  type InvestigationEvidenceOwnership,
  assertPlanningMaterializationOwnership,
  dependencyClosureEntry,
} from './evidence-planning-ownership.ts';
import type { InvestigationEvidenceDependencyClosureEntry } from './evidence-ref-closure.ts';
import {
  DIGEST_PATTERN,
  hasExactKeys,
  isDigest,
  isInvestigationOwner,
  isPlainRecord,
  refInvalid,
  sha256,
} from './evidence-store-values.ts';

export function resolvePlanReviewInvocationOwner(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    subject: unknown;
    assignment: unknown;
    authorizationNodeId: string;
  },
): string {
  const changeId = assertChangeId(input.changeId);
  const subject = assertPlanReviewSubject(input.subject);
  if (!DIGEST_PATTERN.test(input.authorizationNodeId)) {
    throw refInvalid();
  }
  const authorization = readEvidenceNode(paths, input.authorizationNodeId);
  const output = authorization.output;
  const materializationId =
    authorization.provenanceParentNodeIds.materialization;
  if (
    authorization.type !== 'plan-review-authorization' ||
    authorization.nodeSchema !== 'workflow.plan-review-authorization.v3' ||
    authorization.outputSchema !==
      'workflow.plan-review-authorization-output.v3' ||
    authorization.evaluator !== 'workflow-propose.v1' ||
    authorization.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'subject',
      'assignment',
      'author',
      'grantAuthorization',
      'roleTopology',
    ]) ||
    !hasExactKeys(authorization.exactInputDigests, [
      'subject',
      'generation',
      'assignment',
      'grantAuthorization',
      'targetSnapshot',
      'roleTopology',
    ]) ||
    !hasExactKeys(authorization.provenanceParentNodeIds, [
      'materialization',
      'targetSnapshot',
    ]) ||
    !hasExactKeys(authorization.semanticParentResultDigests, [
      'materialization',
      'targetSnapshot',
    ]) ||
    !(
      output.grantAuthorization === null ||
      isPlainRecord(output.grantAuthorization)
    ) ||
    canonicalJson(output.subject) !== canonicalJson(subject) ||
    canonicalJson(output.assignment) !== canonicalJson(input.assignment) ||
    authorization.exactInputDigests.subject !== subject.subjectDigest ||
    authorization.exactInputDigests.assignment !==
      sha256(canonicalJson(input.assignment)) ||
    authorization.exactInputDigests.generation !==
      subject.planningGenerationId ||
    authorization.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(output.grantAuthorization)) ||
    !(output.roleTopology === null || isPlainRecord(output.roleTopology)) ||
    authorization.exactInputDigests.roleTopology !==
      sha256(canonicalJson(output.roleTopology)) ||
    !DIGEST_PATTERN.test(materializationId ?? '') ||
    !DIGEST_PATTERN.test(
      authorization.provenanceParentNodeIds.targetSnapshot ?? '',
    ) ||
    !DIGEST_PATTERN.test(
      authorization.semanticParentResultDigests.materialization ?? '',
    ) ||
    !DIGEST_PATTERN.test(
      authorization.semanticParentResultDigests.targetSnapshot ?? '',
    )
  ) {
    throw refInvalid();
  }
  const grantKind = assertPlanReviewAuthorizationGrantOwnership({
    changeId,
    subject,
    assignment: input.assignment,
    author: output.author,
    grantAuthorization: output.grantAuthorization,
  });
  if (
    grantKind === 'role-context-sharing'
      ? !isPlainRecord(output.roleTopology) ||
        output.roleTopology.disposition !== 'exact-grant-required'
      : isPlainRecord(output.roleTopology) &&
        output.roleTopology.disposition !== 'satisfied'
  ) {
    throw refInvalid();
  }
  const materialization = readEvidenceNode(paths, materializationId);
  const targetSnapshot = readEvidenceNode(
    paths,
    authorization.provenanceParentNodeIds.targetSnapshot,
  );
  const target = readPlanReviewTargetSnapshotNode(targetSnapshot);
  const ownership = assertPlanningMaterializationOwnership(
    paths,
    materialization,
    changeId,
  );
  if (
    materialization.resultDigest !==
      authorization.semanticParentResultDigests.materialization ||
    targetSnapshot.resultDigest !==
      authorization.semanticParentResultDigests.targetSnapshot ||
    targetSnapshot.nodeId !== authorization.exactInputDigests.targetSnapshot ||
    target.subjectDigest !== subject.subjectDigest ||
    target.materializationNodeId !== materialization.nodeId ||
    target.materializationResultDigest !== materialization.resultDigest ||
    !isPlainRecord(materialization.output) ||
    !isPlainRecord(materialization.output.baseline) ||
    canonicalJson(materialization.output.baseline) !==
      canonicalJson(subject.investigationBaseline)
  ) {
    throw refInvalid();
  }
  return ownership.ownerInvestigationId;
}

export function assertPlanReviewRequestOwnership(
  paths: InvestigationRuntimePaths,
  refs: Readonly<Record<string, string>>,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  const retryShape =
    isPlainRecord(output) &&
    Object.hasOwn(output, 'retry') &&
    output.retry !== null;
  if (
    !isPlainRecord(output) ||
    node.type !== 'plan-review-request-reservation' ||
    node.nodeSchema !== 'workflow.plan-review-request-reservation.v3' ||
    node.outputSchema !==
      'workflow.plan-review-request-reservation-output.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    output.changeId !== expectedChangeId ||
    !isInvestigationOwner(output.investigationId)
  ) {
    throw refInvalid();
  }
  if (
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'planning',
      'subject',
      'assignment',
      'author',
      'materializationNode',
      'targetSnapshotNode',
      'manifest',
      'request',
      'grantAuthorization',
      'retry',
    ]) ||
    !hasExactKeys(node.exactInputDigests, [
      'manifest',
      'request',
      'subject',
      'targetSnapshot',
      ...(retryShape ? ['previousRequest', 'failure'] : []),
      ...(retryShape ? ['executionPolicySnapshot', 'retryDecision'] : []),
    ]) ||
    !hasExactKeys(node.provenanceParentNodeIds, [
      'authorization',
      ...(retryShape ? ['previousRequest'] : []),
    ]) ||
    !hasExactKeys(node.semanticParentResultDigests, [
      'authorization',
      ...(retryShape ? ['previousRequest'] : []),
    ]) ||
    !isPlainRecord(output.planning) ||
    !isPlainRecord(output.manifest)
  ) {
    throw refInvalid();
  }
  const subject = assertPlanReviewSubject(output.subject);
  if (
    !isPlainRecord(output.planning.subject) ||
    canonicalJson(output.planning.subject) !== canonicalJson(subject)
  ) {
    throw refInvalid();
  }
  const request = recreateProviderInvocationRequest(output.request);
  const manifest = output.manifest;
  if (
    request.purpose !== 'plan-review' ||
    request.authorizationNodeId !==
      node.provenanceParentNodeIds.authorization ||
    request.requestDigest !== node.exactInputDigests.request ||
    request.inputManifestDigest !== node.exactInputDigests.manifest ||
    request.inputManifestDigest !== sha256(canonicalJson(manifest)) ||
    request.targetDigest !== subject.subjectDigest ||
    subject.subjectDigest !== node.exactInputDigests.subject ||
    canonicalJson(request.roleAssignment) !==
      canonicalJson(output.assignment) ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'plan-review-manifest' ||
    manifest.changeId !== expectedChangeId ||
    manifest.baseCommit !== request.baseCommit ||
    manifest.baseTree !== request.baseTree ||
    canonicalJson(manifest.subject) !== canonicalJson(subject) ||
    manifest.capabilityProfile !== 'repository-read-only'
  ) {
    throw refInvalid();
  }
  const authorization = readEvidenceNode(
    paths,
    node.provenanceParentNodeIds.authorization,
  );
  const authorizationOutput = authorization.output;
  if (
    authorization.type !== 'plan-review-authorization' ||
    authorization.nodeSchema !== 'workflow.plan-review-authorization.v3' ||
    authorization.outputSchema !==
      'workflow.plan-review-authorization-output.v3' ||
    authorization.evaluator !== 'workflow-propose.v1' ||
    authorization.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isPlainRecord(authorizationOutput) ||
    !hasExactKeys(authorizationOutput, [
      'subject',
      'assignment',
      'author',
      'grantAuthorization',
      'roleTopology',
    ]) ||
    !hasExactKeys(authorization.exactInputDigests, [
      'assignment',
      'generation',
      'grantAuthorization',
      'subject',
      'targetSnapshot',
      'roleTopology',
    ]) ||
    !hasExactKeys(authorization.provenanceParentNodeIds, [
      'materialization',
      'targetSnapshot',
    ]) ||
    !hasExactKeys(authorization.semanticParentResultDigests, [
      'materialization',
      'targetSnapshot',
    ]) ||
    authorization.resultDigest !==
      node.semanticParentResultDigests.authorization ||
    canonicalJson(authorizationOutput.subject) !== canonicalJson(subject) ||
    canonicalJson(authorizationOutput.assignment) !==
      canonicalJson(output.assignment) ||
    canonicalJson(authorizationOutput.author) !==
      canonicalJson(output.author) ||
    canonicalJson(authorizationOutput.grantAuthorization) !==
      canonicalJson(output.grantAuthorization) ||
    authorization.exactInputDigests.subject !== subject.subjectDigest ||
    authorization.exactInputDigests.assignment !==
      sha256(canonicalJson(output.assignment)) ||
    authorization.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(output.grantAuthorization)) ||
    !(
      authorizationOutput.roleTopology === null ||
      isPlainRecord(authorizationOutput.roleTopology)
    ) ||
    authorization.exactInputDigests.roleTopology !==
      sha256(canonicalJson(authorizationOutput.roleTopology)) ||
    !isPlainRecord(output.planning.generation) ||
    authorization.exactInputDigests.generation !==
      output.planning.generation.planningGenerationId
  ) {
    throw refInvalid();
  }
  const grantKind = assertPlanReviewAuthorizationGrantOwnership({
    changeId: expectedChangeId,
    subject,
    assignment: request.roleAssignment,
    author: authorizationOutput.author,
    grantAuthorization: authorizationOutput.grantAuthorization,
  });
  if (
    grantKind === 'role-context-sharing'
      ? !isPlainRecord(authorizationOutput.roleTopology) ||
        authorizationOutput.roleTopology.disposition !== 'exact-grant-required'
      : isPlainRecord(authorizationOutput.roleTopology) &&
        authorizationOutput.roleTopology.disposition !== 'satisfied'
  ) {
    throw refInvalid();
  }

  const materializationId =
    authorization.provenanceParentNodeIds.materialization;
  const materialization = readEvidenceNode(paths, materializationId);
  const materializationOwnership = assertPlanningMaterializationOwnership(
    paths,
    materialization,
    expectedChangeId,
  );
  if (
    materialization.resultDigest !==
      authorization.semanticParentResultDigests.materialization ||
    (refs['propose/planning-materialization'] !== undefined &&
      refs['propose/planning-materialization'] !== materialization.nodeId) ||
    output.investigationId !== materializationOwnership.ownerInvestigationId
  ) {
    throw refInvalid();
  }

  const dependencies: InvestigationEvidenceDependencyClosureEntry[] = [
    dependencyClosureEntry('authorization', authorization),
    dependencyClosureEntry('materialization', materialization),
    ...materializationOwnership.dependencies.map((dependency) =>
      Object.freeze({
        ...dependency,
        role: `materialization/${dependency.role}`,
      }),
    ),
  ];
  {
    if (
      !isPlainRecord(output.materializationNode) ||
      !isPlainRecord(output.targetSnapshotNode)
    ) {
      throw refInvalid();
    }
    const embeddedMaterialization = assertStoredEvidenceNode(
      output.materializationNode,
      refInvalid,
    );
    const embeddedTargetSnapshot = assertStoredEvidenceNode(
      output.targetSnapshotNode,
      refInvalid,
    );
    const storedTargetSnapshot = readEvidenceNode(
      paths,
      embeddedTargetSnapshot.nodeId,
    );
    const target = readPlanReviewTargetSnapshotNode(storedTargetSnapshot);
    if (
      canonicalJson(embeddedMaterialization) !==
        canonicalJson(materialization) ||
      canonicalJson(embeddedTargetSnapshot) !==
        canonicalJson(storedTargetSnapshot) ||
      authorization.provenanceParentNodeIds.targetSnapshot !==
        storedTargetSnapshot.nodeId ||
      authorization.semanticParentResultDigests.targetSnapshot !==
        storedTargetSnapshot.resultDigest ||
      authorization.exactInputDigests.targetSnapshot !==
        storedTargetSnapshot.nodeId ||
      node.exactInputDigests.targetSnapshot !== storedTargetSnapshot.nodeId ||
      target.changeId !== expectedChangeId ||
      target.subjectDigest !== subject.subjectDigest ||
      target.materializationNodeId !== materialization.nodeId ||
      target.materializationResultDigest !== materialization.resultDigest ||
      canonicalJson(manifest.planningTarget) !== canonicalJson(target)
    ) {
      throw refInvalid();
    }
    dependencies.push(
      dependencyClosureEntry('target-snapshot', storedTargetSnapshot),
    );
  }
  if (retryShape) {
    const retry = assertPlanReviewRetryOwnership(
      paths,
      refs,
      node,
      output,
      request,
      expectedChangeId,
    );
    if (
      retry.previousOwnership.ownerInvestigationId !==
      materializationOwnership.ownerInvestigationId
    ) {
      throw refInvalid();
    }
    dependencies.push(
      dependencyClosureEntry('previous-request', retry.previousNode),
      ...retry.previousOwnership.dependencies.map((dependency) =>
        Object.freeze({
          ...dependency,
          role: `previous-request/${dependency.role}`,
        }),
      ),
    );
  }
  return Object.freeze({
    ownerInvestigationId: materializationOwnership.ownerInvestigationId,
    dependencies: Object.freeze(
      dependencies.sort((left, right) => left.role.localeCompare(right.role)),
    ),
  });
}

function assertPlanReviewRetryOwnership(
  paths: InvestigationRuntimePaths,
  refs: Readonly<Record<string, string>>,
  node: EvidenceNode,
  output: Record<string, unknown>,
  request: ReturnType<typeof recreateProviderInvocationRequest>,
  expectedChangeId: string,
): {
  previousNode: EvidenceNode;
  previousOwnership: InvestigationEvidenceOwnership;
} {
  const retry = output.retry;
  if (
    !isPlainRecord(retry) ||
    !hasExactKeys(retry, [
      'attempt',
      'previousReservationNodeId',
      'failedInvocation',
      'executionPolicySnapshot',
      'retryDecision',
    ]) ||
    !Number.isSafeInteger(retry.attempt) ||
    (retry.attempt as number) < 2 ||
    !isDigest(retry.previousReservationNodeId) ||
    !isPlainRecord(retry.failedInvocation) ||
    !hasExactKeys(retry.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof retry.failedInvocation.invocationId !== 'string' ||
    retry.failedInvocation.invocationId.length === 0 ||
    !Number.isSafeInteger(retry.failedInvocation.attempt) ||
    (retry.failedInvocation.attempt as number) < 1 ||
    !Number.isSafeInteger(retry.failedInvocation.revision) ||
    (retry.failedInvocation.revision as number) < 0 ||
    !isDigest(retry.failedInvocation.requestDigest) ||
    !isDigest(retry.failedInvocation.failureDigest) ||
    !isPlainRecord(retry.retryDecision) ||
    !hasExactKeys(retry.retryDecision, [
      'evaluatedAt',
      'evidenceDigest',
      'executionJobId',
      'executionRevision',
      'failedAttemptId',
      'kind',
      'schemaVersion',
    ]) ||
    retry.retryDecision.schemaVersion !== 1 ||
    retry.retryDecision.kind !== 'provider-retry-decision-binding' ||
    typeof retry.retryDecision.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(retry.retryDecision.executionJobId) ||
    !Number.isSafeInteger(retry.retryDecision.executionRevision) ||
    (retry.retryDecision.executionRevision as number) < 0 ||
    retry.retryDecision.failedAttemptId !==
      `attempt-provider-${retry.failedInvocation.invocationId}` ||
    !isDigest(retry.retryDecision.evidenceDigest) ||
    typeof retry.retryDecision.evaluatedAt !== 'string' ||
    Number.isNaN(Date.parse(retry.retryDecision.evaluatedAt)) ||
    node.exactInputDigests.retryDecision !==
      retry.retryDecision.evidenceDigest ||
    !isPlainRecord(retry.executionPolicySnapshot) ||
    !hasExactKeys(retry.executionPolicySnapshot, [
      'accountingDigest',
      'attemptReservation',
      ...(retry.executionPolicySnapshot.schemaVersion === 3
        ? ['authority']
        : []),
      'invocationId',
      'kind',
      'policyDigest',
      'policyDocument',
      'requestDigest',
      'retryAccounting',
      'schemaVersion',
    ]) ||
    ![2, 3].includes(retry.executionPolicySnapshot.schemaVersion as number) ||
    (retry.executionPolicySnapshot.schemaVersion === 3 &&
      !isPlainRecord(retry.executionPolicySnapshot.authority)) ||
    retry.executionPolicySnapshot.kind !==
      'provider-execution-policy-snapshot' ||
    retry.executionPolicySnapshot.invocationId !== request.invocationId ||
    retry.executionPolicySnapshot.requestDigest !== request.requestDigest ||
    retry.executionPolicySnapshot.policyDigest !== request.policyDigest ||
    typeof retry.executionPolicySnapshot.policyDocument !== 'string' ||
    !isPlainRecord(retry.executionPolicySnapshot.retryAccounting) ||
    !isPlainRecord(retry.executionPolicySnapshot.attemptReservation) ||
    !isDigest(retry.executionPolicySnapshot.accountingDigest) ||
    node.exactInputDigests.executionPolicySnapshot !==
      sha256(canonicalJson(retry.executionPolicySnapshot)) ||
    node.exactInputDigests.failure !== retry.failedInvocation.failureDigest ||
    node.exactInputDigests.previousRequest !==
      retry.previousReservationNodeId ||
    node.provenanceParentNodeIds.previousRequest !==
      retry.previousReservationNodeId
  ) {
    throw refInvalid();
  }
  const previousNode = readEvidenceNode(paths, retry.previousReservationNodeId);
  if (
    previousNode.resultDigest !==
    node.semanticParentResultDigests.previousRequest
  ) {
    throw refInvalid();
  }
  const previousOwnership = assertPlanReviewRequestOwnership(
    paths,
    refs,
    previousNode,
    expectedChangeId,
  );
  if (
    previousNode.nodeSchema !== 'workflow.plan-review-request-reservation.v3' ||
    previousNode.outputSchema !==
      'workflow.plan-review-request-reservation-output.v3' ||
    !isPlainRecord(previousNode.output) ||
    !Object.hasOwn(previousNode.output, 'retry')
  ) {
    throw refInvalid();
  }
  const previousOutput = previousNode.output;
  const previousRequest = recreateProviderInvocationRequest(
    previousOutput.request,
  );
  const previousRetry = previousOutput.retry;
  const previousAttempt =
    previousRetry === null
      ? 1
      : isPlainRecord(previousRetry) &&
          Number.isSafeInteger(previousRetry.attempt) &&
          (previousRetry.attempt as number) >= 2
        ? (previousRetry.attempt as number)
        : 0;
  const {
    invocationId: _previousInvocationId,
    nonce: _previousNonce,
    requestDigest: _previousRequestDigest,
    policyDigest: _previousPolicyDigest,
    limits: _previousLimits,
    retryExplanation: _previousExplanation,
    ...previousRequestBinding
  } = previousRequest;
  const {
    invocationId: _replacementInvocationId,
    nonce: _replacementNonce,
    requestDigest: _replacementRequestDigest,
    policyDigest: _replacementPolicyDigest,
    limits: _replacementLimits,
    retryExplanation: _replacementExplanation,
    ...replacementRequestBinding
  } = request;
  if (
    previousAttempt === 0 ||
    retry.attempt !== previousAttempt + 1 ||
    retry.failedInvocation.attempt !== previousAttempt ||
    retry.failedInvocation.invocationId !== previousRequest.invocationId ||
    retry.failedInvocation.requestDigest !== previousRequest.requestDigest ||
    request.invocationId === previousRequest.invocationId ||
    request.nonce === previousRequest.nonce ||
    request.requestDigest === previousRequest.requestDigest ||
    canonicalJson(replacementRequestBinding) !==
      canonicalJson(previousRequestBinding)
  ) {
    throw refInvalid();
  }
  for (const field of [
    'planning',
    'subject',
    'assignment',
    'author',
    'materializationNode',
    'targetSnapshotNode',
    'manifest',
    'grantAuthorization',
  ]) {
    if (canonicalJson(previousOutput[field]) !== canonicalJson(output[field])) {
      throw refInvalid();
    }
  }
  return { previousNode, previousOwnership };
}
