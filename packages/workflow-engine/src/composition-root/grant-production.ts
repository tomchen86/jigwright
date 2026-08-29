import { loadWorkflowConfig } from '../adapters/consumer/repository/work-registry/contracts.ts';
import type { CentralGrantRequestPortV1 } from '@jigwright/core/central-grant-port';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
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
import { loadGrantPolicyV2 } from '../modules/authority/grant-policy.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
import type { TransitionRegistry } from '../modules/authority/grant-transition-registry.ts';
import { createTransitionRegistry } from '../modules/authority/grant-transition-registry.ts';
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

/**
 * Production composition root. Unlike the testable kernel, this surface does
 * not accept an approval provider, helper path, policy value, or lifecycle
 * implementation from its caller.
 */
export function createProductionGrantCoordinator(
  cwd: string,
  registry: TransitionRegistry,
): GrantCoordinator {
  assertOptionalGrantsPackageAvailable();
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  ensurePlainDirectory(runtime.root);
  const paths = grantStorePaths(runtime.root);
  const policy = loadGrantPolicyV2(git.repositoryRoot).policy;

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
      const stored = readGrantRecord(paths, challengeId);
      return withRepositoryLifecycleOperationAsync(runtime, operation, {
        allowGrantChallengeId: challengeId,
        ...humanResolutionLifecycleBinding(stored.challenge),
      });
    },
  });
}

function productionApprovalSession(
  humanGate: GrantApprovalSession,
  policy: ReturnType<typeof loadGrantPolicyV2>['policy'],
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
  assertOptionalGrantsPackageAvailable();
  const runtimeRoot =
    loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  const protectedBase = createProductionProtectedBaseInitializationPort(cwd);
  return createProductionGrantCoordinator(
    cwd,
    createTransitionRegistry([
      ...investigationV3GrantTransitionDefinitions(cwd),
      ...workRegistryGrantTransitionDefinitions(cwd),
      ...archivePullRequestGrantTransitionDefinitions(runtimeRoot),
      ...changeRoutingGrantTransitionDefinitions(cwd),
      ...protectedBaseInitializationGrantTransitionDefinitions(protectedBase),
    ]),
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
  proposedReason: string,
) {
  assertOptionalGrantsPackageAvailable();
  const runtimeRoot =
    loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  return createProductionWorkflowGrantCoordinator(cwd).requestGrant(
    createArchivePullRequestGrantRequest(
      runtimeRoot,
      preparationIdentity,
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
  assertOptionalGrantsPackageAvailable();
  return createProductionWorkflowGrantCoordinator(cwd);
}

export async function requestChangeRoutingContinuationGrant(
  cwd: string,
  changeId: string,
  proposedReason: string,
) {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  return createProductionCentralGrantRequestPort(repositoryRoot).requestGrant(
    createChangeRoutingContinuationGrantRequest(
      repositoryRoot,
      changeId,
      proposedReason,
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
