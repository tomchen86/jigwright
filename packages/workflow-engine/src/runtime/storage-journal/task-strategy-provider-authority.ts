/**
 * Replays provider and caller evidence authority for task implementation bindings.
 *
 * Invariants:
 * - Evidence reads and validation retain the original order before accepting authority.
 * - Reservations, results, assignments, and exact output digests remain bound to their original subject.
 *
 * Depends on: task implementation evidence nodes, invocation records, and role-result contracts.
 * Failure modes: copied or stale result bindings acquire authority for another implementation.
 */
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import type { ProviderInvocationRecord } from './provider-invocation-store.ts';
import {
  assertTaskStrategyImplementationOutput,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  type TaskStrategyImplementationSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  TaskStrategyImplementationReservation,
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationReservation,
  TaskStrategyCallerImplementationBinding,
} from './task-strategy-provider-record-contract.ts';
import {
  implementationResultStale,
  sha256,
} from './task-strategy-provider-store-values.ts';
import type { TaskStrategyTransaction } from './task-strategy-store.ts';
import type { RecordedRoleParticipant } from '../../modules/provider-orchestration/role-scheduler.ts';

/**
 * Replay the complete durable provider-result authority chain. Both the live
 * implementation lifecycle and correction projection use this one predicate
 * so a persisted binding cannot become authoritative merely by being copied
 * into a later round record.
 */
export function assertTaskStrategyImplementationProviderAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  reservation: TaskStrategyImplementationReservation,
  invocation: ProviderInvocationRecord,
  binding: TaskStrategyImplementationResultBinding,
): void {
  if (
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    invocation.result.runtimeObservation === null
  ) {
    throw implementationResultStale();
  }
  const output = assertTaskStrategyImplementationOutput(
    invocation.result.output,
  );
  const authorization = readEvidenceNode(
    paths,
    reservation.authorizationNodeId,
  );
  const requestReservation = readEvidenceNode(
    paths,
    reservation.reservationNodeId,
  );
  const observationNode = readEvidenceNode(
    paths,
    binding.providerObservationNodeId,
  );
  const resultNode = readEvidenceNode(paths, binding.providerResultNodeId);
  const { resultDigest, ...roleResultBody } = binding.roleResult;
  if (
    invocation.investigationId !== reservation.ownerInvestigationId ||
    invocation.changeId !== reservation.changeId ||
    invocation.invocationId !== reservation.request.invocationId ||
    invocation.requestDigest !== reservation.request.requestDigest ||
    invocation.manifestDigest !== reservation.request.inputManifestDigest ||
    invocation.providerId !== reservation.request.providerId ||
    invocation.purpose !== reservation.request.purpose ||
    binding.ownerInvestigationId !== reservation.ownerInvestigationId ||
    binding.sessionId !== reservation.sessionId ||
    binding.subjectDigest !== reservation.subject.subjectDigest ||
    binding.invocationId !== invocation.invocationId ||
    binding.requestDigest !== reservation.request.requestDigest ||
    binding.outputDigest !== invocation.result.outputDigest ||
    binding.runtimeObservationDigest !==
      sha256(canonicalJson(invocation.result.runtimeObservation)) ||
    canonicalJson(binding.output) !== canonicalJson(output) ||
    canonicalJson(binding.roleResult.assignment) !==
      canonicalJson(reservation.assignment) ||
    canonicalJson(binding.roleResult.author) !==
      canonicalJson(reservation.redAuthor) ||
    resultDigest !==
      sha256(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...roleResultBody,
        }),
      ) ||
    observationNode.resultDigest !== binding.providerObservationDigest ||
    observationNode.type !==
      'task-strategy-implementation-provider-observation' ||
    observationNode.nodeSchema !==
      'workflow.task-strategy-implementation-provider-observation.v1' ||
    observationNode.evaluator !== 'workflow-task-strategy.v1' ||
    observationNode.policyDigest !==
      TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    observationNode.outputSchema !==
      'workflow.task-strategy-implementation-provider-observation-output.v1' ||
    canonicalJson(observationNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        requestDigest: reservation.request.requestDigest,
        outputDigest: invocation.result.outputDigest,
        submission: output,
      }) ||
    observationNode.exactInputDigests.output !==
      invocation.result.outputDigest ||
    observationNode.exactInputDigests.request !==
      reservation.request.requestDigest ||
    observationNode.exactInputDigests.runtimeObservation !==
      binding.runtimeObservationDigest ||
    observationNode.exactInputDigests.subject !==
      reservation.subject.subjectDigest ||
    observationNode.semanticParentResultDigests.authorization !==
      authorization.resultDigest ||
    observationNode.semanticParentResultDigests.reservation !==
      requestReservation.resultDigest ||
    observationNode.provenanceParentNodeIds.authorization !==
      reservation.authorizationNodeId ||
    observationNode.provenanceParentNodeIds.reservation !==
      reservation.reservationNodeId ||
    canonicalJson(observationNode.runtimeMetadata) !==
      canonicalJson({
        runtimeObservation: invocation.result.runtimeObservation,
      }) ||
    resultNode.resultDigest !== binding.providerResultDigest ||
    resultNode.type !== 'task-strategy-implementation-provider-result' ||
    resultNode.nodeSchema !==
      'workflow.task-strategy-implementation-provider-result.v1' ||
    resultNode.evaluator !== 'workflow-task-strategy.v1' ||
    resultNode.policyDigest !== TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    resultNode.outputSchema !==
      'workflow.task-strategy-implementation-provider-result-output.v1' ||
    canonicalJson(resultNode.output) !==
      canonicalJson({
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        invocationId: invocation.invocationId,
        roleResult: binding.roleResult,
        output,
      }) ||
    resultNode.exactInputDigests.admission !==
      binding.roleResult.resultDigest ||
    resultNode.exactInputDigests.observation !== observationNode.resultDigest ||
    resultNode.exactInputDigests.subject !==
      reservation.subject.subjectDigest ||
    resultNode.semanticParentResultDigests.observation !==
      observationNode.resultDigest ||
    resultNode.provenanceParentNodeIds.observation !== observationNode.nodeId
  ) {
    throw implementationResultStale();
  }
}

export function assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  transaction: TaskStrategyTransaction,
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyCallerImplementationReservation,
): void {
  const submissionNode = readEvidenceNode(paths, reservation.submissionNodeId);
  const caller = {
    callerId: reservation.assignment.participant.principalId,
    assurance: reservation.assignment.participant.identityAssurance,
  };
  if (
    reservation.sessionId !== transaction.sessionId ||
    reservation.subjectDigest !== subject.subjectDigest ||
    reservation.assignment.role !== 'task-implementer' ||
    reservation.assignment.targetDigest !== subject.subjectDigest ||
    reservation.assignment.providerId !== null ||
    reservation.assignment.sessionId !== null ||
    reservation.assignment.degradedForm !== 'caller-supplied' ||
    reservation.assignment.orchestration !== 'caller-supplied' ||
    reservation.assignment.participant.providerId !== null ||
    reservation.assignment.participant.sessionId !== null ||
    reservation.assignment.participant.principalId === null ||
    reservation.assignment.participant.identityAssurance ===
      'maintainer-signed' ||
    reservation.assignment.participant.engineSpawned !== false ||
    canonicalJson(reservation.assignment.author) !==
      canonicalJson(taskStrategyRecordedRedAuthor(transaction)) ||
    reservation.output.sessionId !== transaction.sessionId ||
    reservation.output.sourceTree !== subject.sourceTree ||
    submissionNode.resultDigest !== reservation.submissionResultDigest ||
    submissionNode.type !== 'task-strategy-implementation-caller-submission' ||
    submissionNode.nodeSchema !==
      'workflow.task-strategy-implementation-caller-submission.v1' ||
    submissionNode.evaluator !== 'workflow-task-strategy.v1' ||
    submissionNode.policyDigest !==
      TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    submissionNode.outputSchema !==
      'workflow.task-strategy-implementation-caller-submission-output.v1' ||
    submissionNode.exactInputDigests.assignment !==
      sha256(canonicalJson(reservation.assignment)) ||
    submissionNode.exactInputDigests.caller !== sha256(canonicalJson(caller)) ||
    submissionNode.exactInputDigests.output !==
      sha256(canonicalJson(reservation.output)) ||
    submissionNode.exactInputDigests.subject !== subject.subjectDigest ||
    submissionNode.exactInputDigests.transition !==
      reservation.transitionDigest ||
    submissionNode.semanticParentResultDigests.red !==
      transaction.red.evidenceResultDigest ||
    submissionNode.provenanceParentNodeIds.red !==
      transaction.red.evidenceNodeId ||
    canonicalJson(submissionNode.output) !==
      canonicalJson({
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subjectDigest,
        transitionDigest: reservation.transitionDigest,
        caller,
        assignment: reservation.assignment,
        output: reservation.output,
      }) ||
    canonicalJson(submissionNode.runtimeMetadata) !== canonicalJson({})
  ) {
    throw implementationResultStale();
  }
}

export function assertTaskStrategyCallerImplementationAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  transaction: TaskStrategyTransaction,
  subject: TaskStrategyImplementationSubject,
  reservation: TaskStrategyCallerImplementationReservation,
  binding: TaskStrategyCallerImplementationBinding,
): void {
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
    paths,
    transaction,
    subject,
    reservation,
  );
  const submissionNode = readEvidenceNode(paths, reservation.submissionNodeId);
  const resultNode = readEvidenceNode(paths, binding.resultNodeId);
  if (
    binding.sessionId !== reservation.sessionId ||
    binding.subjectDigest !== reservation.subjectDigest ||
    binding.transitionDigest !== reservation.transitionDigest ||
    binding.submissionNodeId !== reservation.submissionNodeId ||
    binding.submissionResultDigest !== reservation.submissionResultDigest ||
    canonicalJson(binding.output) !== canonicalJson(reservation.output) ||
    canonicalJson(binding.roleResult.assignment) !==
      canonicalJson(reservation.assignment) ||
    canonicalJson(binding.roleResult.author) !==
      canonicalJson(reservation.assignment.author) ||
    canonicalJson(binding.roleResult.participant) !==
      canonicalJson(reservation.assignment.participant) ||
    binding.roleResult.content.nodeId !== submissionNode.nodeId ||
    binding.roleResult.content.resultDigest !== submissionNode.resultDigest ||
    resultNode.resultDigest !== binding.resultDigest ||
    resultNode.type !== 'task-strategy-implementation-caller-result' ||
    resultNode.nodeSchema !==
      'workflow.task-strategy-implementation-caller-result.v1' ||
    resultNode.evaluator !== 'workflow-task-strategy.v1' ||
    resultNode.policyDigest !== TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    resultNode.outputSchema !==
      'workflow.task-strategy-implementation-caller-result-output.v1' ||
    resultNode.exactInputDigests.admission !==
      binding.roleResult.resultDigest ||
    resultNode.exactInputDigests.submission !==
      reservation.submissionResultDigest ||
    resultNode.exactInputDigests.subject !== subject.subjectDigest ||
    resultNode.exactInputDigests.transition !== reservation.transitionDigest ||
    resultNode.semanticParentResultDigests.submission !==
      reservation.submissionResultDigest ||
    resultNode.provenanceParentNodeIds.submission !==
      reservation.submissionNodeId ||
    canonicalJson(resultNode.output) !==
      canonicalJson({
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subjectDigest,
        roleResult: binding.roleResult,
        output: reservation.output,
      }) ||
    canonicalJson(resultNode.runtimeMetadata) !== canonicalJson({})
  ) {
    throw implementationResultStale();
  }
}

function taskStrategyRecordedRedAuthor(
  transaction: TaskStrategyTransaction,
): RecordedRoleParticipant {
  return Object.freeze({
    providerId: transaction.author.providerId,
    sessionId: transaction.sessionId,
    principalId: `provider:${transaction.author.providerId}`,
    identityAssurance: transaction.author.assurance,
    engineSpawned: false,
  });
}
