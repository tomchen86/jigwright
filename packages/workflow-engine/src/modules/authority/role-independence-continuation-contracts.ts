/**
 * Validates and encodes role-independence continuation owners, parameters
 * and observations.
 *
 * Invariants:
 * - assertRoleIndependenceContinuationParameters rejects unless
 *   targetDigest equals ownerTargetDigest(owner) for the owner variant.
 * - An observation is rejected unless parametersDigest equals
 *   roleIndependenceContinuationParametersDigest(parameters).
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  freezeGrantCanonical,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_STABLE_ID as STABLE_ID,
  GRANT_UUID_V4 as UUID_V4,
  grantHasExactKeys as hasExactKeys,
  grantSha256,
} from './grant-primitives.ts';
import type {
  ProposeBlindSurveyContinuationOwnerV1,
  ProposePlanReviewContinuationOwnerV1,
  RoleIndependenceActorAssurance,
  RoleIndependenceActorBindingV1,
  RoleIndependenceContinuationActivationV1,
  RoleIndependenceContinuationApplicabilityV1,
  RoleIndependenceContinuationObservationV1,
  RoleIndependenceContinuationOwnerV1,
  RoleIndependenceContinuationParametersV1,
  RoleIndependenceCurrentInvestigationBindingV1,
  RoleIndependenceProviderId,
  RoleIndependenceRequestedDegradationV1,
  TaskDiffReviewClosureContinuationOwnerV1,
  TaskDiffReviewContinuationOwnerV1,
  TaskStrategyImplementationContinuationOwnerV1,
} from './role-independence-continuation-grant.ts';

const DIGEST = /^[0-9a-f]{64}$/u;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const TASK_ID = /^\d+(?:\.\d+)+$/u;

const SESSION_ID = /^session-[A-Za-z0-9-]+$/u;

const INVESTIGATION_ID = /^investigation-[A-Za-z0-9-]+$/u;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/u;

/**
 * Provider identities in the order this grant's canonical bytes were defined
 * with. Issued digests depend on it, so it cannot follow the registry's
 * preference order; a contract test fails if the registry gains an identity
 * this list omits.
 */
export const PROVIDER_IDS = Object.freeze(['claude', 'codex'] as const);

export const ASSURANCE_LEVELS = Object.freeze([
  'self-declared',
  'runtime-hint',
  'adapter-assigned',
] as const);

export function roleIndependenceContinuationParametersDigest(
  candidate: RoleIndependenceContinuationParametersV1,
): `sha256:${string}` {
  return grantSha256(
    canonicalJson(assertRoleIndependenceContinuationParameters(candidate)),
  );
}

export function assertRoleIndependenceContinuationParameters(
  value: unknown,
): RoleIndependenceContinuationParametersV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repository',
      'baseline',
      'owner',
      'targetDigest',
      'author',
      'requestedDegradation',
      'callableProviderIds',
      'providerPolicyDigest',
      'providerRegistryDigest',
      'assignmentDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'role-independence-continuation-activation.v1'
  ) {
    throw grantInvalid();
  }
  const repository = assertRepository(value.repository);
  const baseline = assertBaseline(value.baseline);
  const owner = assertOwner(value.owner);
  const targetDigest = assertDigest(value.targetDigest);
  const author = assertActor(value.author);
  const callableProviderIds = assertProviderIds(value.callableProviderIds);
  const requestedDegradation = assertRequestedDegradation(
    value.requestedDegradation,
  );
  const providerPolicyDigest = assertDigest(value.providerPolicyDigest);
  const providerRegistryDigest = assertDigest(value.providerRegistryDigest);
  const assignmentDigest = assertDigest(value.assignmentDigest);
  if (targetDigest !== ownerTargetDigest(owner)) {
    throw grantInvalid();
  }
  assertDegradationBinding(
    owner,
    author,
    requestedDegradation,
    callableProviderIds,
  );
  return freezeGrantCanonical({
    schemaVersion: 1,
    kind: 'role-independence-continuation-activation.v1',
    repository,
    baseline,
    owner,
    targetDigest,
    author,
    requestedDegradation,
    callableProviderIds,
    providerPolicyDigest,
    providerRegistryDigest,
    assignmentDigest,
  });
}

export function assertRoleIndependenceContinuationObservation(
  value: unknown,
): RoleIndependenceContinuationObservationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'parameters',
      'parametersDigest',
      'currentRepositoryHead',
      'currentRepositoryTree',
      'sourceStateDigest',
      'providerAvailabilityDigest',
      'competingAttemptDigest',
      'applicability',
      'activation',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'role-independence-continuation-observation.v1'
  ) {
    throw grantInvalid();
  }
  const parameters = assertRoleIndependenceContinuationParameters(
    value.parameters,
  );
  const parametersDigest = assertSha256Digest(value.parametersDigest);
  const currentRepositoryHead = assertGitObject(value.currentRepositoryHead);
  const currentRepositoryTree = assertGitObject(value.currentRepositoryTree);
  const sourceStateDigest = assertDigest(value.sourceStateDigest);
  const providerAvailabilityDigest = assertDigest(
    value.providerAvailabilityDigest,
  );
  const competingAttemptDigest = assertOptionalDigest(
    value.competingAttemptDigest,
  );
  const applicability = assertApplicability(value.applicability);
  const activation = assertActivation(value.activation);
  if (
    parametersDigest !==
      roleIndependenceContinuationParametersDigest(parameters) ||
    (activation !== null &&
      (activation.parametersDigest !== parametersDigest ||
        competingAttemptDigest !== null))
  ) {
    throw grantInvalid();
  }
  return freezeGrantCanonical({
    schemaVersion: 1,
    kind: 'role-independence-continuation-observation.v1',
    parameters,
    parametersDigest,
    currentRepositoryHead,
    currentRepositoryTree,
    sourceStateDigest,
    providerAvailabilityDigest,
    competingAttemptDigest,
    applicability,
    activation,
  });
}

function assertRepository(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'repositoryId',
      'repositoryOrigin',
      'policyBlob',
      'policyDigest',
    ])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    repositoryId: assertText(value.repositoryId, 'repository ID'),
    repositoryOrigin: assertText(value.repositoryOrigin, 'repository origin'),
    policyBlob: assertGitObject(value.policyBlob),
    policyDigest: assertDigest(value.policyDigest),
  });
}

function assertBaseline(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, ['commit', 'tree'])) {
    throw grantInvalid();
  }
  return Object.freeze({
    commit: assertGitObject(value.commit),
    tree: assertGitObject(value.tree),
  });
}

function assertOwner(value: unknown): RoleIndependenceContinuationOwnerV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw grantInvalid();
  }
  switch (value.kind) {
    case 'propose-blind-survey':
      return assertBlindSurveyOwner(value);
    case 'propose-plan-review':
      return assertPlanReviewOwner(value);
    case 'task-strategy-implementation':
      return assertTaskImplementationOwner(value);
    case 'task-diff-review':
      return assertTaskDiffReviewOwner(value);
    case 'task-diff-review-continuation':
      return assertTaskDiffContinuationOwner(value);
    default:
      throw grantInvalid();
  }
}

function assertBlindSurveyOwner(
  value: Record<string, unknown>,
): ProposeBlindSurveyContinuationOwnerV1 {
  if (
    !hasExactKeys(value, [
      'kind',
      'changeId',
      'intentDigest',
      'actorResolutionDigest',
      'currentInvestigation',
    ])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    kind: 'propose-blind-survey',
    changeId: assertChangeId(value.changeId),
    intentDigest: assertDigest(value.intentDigest),
    actorResolutionDigest: assertDigest(value.actorResolutionDigest),
    currentInvestigation: assertCurrentInvestigation(
      value.currentInvestigation,
    ),
  });
}

function assertCurrentInvestigation(
  value: unknown,
): RoleIndependenceCurrentInvestigationBindingV1 | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['investigationId', 'revision', 'sessionDigest'])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    investigationId: assertInvestigationId(value.investigationId),
    revision: assertNonNegativeInteger(value.revision),
    sessionDigest: assertDigest(value.sessionDigest),
  });
}

function assertPlanReviewOwner(
  value: Record<string, unknown>,
): ProposePlanReviewContinuationOwnerV1 {
  if (
    !hasExactKeys(value, [
      'kind',
      'investigationId',
      'changeId',
      'revision',
      'planningGenerationDigest',
      'planningSubjectDigest',
      'materializationNodeId',
      'materializationResultDigest',
      'targetSnapshotNodeId',
      'targetSnapshotResultDigest',
      'requirementDigest',
    ])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    kind: 'propose-plan-review',
    investigationId: assertInvestigationId(value.investigationId),
    changeId: assertChangeId(value.changeId),
    revision: assertNonNegativeInteger(value.revision),
    planningGenerationDigest: assertDigest(value.planningGenerationDigest),
    planningSubjectDigest: assertDigest(value.planningSubjectDigest),
    materializationNodeId: assertDigest(value.materializationNodeId),
    materializationResultDigest: assertDigest(
      value.materializationResultDigest,
    ),
    targetSnapshotNodeId: assertDigest(value.targetSnapshotNodeId),
    targetSnapshotResultDigest: assertDigest(value.targetSnapshotResultDigest),
    requirementDigest: assertDigest(value.requirementDigest),
  });
}

function assertTaskImplementationOwner(
  value: Record<string, unknown>,
): TaskStrategyImplementationContinuationOwnerV1 {
  if (
    !hasExactKeys(value, [
      'kind',
      'sessionId',
      'changeId',
      'taskId',
      'transactionDigest',
      'subjectDigest',
      'redEvidenceNodeId',
      'redEvidenceResultDigest',
      'sourceTree',
      'attempt',
      'failedInvocationId',
    ])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    kind: 'task-strategy-implementation',
    sessionId: assertSessionId(value.sessionId),
    changeId: assertChangeId(value.changeId),
    taskId: assertTaskId(value.taskId),
    transactionDigest: assertDigest(value.transactionDigest),
    subjectDigest: assertDigest(value.subjectDigest),
    redEvidenceNodeId: assertDigest(value.redEvidenceNodeId),
    redEvidenceResultDigest: assertDigest(value.redEvidenceResultDigest),
    sourceTree: assertGitObject(value.sourceTree),
    attempt: assertPositiveInteger(value.attempt),
    failedInvocationId:
      value.failedInvocationId === null
        ? null
        : assertText(value.failedInvocationId, 'failed invocation ID'),
  });
}

function assertTaskDiffReviewOwner(
  value: Record<string, unknown>,
): TaskDiffReviewContinuationOwnerV1 {
  if (
    !hasExactKeys(value, [
      'kind',
      'sessionId',
      'changeId',
      'taskId',
      'subjectDigest',
      'candidateTree',
      'taskContractDigest',
      'requiredCheckPolicyDigest',
      'checkEvidenceDigest',
      'reviewPolicyDigest',
      'implementationActorDigest',
      'requestDigest',
      'attempt',
    ])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    kind: 'task-diff-review',
    sessionId: assertSessionId(value.sessionId),
    changeId: assertChangeId(value.changeId),
    taskId: assertTaskId(value.taskId),
    subjectDigest: assertDigest(value.subjectDigest),
    candidateTree: assertGitObject(value.candidateTree),
    taskContractDigest: assertDigest(value.taskContractDigest),
    requiredCheckPolicyDigest: assertDigest(value.requiredCheckPolicyDigest),
    checkEvidenceDigest: assertDigest(value.checkEvidenceDigest),
    reviewPolicyDigest: assertDigest(value.reviewPolicyDigest),
    implementationActorDigest: assertDigest(value.implementationActorDigest),
    requestDigest: assertDigest(value.requestDigest),
    attempt: assertPositiveInteger(value.attempt),
  });
}

function assertTaskDiffContinuationOwner(
  value: Record<string, unknown>,
): TaskDiffReviewClosureContinuationOwnerV1 {
  if (
    !hasExactKeys(value, [
      'kind',
      'sessionId',
      'changeId',
      'taskId',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'continuationTargetDigest',
      'inputDigest',
    ])
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    kind: 'task-diff-review-continuation',
    sessionId: assertSessionId(value.sessionId),
    changeId: assertChangeId(value.changeId),
    taskId: assertTaskId(value.taskId),
    subjectDigest: assertDigest(value.subjectDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    continuationTargetDigest: assertDigest(value.continuationTargetDigest),
    inputDigest: assertDigest(value.inputDigest),
  });
}

function assertActor(value: unknown): RoleIndependenceActorBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    (value.providerId !== null && !isProviderId(value.providerId)) ||
    (value.sessionId !== null && typeof value.sessionId !== 'string') ||
    (value.principalId !== null &&
      (typeof value.principalId !== 'string' ||
        !IDENTITY.test(value.principalId))) ||
    !ASSURANCE_LEVELS.includes(
      value.identityAssurance as RoleIndependenceActorAssurance,
    ) ||
    typeof value.engineSpawned !== 'boolean' ||
    (value.providerId === null) !== (value.sessionId === null)
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    providerId: value.providerId as RoleIndependenceProviderId | null,
    sessionId:
      value.sessionId === null
        ? null
        : assertText(value.sessionId, 'actor session ID'),
    principalId: value.principalId as string | null,
    identityAssurance:
      value.identityAssurance as RoleIndependenceActorAssurance,
    engineSpawned: value.engineSpawned,
  });
}

function assertRequestedDegradation(
  value: unknown,
): RoleIndependenceRequestedDegradationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'participant', 'stagedInputDigest'])
  ) {
    throw grantInvalid();
  }
  const participant = assertActor(value.participant);
  switch (value.kind) {
    case 'same-provider-fresh-session':
      if (value.stagedInputDigest !== null) throw grantInvalid();
      return Object.freeze({
        kind: 'same-provider-fresh-session',
        participant,
        stagedInputDigest: null,
      });
    case 'caller-supplied':
      return Object.freeze({
        kind: 'caller-supplied',
        participant,
        stagedInputDigest: assertDigest(value.stagedInputDigest),
      });
    case 'direct-human-review':
      return Object.freeze({
        kind: 'direct-human-review',
        participant,
        stagedInputDigest: assertDigest(value.stagedInputDigest),
      });
    default:
      throw grantInvalid();
  }
}

function assertProviderIds(
  value: unknown,
): readonly RoleIndependenceProviderId[] {
  if (
    !Array.isArray(value) ||
    !value.every(isProviderId) ||
    new Set(value).size !== value.length ||
    canonicalJson(value) !==
      canonicalJson(
        PROVIDER_IDS.filter((providerId) => value.includes(providerId)),
      )
  ) {
    throw grantInvalid();
  }
  return Object.freeze([...value]);
}

function assertDegradationBinding(
  owner: RoleIndependenceContinuationOwnerV1,
  author: RoleIndependenceActorBindingV1,
  degradation: RoleIndependenceRequestedDegradationV1,
  callableProviderIds: readonly RoleIndependenceProviderId[],
): void {
  const allowed = allowedDegradations(owner.kind);
  if (!allowed.includes(degradation.kind)) throw grantInvalid();
  const participant = degradation.participant;
  if (degradation.kind === 'same-provider-fresh-session') {
    if (
      author.providerId === null ||
      author.sessionId === null ||
      participant.providerId !== author.providerId ||
      participant.sessionId === null ||
      participant.sessionId === author.sessionId ||
      !participant.engineSpawned ||
      callableProviderIds.length !== 1 ||
      callableProviderIds[0] !== participant.providerId
    ) {
      throw grantInvalid();
    }
    return;
  }
  if (callableProviderIds.length !== 0) throw grantInvalid();
  if (
    participant.providerId !== null ||
    participant.sessionId !== null ||
    participant.principalId === null ||
    participant.engineSpawned
  ) {
    throw grantInvalid();
  }
}

function allowedDegradations(
  ownerKind: RoleIndependenceContinuationOwnerV1['kind'],
): readonly RoleIndependenceRequestedDegradationV1['kind'][] {
  switch (ownerKind) {
    case 'propose-blind-survey':
      return ['same-provider-fresh-session', 'caller-supplied'];
    case 'propose-plan-review':
    case 'task-diff-review':
      return [
        'same-provider-fresh-session',
        'caller-supplied',
        'direct-human-review',
      ];
    case 'task-strategy-implementation':
      return ['same-provider-fresh-session', 'caller-supplied'];
    case 'task-diff-review-continuation':
      return ['caller-supplied', 'direct-human-review'];
  }
}

function assertApplicability(
  value: unknown,
): RoleIndependenceContinuationApplicabilityV1 {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw grantInvalid();
  }
  if (value.status === 'applicable' && hasExactKeys(value, ['status'])) {
    return Object.freeze({ status: 'applicable' });
  }
  if (
    value.status === 'refused' &&
    hasExactKeys(value, ['status', 'reasonCode', 'factsDigest']) &&
    typeof value.reasonCode === 'string' &&
    STABLE_ID.test(value.reasonCode)
  ) {
    return Object.freeze({
      status: 'refused',
      reasonCode: value.reasonCode,
      factsDigest: assertSha256Digest(value.factsDigest),
    });
  }
  throw grantInvalid();
}

function assertActivation(
  value: unknown,
): RoleIndependenceContinuationActivationV1 | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'challengeId',
      'challengeDigest',
      'operationId',
      'approvalSubjectDigest',
      'parametersDigest',
    ]) ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.operationId !== 'string' ||
    !UUID_V4.test(value.operationId)
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    challengeId: value.challengeId,
    challengeDigest: assertSha256Digest(value.challengeDigest),
    operationId: value.operationId,
    approvalSubjectDigest: assertSha256Digest(value.approvalSubjectDigest),
    parametersDigest: assertSha256Digest(value.parametersDigest),
  });
}

function ownerTargetDigest(owner: RoleIndependenceContinuationOwnerV1): string {
  switch (owner.kind) {
    case 'propose-blind-survey':
      return owner.intentDigest;
    case 'propose-plan-review':
      return owner.planningSubjectDigest;
    case 'task-strategy-implementation':
    case 'task-diff-review':
      return owner.subjectDigest;
    case 'task-diff-review-continuation':
      return owner.continuationTargetDigest;
  }
}

function isProviderId(value: unknown): value is RoleIndependenceProviderId {
  return PROVIDER_IDS.includes(value as RoleIndependenceProviderId);
}

function assertChangeId(value: unknown): string {
  if (typeof value !== 'string' || !CHANGE_ID.test(value)) throw grantInvalid();
  return value;
}

function assertTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID.test(value)) throw grantInvalid();
  return value;
}

function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value))
    throw grantInvalid();
  return value;
}

function assertInvestigationId(value: unknown): string {
  if (typeof value !== 'string' || !INVESTIGATION_ID.test(value)) {
    throw grantInvalid();
  }
  return value;
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw grantInvalid();
  return value;
}

function assertOptionalDigest(value: unknown): string | null {
  return value === null ? null : assertDigest(value);
}

export function assertSha256Digest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw grantInvalid();
  }
  return value as `sha256:${string}`;
}

function assertGitObject(value: unknown): string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    throw grantInvalid();
  }
  return value;
}

function assertNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw grantInvalid();
  return Number(value);
}

function assertPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw grantInvalid();
  return Number(value);
}

export function assertText(
  value: unknown,
  label: string,
  maxBytes = 4_096,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\0\r]/u.test(value)
  ) {
    throw workflowError(
      'ROLE_INDEPENDENCE_CONTINUATION_GRANT_INVALID',
      `Role-independence continuation ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

export function grantInvalid() {
  return workflowError(
    'ROLE_INDEPENDENCE_CONTINUATION_GRANT_INVALID',
    'Role-independence continuation Grant state is malformed or internally inconsistent.',
    ExitCode.guard,
  );
}
