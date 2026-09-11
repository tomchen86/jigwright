import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
/**
 * Admits blind-survey role evidence with its exact provider assignment and durable grant use.
 *
 * Invariants:
 * - Admission binds author, reviewer, provider output, and content to the same assignment.
 * - Read-only replay verifies an already-consumed grant without mutating its state.
 * - Mutating admission consumes the exact grant before publishing an admitted role result.
 */

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessResult,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import { type RecordedRoleParticipant } from '../../modules/provider-orchestration/role-assignment.ts';
import {
  loadMaintainerPolicyAtCommit,
  resolveAuthoritativeCollaborationGrantVerifier,
} from './propose-context.ts';
import type { readProposeAuthorization } from './propose-request-validation.ts';
import type { CollaborationGrantUseProjection } from '../../modules/authority/collaboration-grant-records.ts';
import type { EvidenceNode, ProposeRuntime } from './propose-runtime.ts';
import type {
  CollaborationGrantAccessMode,
  ProposeResumeOptions,
} from './propose-types.ts';

export function createBlindSurveyRoleResult(
  services: Pick<
    ProposeRuntime,
    'grants' | 'provider' | 'workspace' | 'roleAdmission'
  >,
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  authorization: ReturnType<typeof readProposeAuthorization>,
  request: ProviderInvocationRequest,
  result: ProviderProcessResult,
  providerResultNode: EvidenceNode,
  grantAccess: CollaborationGrantAccessMode,
  validation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
): AdmittedRoleResult {
  const grantAuthorization = authorization.grantAuthorization;
  const content = {
    kind: 'blind-survey' as const,
    nodeId: providerResultNode.nodeId,
    resultDigest: providerResultNode.resultDigest,
    outputSchema: services.provider.BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluator: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    contentDigest: providerResultNode.resultDigest,
    current: true as const,
  };
  const author: RecordedRoleParticipant = {
    providerId: authorization.actor.providerId,
    sessionId: `author-${authorization.actor.providerId}`,
    principalId: null,
    identityAssurance: authorization.actor.assurance,
    engineSpawned: false,
  };
  const participant: RecordedRoleParticipant =
    'grantId' in request.roleAssignment
      ? request.roleAssignment.participant
      : {
          providerId: request.roleAssignment.providerId,
          sessionId: request.roleAssignment.sessionId,
          principalId: null,
          identityAssurance: 'adapter-assigned',
          engineSpawned: true,
        };
  const providerInvocation = {
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: result.outputDigest,
    providerId: request.roleAssignment.providerId,
    sessionId: request.roleAssignment.sessionId,
    targetDigest: request.roleAssignment.targetDigest,
    engineSpawned: true as const,
  };
  let grantUse: CollaborationGrantUseProjection | null = null;
  let grantAdmission: NonNullable<
    Parameters<RoleAdmissionServices['admitRoleResult']>[0]['grantValidation']
  > | null = null;
  if ('grantId' in request.roleAssignment) {
    if (
      grantAuthorization === null ||
      'kind' in grantAuthorization ||
      grantAuthorization.grantId !== request.roleAssignment.grantId
    ) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        'A granted blind survey requires its exact durable grant authorization.',
        ExitCode.guard,
      );
    }
    const exactConsumption = {
      transitionDigest: grantAuthorization.transitionDigest,
      assignment: request.roleAssignment,
      contentAdmission: {
        kind: content.kind,
        nodeId: content.nodeId,
        resultDigest: content.resultDigest,
        current: true as const,
      },
    };
    if (grantAccess === 'replay-consumed') {
      const use = services.grants.readExactConsumedCollaborationGrantUse(
        context.git.gitCommonDirectory,
        grantAuthorization.grantId,
        exactConsumption,
      );
      if (!use) {
        throw workflowError(
          'COLLABORATION_GRANT_ADMISSION_REQUIRED',
          'Status cannot admit a reserved collaboration grant; retry the exact mutating propose input.',
          ExitCode.staleState,
        );
      }
      const replayPort = validation?.consumedRoleResultReplay;
      if (replayPort === undefined) {
        throw workflowError(
          'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
          'The terminal-only Collaboration Grant replay verifier is unavailable.',
          ExitCode.guard,
        );
      }
      const replay = replayPort.verify({
        repositoryRoot: context.git.repositoryRoot,
        expectedBinding: grantAuthorization.expectedBinding,
        grantUse: use,
        assignment: request.roleAssignment,
        content,
        directHumanReviewAttestation: null,
      });
      return services.roleAdmission.admitConsumedRoleResultReplay({
        assignment: request.roleAssignment,
        author,
        participant,
        content,
        providerInvocation,
        replay,
      });
    }

    const policy = loadMaintainerPolicyAtCommit(
      services,
      context.git.repositoryRoot,
      grantAuthorization.expectedBinding.baselineCommit,
    );
    const verifier = resolveAuthoritativeCollaborationGrantVerifier(
      validation?.verifier,
    );
    const now = validation?.now ?? new Date();
    const consumption = { ...exactConsumption, now, verifier };
    const use = (
      assertOwned === undefined
        ? services.grants.consumeCollaborationGrant(
            context.git.gitCommonDirectory,
            grantAuthorization.grantId,
            consumption,
          )
        : services.grants.consumeCollaborationGrantUnderLifecycleLock(
            context.git.gitCommonDirectory,
            grantAuthorization.grantId,
            consumption,
            assertOwned,
          )
    ).use;
    if (!use) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        'The exact collaboration grant use was not durably consumed.',
        ExitCode.staleState,
      );
    }
    grantUse = use;
    grantAdmission = {
      now,
      expectedBinding: grantAuthorization.expectedBinding,
      policy,
      verifier,
      transitionDigest: grantAuthorization.transitionDigest,
    };
  } else if (grantAuthorization !== null) {
    throw workflowError(
      'PROPOSE_AUTHORIZATION_INVALID',
      'Ordinary survey authorization cannot carry a collaboration grant.',
      ExitCode.staleState,
    );
  }
  return services.roleAdmission.admitRoleResult({
    assignment: request.roleAssignment,
    author,
    participant,
    content,
    providerInvocation,
    grantUse,
    grantValidation: grantAdmission,
  });
}
