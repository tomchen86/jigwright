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
  assertGrantParentBindingV1,
  type GrantParentBindingV1,
} from './grant-parent-binding.ts';
import {
  freezeGrantCanonical,
  GRANT_UUID_V4 as UUID_V4,
  grantHasExactKeys as hasExactKeys,
  grantSha256,
} from './grant-primitives.ts';
import {
  ASSURANCE_LEVELS,
  PROVIDER_IDS,
  assertRoleIndependenceContinuationObservation,
  assertRoleIndependenceContinuationParameters,
  assertSha256Digest,
  assertText,
  grantInvalid,
  roleIndependenceContinuationParametersDigest,
} from './role-independence-continuation-contracts.ts';

export {
  assertRoleIndependenceContinuationParameters,
  assertRoleIndependenceContinuationObservation,
  roleIndependenceContinuationParametersDigest,
} from './role-independence-continuation-contracts.ts';

export const ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID =
  'role-independence.activate-degraded-continuation.v1' as const;

export const ROLE_INDEPENDENCE_CONTINUATION_PARENT_RELATION =
  'task.protected-apply.role-independence-continuation.v1' as const;

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
  parentGrantBinding?: GrantParentBindingV1;
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
    soleAuthority: 'completed-central-grant',
    otherAuthorityArtifactRequired: false,
    sourceStateValidationBypass: false,
    providerAvailabilityValidationBypass: false,
    assignmentValidationBypass: false,
    stagedInputValidationBypass: false,
    staleStateBypass: false,
    contentValidationBypass: false,
    naturalResultFabrication: false,
    reusableForDifferentAttempt: false,
  }),
);

export function createRoleIndependenceContinuationGrantRequest(
  candidate: RoleIndependenceContinuationObservationV1,
  proposedReason: string,
  parentGrantBinding: GrantParentBindingV1 | null = null,
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
  const parentBinding =
    parentGrantBinding === null
      ? null
      : assertRoleIndependenceContinuationParentBinding(
          parameters,
          parentGrantBinding,
        );
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
    ...(parentBinding === null ? {} : { parentGrantBinding: parentBinding }),
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
            'The completed Central Grant is the sole authority for this exact degraded continuation; no other authority artifact is a precondition.',
            'Record provider independence as degraded; do not describe this continuation as provider-independent.',
            'Preserve exact source, provider availability, assignment, staged-input, staleness, structured-content, and natural-result validation.',
            'Activation does not assert provider success, review satisfaction, or challenge closure.',
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

export function roleIndependenceContinuationParentRelationshipFactsDigest(
  candidate: RoleIndependenceContinuationParametersV1,
): `sha256:${string}` {
  const parameters = assertRoleIndependenceContinuationParameters(candidate);
  return grantSha256(
    `workflow.role-independence-continuation-parent-relationship.v1\n${canonicalJson(
      {
        schemaVersion: 1,
        kind: 'role-independence-continuation-parent-relationship.v1',
        owner: parameters.owner,
        targetDigest: parameters.targetDigest,
        assignmentDigest: parameters.assignmentDigest,
        parametersDigest:
          roleIndependenceContinuationParametersDigest(parameters),
      },
    )}`,
  );
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

function assertRoleIndependenceContinuationParentBinding(
  parameters: RoleIndependenceContinuationParametersV1,
  candidate: GrantParentBindingV1,
): GrantParentBindingV1 {
  const binding = assertGrantParentBindingV1(candidate);
  if (
    (parameters.owner.kind !== 'task-diff-review' &&
      parameters.owner.kind !== 'task-diff-review-continuation') ||
    binding.relationKind !== ROLE_INDEPENDENCE_CONTINUATION_PARENT_RELATION ||
    binding.relationshipFactsDigest !==
      roleIndependenceContinuationParentRelationshipFactsDigest(parameters)
  ) {
    throw workflowError(
      'GRANT_PARENT_BINDING_INVALID',
      'Role-independence continuation parent binding does not match the exact protected TaskDiffReview descendant.',
      ExitCode.guard,
    );
  }
  return binding;
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

function assertAuthorityDigest(value: unknown): `sha256:${string}` {
  try {
    return assertSha256Digest(value);
  } catch {
    throw activationInvalid();
  }
}

function activationInvalid() {
  return workflowError(
    'ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_INVALID',
    'The role-independence continuation activation does not authenticate against the completed Central Grant authority.',
    ExitCode.verification,
  );
}
