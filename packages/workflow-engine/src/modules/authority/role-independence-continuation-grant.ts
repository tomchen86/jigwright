import type {
  CentralGrantCompletedAuthorityRefV1,
  CentralGrantRequestInputV1,
} from '@jigwright/core/central-grant-port';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
} from './grant-transition-registry.ts';
import {
  freezeGrantCanonical,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_STABLE_ID as STABLE_ID,
  GRANT_UUID_V4 as UUID_V4,
  grantHasExactKeys as hasExactKeys,
  grantSha256,
} from './grant-primitives.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TASK_ID = /^\d+(?:\.\d+)+$/u;
const SESSION_ID = /^session-[A-Za-z0-9-]+$/u;
const INVESTIGATION_ID = /^investigation-[A-Za-z0-9-]+$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/u;

const PROVIDER_IDS = Object.freeze(['claude', 'codex'] as const);
const ASSURANCE_LEVELS = Object.freeze([
  'self-declared',
  'runtime-hint',
  'adapter-assigned',
  'maintainer-signed',
] as const);

export const ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID =
  'role-independence.activate-degraded-continuation.v1' as const;

export type RoleIndependenceProviderId = (typeof PROVIDER_IDS)[number];
export type RoleIndependenceActorAssurance = (typeof ASSURANCE_LEVELS)[number];

export type RoleIndependenceActorBindingV1 = Readonly<{
  providerId: RoleIndependenceProviderId | null;
  sessionId: string | null;
  principalId: string | null;
  identityAssurance: RoleIndependenceActorAssurance;
  engineSpawned: boolean;
}>;

export type RoleIndependenceCurrentInvestigationBindingV1 = Readonly<{
  investigationId: string;
  revision: number;
  sessionDigest: string;
}>;

export type ProposeBlindSurveyContinuationOwnerV1 = Readonly<{
  kind: 'propose-blind-survey';
  changeId: string;
  intentDigest: string;
  actorResolutionDigest: string;
  currentInvestigation: RoleIndependenceCurrentInvestigationBindingV1 | null;
}>;

export type ProposePlanReviewContinuationOwnerV1 = Readonly<{
  kind: 'propose-plan-review';
  investigationId: string;
  changeId: string;
  revision: number;
  planningGenerationDigest: string;
  planningSubjectDigest: string;
  materializationNodeId: string;
  materializationResultDigest: string;
  targetSnapshotNodeId: string;
  targetSnapshotResultDigest: string;
  requirementDigest: string;
}>;

export type TaskStrategyImplementationContinuationOwnerV1 = Readonly<{
  kind: 'task-strategy-implementation';
  sessionId: string;
  changeId: string;
  taskId: string;
  transactionDigest: string;
  subjectDigest: string;
  redEvidenceNodeId: string;
  redEvidenceResultDigest: string;
  sourceTree: string;
  attempt: number;
  failedInvocationId: string | null;
}>;

export type TaskDiffReviewContinuationOwnerV1 = Readonly<{
  kind: 'task-diff-review';
  sessionId: string;
  changeId: string;
  taskId: string;
  subjectDigest: string;
  candidateTree: string;
  taskContractDigest: string;
  requiredCheckPolicyDigest: string;
  checkEvidenceDigest: string;
  reviewPolicyDigest: string;
  implementationActorDigest: string;
  requestDigest: string;
  attempt: number;
}>;

export type TaskDiffReviewClosureContinuationOwnerV1 = Readonly<{
  kind: 'task-diff-review-continuation';
  sessionId: string;
  changeId: string;
  taskId: string;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  continuationTargetDigest: string;
  inputDigest: string;
}>;

export type RoleIndependenceContinuationOwnerV1 =
  | ProposeBlindSurveyContinuationOwnerV1
  | ProposePlanReviewContinuationOwnerV1
  | TaskStrategyImplementationContinuationOwnerV1
  | TaskDiffReviewContinuationOwnerV1
  | TaskDiffReviewClosureContinuationOwnerV1;

export type RoleIndependenceRequestedDegradationV1 =
  | Readonly<{
      kind: 'same-provider-fresh-session';
      participant: RoleIndependenceActorBindingV1;
      stagedInputDigest: null;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      participant: RoleIndependenceActorBindingV1;
      stagedInputDigest: string;
    }>
  | Readonly<{
      kind: 'direct-human-review';
      participant: RoleIndependenceActorBindingV1;
      stagedInputDigest: string;
    }>;

export type RoleIndependenceTaskMandateBindingV1 = Readonly<{
  schemaVersion: 1;
  mandateTaskId: string;
  mandateId: string;
  mandateDigest: string;
  changeId: string;
  externalAuditRoot: string;
}>;

export type RoleIndependenceContinuationParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'role-independence-continuation-activation.v1';
  repository: Readonly<{
    repositoryId: string;
    repositoryOrigin: string;
    policyBlob: string;
    policyDigest: string;
  }>;
  baseline: Readonly<{ commit: string; tree: string }>;
  owner: RoleIndependenceContinuationOwnerV1;
  targetDigest: string;
  author: RoleIndependenceActorBindingV1;
  requestedDegradation: RoleIndependenceRequestedDegradationV1;
  callableProviderIds: readonly RoleIndependenceProviderId[];
  providerPolicyDigest: string;
  providerRegistryDigest: string;
  assignmentDigest: string;
  mandateBinding: RoleIndependenceTaskMandateBindingV1 | null;
}>;

export type RoleIndependenceContinuationActivationV1 = Readonly<{
  challengeId: string;
  challengeDigest: `sha256:${string}`;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  parametersDigest: `sha256:${string}`;
}>;

export type RoleIndependenceContinuationApplicabilityV1 =
  | Readonly<{ status: 'applicable' }>
  | Readonly<{
      status: 'refused';
      reasonCode: string;
      factsDigest: `sha256:${string}`;
    }>;

export type RoleIndependenceContinuationObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'role-independence-continuation-observation.v1';
  parameters: RoleIndependenceContinuationParametersV1;
  parametersDigest: `sha256:${string}`;
  currentRepositoryHead: string;
  currentRepositoryTree: string;
  sourceStateDigest: string;
  providerAvailabilityDigest: string;
  mandateStateDigest: string | null;
  competingAttemptDigest: string | null;
  applicability: RoleIndependenceContinuationApplicabilityV1;
  activation: RoleIndependenceContinuationActivationV1 | null;
}>;

export type RoleIndependenceContinuationPort = Readonly<{
  observe(
    parameters: RoleIndependenceContinuationParametersV1,
  ):
    | RoleIndependenceContinuationObservationV1
    | Promise<RoleIndependenceContinuationObservationV1>;
  activate(
    context: AuthorizedTransitionContext<RoleIndependenceContinuationParametersV1>,
  ):
    | RoleIndependenceContinuationObservationV1
    | Promise<RoleIndependenceContinuationObservationV1>;
}>;

export type AuthenticatedRoleIndependenceContinuationAuthorityV1 =
  CentralGrantCompletedAuthorityRefV1 &
    Readonly<{
      transitionId: typeof ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID;
      parametersDigest: `sha256:${string}`;
      approvalSubjectDigest: `sha256:${string}`;
    }>;

export type RoleIndependenceContinuationGrantFactsV1 = Readonly<{
  schemaVersion: 1;
  kind: 'role-independence-continuation-grant-facts.v1';
  repositoryId: string;
  owner: RoleIndependenceContinuationOwnerV1;
  targetDigest: string;
  requiredIndependence: 'provider-independent';
  author: RoleIndependenceActorBindingV1;
  requestedDegradation: RoleIndependenceRequestedDegradationV1;
  callableProviderIds: readonly RoleIndependenceProviderId[];
  assignmentDigest: string;
  parametersDigest: `sha256:${string}`;
  sourceStateDigest: string;
  providerAvailabilityDigest: string;
  mandateStateDigest: string | null;
}>;

export const ROLE_INDEPENDENCE_CONTINUATION_PARAMETER_SCHEMA_DIGEST =
  grantSha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'role-independence-continuation-activation.schema.v1',
      commonRequired: [
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
        'mandateBinding',
      ],
      ownerKinds: [
        'propose-blind-survey',
        'propose-plan-review',
        'task-strategy-implementation',
        'task-diff-review',
        'task-diff-review-continuation',
      ],
      degradationKinds: [
        'same-provider-fresh-session',
        'caller-supplied',
        'direct-human-review',
      ],
    }),
  );

export const ROLE_INDEPENDENCE_CONTINUATION_CONSEQUENCE_DIGEST = grantSha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'role-independence-continuation-consequence.v1',
    effect: 'activate-one-exact-degraded-role-continuation',
    providerIndependence: 'explicitly-degraded',
    staleStateBypass: false,
    contentValidationBypass: false,
    taskMandateBypass: false,
    reusableForDifferentAttempt: false,
  }),
);

export function createRoleIndependenceContinuationGrantRequest(
  candidate: RoleIndependenceContinuationObservationV1,
  proposedReason: string,
): CentralGrantRequestInputV1<RoleIndependenceContinuationGrantFactsV1> {
  const observation = assertRoleIndependenceContinuationObservation(candidate);
  if (
    observation.applicability.status !== 'applicable' ||
    observation.activation !== null ||
    observation.competingAttemptDigest !== null
  ) {
    throw workflowError(
      'ROLE_INDEPENDENCE_CONTINUATION_GRANT_NOT_APPLICABLE',
      'The exact role-independence continuation is not currently eligible for a new Central Grant.',
      ExitCode.guard,
    );
  }
  const reason = assertText(proposedReason, 'proposed reason', 2_048);
  const parameters = observation.parameters;
  const facts = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'role-independence-continuation-grant-facts.v1' as const,
    repositoryId: parameters.repository.repositoryId,
    owner: parameters.owner,
    targetDigest: parameters.targetDigest,
    requiredIndependence: 'provider-independent' as const,
    author: parameters.author,
    requestedDegradation: parameters.requestedDegradation,
    callableProviderIds: parameters.callableProviderIds,
    assignmentDigest: parameters.assignmentDigest,
    parametersDigest: observation.parametersDigest,
    sourceStateDigest: observation.sourceStateDigest,
    providerAvailabilityDigest: observation.providerAvailabilityDigest,
    mandateStateDigest: observation.mandateStateDigest,
  });
  return Object.freeze({
    sourceModuleId: 'role-independence-continuation',
    failureCode: 'role-independence-continuation-grant-required',
    facts,
    stateBinding: roleIndependenceContinuationStateBinding(observation),
    candidates: Object.freeze([
      Object.freeze({
        transitionId: ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze([
          'approve-exact-role-independence-degradation',
        ]),
        reasonRequired: true,
        proposedReason: reason,
      }),
    ]),
  });
}

export function roleIndependenceContinuationTransitionDefinitions(
  port: RoleIndependenceContinuationPort,
): readonly TransitionDefinition<RoleIndependenceContinuationParametersV1>[] {
  assertPort(port);
  return Object.freeze([
    Object.freeze({
      transitionId: ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID,
      parameterSchemaDigest:
        ROLE_INDEPENDENCE_CONTINUATION_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: ROLE_INDEPENDENCE_CONTINUATION_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertRoleIndependenceContinuationParameters,
      renderTrustedChoice(candidate: RoleIndependenceContinuationParametersV1) {
        const parameters =
          assertRoleIndependenceContinuationParameters(candidate);
        return Object.freeze({
          title: `Activate the exact ${ownerLabel(parameters.owner)} degraded continuation`,
          consequences: Object.freeze([
            `Use only ${parameters.requestedDegradation.kind} for assignment ${parameters.assignmentDigest}.`,
            'Record provider independence as degraded; do not describe this continuation as provider-independent.',
            'Do not bypass current source, Task Mandate, structured-content, or result validation.',
            'Any owner, participant, input, provider availability, or source-state change requires a fresh Central Grant.',
          ]),
        });
      },
      async observeState(candidate: RoleIndependenceContinuationParametersV1) {
        const parameters =
          assertRoleIndependenceContinuationParameters(candidate);
        return roleIndependenceContinuationStateBinding(
          assertMatchingObservation(await port.observe(parameters), parameters),
        );
      },
      async execute(
        context: AuthorizedTransitionContext<RoleIndependenceContinuationParametersV1>,
      ) {
        context.assertLifecycleOwned();
        const parameters = assertRoleIndependenceContinuationParameters(
          context.parameters,
        );
        const before = assertMatchingObservation(
          await port.observe(parameters),
          parameters,
        );
        if (before.activation !== null) {
          if (
            !activationMatchesContext(before.activation, parameters, context)
          ) {
            throw workflowError(
              'ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_CONFLICT',
              'A different Central Grant operation already activated this exact role-independence continuation.',
              ExitCode.conflict,
            );
          }
          return completedOutcome(parameters);
        }
        if (
          before.applicability.status !== 'applicable' ||
          before.competingAttemptDigest !== null
        ) {
          throw grantTransitionPreconditionChanged(
            'ROLE_INDEPENDENCE_CONTINUATION_STATE_CHANGED',
            'The exact role-independence continuation precondition changed before activation.',
          );
        }
        context.assertLifecycleOwned();
        const after = assertMatchingObservation(
          await port.activate({ ...context, parameters }),
          parameters,
        );
        if (
          after.activation === null ||
          !activationMatchesContext(after.activation, parameters, context)
        ) {
          throw workflowError(
            'ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_INVALID',
            'The exact Central Grant activation was not durably published.',
            ExitCode.verification,
          );
        }
        context.assertLifecycleOwned();
        return completedOutcome(parameters);
      },
    }),
  ]);
}

export function roleIndependenceContinuationStateBinding(
  candidate: RoleIndependenceContinuationObservationV1,
) {
  const observation = assertRoleIndependenceContinuationObservation(candidate);
  return Object.freeze({
    kind: 'role-independence-continuation-state.v1',
    digest: grantSha256(canonicalJson(observation)),
  });
}

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
      'mandateBinding',
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
  const mandateBinding = assertMandateBinding(value.mandateBinding);
  if (
    targetDigest !== ownerTargetDigest(owner) ||
    (mandateBinding !== null &&
      (mandateBinding.changeId !== ownerChangeId(owner) ||
        (ownerTaskId(owner) !== null &&
          mandateBinding.mandateTaskId !== ownerTaskId(owner))))
  ) {
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
    mandateBinding,
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
      'mandateStateDigest',
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
  const mandateStateDigest = assertOptionalDigest(value.mandateStateDigest);
  const competingAttemptDigest = assertOptionalDigest(
    value.competingAttemptDigest,
  );
  const applicability = assertApplicability(value.applicability);
  const activation = assertActivation(value.activation);
  if (
    parametersDigest !==
      roleIndependenceContinuationParametersDigest(parameters) ||
    (parameters.mandateBinding === null) !== (mandateStateDigest === null) ||
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
    mandateStateDigest,
    competingAttemptDigest,
    applicability,
    activation,
  });
}

/**
 * Bind an already trusted completed Central Grant reference to the durable
 * activation published by its transition. The caller remains responsible for
 * minting `authority` from the canonical Grant store rather than user input.
 */
export function authenticateRoleIndependenceContinuationActivation(
  candidate: RoleIndependenceContinuationObservationV1,
  authorityCandidate: CentralGrantCompletedAuthorityRefV1,
  approvalSubjectDigestCandidate: string,
): AuthenticatedRoleIndependenceContinuationAuthorityV1 {
  try {
    return authenticateRoleIndependenceContinuationActivationUnsafe(
      candidate,
      authorityCandidate,
      approvalSubjectDigestCandidate,
    );
  } catch {
    throw activationInvalid();
  }
}

function authenticateRoleIndependenceContinuationActivationUnsafe(
  candidate: RoleIndependenceContinuationObservationV1,
  authorityCandidate: CentralGrantCompletedAuthorityRefV1,
  approvalSubjectDigestCandidate: string,
): AuthenticatedRoleIndependenceContinuationAuthorityV1 {
  const observation = assertRoleIndependenceContinuationObservation(candidate);
  const activation = observation.activation;
  const authority = assertCompletedAuthority(authorityCandidate);
  const approvalSubjectDigest = assertSha256Digest(
    approvalSubjectDigestCandidate,
  );
  if (
    activation === null ||
    authority.transitionId !== ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID ||
    activation.challengeId !== authority.challengeId ||
    activation.challengeDigest !== authority.challengeDigest ||
    activation.operationId !== authority.operationId ||
    activation.parametersDigest !== observation.parametersDigest ||
    activation.approvalSubjectDigest !== approvalSubjectDigest ||
    authority.terminalOutcomeDigest !==
      grantSha256(canonicalJson(completedOutcome(observation.parameters)))
  ) {
    throw activationInvalid();
  }
  return freezeGrantCanonical({
    ...authority,
    transitionId: ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID,
    parametersDigest: observation.parametersDigest,
    approvalSubjectDigest,
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

function assertMandateBinding(
  value: unknown,
): RoleIndependenceTaskMandateBindingV1 | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    mandateTaskId: assertTaskId(value.mandateTaskId),
    mandateId: assertText(value.mandateId, 'mandate ID'),
    mandateDigest: assertDigest(value.mandateDigest),
    changeId: assertChangeId(value.changeId),
    externalAuditRoot: assertText(
      value.externalAuditRoot,
      'external audit root',
    ),
  });
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
      participant.identityAssurance === 'maintainer-signed' ||
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
  if (
    degradation.kind === 'caller-supplied' &&
    participant.identityAssurance === 'maintainer-signed'
  ) {
    throw grantInvalid();
  }
  if (
    degradation.kind === 'direct-human-review' &&
    participant.identityAssurance !== 'maintainer-signed'
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

function assertCompletedAuthority(
  value: unknown,
): CentralGrantCompletedAuthorityRefV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'contractVersion',
      'challengeId',
      'challengeDigest',
      'transitionId',
      'operationId',
      'terminalOutcomeDigest',
    ]) ||
    value.contractVersion !== 'central-grant-completed-authority-ref.v1' ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.transitionId !== 'string' ||
    typeof value.operationId !== 'string' ||
    !UUID_V4.test(value.operationId)
  ) {
    throw activationInvalid();
  }
  return Object.freeze({
    contractVersion: 'central-grant-completed-authority-ref.v1',
    challengeId: value.challengeId,
    challengeDigest: assertAuthorityDigest(value.challengeDigest),
    transitionId: value.transitionId,
    operationId: value.operationId,
    terminalOutcomeDigest: assertAuthorityDigest(value.terminalOutcomeDigest),
  });
}

function assertMatchingObservation(
  candidate: RoleIndependenceContinuationObservationV1,
  parameters: RoleIndependenceContinuationParametersV1,
): RoleIndependenceContinuationObservationV1 {
  const observation = assertRoleIndependenceContinuationObservation(candidate);
  if (canonicalJson(observation.parameters) !== canonicalJson(parameters)) {
    throw workflowError(
      'ROLE_INDEPENDENCE_CONTINUATION_SOURCE_MISMATCH',
      'The observed continuation does not match the exact source-specific owner bound to this Central Grant.',
      ExitCode.verification,
    );
  }
  return observation;
}

function activationMatchesContext(
  activation: RoleIndependenceContinuationActivationV1,
  parameters: RoleIndependenceContinuationParametersV1,
  context: AuthorizedTransitionContext<RoleIndependenceContinuationParametersV1>,
): boolean {
  return (
    activation.challengeId === context.challengeId &&
    activation.challengeDigest === context.approvalSubject.challengeDigest &&
    activation.operationId === context.operationId &&
    activation.approvalSubjectDigest === context.approvalSubjectDigest &&
    activation.parametersDigest ===
      roleIndependenceContinuationParametersDigest(parameters)
  );
}

function completedOutcome(
  parameters: RoleIndependenceContinuationParametersV1,
) {
  return Object.freeze({
    outcome: 'completed' as const,
    details: Object.freeze({
      schemaVersion: 1,
      kind: 'role-independence-continuation-activated.v1',
      owner: parameters.owner,
      targetDigest: parameters.targetDigest,
      degradedForm: parameters.requestedDegradation.kind,
      assignmentDigest: parameters.assignmentDigest,
      parametersDigest:
        roleIndependenceContinuationParametersDigest(parameters),
    }),
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

function ownerChangeId(owner: RoleIndependenceContinuationOwnerV1): string {
  return owner.changeId;
}

function ownerTaskId(
  owner: RoleIndependenceContinuationOwnerV1,
): string | null {
  switch (owner.kind) {
    case 'propose-blind-survey':
    case 'propose-plan-review':
      return null;
    case 'task-strategy-implementation':
    case 'task-diff-review':
    case 'task-diff-review-continuation':
      return owner.taskId;
  }
}

function ownerLabel(owner: RoleIndependenceContinuationOwnerV1): string {
  switch (owner.kind) {
    case 'propose-blind-survey':
      return 'blind-survey';
    case 'propose-plan-review':
      return 'PlanReview';
    case 'task-strategy-implementation':
      return 'task implementation';
    case 'task-diff-review':
      return 'TaskDiffReview';
    case 'task-diff-review-continuation':
      return 'TaskDiffReview continuation';
  }
}

function assertPort(value: RoleIndependenceContinuationPort): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.observe !== 'function' ||
    typeof value.activate !== 'function'
  ) {
    throw grantInvalid();
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

function assertSha256Digest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw grantInvalid();
  }
  return value as `sha256:${string}`;
}

function assertAuthorityDigest(value: unknown): `sha256:${string}` {
  try {
    return assertSha256Digest(value);
  } catch {
    throw activationInvalid();
  }
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

function assertText(value: unknown, label: string, maxBytes = 4_096): string {
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

function grantInvalid() {
  return workflowError(
    'ROLE_INDEPENDENCE_CONTINUATION_GRANT_INVALID',
    'Role-independence continuation Grant state is malformed or internally inconsistent.',
    ExitCode.guard,
  );
}

function activationInvalid() {
  return workflowError(
    'ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_INVALID',
    'The role-independence continuation activation does not authenticate against the completed Central Grant authority.',
    ExitCode.verification,
  );
}
