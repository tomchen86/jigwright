/**
 * Persists and validates review artifacts, reservations, and exact grant requirements.
 *
 * Invariants:
 * - Stored reviews replay their admitted role result and selected disposition.
 * - Reservations bind the subject, snapshots, request, grant, and retry lineage.
 * - Current requirement references advance only to the corresponding immutable evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertPlanReviewSubject,
  type PlanReviewSubject,
  type PlanReviewTargetSnapshot,
  readPlanReviewDispositionNode,
  readPlanReviewNode,
  readPlanReviewTargetSnapshotNode,
} from '../../modules/assurance/plan-review.ts';
import {
  type ConsumedPlanReviewReplayPort,
  type InvestigationFirstPlanningSubject,
  replayCurrentPlanReviewRoleResult,
} from '../../modules/assurance/planning-assurance-validator.ts';
import {
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type AdmittedRoleResult,
  assertAdmittedRoleResultRecord,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  assertDurableCollaborationPlanReviewRequirement,
  assertDurablePlanReviewRoleTopology,
  assertDurableRoleContextSharingPlanReviewRequirement,
  assertPlanReviewGrantAuthorization,
  assertPlanReviewRetryDecisionBinding,
  type DurablePlanReviewGrantRequirementV3,
  type PlanReviewGrantRequirement,
} from './plan-review-contracts.ts';
import {
  DIGEST,
  hasExactKeys,
  isRecord,
  PLAN_REVIEW_GRANT_REQUIREMENT_REF,
  PLAN_REVIEW_REQUEST_REF,
  PLANNING_MATERIALIZATION_REF,
  planReviewRequestStale,
  sha256,
} from './propose-common.ts';
import { uniqueNodes } from './propose-evidence.ts';
import type {
  EvidenceNode,
  PlanReviewManifest,
  ProposeRuntime,
  ProviderExecutionPolicySnapshotCurrent,
} from './propose-runtime.ts';
import {
  type PlanReviewReservation,
  type PlanReviewRetryEnvelope,
  type ProposeLifecycleStatus,
} from './propose-types.ts';
import { type RoleContextSharingPlanReviewRequirementV3 } from './role-context-sharing-plan-review.ts';

export function writeTrackedPlanReview(
  services: Pick<ProposeRuntime, 'workspace'>,
  repositoryRoot: string,
  changeId: string,
  input: {
    nodes: EvidenceNode[];
    roleResult: AdmittedRoleResult;
    dispositionNode: EvidenceNode | null;
  },
): void {
  const reviewNode = input.nodes.find(({ type }) => type === 'plan-review');
  if (!reviewNode) {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_INVALID',
      'PlanReview artifact has no review node.',
      ExitCode.verification,
    );
  }
  const nodes = uniqueNodes([
    ...input.nodes,
    ...(input.dispositionNode ? [input.dispositionNode] : []),
  ]);
  const artifact = services.workspace.parsePlanReviewArtifact(
    {
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId,
      nodes,
      currentRefs: {
        planReview: reviewNode.nodeId,
        ...(input.dispositionNode
          ? { planReviewDisposition: input.dispositionNode.nodeId }
          : {}),
      },
      roleResults: [input.roleResult],
    },
    changeId,
  );
  const target = path.join(
    repositoryRoot,
    services.workspace.loadInvestigationRuntimeContext(repositoryRoot).config
      .changeRoot,
    changeId,
    'plan-review.json',
  );
  const bytes = `${canonicalJson(artifact)}\n`;
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (current === bytes) {
      return;
    }
    services.workspace.replaceTextAtomic(target, bytes, { allowCreate: false });
    return;
  }
  services.workspace.replaceTextAtomic(target, bytes, {
    allowCreate: true,
    defaultMode: 0o644,
  });
}

export function readTrackedPlanReview(
  services: Pick<ProposeRuntime, 'workspace'>,
  repositoryRoot: string,
  changeId: string,
  replay?: Readonly<{
    subject: PlanReviewSubject;
    consumedPlanReviewReplay?: ConsumedPlanReviewReplayPort;
  }>,
): {
  nodes: EvidenceNode[];
  reviewNode: EvidenceNode;
  dispositionNode: EvidenceNode | null;
  roleResult: AdmittedRoleResult;
} | null {
  const context =
    services.workspace.loadInvestigationRuntimeContext(repositoryRoot);
  const reviewPath = path.join(
    repositoryRoot,
    context.config.changeRoot,
    changeId,
    'plan-review.json',
  );
  if (!fs.existsSync(reviewPath)) {
    return null;
  }
  const artifact = services.workspace.parsePlanReviewArtifact(
    JSON.parse(fs.readFileSync(reviewPath, 'utf8')),
    changeId,
  );
  const reviewNodeId = artifact.currentRefs.planReview;
  const reviewNodes = artifact.nodes.filter(
    ({ nodeId }) => nodeId === reviewNodeId,
  );
  const review =
    reviewNodes.length === 1 ? readPlanReviewNode(reviewNodes[0]!) : null;
  const roleResults = (artifact.roleResults ?? []).filter(
    (value) =>
      isRecord(value) &&
      isRecord(value.content) &&
      review !== null &&
      value.content.nodeId === review.providerResultNodeId &&
      value.content.resultDigest === review.providerResultResultDigest,
  );
  if (reviewNodes.length !== 1 || roleResults.length !== 1) {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_STALE',
      'Tracked PlanReview does not select one admitted review result.',
      ExitCode.staleState,
    );
  }
  let roleResult: AdmittedRoleResult;
  try {
    roleResult =
      replay === undefined
        ? assertAdmittedRoleResultRecord(roleResults[0])
        : replayCurrentPlanReviewRoleResult(
            roleResults[0],
            {
              repositoryRoot,
              changeId,
              baselineCommit: replay.subject.investigationBaseline.head,
              baselineTree: replay.subject.investigationBaseline.tree,
              subjectDigest: replay.subject.subjectDigest,
              planningGenerationId: replay.subject.planningGenerationId,
            },
            replay.consumedPlanReviewReplay,
          );
  } catch {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_STALE',
      'Tracked PlanReview role authority no longer replays exactly.',
      ExitCode.staleState,
    );
  }
  const dispositionId = artifact.currentRefs.planReviewDisposition;
  const dispositionNode = dispositionId
    ? (artifact.nodes.find(({ nodeId }) => nodeId === dispositionId) ?? null)
    : null;
  if (dispositionId && dispositionNode === null) {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_STALE',
      'Tracked PlanReview disposition is unavailable.',
      ExitCode.staleState,
    );
  }
  if (dispositionNode !== null) {
    readPlanReviewDispositionNode(dispositionNode);
  }
  return {
    nodes: artifact.nodes,
    reviewNode: reviewNodes[0]!,
    dispositionNode,
    roleResult,
  };
}

export function persistPlanReviewGrantRequirement(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: ProposeLifecycleStatus,
  requirement: DurablePlanReviewGrantRequirementV3,
): string {
  const node = services.evidence.createEvidenceNode({
    type: 'plan-review-grant-requirement',
    nodeSchema: 'workflow.plan-review-grant-requirement.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      requirement: sha256(canonicalJson(requirement)),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.plan-review-grant-requirement-output.v3',
    output: { requirement },
    runtimeMetadata: {},
  });
  services.evidence.writeEvidenceNode(paths, node);
  const current =
    services.evidence.readEvidenceRefs(paths, status.changeId)[
      PLAN_REVIEW_GRANT_REQUIREMENT_REF
    ] ?? null;
  if (current === node.nodeId) {
    return node.nodeId;
  }
  services.evidence.compareAndSwapEvidenceRef(paths, {
    changeId: status.changeId,
    refName: PLAN_REVIEW_GRANT_REQUIREMENT_REF,
    expectedNodeId: current,
    nextNodeId: node.nodeId,
  });
  return node.nodeId;
}

export function persistPlanReviewTopologyRequirement(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: ProposeLifecycleStatus,
  requirement: RoleContextSharingPlanReviewRequirementV3,
): string {
  return persistPlanReviewGrantRequirement(
    services,
    paths,
    status,
    requirement,
  );
}

export function readPlanReviewGrantRequirement(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: ProposeLifecycleStatus,
): PlanReviewGrantRequirement | null {
  const nodeId = services.evidence.readEvidenceRefs(paths, status.changeId)[
    PLAN_REVIEW_GRANT_REQUIREMENT_REF
  ];
  if (!nodeId) {
    return null;
  }
  const node = services.evidence.readEvidenceNode(paths, nodeId);
  const output = node.output;
  if (
    node.type !== 'plan-review-grant-requirement' ||
    node.nodeSchema !== 'workflow.plan-review-grant-requirement.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== 'workflow.plan-review-grant-requirement-output.v3' ||
    !hasExactKeys(node.exactInputDigests, ['requirement']) ||
    !hasExactKeys(node.provenanceParentNodeIds, []) ||
    !hasExactKeys(node.semanticParentResultDigests, []) ||
    !isRecord(output) ||
    !hasExactKeys(output, ['requirement']) ||
    !isRecord(output.requirement) ||
    sha256(canonicalJson(output.requirement)) !==
      node.exactInputDigests.requirement
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  if (
    output.requirement.kind ===
    'role-context-sharing-plan-review-requirement.v3'
  ) {
    const requirement = assertDurableRoleContextSharingPlanReviewRequirement(
      output.requirement,
      status,
    );
    return {
      kind: 'role-context-sharing',
      requirementNodeId: node.nodeId,
      requirement,
    };
  }
  const requirement = assertDurableCollaborationPlanReviewRequirement(
    output.requirement,
    status,
  );
  return {
    kind: 'collaboration',
    requirementNodeId: node.nodeId,
    requirement,
  };
}

export function readCurrentRoleContextSharingPlanReviewRequirement(
  services: Pick<ProposeRuntime, 'evidence' | 'investigation' | 'workspace'>,
  cwd: string,
  requirementNodeId: string,
): Extract<PlanReviewGrantRequirement, { kind: 'role-context-sharing' }> {
  if (!DIGEST.test(requirementNodeId)) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'R-007 import requires one exact durable requirement node ID.',
      ExitCode.staleState,
    );
  }
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const node = services.evidence.readEvidenceNode(
    context.runtime,
    requirementNodeId,
  );
  const rawRequirement =
    isRecord(node.output) && isRecord(node.output.requirement)
      ? node.output.requirement
      : null;
  const investigationId = rawRequirement?.investigationId;
  if (typeof investigationId !== 'string') {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'R-007 import requirement evidence is malformed.',
      ExitCode.staleState,
    );
  }
  const status: ProposeLifecycleStatus =
    services.investigation.isProposeExemptionInvestigationId(investigationId)
      ? services.investigation.readProposeExemptionSession(
          context.runtime,
          investigationId,
        )
      : services.investigation.getInvestigationStatus(cwd, investigationId);
  const current = readPlanReviewGrantRequirement(
    services,
    context.runtime,
    status,
  );
  if (
    current?.kind !== 'role-context-sharing' ||
    current.requirementNodeId !== requirementNodeId
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'R-007 import requires the exact current PlanReview requirement.',
      ExitCode.staleState,
    );
  }
  return current;
}

export function readPlanReviewReservation(
  services: Pick<ProposeRuntime, 'evidence' | 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: ProposeLifecycleStatus,
  expectedSubject?: PlanReviewSubject,
  allowNoncurrentMaterialization = false,
): PlanReviewReservation | null {
  const refs = services.evidence.readEvidenceRefs(paths, status.changeId);
  const nodeId = refs[PLAN_REVIEW_REQUEST_REF];
  if (nodeId === undefined) {
    return null;
  }
  const currentMaterializationNodeId = refs[PLANNING_MATERIALIZATION_REF];
  if (
    !allowNoncurrentMaterialization &&
    currentMaterializationNodeId === undefined
  ) {
    throw planReviewRequestStale();
  }
  let closure: ReturnType<
    ProposeRuntime['evidence']['computeInvestigationEvidenceRefsClosure']
  >;
  try {
    closure = services.evidence.computeInvestigationEvidenceRefsClosure(
      paths,
      status.changeId,
      allowNoncurrentMaterialization
        ? { [PLAN_REVIEW_REQUEST_REF]: nodeId }
        : {
            [PLAN_REVIEW_REQUEST_REF]: nodeId,
            [PLANNING_MATERIALIZATION_REF]: currentMaterializationNodeId!,
          },
    );
  } catch {
    throw planReviewRequestStale();
  }
  const closureEntries = closure.entries.filter(
    (entry) => entry.refName === PLAN_REVIEW_REQUEST_REF,
  );
  if (
    closureEntries.length !== 1 ||
    closureEntries[0]?.nodeId !== nodeId ||
    closureEntries[0]?.ownerInvestigationId !== status.investigationId
  ) {
    throw planReviewRequestStale();
  }
  const node = services.evidence.readEvidenceNode(paths, nodeId);
  const output = node.output;
  const retryShape =
    isRecord(output) && Object.hasOwn(output, 'retry') && output.retry !== null;
  if (
    node.type !== 'plan-review-request-reservation' ||
    node.nodeSchema !== 'workflow.plan-review-request-reservation.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.plan-review-request-reservation-output.v3' ||
    !isRecord(output) ||
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
      'request',
      'manifest',
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
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    !isRecord(output.materializationNode) ||
    !isRecord(output.targetSnapshotNode)
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Durable plan-review request reservation is invalid.',
      ExitCode.staleState,
    );
  }
  const subject = assertPlanReviewSubject(output.subject);
  const planning = output.planning as InvestigationFirstPlanningSubject;
  const request = output.request as ProviderInvocationRequest;
  const manifest = output.manifest as PlanReviewManifest & {
    planningTarget: PlanReviewTargetSnapshot;
  };
  const assignment = output.assignment as ProviderRoleAssignment;
  const author = output.author as RecordedRoleParticipant;
  const materializationNode = services.evidence.assertStoredEvidenceNode(
    output.materializationNode,
    () =>
      workflowError(
        'PLAN_REVIEW_REQUEST_STALE',
        'Durable plan-review materialization evidence is malformed.',
        ExitCode.staleState,
      ),
  );
  const targetSnapshotNode = services.evidence.assertStoredEvidenceNode(
    output.targetSnapshotNode,
    () =>
      workflowError(
        'PLAN_REVIEW_REQUEST_STALE',
        'Durable plan-review target snapshot evidence is malformed.',
        ExitCode.staleState,
      ),
  );
  const storedMaterializationNode = services.evidence.readEvidenceNode(
    paths,
    materializationNode.nodeId,
  );
  const storedTargetSnapshotNode = services.evidence.readEvidenceNode(
    paths,
    targetSnapshotNode.nodeId,
  );
  const targetSnapshot = readPlanReviewTargetSnapshotNode(
    storedTargetSnapshotNode,
  );
  const authorizationNode = services.evidence.readEvidenceNode(
    paths,
    request.authorizationNodeId,
  );
  const grantAuthorization = assertPlanReviewGrantAuthorization(
    output.grantAuthorization,
    author,
    request,
  );
  const roleContextAuthorization =
    grantAuthorization !== null && 'kind' in grantAuthorization;
  const authorizationOutput = authorizationNode.output;
  if (
    authorizationNode.nodeSchema !== 'workflow.plan-review-authorization.v3' ||
    authorizationNode.outputSchema !==
      'workflow.plan-review-authorization-output.v3' ||
    !isRecord(authorizationOutput) ||
    !hasExactKeys(authorizationOutput, [
      'subject',
      'assignment',
      'author',
      'grantAuthorization',
      'roleTopology',
    ]) ||
    !hasExactKeys(authorizationNode.exactInputDigests, [
      'subject',
      'generation',
      'assignment',
      'grantAuthorization',
      'targetSnapshot',
      'roleTopology',
    ]) ||
    canonicalJson(authorizationOutput.subject) !== canonicalJson(subject) ||
    canonicalJson(authorizationOutput.assignment) !==
      canonicalJson(assignment) ||
    canonicalJson(authorizationOutput.author) !== canonicalJson(author) ||
    canonicalJson(authorizationOutput.grantAuthorization) !==
      canonicalJson(grantAuthorization) ||
    authorizationNode.exactInputDigests.subject !== subject.subjectDigest ||
    authorizationNode.exactInputDigests.generation !==
      subject.planningGenerationId ||
    authorizationNode.exactInputDigests.assignment !==
      sha256(canonicalJson(assignment)) ||
    authorizationNode.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(grantAuthorization))
  ) {
    throw planReviewRequestStale();
  }
  const roleTopology =
    authorizationOutput.roleTopology === null
      ? null
      : assertDurablePlanReviewRoleTopology(authorizationOutput.roleTopology, {
          changeId: status.changeId,
          planningGeneration: subject.planningGenerationId,
          author,
          assignment,
          requiredDisposition: roleContextAuthorization
            ? 'exact-grant-required'
            : 'satisfied',
        });
  if (
    (roleContextAuthorization && roleTopology === null) ||
    authorizationNode.exactInputDigests.roleTopology !==
      sha256(canonicalJson(roleTopology))
  ) {
    throw planReviewRequestStale();
  }
  const retry =
    output.retry === null
      ? null
      : assertPlanReviewRetryReservation(
          services,
          paths,
          node,
          output.retry,
          output,
          request,
        );
  if (
    (expectedSubject &&
      canonicalJson(subject) !== canonicalJson(expectedSubject)) ||
    !isRecord(planning) ||
    manifest.planningTarget === undefined ||
    canonicalJson(materializationNode) !==
      canonicalJson(storedMaterializationNode) ||
    canonicalJson(targetSnapshotNode) !==
      canonicalJson(storedTargetSnapshotNode) ||
    canonicalJson(planning.subject) !== canonicalJson(subject) ||
    request.requestDigest !== node.exactInputDigests.request ||
    request.inputManifestDigest !== node.exactInputDigests.manifest ||
    subject.subjectDigest !== node.exactInputDigests.subject ||
    targetSnapshotNode.nodeId !== node.exactInputDigests.targetSnapshot ||
    targetSnapshot.snapshotDigest !== manifest.planningTarget.snapshotDigest ||
    targetSnapshot.materializationNodeId !== materializationNode.nodeId ||
    targetSnapshot.materializationResultDigest !==
      materializationNode.resultDigest ||
    authorizationNode.type !== 'plan-review-authorization' ||
    authorizationNode.evaluator !== 'workflow-propose.v1' ||
    authorizationNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    authorizationNode.exactInputDigests.targetSnapshot !==
      targetSnapshotNode.nodeId ||
    authorizationNode.provenanceParentNodeIds.targetSnapshot !==
      targetSnapshotNode.nodeId ||
    authorizationNode.semanticParentResultDigests.targetSnapshot !==
      targetSnapshotNode.resultDigest ||
    authorizationNode.provenanceParentNodeIds.materialization !==
      materializationNode.nodeId ||
    authorizationNode.semanticParentResultDigests.materialization !==
      materializationNode.resultDigest ||
    canonicalJson(request.roleAssignment) !== canonicalJson(assignment) ||
    request.authorizationNodeId !==
      node.provenanceParentNodeIds.authorization ||
    node.semanticParentResultDigests.authorization !==
      authorizationNode.resultDigest ||
    services.provider.providerInvocationManifestDigest(manifest) !==
      request.inputManifestDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Durable plan-review request no longer matches the planning subject.',
      ExitCode.staleState,
    );
  }
  return {
    reservationNode: node,
    subject,
    planning,
    assignment,
    author,
    materializationNode,
    targetSnapshotNode,
    manifest,
    request,
    grantAuthorization,
    roleTopology,
    retry,
  };
}

function assertPlanReviewRetryReservation(
  services: Pick<ProposeRuntime, 'evidence' | 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  node: EvidenceNode,
  value: unknown,
  output: Record<string, unknown>,
  request: ProviderInvocationRequest,
): NonNullable<PlanReviewReservation['retry']> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempt',
      'previousReservationNodeId',
      'failedInvocation',
      'executionPolicySnapshot',
      'retryDecision',
    ]) ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 2 ||
    typeof value.previousReservationNodeId !== 'string' ||
    !DIGEST.test(value.previousReservationNodeId) ||
    !isRecord(value.failedInvocation) ||
    !hasExactKeys(value.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof value.failedInvocation.invocationId !== 'string' ||
    !Number.isInteger(value.failedInvocation.attempt) ||
    (value.failedInvocation.attempt as number) < 1 ||
    !Number.isInteger(value.failedInvocation.revision) ||
    (value.failedInvocation.revision as number) < 0 ||
    typeof value.failedInvocation.requestDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.requestDigest) ||
    typeof value.failedInvocation.failureDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.failureDigest)
  ) {
    throw planReviewRequestStale();
  }
  const previousReservationNodeId = value.previousReservationNodeId;
  const failedInvocation =
    value.failedInvocation as PlanReviewRetryEnvelope['failedInvocation'];
  const retryDecision = assertPlanReviewRetryDecisionBinding(
    value.retryDecision,
  );
  let executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent;
  try {
    executionPolicySnapshot =
      services.provider.validateProviderExecutionPolicySnapshot(
        request,
        value.executionPolicySnapshot,
      );
  } catch {
    throw planReviewRequestStale();
  }
  const previousNode = services.evidence.readEvidenceNode(
    paths,
    previousReservationNodeId,
  );
  const previousOutput = previousNode.output;
  const previousAttempt =
    isRecord(previousOutput) &&
    Object.hasOwn(previousOutput, 'retry') &&
    previousOutput.retry === null
      ? 1
      : isRecord(previousOutput) &&
          isRecord(previousOutput.retry) &&
          Number.isInteger(previousOutput.retry.attempt) &&
          (previousOutput.retry.attempt as number) >= 2
        ? (previousOutput.retry.attempt as number)
        : 0;
  const failed = services.provider.readProviderInvocation(
    paths,
    failedInvocation.invocationId,
  );
  const failedRequest = services.provider.readProviderInvocationRequest(
    paths,
    failedInvocation.invocationId,
  );
  const {
    invocationId: _failedInvocationId,
    nonce: _failedNonce,
    requestDigest: _failedRequestDigest,
    policyDigest: _failedPolicyDigest,
    limits: _failedLimits,
    retryExplanation: _failedExplanation,
    ...failedRequestBinding
  } = failedRequest;
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
    previousNode.type !== 'plan-review-request-reservation' ||
    previousNode.nodeSchema !== 'workflow.plan-review-request-reservation.v3' ||
    previousNode.evaluator !== 'workflow-propose.v1' ||
    previousNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    previousNode.outputSchema !==
      'workflow.plan-review-request-reservation-output.v3' ||
    !isRecord(previousOutput) ||
    previousNode.nodeId !== node.exactInputDigests.previousRequest ||
    previousNode.nodeId !== node.provenanceParentNodeIds.previousRequest ||
    previousNode.resultDigest !==
      node.semanticParentResultDigests.previousRequest ||
    failedInvocation.failureDigest !== node.exactInputDigests.failure ||
    retryDecision.evidenceDigest !== node.exactInputDigests.retryDecision ||
    retryDecision.failedAttemptId !==
      `attempt-provider-${failedInvocation.invocationId}` ||
    sha256(canonicalJson(executionPolicySnapshot)) !==
      node.exactInputDigests.executionPolicySnapshot ||
    previousAttempt === 0 ||
    failed.attempt !== previousAttempt ||
    value.attempt !== failed.attempt + 1 ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    failed.invocationId !== failedInvocation.invocationId ||
    failed.attempt !== failedInvocation.attempt ||
    failed.revision !== failedInvocation.revision ||
    failed.requestDigest !== failedInvocation.requestDigest ||
    failedRequest.requestDigest !== failedInvocation.requestDigest ||
    sha256(canonicalJson(failed.failure)) !== failedInvocation.failureDigest ||
    canonicalJson(previousOutput.request) !== canonicalJson(failedRequest) ||
    canonicalJson(previousOutput.subject) !== canonicalJson(output.subject) ||
    canonicalJson(previousOutput.planning) !== canonicalJson(output.planning) ||
    canonicalJson(previousOutput.assignment) !==
      canonicalJson(output.assignment) ||
    canonicalJson(previousOutput.author) !== canonicalJson(output.author) ||
    canonicalJson(previousOutput.materializationNode) !==
      canonicalJson(output.materializationNode) ||
    canonicalJson(previousOutput.targetSnapshotNode) !==
      canonicalJson(output.targetSnapshotNode) ||
    canonicalJson(previousOutput.manifest) !== canonicalJson(output.manifest) ||
    canonicalJson(previousOutput.grantAuthorization) !==
      canonicalJson(output.grantAuthorization) ||
    request.requestDigest === failedRequest.requestDigest ||
    request.invocationId === failedRequest.invocationId ||
    request.nonce === failedRequest.nonce ||
    canonicalJson(replacementRequestBinding) !==
      canonicalJson(failedRequestBinding)
  ) {
    throw planReviewRequestStale();
  }
  return {
    attempt: value.attempt as number,
    previousReservationNodeId,
    failedInvocation,
    retryDecision,
    executionPolicySnapshot,
  };
}
