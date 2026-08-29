import crypto from 'node:crypto';

import type { CentralGrantRequestInputV1 } from '@jigwright/core/central-grant-port';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  AuthorizedTransitionContext,
  TransitionDefinition,
} from '../authority/grant-transition-registry.ts';
import { grantTransitionPreconditionChanged } from '../authority/grant-transition-registry.ts';
import type { AgentRolePair } from './agent-role-plan.ts';
import type { ChangeRoleAssignmentGrantRequirementV1 } from './change-role-assignment-record.ts';

export const CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID =
  'agent-runtime.role-assignment.activate.v1' as const;

const DIGEST = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ROLE_PAIRS = Object.freeze([
  'author-builder',
  'author-reviewer',
  'builder-reviewer',
] as const satisfies readonly AgentRolePair[]);

export type ChangeRoleAssignmentGrantActivationV1 = Readonly<{
  challengeId: string;
  challengeDigest: `sha256:${string}`;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
}>;

export type ChangeRoleAssignmentGrantObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-grant-observation.v1';
  repositoryId: string;
  changeId: string;
  planningGeneration: string;
  invocationId: string;
  recordDigest: string;
  assignmentDigest: string;
  grantRequirementDigest: string;
  exactRolePairs: readonly AgentRolePair[];
  activation: ChangeRoleAssignmentGrantActivationV1 | null;
}>;

export type ChangeRoleAssignmentGrantParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-grant-activation.v1';
  repositoryId: string;
  changeId: string;
  planningGeneration: string;
  invocationId: string;
  recordDigest: string;
  assignmentDigest: string;
  grantRequirementDigest: string;
  exactRolePairs: readonly AgentRolePair[];
}>;

export type ChangeRoleAssignmentGrantPort = Readonly<{
  observe(
    parameters: ChangeRoleAssignmentGrantParametersV1,
  ): ChangeRoleAssignmentGrantObservationV1;
  activate(
    context: AuthorizedTransitionContext<ChangeRoleAssignmentGrantParametersV1>,
  ): ChangeRoleAssignmentGrantObservationV1;
}>;

export const CHANGE_ROLE_ASSIGNMENT_GRANT_PARAMETER_SCHEMA_DIGEST = digest(
  canonicalJson({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation.schema.v1',
    required: [
      'repositoryId',
      'changeId',
      'planningGeneration',
      'invocationId',
      'recordDigest',
      'assignmentDigest',
      'grantRequirementDigest',
      'exactRolePairs',
    ],
  }),
);

export const CHANGE_ROLE_ASSIGNMENT_GRANT_CONSEQUENCE_DIGEST = digest(
  canonicalJson({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation-consequence.v1',
    effect: 'activate-one-exact-below-floor-role-assignment',
    providerAvailabilityBypass: false,
    dataAuthorizationBypass: false,
    staleStateBypass: false,
  }),
);

export function changeRoleAssignmentGrantRequirementDigestV1(
  requirement: ChangeRoleAssignmentGrantRequirementV1,
): string {
  return crypto
    .createHash('sha256')
    .update(
      `workflow.change-role-assignment-grant-requirement.v1\n${canonicalJson(requirement)}`,
    )
    .digest('hex');
}

export function createChangeRoleAssignmentGrantRequest(
  candidate: ChangeRoleAssignmentGrantObservationV1,
  proposedReason: string,
): CentralGrantRequestInputV1 {
  const observation = assertChangeRoleAssignmentGrantObservation(candidate);
  if (observation.activation !== null) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_NOT_APPLICABLE',
      'The exact role assignment already has a durable Central Grant activation.',
      ExitCode.guard,
    );
  }
  const parameters = parametersFromObservation(observation);
  return Object.freeze({
    sourceModuleId: 'agent-runtime-role-assignment',
    failureCode: 'role-independence-grant-required',
    facts: factsFromObservation(observation),
    stateBinding: changeRoleAssignmentGrantStateBinding(observation),
    candidates: Object.freeze([
      Object.freeze({
        transitionId: CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze([
          'approve-exact-role-independence-exception',
        ]),
        reasonRequired: true,
        proposedReason: assertText(proposedReason, 'proposed reason'),
      }),
    ]),
  });
}

export function changeRoleAssignmentGrantTransitionDefinitions(
  port: ChangeRoleAssignmentGrantPort,
): readonly TransitionDefinition<ChangeRoleAssignmentGrantParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID,
      parameterSchemaDigest:
        CHANGE_ROLE_ASSIGNMENT_GRANT_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: CHANGE_ROLE_ASSIGNMENT_GRANT_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      validateParameters: assertChangeRoleAssignmentGrantParameters,
      renderTrustedChoice(parameters: ChangeRoleAssignmentGrantParametersV1) {
        return Object.freeze({
          title: `Authorize the exact current role assignment for ${parameters.changeId}`,
          consequences: Object.freeze([
            `Allow only assignment ${parameters.assignmentDigest} to use the below-floor role pairs ${parameters.exactRolePairs.join(', ')}.`,
            'Do not bypass provider availability, executable identity, data authorization, or current-state checks.',
            'Any assignment or source change requires a fresh Central Grant.',
          ]),
        });
      },
      observeState(parameters: ChangeRoleAssignmentGrantParametersV1) {
        const normalized =
          assertChangeRoleAssignmentGrantParameters(parameters);
        try {
          const observation = assertMatchingObservation(
            port.observe(normalized),
            normalized,
          );
          return changeRoleAssignmentGrantStateBinding(observation);
        } catch (error) {
          const code = roleAssignmentPreconditionCode(error);
          if (code === null) throw error;
          return changeRoleAssignmentGrantUnavailableStateBinding(
            normalized,
            code,
          );
        }
      },
      async execute(
        context: AuthorizedTransitionContext<ChangeRoleAssignmentGrantParametersV1>,
      ) {
        context.assertLifecycleOwned();
        const parameters = assertChangeRoleAssignmentGrantParameters(
          context.parameters,
        );
        let observedBefore: ChangeRoleAssignmentGrantObservationV1;
        try {
          observedBefore = port.observe(parameters);
        } catch (error) {
          throwRoleAssignmentPreconditionIfKnown(error);
        }
        const before = assertMatchingObservation(observedBefore!, parameters);
        if (
          before.activation !== null &&
          !activationMatchesContext(before.activation, context)
        ) {
          throw workflowError(
            'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
            'A different durable role-assignment activation already exists.',
            ExitCode.conflict,
          );
        }
        context.assertLifecycleOwned();
        let activated: ChangeRoleAssignmentGrantObservationV1;
        try {
          activated = port.activate(context);
        } catch (error) {
          throwRoleAssignmentPreconditionIfKnown(error);
        }
        const after = assertMatchingObservation(activated, parameters);
        if (
          after.activation === null ||
          !activationMatchesContext(after.activation, context)
        ) {
          throw workflowError(
            'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_INVALID',
            'The exact role assignment Central Grant activation was not published.',
            ExitCode.verification,
          );
        }
        context.assertLifecycleOwned();
        return Object.freeze({
          outcome: 'completed' as const,
          details: Object.freeze({
            schemaVersion: 1,
            kind: 'change-role-assignment-grant-activated.v1',
            changeId: parameters.changeId,
            recordDigest: parameters.recordDigest,
            assignmentDigest: parameters.assignmentDigest,
            exactRolePairs: parameters.exactRolePairs,
          }),
        });
      },
    }),
  ]);
}

export function changeRoleAssignmentGrantStateBinding(
  candidate: ChangeRoleAssignmentGrantObservationV1,
) {
  const observation = assertChangeRoleAssignmentGrantObservation(candidate);
  return Object.freeze({
    kind: 'change-role-assignment-grant-state.v1',
    digest: digest(canonicalJson(observation)),
  });
}

export function assertChangeRoleAssignmentGrantObservation(
  value: unknown,
): ChangeRoleAssignmentGrantObservationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repositoryId',
      'changeId',
      'planningGeneration',
      'invocationId',
      'recordDigest',
      'assignmentDigest',
      'grantRequirementDigest',
      'exactRolePairs',
      'activation',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'change-role-assignment-grant-observation.v1'
  ) {
    throw grantInvalid();
  }
  const parameters = assertIdentityFields(value);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-observation.v1',
    ...parameters,
    activation: assertActivation(value.activation),
  });
}

export function assertChangeRoleAssignmentGrantParameters(
  value: unknown,
): ChangeRoleAssignmentGrantParametersV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repositoryId',
      'changeId',
      'planningGeneration',
      'invocationId',
      'recordDigest',
      'assignmentDigest',
      'grantRequirementDigest',
      'exactRolePairs',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'change-role-assignment-grant-activation.v1'
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation.v1',
    ...assertIdentityFields(value),
  });
}

function assertIdentityFields(value: Record<string, unknown>) {
  const exactRolePairs = value.exactRolePairs;
  if (
    typeof value.repositoryId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.invocationId !== 'string' ||
    !DIGEST.test(value.planningGeneration as string) ||
    !DIGEST.test(value.recordDigest as string) ||
    !DIGEST.test(value.assignmentDigest as string) ||
    !DIGEST.test(value.grantRequirementDigest as string) ||
    !Array.isArray(exactRolePairs) ||
    exactRolePairs.length < 1 ||
    exactRolePairs.length > ROLE_PAIRS.length ||
    !exactRolePairs.every((pair) => ROLE_PAIRS.includes(pair)) ||
    new Set(exactRolePairs).size !== exactRolePairs.length ||
    canonicalJson(exactRolePairs) !==
      canonicalJson(ROLE_PAIRS.filter((pair) => exactRolePairs.includes(pair)))
  ) {
    throw grantInvalid();
  }
  return {
    repositoryId: assertText(value.repositoryId, 'repository ID'),
    changeId: value.changeId,
    planningGeneration: value.planningGeneration as string,
    invocationId: assertText(value.invocationId, 'invocation ID'),
    recordDigest: value.recordDigest as string,
    assignmentDigest: value.assignmentDigest as string,
    grantRequirementDigest: value.grantRequirementDigest as string,
    exactRolePairs: Object.freeze([...(exactRolePairs as AgentRolePair[])]),
  };
}

function parametersFromObservation(
  observation: ChangeRoleAssignmentGrantObservationV1,
): ChangeRoleAssignmentGrantParametersV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation.v1',
    ...factsFromObservation(observation),
  });
}

function factsFromObservation(
  observation: ChangeRoleAssignmentGrantObservationV1,
) {
  return Object.freeze({
    repositoryId: observation.repositoryId,
    changeId: observation.changeId,
    planningGeneration: observation.planningGeneration,
    invocationId: observation.invocationId,
    recordDigest: observation.recordDigest,
    assignmentDigest: observation.assignmentDigest,
    grantRequirementDigest: observation.grantRequirementDigest,
    exactRolePairs: observation.exactRolePairs,
  });
}

function assertMatchingObservation(
  candidate: ChangeRoleAssignmentGrantObservationV1,
  parameters: ChangeRoleAssignmentGrantParametersV1,
): ChangeRoleAssignmentGrantObservationV1 {
  const observation = assertChangeRoleAssignmentGrantObservation(candidate);
  if (
    canonicalJson(parametersFromObservation(observation)) !==
    canonicalJson(parameters)
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
      'The observed role-assignment activation does not match the immutable invocation bound to this Central Grant.',
      ExitCode.verification,
    );
  }
  return observation;
}

function assertActivation(
  value: unknown,
): ChangeRoleAssignmentGrantActivationV1 | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'challengeId',
      'challengeDigest',
      'operationId',
      'approvalSubjectDigest',
    ]) ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.challengeDigest !== 'string' ||
    !SHA256_DIGEST.test(value.challengeDigest) ||
    typeof value.operationId !== 'string' ||
    !UUID_V4.test(value.operationId) ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !SHA256_DIGEST.test(value.approvalSubjectDigest)
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    challengeId: value.challengeId,
    challengeDigest: value.challengeDigest as `sha256:${string}`,
    operationId: value.operationId,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
  });
}

function activationMatchesContext(
  activation: ChangeRoleAssignmentGrantActivationV1,
  context: AuthorizedTransitionContext<ChangeRoleAssignmentGrantParametersV1>,
): boolean {
  return (
    activation.challengeId === context.challengeId &&
    activation.challengeDigest === context.approvalSubject.challengeDigest &&
    activation.operationId === context.operationId &&
    activation.approvalSubjectDigest === context.approvalSubjectDigest
  );
}

function throwRoleAssignmentPreconditionIfKnown(error: unknown): never {
  if (roleAssignmentPreconditionCode(error) !== null) {
    throw grantTransitionPreconditionChanged(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
      'The exact prepared role-assignment precondition changed before this transition applied an effect.',
    );
  }
  throw error;
}

function roleAssignmentPreconditionCode(error: unknown): string | null {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  if (code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED') {
    return code;
  }
  return null;
}

function changeRoleAssignmentGrantUnavailableStateBinding(
  parameters: ChangeRoleAssignmentGrantParametersV1,
  reasonCode: string,
) {
  return Object.freeze({
    kind: 'change-role-assignment-grant-state.v1',
    digest: digest(
      canonicalJson({
        schemaVersion: 1,
        kind: 'change-role-assignment-grant-unavailable-state.v1',
        parameters,
        reasonCode,
      }),
    ),
  });
}

function assertText(value: string, label: string): string {
  if (
    value.trim() !== value ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_INVALID',
      `Change role-assignment Grant ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function grantInvalid() {
  return workflowError(
    'CHANGE_ROLE_ASSIGNMENT_GRANT_INVALID',
    'Change role-assignment Central Grant facts are invalid.',
    ExitCode.guard,
  );
}
