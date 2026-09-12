import type {
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
} from '../../modules/assurance/task-strategy-evidence.ts';
export type {
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
} from '../../modules/assurance/task-strategy-evidence.ts';
/**
 * Validates immutable provider and caller implementation reservation and result records.
 *
 * Invariants:
 * - Exact keys, canonical digests, subjects, manifests, and role bindings retain their existing checks.
 * - Provider and caller authority forms remain distinct and parsed records stay deeply frozen.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  type TaskStrategyImplementationOutput,
  assertTaskStrategyImplementationSubject,
  assertTaskStrategyImplementationManifest,
  assertTaskStrategyImplementationOutput,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type {
  TaskStrategyImplementationSubject,
  TaskStrategyImplementationManifest,
} from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import type {
  RecordedRoleParticipant,
  ProviderRoleAssignment,
  GrantedRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';
import type { AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';

import {
  type ProviderInvocationRequest,
  isProviderRoleAssignment,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  ProviderRetryDecisionBinding,
  ProviderRetryReservationV2,
  ProviderRetryReservationV3,
} from '../../modules/provider-orchestration/provider-invocation-reservations.ts';
import path from 'node:path';
import {
  isRecord,
  hasExactKeys,
  isDigest,
  CHANGE_ID,
  TASK_ID,
  stateCorrupt,
  sha256,
  deepFreeze,
  withoutDigest,
  isGrantId,
  GIT_OBJECT_ID,
} from './task-strategy-provider-store-values.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from '../../modules/authority/collaboration-grant-codec.ts';
import {
  assertSessionId,
  assertInvestigationId,
  assertInvocationId,
} from '../../foundation/repository-path/repository-path.ts';

function isCurrentTaskStrategyOutputSchema(value: unknown): boolean {
  try {
    return (
      canonicalJson(value) ===
      canonicalJson(TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA)
    );
  } catch {
    return false;
  }
}

export type TaskStrategyImplementationReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-reservation.v1';
  recordDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding | null;
  subject: TaskStrategyImplementationSubject;
  redAuthor: RecordedRoleParticipant;
  assignment: ProviderRoleAssignment;
  manifest: TaskStrategyImplementationManifest;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  createdAt: string;
}>;

export type TaskStrategyImplementationProviderAttempt = Readonly<{
  root: TaskStrategyImplementationReservation;
  attempt: number;
  previousInvocationId: string | null;
  assignment: ProviderRoleAssignment;
  manifestDigest: string;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  retryDecision: ProviderRetryDecisionBinding | null;
  retryReservation:
    ProviderRetryReservationV2 | ProviderRetryReservationV3 | null;
  createdAt: string;
}>;

export type TaskStrategyCallerImplementationReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-caller-implementation-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  subjectDigest: string;
  grantId: string;
  transitionDigest: string;
  assignment: GrantedRoleAssignment;
  submissionNodeId: string;
  submissionResultDigest: string;
  output: TaskStrategyImplementationOutput;
  createdAt: string;
}>;

export function parseTaskStrategyImplementationReservation(
  value: unknown,
): TaskStrategyImplementationReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'ownerInvestigationId',
      'sessionId',
      'changeId',
      'taskId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'mandateBinding',
      'subject',
      'redAuthor',
      'assignment',
      'manifest',
      'request',
      'authorizationNodeId',
      'reservationNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-implementation-reservation.v1' ||
    !isDigest(value.recordDigest) ||
    !isInvestigationId(value.ownerInvestigationId) ||
    !isSessionId(value.sessionId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    typeof value.gitCommonDirectory !== 'string' ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    typeof value.branch !== 'string' ||
    value.branch.length === 0 ||
    !isBaseline(value.baseline) ||
    !isMandateBinding(value.mandateBinding, value.changeId) ||
    !isRecordedParticipant(value.redAuthor) ||
    !isProviderRoleAssignment(value.assignment) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let subject: TaskStrategyImplementationSubject;
  let manifest: TaskStrategyImplementationManifest;
  let request: ProviderInvocationRequest;
  try {
    subject = assertTaskStrategyImplementationSubject(value.subject);
    manifest = assertTaskStrategyImplementationManifest(value.manifest);
    request = recreateProviderInvocationRequest(value.request);
  } catch {
    throw stateCorrupt();
  }
  if (
    subject.sessionId !== value.sessionId ||
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    manifest.subject.subjectDigest !== subject.subjectDigest ||
    manifest.baseCommit !== value.baseline.head ||
    manifest.baseTree !== value.baseline.tree ||
    request.authorizationNodeId !== value.authorizationNodeId ||
    request.targetDigest !== subject.subjectDigest ||
    !isCurrentTaskStrategyOutputSchema(request.outputSchema) ||
    canonicalJson(request.roleAssignment) !== canonicalJson(value.assignment)
  ) {
    throw stateCorrupt();
  }
  const { recordDigest, ...body } = value;
  if (recordDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return deepFreeze(
    structuredClone(value),
  ) as TaskStrategyImplementationReservation;
}

export function parseTaskStrategyImplementationResultBinding(
  value: unknown,
): TaskStrategyImplementationResultBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'ownerInvestigationId',
      'sessionId',
      'subjectDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'runtimeObservationDigest',
      'providerObservationNodeId',
      'providerObservationDigest',
      'providerResultNodeId',
      'providerResultDigest',
      'roleResult',
      'output',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-implementation-result-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    !isInvestigationId(value.ownerInvestigationId) ||
    !isSessionId(value.sessionId) ||
    !isDigest(value.subjectDigest) ||
    !isInvocationId(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.runtimeObservationDigest) ||
    !isDigest(value.providerObservationNodeId) ||
    !isDigest(value.providerObservationDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest) ||
    !isAdmittedImplementationRoleResult(value.roleResult) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let output: TaskStrategyImplementationOutput;
  try {
    output = assertTaskStrategyImplementationOutput(value.output);
  } catch {
    throw stateCorrupt();
  }
  const binding: TaskStrategyImplementationResultBinding = {
    schemaVersion: 1,
    kind: 'task-strategy-implementation-result-binding.v1',
    bindingDigest: value.bindingDigest,
    ownerInvestigationId: value.ownerInvestigationId,
    sessionId: value.sessionId,
    subjectDigest: value.subjectDigest,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    runtimeObservationDigest: value.runtimeObservationDigest,
    providerObservationNodeId: value.providerObservationNodeId,
    providerObservationDigest: value.providerObservationDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
    roleResult: structuredClone(value.roleResult),
    output,
    createdAt: value.createdAt,
  };
  if (
    output.sessionId !== binding.sessionId ||
    binding.roleResult.targetDigest !== binding.subjectDigest ||
    binding.roleResult.role !== 'task-implementer' ||
    !isCurrentImplementationRoleResult(binding.roleResult) ||
    binding.roleResult.content.nodeId !== binding.providerObservationNodeId ||
    binding.roleResult.content.resultDigest !==
      binding.providerObservationDigest ||
    binding.roleResult.providerInvocation?.invocationId !==
      binding.invocationId ||
    binding.roleResult.providerInvocation.requestDigest !==
      binding.requestDigest ||
    binding.roleResult.providerInvocation.outputDigest !==
      binding.outputDigest ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw stateCorrupt();
  }
  return deepFreeze(binding);
}

function isCurrentImplementationRoleResult(value: AdmittedRoleResult): boolean {
  const { resultDigest, ...body } = value;
  if (
    resultDigest !==
      sha256(canonicalJson({ schema: 'admitted-role-result.v1', ...body })) ||
    value.role !== 'task-implementer' ||
    value.orchestration !== 'engine-spawned-provider' ||
    value.requiredIndependence !== 'session-independent' ||
    value.content.kind !== 'task-implementation' ||
    value.content.contentDigest !== value.content.resultDigest ||
    value.content.current !== true ||
    !isCurrentTaskStrategyOutputSchema(value.content.outputSchema) ||
    value.providerInvocation === null ||
    value.providerInvocation.providerId !== value.assignment.providerId ||
    value.providerInvocation.sessionId !== value.assignment.sessionId ||
    value.providerInvocation.targetDigest !== value.targetDigest ||
    value.participant.providerId !== value.assignment.providerId ||
    value.participant.sessionId !== value.assignment.sessionId ||
    value.participant.engineSpawned !== true ||
    value.directHumanReviewAttestation !== null
  ) {
    return false;
  }
  if (!('grantId' in value.assignment)) {
    return (
      value.form === 'ordinary-provider' &&
      (value.achievedIndependence === 'provider-independent' ||
        value.achievedIndependence === 'session-independent') &&
      value.grantUse === null
    );
  }
  return (
    value.form === 'granted-same-provider' &&
    value.achievedIndependence === 'session-independent' &&
    value.assignment.degradedForm === 'same-provider-fresh-session' &&
    value.grantUse !== null &&
    value.grantUse.grantId === value.assignment.grantId &&
    value.grantUse.degradedForm === 'same-provider-fresh-session' &&
    value.grantUse.targetDigest === value.targetDigest &&
    value.grantUse.structuredContent.kind === 'task-implementation' &&
    value.grantUse.structuredContent.nodeId === value.content.nodeId &&
    value.grantUse.structuredContent.resultDigest === value.content.resultDigest
  );
}

export function parseTaskStrategyCallerImplementationReservation(
  value: unknown,
): TaskStrategyCallerImplementationReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'sessionId',
      'subjectDigest',
      'grantId',
      'transitionDigest',
      'assignment',
      'submissionNodeId',
      'submissionResultDigest',
      'output',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-caller-implementation-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    !isSessionId(value.sessionId) ||
    !isDigest(value.subjectDigest) ||
    !isGrantId(value.grantId) ||
    !isDigest(value.transitionDigest) ||
    !isCallerGrantedAssignment(value.assignment) ||
    !isDigest(value.submissionNodeId) ||
    !isDigest(value.submissionResultDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let output: TaskStrategyImplementationOutput;
  try {
    output = assertTaskStrategyImplementationOutput(value.output);
  } catch {
    throw stateCorrupt();
  }
  const reservation: TaskStrategyCallerImplementationReservation = {
    schemaVersion: 1,
    kind: 'task-strategy-caller-implementation-reservation.v1',
    reservationDigest: value.reservationDigest,
    sessionId: value.sessionId,
    subjectDigest: value.subjectDigest,
    grantId: value.grantId,
    transitionDigest: value.transitionDigest,
    assignment: structuredClone(value.assignment),
    submissionNodeId: value.submissionNodeId,
    submissionResultDigest: value.submissionResultDigest,
    output,
    createdAt: value.createdAt,
  };
  if (
    output.sessionId !== reservation.sessionId ||
    reservation.assignment.grantId !== reservation.grantId ||
    reservation.assignment.targetDigest !== reservation.subjectDigest ||
    reservation.reservationDigest !==
      sha256(canonicalJson(withoutDigest(reservation, 'reservationDigest')))
  ) {
    throw stateCorrupt();
  }
  return deepFreeze(reservation);
}

export function parseTaskStrategyCallerImplementationBinding(
  value: unknown,
): TaskStrategyCallerImplementationBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'sessionId',
      'subjectDigest',
      'transitionDigest',
      'submissionNodeId',
      'submissionResultDigest',
      'resultNodeId',
      'resultDigest',
      'roleResult',
      'output',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-caller-implementation-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    !isSessionId(value.sessionId) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.transitionDigest) ||
    !isDigest(value.submissionNodeId) ||
    !isDigest(value.submissionResultDigest) ||
    !isDigest(value.resultNodeId) ||
    !isDigest(value.resultDigest) ||
    !isAdmittedImplementationRoleResult(value.roleResult) ||
    !isTimestamp(value.createdAt)
  ) {
    throw stateCorrupt();
  }
  let output: TaskStrategyImplementationOutput;
  try {
    output = assertTaskStrategyImplementationOutput(value.output);
  } catch {
    throw stateCorrupt();
  }
  const binding: TaskStrategyCallerImplementationBinding = {
    schemaVersion: 1,
    kind: 'task-strategy-caller-implementation-binding.v1',
    bindingDigest: value.bindingDigest,
    sessionId: value.sessionId,
    subjectDigest: value.subjectDigest,
    transitionDigest: value.transitionDigest,
    submissionNodeId: value.submissionNodeId,
    submissionResultDigest: value.submissionResultDigest,
    resultNodeId: value.resultNodeId,
    resultDigest: value.resultDigest,
    roleResult: structuredClone(value.roleResult),
    output,
    createdAt: value.createdAt,
  };
  const { resultDigest, ...roleResultBody } = binding.roleResult;
  if (
    output.sessionId !== binding.sessionId ||
    !isCallerGrantedAssignment(binding.roleResult.assignment) ||
    binding.roleResult.role !== 'task-implementer' ||
    binding.roleResult.targetDigest !== binding.subjectDigest ||
    binding.roleResult.form !== 'granted-caller-supplied' ||
    binding.roleResult.orchestration !== 'caller-supplied' ||
    binding.roleResult.achievedIndependence !== 'none' ||
    binding.roleResult.providerInvocation !== null ||
    binding.roleResult.directHumanReviewAttestation !== null ||
    canonicalJson(binding.roleResult.author) !==
      canonicalJson(binding.roleResult.assignment.author) ||
    canonicalJson(binding.roleResult.participant) !==
      canonicalJson(binding.roleResult.assignment.participant) ||
    binding.roleResult.grantUse?.degradedForm !== 'caller-supplied' ||
    binding.roleResult.grantUse.grantId !==
      binding.roleResult.assignment.grantId ||
    binding.roleResult.grantUse.targetDigest !== binding.subjectDigest ||
    binding.roleResult.grantUse.transitionDigest !== binding.transitionDigest ||
    binding.roleResult.grantUse.authorizedEffect !==
      COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
    canonicalJson(binding.roleResult.grantUse.assignment) !==
      canonicalJson(binding.roleResult.assignment) ||
    binding.roleResult.grantUse.structuredContent.kind !==
      'task-implementation' ||
    binding.roleResult.grantUse.structuredContent.nodeId !==
      binding.submissionNodeId ||
    binding.roleResult.grantUse.structuredContent.resultDigest !==
      binding.submissionResultDigest ||
    binding.roleResult.content.kind !== 'task-implementation' ||
    binding.roleResult.content.nodeId !== binding.submissionNodeId ||
    binding.roleResult.content.resultDigest !==
      binding.submissionResultDigest ||
    binding.roleResult.content.contentDigest !==
      binding.submissionResultDigest ||
    !isCurrentTaskStrategyOutputSchema(
      binding.roleResult.content.outputSchema,
    ) ||
    binding.roleResult.content.evaluator !==
      'task-strategy-implementation.v1' ||
    binding.roleResult.content.policyDigest !==
      TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    binding.roleResult.content.current !== true ||
    resultDigest !==
      sha256(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...roleResultBody,
        }),
      ) ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw stateCorrupt();
  }
  return deepFreeze(binding);
}

function isCallerGrantedAssignment(
  value: unknown,
): value is GrantedRoleAssignment {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'role',
      'providerId',
      'sessionId',
      'targetDigest',
      'requiredIndependence',
      'achievedIndependence',
      'providerIndependent',
      'sessionIndependent',
      'engineSpawned',
      'orchestration',
      'grantId',
      'degradedForm',
      'authorizedEffect',
      'author',
      'participant',
      'callableProviderIds',
      'directHumanReviewAttestationDigest',
    ]) &&
    value.role === 'task-implementer' &&
    value.providerId === null &&
    value.sessionId === null &&
    isDigest(value.targetDigest) &&
    value.requiredIndependence === 'provider-independent' &&
    value.achievedIndependence === 'none' &&
    value.providerIndependent === false &&
    value.sessionIndependent === false &&
    value.engineSpawned === false &&
    value.orchestration === 'caller-supplied' &&
    isGrantId(value.grantId) &&
    value.degradedForm === 'caller-supplied' &&
    value.authorizedEffect === COLLABORATION_GRANT_AUTHORIZED_EFFECT &&
    isRecordedParticipant(value.author) &&
    isCallerParticipant(value.participant) &&
    Array.isArray(value.callableProviderIds) &&
    value.callableProviderIds.length === 0 &&
    value.directHumanReviewAttestationDigest === null
  );
}

function isCallerParticipant(value: unknown): value is RecordedRoleParticipant {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) &&
    value.providerId === null &&
    value.sessionId === null &&
    typeof value.principalId === 'string' &&
    value.principalId.length > 0 &&
    (value.identityAssurance === 'self-declared' ||
      value.identityAssurance === 'runtime-hint' ||
      value.identityAssurance === 'adapter-assigned') &&
    value.engineSpawned === false
  );
}

function isBaseline(value: unknown): value is { head: string; tree: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

function isRecordedParticipant(
  value: unknown,
): value is RecordedRoleParticipant {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) &&
    (value.providerId === 'codex' || value.providerId === 'claude') &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    typeof value.principalId === 'string' &&
    value.principalId.length > 0 &&
    (value.identityAssurance === 'self-declared' ||
      value.identityAssurance === 'runtime-hint' ||
      value.identityAssurance === 'adapter-assigned') &&
    value.engineSpawned === false
  );
}

function isMandateBinding(
  value: unknown,
  changeId: string,
): value is TaskMandateBinding | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'schemaVersion',
        'mandateTaskId',
        'mandateId',
        'mandateDigest',
        'changeId',
        'externalAuditRoot',
      ]) &&
      value.schemaVersion === 1 &&
      typeof value.mandateTaskId === 'string' &&
      value.mandateTaskId.length > 0 &&
      typeof value.mandateId === 'string' &&
      value.mandateId.length > 0 &&
      isDigest(value.mandateDigest) &&
      value.changeId === changeId &&
      typeof value.externalAuditRoot === 'string' &&
      value.externalAuditRoot.length > 0)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

function isInvestigationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertInvestigationId(value) === value;
  } catch {
    return false;
  }
}

function isInvocationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertInvocationId(value) === value;
  } catch {
    return false;
  }
}

function isAdmittedImplementationRoleResult(
  value: unknown,
): value is AdmittedRoleResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'form',
      'role',
      'targetDigest',
      'assignment',
      'author',
      'participant',
      'orchestration',
      'requiredIndependence',
      'achievedIndependence',
      'content',
      'providerInvocation',
      'grantUse',
      'directHumanReviewAttestation',
      'resultDigest',
    ]) &&
    value.schemaVersion === 1 &&
    value.role === 'task-implementer' &&
    isDigest(value.targetDigest) &&
    isDigest(value.resultDigest) &&
    isRecord(value.assignment) &&
    isRecord(value.author) &&
    isRecord(value.participant) &&
    isRecord(value.content) &&
    (value.providerInvocation === null || isRecord(value.providerInvocation))
  );
}
