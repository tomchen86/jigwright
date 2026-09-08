/** Exact provider participants, assignments, request/result envelopes, and validators for provider contracts. */
import { scheduleOrdinaryRole } from '../src/modules/provider-orchestration/role-scheduler.ts';
import type {
  RoleParticipant,
  RoleAssignment,
  ProviderRoleAssignment,
  GrantedSameProviderRoleAssignment,
} from '../src/modules/provider-orchestration/role-scheduler.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

export const DIGESTS = {
  authorization: '1'.repeat(64),
  baseTree: '2'.repeat(40),
  target: '3'.repeat(64),
  manifest: '4'.repeat(64),
  outputSchema: '5'.repeat(64),
  policy: '6'.repeat(64),
} as const;

export function participant(
  override: Partial<RoleParticipant> = {},
): RoleParticipant {
  return {
    providerId: 'codex',
    sessionId: 'session-a',
    principalId: undefined,
    identityAssurance: 'runtime-hint',
    engineSpawned: true,
    ...override,
  };
}

export function surveyAssignment(): RoleAssignment {
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author: participant({
      providerId: 'codex',
      sessionId: 'author-session',
    }),
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'claude',
        sessionId: 'survey-session',
        enabled: true,
        available: true,
      },
    ],
  });
  if (scheduled.outcome !== 'assigned') {
    throw new Error('fixture role assignment was not scheduled');
  }
  return scheduled.assignment;
}

export function requestInput(assignment: ProviderRoleAssignment) {
  return {
    invocationId: 'invocation-1',
    nonce: 'nonce-with-at-least-16-bytes',
    purpose: 'survey' as const,
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: 'expense-app@canonical-origin',
    baseCommit: 'a'.repeat(40),
    baseTree: DIGESTS.baseTree,
    targetDigest: DIGESTS.target,
    inputManifestDigest: DIGESTS.manifest,
    authorizationNodeId: DIGESTS.authorization,
    writeAllowedPaths: [] as string[],
    outputSchema: {
      id: 'expense-app.workflow.survey-output',
      version: 1,
      digest: DIGESTS.outputSchema,
    },
    evaluatorVersion: 'survey-evaluator.v1',
    policyDigest: DIGESTS.policy,
    limits: {
      timeoutMs: 3_600_000,
      aggregateOutputBytes: 1_048_576,
    },
  };
}

export function grantedSameProviderAssignment(): GrantedSameProviderRoleAssignment {
  return {
    role: 'plan-reviewer',
    providerId: 'codex',
    sessionId: 'fresh-session',
    targetDigest: DIGESTS.target,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'session-independent',
    providerIndependent: false,
    sessionIndependent: true,
    engineSpawned: true,
    orchestration: 'engine-spawned-provider',
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    degradedForm: 'same-provider-fresh-session',
    authorizedEffect: 'role-independence-degradation-only',
    author: {
      providerId: 'codex',
      sessionId: 'author-session',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    participant: {
      providerId: 'codex',
      sessionId: 'fresh-session',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: true,
    },
    callableProviderIds: ['codex'],
    directHumanReviewAttestationDigest: null,
  };
}

export function roleContent() {
  return {
    kind: 'blind-survey' as const,
    nodeId: '9'.repeat(64),
    resultDigest: 'a'.repeat(64),
    outputSchema: {
      id: 'blind-survey-output.v1',
      version: 1,
      digest: DIGESTS.outputSchema,
    },
    evaluator: 'blind-survey-evaluator.v1',
    policyDigest: DIGESTS.policy,
    contentDigest: 'a'.repeat(64),
    current: true as const,
  };
}

export function providerResult(
  request: ProviderInvocationRequest,
  output: unknown,
) {
  return {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
}

export function processOutcome(
  result: unknown,
  override: Partial<ProviderProcessOutcome> = {},
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(result),
    stderr: '',
    ...override,
  };
}

export function outputValidator(request: ProviderInvocationRequest) {
  return {
    id: request.outputSchema.id,
    version: request.outputSchema.version,
    digest: request.outputSchema.digest,
    validate: () => true,
  };
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
