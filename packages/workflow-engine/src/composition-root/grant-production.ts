import type { CentralGrantRequestPortV1 } from '@jigwright/core/central-grant-port';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  createGrantCoordinatorKernel,
  type GrantApprovalSession,
  type GrantCoordinator,
} from '../modules/authority/grant-coordinator.ts';
import { collectSshApprovalProof } from '../adapters/signing/ssh/grant-proof-ssh.ts';
import {
  createInvestigationV3PublicationGrantRequest,
  createInvestigationV3GrantRequest,
  investigationV3GrantTransitionDefinitions,
} from '../modules/investigation/seal/investigation-v3-grant.ts';
import {
  createWorkRegistryPromotionGrantRequest,
  createWorkRegistryReviewGrantRequest,
  workRegistryGrantTransitionDefinitions,
} from '../modules/governance-intake/work-registry-grant.ts';
import {
  workRegistryTransitionRequiresGrant,
  type WorkItemReviewV1,
} from '../modules/governance-intake/work-registry.ts';
import {
  archivePullRequestGrantTransitionDefinitions,
  createArchivePullRequestGrantRequest,
} from '../modules/authority/archive-pr-grant.ts';
export type { WorkItemReviewV1 } from '../modules/governance-intake/work-registry.ts';
import type { InvestigationManifestPublicationFailure } from '../runtime/managed-documents/transaction/investigation-publication.ts';
import { readCurrentInvestigationV3FailureObservation } from '../runtime/storage-journal/investigation-v3-failure-store.ts';
import {
  parseGrantPolicyV2Document,
  type GrantPolicyV2,
} from '../modules/authority/grant-policy.ts';
import {
  grantStorePaths,
  grantRecordDigest,
  readGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
import { approvalSubjectDigest } from '../modules/authority/grant-core.ts';
import { grantSha256 } from '../modules/authority/grant-primitives.ts';
import {
  assertGrantParentBindingV1,
  createGrantParentBindingV1,
  type GrantParentBindingV1,
} from '../modules/authority/grant-parent-binding.ts';
import type { TransitionRegistry } from '../modules/authority/grant-transition-registry.ts';
import { createTransitionRegistry } from '../modules/authority/grant-transition-registry.ts';
import { systemDocumentGrantTransitionDefinitions } from '../application/finalize/system-document-grant.ts';
import {
  inspectMacOsHumanGateRuntime,
  openMacOsHumanGateApprovalSession,
} from '../adapters/human/macos/human-gate-macos.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { assertChangeId } from '../runtime/session-workspace/paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
  type RepositoryLifecycleOperationOptions,
} from '../runtime/session-workspace/session-store.ts';
import { assertOptionalGrantsPackageAvailable } from './optional-grants-package-production.ts';
import {
  changeRoutingGrantTransitionDefinitions,
  createChangeRoutingContinuationGrantRequest,
} from '../modules/lifecycle/change-routing-grant.ts';
import {
  createProtectedBaseInitializationGrantRequest,
  protectedBaseInitializationGrantTransitionDefinitions,
} from '../modules/authority/protected-base-initialization-grant.ts';
import { createProductionProtectedBaseInitializationPort } from './protected-base-initialization-production.ts';
import {
  createProductionChangeRoleAssignmentGrantPort,
  observeCurrentChangeRoleAssignmentGrantForInvocation,
} from './change-role-assignment-grant-production.ts';
import {
  changeRoleAssignmentGrantTransitionDefinitions,
  assertChangeRoleAssignmentGrantParameters,
  CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID,
  changeRoleAssignmentGrantParentBinding,
  createChangeRoleAssignmentGrantRequest,
} from '../modules/provider-orchestration/change-role-assignment-grant.ts';
import { resolveArchivePullRequestPublicationTarget } from './archive-pr-publication-production.ts';
import {
  createProductionProtectedTaskApplyGrantPort,
  observeCurrentProtectedTaskApply,
} from './protected-task-apply-grant-production.ts';
import {
  createProtectedTaskApplyGrantRequest,
  protectedTaskApplyGrantTransitionDefinitions,
  PROTECTED_TASK_APPLY_TRANSITION_ID,
  type ProtectedTaskApplyFailureDetailsV1,
} from '../modules/authority/protected-task-apply-grant.ts';
import { deriveProtectedTaskApplyTaskDiffProviderGrantContinuation } from '../application/finalize/task-diff-review-lifecycle.ts';
import {
  createProtectedTaskApplyRecoveryGrantRequest,
  protectedTaskApplyRecoveryGrantTransitionDefinitions,
  type ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
} from '../modules/authority/protected-task-apply-recovery-grant.ts';
import {
  createProductionProtectedTaskApplyRecoveryGrantPort,
  observeCurrentProtectedTaskApplyRecoveryRequest,
  protectedTaskApplyRecoveryParentContinuation,
  protectedTaskApplyRecoveryParentReference,
} from './protected-task-apply-recovery-grant-production.ts';
import {
  createProductionProtectedTaskApplyDescendantSettlementGrantPort,
  observeCurrentProtectedTaskApplyDescendantSettlementRequest,
  protectedTaskApplyDescendantSettlementContinuation,
} from './protected-task-apply-descendant-settlement-grant-production.ts';
import {
  createProtectedTaskApplyDescendantSettlementGrantRequest,
  protectedTaskApplyDescendantSettlementTransitionDefinitions,
  type ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
} from '../modules/authority/protected-task-apply-descendant-settlement-grant.ts';
import {
  createProviderInvocationCancellationGrantRequest,
  providerInvocationCancellationTransitionDefinitions,
} from '../modules/authority/provider-invocation-cancellation-grant.ts';
import {
  createProductionProviderInvocationCancellationGrantPort,
  observeCurrentProviderInvocationCancellationRequest,
} from './provider-invocation-cancellation-grant-production.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  gitAuthorityCandidateApplyGrantTransitionDefinitions,
  type GitAuthorityCandidateApplyParametersV1,
} from '../modules/authority/git-authority-candidate-apply-grant.ts';
import {
  createProductionGitAuthorityCandidateApplyPort,
  readProductionGitBaseAuthorityContext,
  readProductionGitAuthorityCandidateBaseGrantPolicyDocument,
} from './git-authority-candidate-apply-production.ts';

const TASK_DIFF_ROLE_ASSIGNMENT_PARENT_RELATION =
  'task.protected-apply.task-diff-role-assignment.v1' as const;

/**
 * Production composition root. Unlike the testable kernel, this surface does
 * not accept an approval provider, helper path, policy value, or lifecycle
 * implementation from its caller.
 */
export function createProductionGrantCoordinator(
  cwd: string,
  registry: TransitionRegistry,
): GrantCoordinator {
  const git = discoverRepository(cwd);
  return createProductionGrantCoordinatorWithAuthorityContext(
    git.repositoryRoot,
    registry,
    productionGrantAuthorityAtCommit(git.repositoryRoot, git.head),
    true,
  );
}

function createProductionGrantCoordinatorWithAuthorityContext(
  cwd: string,
  registry: TransitionRegistry,
  exactAuthorityContext: Readonly<{
    runtimeDirectory: string;
    policy: GrantPolicyV2;
  }>,
  preserveParentContinuations: boolean,
): GrantCoordinator {
  const git = discoverRepository(cwd);
  const runtimeDirectory = exactAuthorityContext.runtimeDirectory;
  const runtime = runtimePaths(git.gitCommonDirectory, runtimeDirectory);
  ensurePlainDirectory(runtime.root);
  const paths = grantStorePaths(runtime.root);
  const policy = exactAuthorityContext.policy;

  return createGrantCoordinatorKernel({
    paths,
    registry,
    policy,
    openApprovalSession(presentation) {
      inspectMacOsHumanGateRuntime(git.repositoryRoot);
      return productionApprovalSession(
        openMacOsHumanGateApprovalSession(git.repositoryRoot, presentation),
        policy,
        git.repositoryRoot,
      );
    },
    async withLifecycleOperation(challengeId, operation) {
      if (!preserveParentContinuations) {
        return withRepositoryLifecycleOperationAsync(runtime, operation, {
          allowGrantChallengeIds: [challengeId],
        });
      }
      return withProductionGrantLifecycleOperation(
        git.repositoryRoot,
        challengeId,
        operation,
        runtimeDirectory,
      );
    },
  });
}

export async function withProductionGrantLifecycleOperation<T>(
  cwd: string,
  challengeId: string,
  operation: (assertOwned: () => void) => Promise<T>,
  exactRuntimeDirectory?: string,
): Promise<T> {
  const git = discoverRepository(cwd);
  const runtimeDirectory =
    exactRuntimeDirectory ??
    productionGrantAuthorityAtCommit(git.repositoryRoot, git.head)
      .runtimeDirectory;
  const runtime = runtimePaths(git.gitCommonDirectory, runtimeDirectory);
  const paths = grantStorePaths(runtime.root);
  const stored = readGrantRecord(paths, challengeId);
  const taskDiffContinuation = taskDiffRoleAssignmentGrantContinuation(
    git.repositoryRoot,
    stored.challenge,
    runtimeDirectory,
  );
  const recoveryContinuation = protectedTaskApplyRecoveryParentContinuation(
    git.repositoryRoot,
    stored.challenge,
  );
  const settlementContinuation =
    protectedTaskApplyDescendantSettlementContinuation(stored.challenge);
  if (
    [taskDiffContinuation, recoveryContinuation, settlementContinuation].filter(
      (value) => value !== null,
    ).length > 1
  ) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'One Grant challenge cannot claim two parent continuations.',
      ExitCode.guard,
    );
  }
  const continuation =
    taskDiffContinuation ?? recoveryContinuation ?? settlementContinuation;
  const continuationChallengeIds =
    settlementContinuation !== null
      ? [
          settlementContinuation.parentChallengeId,
          ...settlementContinuation.descendantChallengeIds,
        ]
      : continuation === null
        ? []
        : [continuation.parentChallengeId];
  const allowGrantChallengeIds = [challengeId, ...continuationChallengeIds];
  return withRepositoryLifecycleOperationAsync(
    runtime,
    async (assertLifecycleOwned) => {
      const assertExactContinuationOwned = () => {
        assertLifecycleOwned();
        const current = readGrantRecord(paths, challengeId);
        if (
          current.challenge.challengeDigest !==
            stored.challenge.challengeDigest ||
          canonicalJson(
            taskDiffRoleAssignmentGrantContinuation(
              git.repositoryRoot,
              current.challenge,
              runtimeDirectory,
            ) ??
              protectedTaskApplyRecoveryParentContinuation(
                git.repositoryRoot,
                current.challenge,
              ) ??
              protectedTaskApplyDescendantSettlementContinuation(
                current.challenge,
              ),
          ) !== canonicalJson(continuation)
        ) {
          throw workflowError(
            'GRANT_CONTINUATION_INVALID',
            'The exact TaskDiffReview parent-child Grant continuation changed.',
            ExitCode.staleState,
          );
        }
      };
      assertExactContinuationOwned();
      return operation(assertExactContinuationOwned);
    },
    {
      allowGrantChallengeIds,
      ...humanResolutionLifecycleBinding(stored.challenge),
    },
  );
}

function taskDiffRoleAssignmentGrantContinuation(
  repositoryRoot: string,
  challenge: ReturnType<typeof readGrantRecord>['challenge'],
  exactRuntimeDirectory: string,
) {
  if (
    challenge.sourceModuleId !== 'agent-runtime-role-assignment' ||
    challenge.failureCode !== 'role-independence-grant-required'
  ) {
    return null;
  }
  if (
    !isRecord(challenge.facts) ||
    typeof challenge.facts.invocationId !== 'string' ||
    typeof challenge.facts.changeId !== 'string' ||
    challenge.choices.length !== 1 ||
    challenge.choices[0]!.transitionId !==
      CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID
  ) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'Role-assignment Grant continuation facts are malformed.',
      ExitCode.guard,
    );
  }
  const parameters = assertChangeRoleAssignmentGrantParameters(
    challenge.choices[0]!.parameters,
  );
  if (
    parameters.repositoryId !== challenge.facts.repositoryId ||
    parameters.invocationId !== challenge.facts.invocationId ||
    parameters.changeId !== challenge.facts.changeId ||
    parameters.planningGeneration !== challenge.facts.planningGeneration ||
    parameters.recordDigest !== challenge.facts.recordDigest ||
    parameters.assignmentDigest !== challenge.facts.assignmentDigest ||
    parameters.grantRequirementDigest !==
      challenge.facts.grantRequirementDigest ||
    canonicalJson(parameters.exactRolePairs) !==
      canonicalJson(challenge.facts.exactRolePairs)
  ) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'Role-assignment Grant continuation does not match its exact invocation.',
      ExitCode.guard,
    );
  }
  const continuation =
    deriveProtectedTaskApplyTaskDiffProviderGrantContinuation(
      repositoryRoot,
      parameters.invocationId,
    );
  const parentBinding = changeRoleAssignmentGrantParentBinding(challenge.facts);
  if (continuation === null && parentBinding === null) return null;
  if (continuation === null || parentBinding === null) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'Protected TaskDiffReview role-assignment Grant lineage is incomplete.',
      ExitCode.guard,
    );
  }
  if (
    continuation.repositoryId !== parameters.repositoryId ||
    continuation.changeId !== parameters.changeId
  ) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'Role-assignment Grant continuation does not match its TaskDiffReview owner.',
      ExitCode.guard,
    );
  }
  assertTaskDiffRoleAssignmentParentBinding(
    repositoryRoot,
    continuation,
    parentBinding,
    exactRuntimeDirectory,
  );
  return continuation;
}

function createTaskDiffRoleAssignmentParentBinding(
  repositoryRoot: string,
  continuation: NonNullable<
    ReturnType<typeof deriveProtectedTaskApplyTaskDiffProviderGrantContinuation>
  >,
  exactRuntimeDirectory: string,
): GrantParentBindingV1 {
  const parent = readRepositoryGrantRecord(
    repositoryRoot,
    continuation.parentChallengeId,
    exactRuntimeDirectory,
  );
  const choice = parent.challenge.choices[0];
  if (
    parent.state !== 'prepared' ||
    parent.challenge.choices.length !== 1 ||
    choice?.transitionId !== PROTECTED_TASK_APPLY_TRANSITION_ID
  ) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'Protected TaskDiffReview role-assignment parent is not one exact prepared Apply Grant.',
      ExitCode.staleState,
    );
  }
  return createGrantParentBindingV1({
    schemaVersion: 1,
    kind: 'grant-parent-binding.v1',
    relationKind: TASK_DIFF_ROLE_ASSIGNMENT_PARENT_RELATION,
    parentChallengeId: parent.challenge.challengeId,
    parentChallengeDigest: parent.challenge.challengeDigest,
    parentOperationId: parent.operationId,
    parentApprovalSubjectDigest: approvalSubjectDigest(parent.approvalSubject),
    parentStateBindingDigest: parent.challenge.stateBinding.digest,
    parentParametersDigest: grantSha256(canonicalJson(choice.parameters)),
    parentPreparedRecordDigest: grantRecordDigest(parent),
    relationshipFactsDigest:
      taskDiffRoleAssignmentRelationshipFactsDigest(continuation),
  });
}

function assertTaskDiffRoleAssignmentParentBinding(
  repositoryRoot: string,
  continuation: NonNullable<
    ReturnType<typeof deriveProtectedTaskApplyTaskDiffProviderGrantContinuation>
  >,
  candidate: GrantParentBindingV1,
  exactRuntimeDirectory: string,
): void {
  const binding = assertGrantParentBindingV1(candidate);
  const expected = createTaskDiffRoleAssignmentParentBinding(
    repositoryRoot,
    continuation,
    exactRuntimeDirectory,
  );
  if (canonicalJson(binding) !== canonicalJson(expected)) {
    throw workflowError(
      'GRANT_CONTINUATION_INVALID',
      'Protected TaskDiffReview role-assignment parent binding changed.',
      ExitCode.staleState,
    );
  }
}

function taskDiffRoleAssignmentRelationshipFactsDigest(
  continuation: NonNullable<
    ReturnType<typeof deriveProtectedTaskApplyTaskDiffProviderGrantContinuation>
  >,
): `sha256:${string}` {
  return grantSha256(
    `workflow.task-diff-role-assignment-parent.v1\n${canonicalJson({
      invocationId: continuation.invocationId,
      repositoryId: continuation.repositoryId,
      changeId: continuation.changeId,
      sessionId: continuation.sessionId,
      parentChallengeId: continuation.parentChallengeId,
      subjectDigest: continuation.subjectDigest,
    })}`,
  );
}

function readRepositoryGrantRecord(
  repositoryRoot: string,
  challengeId: string,
  exactRuntimeDirectory: string,
) {
  const git = discoverRepository(repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, exactRuntimeDirectory);
  return readGrantRecord(grantStorePaths(runtime.root), challengeId);
}

function productionApprovalSession(
  humanGate: GrantApprovalSession,
  policy: GrantPolicyV2,
  repositoryRoot: string,
): GrantApprovalSession {
  return Object.freeze({
    collectDecision: () => humanGate.collectDecision(),
    async authenticate(request) {
      if (request.approvalSubject.approvalMethod === 'ssh') {
        return [collectSshApprovalProof(policy, request, { repositoryRoot })];
      }
      return humanGate.authenticate(request);
    },
    close: () => humanGate.close(),
  });
}

export function createProductionWorkflowGrantCoordinator(
  cwd: string,
): GrantCoordinator {
  const git = discoverRepository(cwd);
  const authority = productionGrantAuthorityAtCommit(
    git.repositoryRoot,
    git.head,
  );
  const runtimeRoot = runtimePaths(
    git.gitCommonDirectory,
    authority.runtimeDirectory,
  ).root;
  const protectedBase = createProductionProtectedBaseInitializationPort(cwd);
  const roleAssignment = createProductionChangeRoleAssignmentGrantPort(cwd);
  const protectedTaskApply = createProductionProtectedTaskApplyGrantPort(cwd);
  const protectedTaskApplyRecovery =
    createProductionProtectedTaskApplyRecoveryGrantPort(cwd);
  const protectedTaskApplyDescendantSettlement =
    createProductionProtectedTaskApplyDescendantSettlementGrantPort(cwd);
  const providerInvocationCancellation =
    createProductionProviderInvocationCancellationGrantPort(cwd);
  const coordinator = createProductionGrantCoordinatorWithAuthorityContext(
    cwd,
    createTransitionRegistry([
      ...investigationV3GrantTransitionDefinitions(cwd),
      ...workRegistryGrantTransitionDefinitions(cwd),
      ...systemDocumentGrantTransitionDefinitions(cwd),
      ...archivePullRequestGrantTransitionDefinitions(runtimeRoot),
      ...changeRoutingGrantTransitionDefinitions(cwd),
      ...protectedBaseInitializationGrantTransitionDefinitions(protectedBase),
      ...changeRoleAssignmentGrantTransitionDefinitions(roleAssignment),
      ...protectedTaskApplyGrantTransitionDefinitions(protectedTaskApply),
      ...protectedTaskApplyRecoveryGrantTransitionDefinitions(
        protectedTaskApplyRecovery,
      ),
      ...protectedTaskApplyDescendantSettlementTransitionDefinitions(
        protectedTaskApplyDescendantSettlement,
      ),
      ...providerInvocationCancellationTransitionDefinitions(
        providerInvocationCancellation,
      ),
    ]),
    authority,
    true,
  );
  return coordinateProtectedTaskApplyRecoveryParent(
    cwd,
    coordinator,
    authority.runtimeDirectory,
  );
}

export function createProductionGitAuthorityCandidateApplyGrantCoordinator(
  cwd: string,
  parametersValue: GitAuthorityCandidateApplyParametersV1,
): GrantCoordinator {
  const parameters =
    assertGitAuthorityCandidateApplyParameters(parametersValue);
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const policy = parseGrantPolicyV2Document(
    readProductionGitAuthorityCandidateBaseGrantPolicyDocument(
      repositoryRoot,
      parameters,
    ),
  ).policy;
  const port = createProductionGitAuthorityCandidateApplyPort(repositoryRoot);
  return createProductionGrantCoordinatorWithAuthorityContext(
    repositoryRoot,
    createTransitionRegistry(
      gitAuthorityCandidateApplyGrantTransitionDefinitions(port),
    ),
    {
      runtimeDirectory:
        parameters.baseAuthorityContext.workflowConfig.runtimeDirectory,
      policy,
    },
    false,
  );
}

function productionGrantAuthorityAtCommit(
  cwd: string,
  commit: string,
): Readonly<{ runtimeDirectory: string; policy: GrantPolicyV2 }> {
  const loaded = readProductionGitBaseAuthorityContext(cwd, commit);
  return Object.freeze({
    runtimeDirectory: loaded.context.workflowConfig.runtimeDirectory,
    policy: parseGrantPolicyV2Document(loaded.grantPolicyDocument).policy,
  });
}

export function coordinateProtectedTaskApplyRecoveryParent(
  cwd: string,
  coordinator: GrantCoordinator,
  exactRuntimeDirectory?: string,
): GrantCoordinator {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const complete = async (
    challengeId: string,
    operation: () => ReturnType<GrantCoordinator['resolveChallenge']>,
  ) => {
    const git = discoverRepository(repositoryRoot);
    const runtimeDirectory =
      exactRuntimeDirectory ??
      productionGrantAuthorityAtCommit(git.repositoryRoot, git.head)
        .runtimeDirectory;
    const runtime = runtimePaths(git.gitCommonDirectory, runtimeDirectory);
    const paths = grantStorePaths(runtime.root);
    const before = readGrantRecord(paths, challengeId);
    const reference = protectedTaskApplyRecoveryParentReference(
      before.challenge,
    );
    const result = await operation();
    if (reference === null || result.outcome !== 'completed') return result;
    let parent = readGrantRecord(paths, reference.parentChallengeId);
    if (parent.state === 'prepared') {
      const parentResult = await coordinator.recoverChallenge(
        reference.parentChallengeId,
      );
      if (parentResult.outcome !== 'failed') {
        throw workflowError(
          'PROTECTED_TASK_APPLY_RECOVERY_RESULT_INVALID',
          'Protected Apply parent did not record the exact cancellation failure.',
          ExitCode.verification,
        );
      }
      parent = readGrantRecord(paths, reference.parentChallengeId);
    }
    if (
      parent.state !== 'failed' ||
      !isRecord(parent.outcome.details) ||
      parent.outcome.details.kind !== 'protected-task-apply-cancelled.v1'
    ) {
      throw workflowError(
        'PROTECTED_TASK_APPLY_RECOVERY_RESULT_INVALID',
        'Protected Apply parent recovery is not the exact truthful cancellation outcome.',
        ExitCode.verification,
      );
    }
    return result;
  };
  return Object.freeze({
    contractVersion: coordinator.contractVersion,
    challengeContractVersion: coordinator.challengeContractVersion,
    requestGrant: (input) => coordinator.requestGrant(input),
    inspectChallenge: (challengeId) =>
      coordinator.inspectChallenge(challengeId),
    resolveChallenge: (challengeId) =>
      complete(challengeId, () => coordinator.resolveChallenge(challengeId)),
    recoverChallenge: (challengeId) =>
      complete(challengeId, () => coordinator.recoverChallenge(challengeId)),
  });
}

export async function requestProtectedTaskApplyGrant(
  cwd: string,
  sessionId: string,
  commitMessage: string,
  fullGate: boolean,
  failure: ProtectedTaskApplyFailureDetailsV1,
  proposedReason: string,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observation = observeCurrentProtectedTaskApply(
    repositoryRoot,
    sessionId,
    commitMessage,
    fullGate,
  );
  return createProductionCentralGrantRequestPort(repositoryRoot).requestGrant(
    createProtectedTaskApplyGrantRequest(observation, failure, proposedReason),
  );
}

export async function requestProtectedTaskApplyRecoveryGrant(
  cwd: string,
  details: ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
  proposedReason: string,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observation = observeCurrentProtectedTaskApplyRecoveryRequest(
    repositoryRoot,
    details,
  );
  return createProductionCentralGrantRequestPort(repositoryRoot).requestGrant(
    createProtectedTaskApplyRecoveryGrantRequest(observation, proposedReason),
  );
}

export async function requestProtectedTaskApplyDescendantSettlementGrant(
  cwd: string,
  details: ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
  proposedReason: string,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observation =
    observeCurrentProtectedTaskApplyDescendantSettlementRequest(
      repositoryRoot,
      details,
    );
  return createProductionCentralGrantRequestPort(repositoryRoot).requestGrant(
    createProtectedTaskApplyDescendantSettlementGrantRequest(
      observation,
      proposedReason,
    ),
  );
}

export async function requestProviderInvocationCancellationGrant(
  cwd: string,
  invocationId: string,
  reason: string,
  proposedReason: string,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observation = observeCurrentProviderInvocationCancellationRequest(
    repositoryRoot,
    invocationId,
    reason,
  );
  return createProductionCentralGrantRequestPort(repositoryRoot).requestGrant(
    createProviderInvocationCancellationGrantRequest(
      observation,
      proposedReason,
    ),
  );
}

export async function requestChangeRoleAssignmentGrant(
  cwd: string,
  invocationId: string,
  proposedReason: string,
) {
  const git = discoverRepository(cwd);
  const repositoryRoot = git.repositoryRoot;
  const runtimeDirectory = productionGrantAuthorityAtCommit(
    repositoryRoot,
    git.head,
  ).runtimeDirectory;
  const runtime = runtimePaths(git.gitCommonDirectory, runtimeDirectory);
  const initialContinuation =
    deriveProtectedTaskApplyTaskDiffProviderGrantContinuation(
      repositoryRoot,
      invocationId,
    );
  return withRepositoryLifecycleOperationAsync(
    runtime,
    async (assertOwned) => {
      assertOwned();
      const continuation =
        deriveProtectedTaskApplyTaskDiffProviderGrantContinuation(
          repositoryRoot,
          invocationId,
        );
      if (canonicalJson(continuation) !== canonicalJson(initialContinuation)) {
        throw workflowError(
          'GRANT_CONTINUATION_INVALID',
          'TaskDiffReview role-assignment parent changed before Grant creation.',
          ExitCode.staleState,
        );
      }
      const parentBinding =
        continuation === null
          ? null
          : createTaskDiffRoleAssignmentParentBinding(
              repositoryRoot,
              continuation,
              runtimeDirectory,
            );
      const observation = observeCurrentChangeRoleAssignmentGrantForInvocation(
        repositoryRoot,
        invocationId,
      );
      const result = await createProductionCentralGrantRequestPort(
        repositoryRoot,
      ).requestGrant(
        createChangeRoleAssignmentGrantRequest(
          observation,
          proposedReason,
          parentBinding,
        ),
      );
      assertOwned();
      if (continuation !== null && parentBinding !== null) {
        assertTaskDiffRoleAssignmentParentBinding(
          repositoryRoot,
          continuation,
          parentBinding,
          runtimeDirectory,
        );
      }
      return result;
    },
    {
      allowGrantChallengeIds:
        initialContinuation === null
          ? []
          : [initialContinuation.parentChallengeId],
    },
  );
}

export async function requestProtectedBaseInitializationGrant(
  cwd: string,
  proposedReason: string,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const port = createProductionProtectedBaseInitializationPort(repositoryRoot);
  return createProductionWorkflowGrantCoordinator(repositoryRoot).requestGrant(
    createProtectedBaseInitializationGrantRequest(port, proposedReason),
  );
}

export async function requestArchivePullRequestPublicationGrant(
  cwd: string,
  preparationIdentity: string,
  configValue: unknown,
  proposedReason: string,
) {
  assertOptionalGrantsPackageAvailable();
  const runtimeRoot =
    loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  return createProductionWorkflowGrantCoordinator(cwd).requestGrant(
    createArchivePullRequestGrantRequest(
      runtimeRoot,
      preparationIdentity,
      resolveArchivePullRequestPublicationTarget(cwd, configValue),
      proposedReason,
    ),
  );
}

export async function requestWorkRegistryReviewGrant(
  cwd: string,
  workItemId: string,
  review: WorkItemReviewV1,
  proposedReason: string,
) {
  assertOptionalGrantsPackageAvailable();
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const transition = review.action === 'prioritize' ? 'prioritize' : 'intake';
  assertWorkRegistryGrantRequired(repositoryRoot, transition);
  return createProductionWorkflowGrantCoordinator(repositoryRoot).requestGrant(
    createWorkRegistryReviewGrantRequest({
      repositoryRoot,
      workItemId,
      review,
      proposedReason,
    }),
  );
}

export async function requestWorkRegistryPromotionGrant(
  cwd: string,
  workItemId: string,
  changeId: string,
  expectedDigest: string,
  proposedReason: string,
) {
  assertOptionalGrantsPackageAvailable();
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  assertWorkRegistryGrantRequired(repositoryRoot, 'promote');
  return createProductionWorkflowGrantCoordinator(repositoryRoot).requestGrant(
    createWorkRegistryPromotionGrantRequest({
      repositoryRoot,
      workItemId,
      changeId,
      expectedDigest,
      proposedReason,
    }),
  );
}

function assertWorkRegistryGrantRequired(
  repositoryRoot: string,
  transition: 'intake' | 'prioritize' | 'promote',
): void {
  if (workRegistryTransitionRequiresGrant(repositoryRoot, transition)) return;
  throw workflowError(
    'WORK_REGISTRY_GRANT_NOT_REQUIRED',
    `Repository policy permits the ${transition} transition without Central Grant.`,
    ExitCode.guard,
  );
}

/** Domain-facing composition boundary; it intentionally omits Human Gate APIs. */
export function createProductionCentralGrantRequestPort(
  cwd: string,
): CentralGrantRequestPortV1 {
  return createProductionWorkflowGrantCoordinator(cwd);
}

export async function requestChangeRoutingContinuationGrant(
  cwd: string,
  changeId: string,
  proposedReason: string,
  expected?: Readonly<{
    sourceDigest: `sha256:${string}`;
    stateBindingDigest: `sha256:${string}`;
  }>,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  return createProductionCentralGrantRequestPort(repositoryRoot).requestGrant(
    createChangeRoutingContinuationGrantRequest(
      repositoryRoot,
      changeId,
      proposedReason,
      expected,
    ),
  );
}

export async function requestInvestigationV3Grant(
  cwd: string,
  investigationId: string,
  proposedReason: string,
) {
  assertOptionalGrantsPackageAvailable();
  const context = loadInvestigationRuntimeContext(cwd);
  const observation = readCurrentInvestigationV3FailureObservation(
    context.runtime,
    investigationId,
  );
  const repositoryId =
    observation.kind === 'investigation-v3-failure-observation'
      ? observation.repositoryId
      : observation.failure.lifecycle.repositoryId;
  if (repositoryId !== context.config.repositoryName) {
    throw workflowError(
      'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
      'Investigation v3 failure observation belongs to another repository.',
      ExitCode.guard,
    );
  }
  const request =
    observation.kind === 'investigation-v3-failure-observation'
      ? createInvestigationV3GrantRequest({
          cwd,
          failure: {
            repositoryId: observation.repositoryId,
            changeId: observation.changeId,
            investigationId: observation.investigationId,
            sessionRevision: observation.sessionRevision,
            sessionSnapshotDigest: observation.sessionSnapshotDigest,
            blocker: observation.blocker,
          },
          emission: observation.emission,
          proposedReason,
        })
      : createInvestigationV3PublicationGrantRequest({
          cwd,
          failure: observation.failure,
          proposedReason,
        });
  return createProductionCentralGrantRequestPort(cwd).requestGrant(request);
}

export async function requestInvestigationV3PublicationGrant(
  cwd: string,
  input: Readonly<{
    failure: InvestigationManifestPublicationFailure;
    proposedReason: string;
  }>,
) {
  assertOptionalGrantsPackageAvailable();
  const context = loadInvestigationRuntimeContext(cwd);
  if (input.failure.lifecycle.repositoryId !== context.config.repositoryName) {
    throw workflowError(
      'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
      'Investigation v3 publication failure belongs to another repository.',
      ExitCode.guard,
    );
  }
  return createProductionCentralGrantRequestPort(cwd).requestGrant(
    createInvestigationV3PublicationGrantRequest({
      cwd,
      failure: input.failure,
      proposedReason: input.proposedReason,
    }),
  );
}

export type InvestigationV3PublicationOperationResult = Readonly<{
  outcome: string;
  recoveryKind?: string;
  failure?: InvestigationManifestPublicationFailure;
}>;

export type InvestigationV3PublicationPropagation<
  T extends InvestigationV3PublicationOperationResult,
> =
  | Readonly<{
      propagationOutcome: 'unchanged';
      result: T;
    }>
  | Readonly<{
      propagationOutcome: 'grant-free';
      result: T;
    }>
  | Readonly<{
      propagationOutcome: 'central-grant-requested';
      result: T;
      grant: Awaited<ReturnType<typeof requestInvestigationV3PublicationGrant>>;
    }>;

/**
 * Production propagation boundary for the real publication operation unions.
 * Failure-bearing results enter central Grant Core here; successful, empty,
 * committed, read, and idempotently recoverable results retain their original
 * operation classification and object identity.
 */
export async function propagateInvestigationV3PublicationResult<
  T extends InvestigationV3PublicationOperationResult,
>(
  cwd: string,
  input: Readonly<{ result: T; proposedReason: string }>,
): Promise<InvestigationV3PublicationPropagation<T>> {
  if (input.result.failure !== undefined) {
    try {
      const grant = await requestInvestigationV3PublicationGrant(cwd, {
        failure: input.result.failure,
        proposedReason: input.proposedReason,
      });
      return Object.freeze({
        propagationOutcome: 'central-grant-requested' as const,
        result: input.result,
        grant,
      });
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        error.code === 'INVESTIGATION_V3_GRANT_NOT_REQUIRED'
      ) {
        return Object.freeze({
          propagationOutcome: 'grant-free' as const,
          result: input.result,
        });
      }
      throw error;
    }
  }
  if (
    input.result.outcome === 'blocked' ||
    (input.result.outcome === 'recoverable' &&
      input.result.recoveryKind === 'pre-ref')
  ) {
    throw workflowError(
      'INVESTIGATION_V3_PUBLICATION_RESULT_INVALID',
      'A failure-bearing Investigation v3 publication result omitted its source envelope.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    propagationOutcome: 'unchanged' as const,
    result: input.result,
  });
}

function humanResolutionLifecycleBinding(
  challenge: ReturnType<typeof readGrantRecord>['challenge'],
): RepositoryLifecycleOperationOptions {
  // Historical v2 records retain their narrow lifecycle identity for safe
  // inspection. No v2 transition is registered, so this cannot execute one.
  if (
    challenge.sourceModuleId !== 'investigation' ||
    !isRecord(challenge.facts) ||
    typeof challenge.facts.changeId !== 'string'
  ) {
    return {};
  }
  return {
    allowHumanResolutionGrantId: challenge.challengeId,
    allowHumanResolutionChangeId: assertChangeId(challenge.facts.changeId),
  };
}
