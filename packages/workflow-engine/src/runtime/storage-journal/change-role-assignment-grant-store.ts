/**
 * Persists role assignment activations and authenticates their completed
 * Central Grants.
 *
 * Invariants:
 * - Activation authority must match the exact assignment, invocation, and
 *   required role pairs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { CentralGrantCompletedAuthorityRefV1 } from '@jigwright/core/central-grant-port';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { approvalSubjectDigest } from '../../modules/authority/grant-core.ts';
import {
  CHANGE_ROLE_ASSIGNMENT_GRANT_CONSEQUENCE_DIGEST,
  CHANGE_ROLE_ASSIGNMENT_GRANT_PARAMETER_SCHEMA_DIGEST,
  CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID,
  assertChangeRoleAssignmentGrantParameters,
  changeRoleAssignmentGrantChallengeFacts,
  changeRoleAssignmentGrantParentBinding,
  changeRoleAssignmentGrantRequirementDigestV1,
  changeRoleAssignmentGrantStateBinding,
  type ChangeRoleAssignmentGrantActivationV1,
  type ChangeRoleAssignmentGrantObservationV1,
  type ChangeRoleAssignmentGrantParametersV1,
} from '../../modules/provider-orchestration/change-role-assignment-grant.ts';
import type { ChangeRoleAssignmentRecordV1 } from '../../modules/provider-orchestration/change-role-assignment-record.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../lifecycle-ledgers/grant-store.ts';
import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import { inspectHistoricalChangeRoleAssignmentRecordV1 } from './change-role-assignment-store.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type StoredChangeRoleAssignmentGrantActivationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-grant-activation-record.v1';
  repositoryId: string;
  changeId: string;
  planningGeneration: string;
  invocationId: string;
  recordDigest: string;
  assignmentDigest: string;
  grantRequirementDigest: string;
  exactRolePairs: ChangeRoleAssignmentGrantParametersV1['exactRolePairs'];
  challengeId: string;
  challengeDigest: `sha256:${string}`;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  activationDigest: string;
}>;

export type CompletedChangeRoleAssignmentGrantAuthorityV1 =
  CentralGrantCompletedAuthorityRefV1 &
    Readonly<{
      transitionId: typeof CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID;
      assignmentRecordDigest: string;
      grantRequirementDigest: string;
    }>;

export function observeChangeRoleAssignmentGrantActivation(
  paths: InvestigationRuntimePaths,
  candidate: ChangeRoleAssignmentGrantParametersV1,
): ChangeRoleAssignmentGrantObservationV1 {
  const parameters = assertChangeRoleAssignmentGrantParameters(candidate);
  const activation = readOptionalActivation(
    paths,
    parameters.recordDigest,
    parameters.invocationId,
  );
  if (activation !== null) {
    assertActivationIdentity(activation, parameters);
    return Object.freeze({
      schemaVersion: 1,
      kind: 'change-role-assignment-grant-observation.v1',
      repositoryId: parameters.repositoryId,
      changeId: parameters.changeId,
      planningGeneration: parameters.planningGeneration,
      invocationId: parameters.invocationId,
      recordDigest: parameters.recordDigest,
      assignmentDigest: parameters.assignmentDigest,
      grantRequirementDigest: parameters.grantRequirementDigest,
      exactRolePairs: parameters.exactRolePairs,
      activation: activationProjection(activation),
    });
  }
  const record = readExactAssignment(paths, parameters);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-observation.v1',
    repositoryId: parameters.repositoryId,
    changeId: parameters.changeId,
    planningGeneration: parameters.planningGeneration,
    invocationId: parameters.invocationId,
    recordDigest: record.recordDigest,
    assignmentDigest: record.assignmentDigest,
    grantRequirementDigest: requirementDigest(record),
    exactRolePairs: record.grantRequirement!.exactRolePairs,
    activation: null,
  });
}

export function activateChangeRoleAssignmentGrant(
  paths: InvestigationRuntimePaths,
  context: Readonly<{
    parameters: ChangeRoleAssignmentGrantParametersV1;
    challengeId: string;
    operationId: string;
    approvalSubject: Readonly<{ challengeDigest: `sha256:${string}` }>;
    approvalSubjectDigest: `sha256:${string}`;
  }>,
): ChangeRoleAssignmentGrantObservationV1 {
  const parameters = assertChangeRoleAssignmentGrantParameters(
    context.parameters,
  );
  readExactAssignment(paths, parameters);
  const body = {
    schemaVersion: 1 as const,
    kind: 'change-role-assignment-grant-activation-record.v1' as const,
    repositoryId: parameters.repositoryId,
    changeId: parameters.changeId,
    planningGeneration: parameters.planningGeneration,
    invocationId: parameters.invocationId,
    recordDigest: parameters.recordDigest,
    assignmentDigest: parameters.assignmentDigest,
    grantRequirementDigest: parameters.grantRequirementDigest,
    exactRolePairs: parameters.exactRolePairs,
    challengeId: context.challengeId,
    challengeDigest: context.approvalSubject.challengeDigest,
    operationId: context.operationId,
    approvalSubjectDigest: context.approvalSubjectDigest,
  };
  const activation = assertStoredActivation({
    ...body,
    activationDigest: sha256(
      `workflow.change-role-assignment-grant-activation-record.v1\n${canonicalJson(body)}`,
    ),
  });
  createPrivateCanonicalJson(
    paths,
    activationPath(paths, parameters.recordDigest, parameters.invocationId),
    activation,
    activationInvalid,
    'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-observation.v1',
    repositoryId: parameters.repositoryId,
    changeId: parameters.changeId,
    planningGeneration: parameters.planningGeneration,
    invocationId: parameters.invocationId,
    recordDigest: parameters.recordDigest,
    assignmentDigest: parameters.assignmentDigest,
    grantRequirementDigest: parameters.grantRequirementDigest,
    exactRolePairs: parameters.exactRolePairs,
    activation: activationProjection(activation),
  });
}

export function readCompletedChangeRoleAssignmentGrantAuthority(
  paths: InvestigationRuntimePaths,
  grantRuntimeRoot: string,
  assignment: ChangeRoleAssignmentRecordV1,
  expectedInvocationId: string,
  expectedRepositoryId: string,
): CompletedChangeRoleAssignmentGrantAuthorityV1 | null {
  if (assignment.grantRequirement === null) return null;
  const activation = readOptionalActivation(
    paths,
    assignment.recordDigest,
    expectedInvocationId,
  );
  if (activation === null) return null;
  if (
    activation.repositoryId !== expectedRepositoryId ||
    activation.changeId !== assignment.changeId ||
    activation.invocationId !== expectedInvocationId ||
    activation.planningGeneration !== assignment.planningGeneration ||
    activation.recordDigest !== assignment.recordDigest ||
    activation.assignmentDigest !== assignment.assignmentDigest ||
    activation.grantRequirementDigest !== requirementDigest(assignment) ||
    canonicalJson(activation.exactRolePairs) !==
      canonicalJson(assignment.grantRequirement.exactRolePairs)
  ) {
    throw activationInvalid();
  }
  const parameters = assertChangeRoleAssignmentGrantParameters({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation.v1',
    repositoryId: activation.repositoryId,
    changeId: activation.changeId,
    planningGeneration: activation.planningGeneration,
    invocationId: activation.invocationId,
    recordDigest: activation.recordDigest,
    assignmentDigest: activation.assignmentDigest,
    grantRequirementDigest: activation.grantRequirementDigest,
    exactRolePairs: activation.exactRolePairs,
  });
  const grant = createFileGrantRecordStore(
    grantStorePaths(grantRuntimeRoot),
  ).readGrantRecord(activation.challengeId);
  const preActivation = Object.freeze({
    ...observeChangeRoleAssignmentGrantActivation(paths, parameters),
    activation: null,
  });
  const postActivation = observeChangeRoleAssignmentGrantActivation(
    paths,
    parameters,
  );
  if (
    grant.state !== 'completed' ||
    grant.outcome.outcome !== 'completed' ||
    canonicalJson(grant.outcome.details) !==
      canonicalJson({
        schemaVersion: 1,
        kind: 'change-role-assignment-grant-activated.v1',
        changeId: assignment.changeId,
        recordDigest: assignment.recordDigest,
        assignmentDigest: assignment.assignmentDigest,
        exactRolePairs: assignment.grantRequirement.exactRolePairs,
      }) ||
    grant.operationId !== activation.operationId ||
    grant.challenge.challengeId !== activation.challengeId ||
    grant.challenge.challengeDigest !== activation.challengeDigest ||
    grant.challenge.sourceModuleId !== 'agent-runtime-role-assignment' ||
    grant.challenge.failureCode !== 'role-independence-grant-required' ||
    canonicalJson(grant.challenge.facts) !==
      canonicalJson(
        changeRoleAssignmentGrantChallengeFacts(
          parameters,
          changeRoleAssignmentGrantParentBinding(grant.challenge.facts),
        ),
      ) ||
    canonicalJson(grant.challenge.stateBinding) !==
      canonicalJson(changeRoleAssignmentGrantStateBinding(preActivation)) ||
    grant.poststateDigest !==
      changeRoleAssignmentGrantStateBinding(postActivation).digest ||
    approvalSubjectDigest(grant.approvalSubject) !==
      activation.approvalSubjectDigest
  ) {
    throw activationInvalid();
  }
  const choice = grant.challenge.choices.find(
    ({ choiceId }) => choiceId === grant.approvalSubject.choiceId,
  );
  if (
    choice === undefined ||
    choice.transitionId !== CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID ||
    choice.parameterSchemaDigest !==
      CHANGE_ROLE_ASSIGNMENT_GRANT_PARAMETER_SCHEMA_DIGEST ||
    choice.consequenceDigest !==
      CHANGE_ROLE_ASSIGNMENT_GRANT_CONSEQUENCE_DIGEST ||
    choice.resolutionKind !== 'non-retry' ||
    canonicalJson(choice.parameters) !== canonicalJson(parameters)
  ) {
    throw activationInvalid();
  }
  return Object.freeze({
    contractVersion: 'central-grant-completed-authority-ref.v1',
    challengeId: grant.challenge.challengeId,
    challengeDigest: grant.challenge.challengeDigest,
    transitionId: CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID,
    operationId: grant.operationId,
    terminalOutcomeDigest: digest(canonicalJson(grant.outcome)),
    assignmentRecordDigest: assignment.recordDigest,
    grantRequirementDigest: activation.grantRequirementDigest,
  });
}

function readExactAssignment(
  paths: InvestigationRuntimePaths,
  parameters: ChangeRoleAssignmentGrantParametersV1,
): ChangeRoleAssignmentRecordV1 {
  const observation = inspectHistoricalChangeRoleAssignmentRecordV1(
    paths,
    parameters.changeId,
    parameters.planningGeneration,
  );
  const record = observation?.record ?? null;
  if (
    record === null ||
    record.grantRequirement === null ||
    record.recordDigest !== parameters.recordDigest ||
    record.assignmentDigest !== parameters.assignmentDigest ||
    requirementDigest(record) !== parameters.grantRequirementDigest ||
    canonicalJson(record.grantRequirement.exactRolePairs) !==
      canonicalJson(parameters.exactRolePairs)
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
      'The immutable below-floor role assignment bound to this provider invocation is unavailable or does not match.',
      ExitCode.verification,
    );
  }
  return record;
}

function requirementDigest(record: ChangeRoleAssignmentRecordV1): string {
  if (record.grantRequirement === null) throw activationInvalid();
  return changeRoleAssignmentGrantRequirementDigestV1(record.grantRequirement);
}

function activationProjection(
  activation: StoredChangeRoleAssignmentGrantActivationV1 | null,
): ChangeRoleAssignmentGrantActivationV1 | null {
  if (activation === null) return null;
  return Object.freeze({
    challengeId: activation.challengeId,
    challengeDigest: activation.challengeDigest,
    operationId: activation.operationId,
    approvalSubjectDigest: activation.approvalSubjectDigest,
  });
}

function readOptionalActivation(
  paths: InvestigationRuntimePaths,
  recordDigest: string,
  invocationId: string,
): StoredChangeRoleAssignmentGrantActivationV1 | null {
  if (!DIGEST.test(recordDigest)) throw activationInvalid();
  const filePath = activationPath(paths, recordDigest, invocationId);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  return assertStoredActivation(
    readPrivateCanonicalJson(paths, filePath, activationInvalid),
  );
}

function assertStoredActivation(
  value: unknown,
): StoredChangeRoleAssignmentGrantActivationV1 {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
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
          'challengeId',
          'challengeDigest',
          'operationId',
          'approvalSubjectDigest',
          'activationDigest',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'change-role-assignment-grant-activation-record.v1' ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.challengeDigest !== 'string' ||
    !SHA256_DIGEST.test(value.challengeDigest) ||
    typeof value.operationId !== 'string' ||
    !UUID_V4.test(value.operationId) ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !SHA256_DIGEST.test(value.approvalSubjectDigest) ||
    typeof value.activationDigest !== 'string' ||
    !DIGEST.test(value.activationDigest)
  ) {
    throw activationInvalid();
  }
  const parameters = assertChangeRoleAssignmentGrantParameters({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation.v1',
    repositoryId: value.repositoryId,
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
    invocationId: value.invocationId,
    recordDigest: value.recordDigest,
    assignmentDigest: value.assignmentDigest,
    grantRequirementDigest: value.grantRequirementDigest,
    exactRolePairs: value.exactRolePairs,
  });
  const body = {
    schemaVersion: 1 as const,
    kind: 'change-role-assignment-grant-activation-record.v1' as const,
    repositoryId: parameters.repositoryId,
    changeId: parameters.changeId,
    planningGeneration: parameters.planningGeneration,
    invocationId: parameters.invocationId,
    recordDigest: parameters.recordDigest,
    assignmentDigest: parameters.assignmentDigest,
    grantRequirementDigest: parameters.grantRequirementDigest,
    exactRolePairs: parameters.exactRolePairs,
    challengeId: value.challengeId,
    challengeDigest: value.challengeDigest,
    operationId: value.operationId,
    approvalSubjectDigest: value.approvalSubjectDigest,
  };
  if (
    value.activationDigest !==
    sha256(
      `workflow.change-role-assignment-grant-activation-record.v1\n${canonicalJson(body)}`,
    )
  ) {
    throw activationInvalid();
  }
  return Object.freeze({
    ...body,
    challengeDigest: value.challengeDigest as `sha256:${string}`,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
    activationDigest: value.activationDigest,
  });
}

function assertActivationIdentity(
  activation: StoredChangeRoleAssignmentGrantActivationV1,
  parameters: ChangeRoleAssignmentGrantParametersV1,
): void {
  if (
    activation.repositoryId !== parameters.repositoryId ||
    activation.changeId !== parameters.changeId ||
    activation.planningGeneration !== parameters.planningGeneration ||
    activation.invocationId !== parameters.invocationId ||
    activation.recordDigest !== parameters.recordDigest ||
    activation.assignmentDigest !== parameters.assignmentDigest ||
    activation.grantRequirementDigest !== parameters.grantRequirementDigest ||
    canonicalJson(activation.exactRolePairs) !==
      canonicalJson(parameters.exactRolePairs)
  ) {
    throw activationInvalid();
  }
}

function activationPath(
  paths: InvestigationRuntimePaths,
  recordDigest: string,
  invocationId: string,
) {
  if (
    !DIGEST.test(recordDigest) ||
    invocationId.length < 1 ||
    Buffer.byteLength(invocationId, 'utf8') > 4_096
  ) {
    throw activationInvalid();
  }
  return path.join(
    paths.root,
    'change-role-assignment-grant-activations',
    'v1',
    recordDigest,
    `${sha256(invocationId)}.json`,
  );
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function activationInvalid() {
  return workflowError(
    'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_INVALID',
    'The durable change role-assignment Central Grant activation is invalid.',
    ExitCode.verification,
  );
}
