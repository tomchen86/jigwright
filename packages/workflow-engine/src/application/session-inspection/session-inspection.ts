/**
 * Builds the current session inspection: the pinned repository, contract,
 * task projection and authorized artifact set a session is allowed to act on.
 *
 * Invariants:
 * - Repository identity, pinned artifacts and task projection are all
 *   rechecked against the stored session before any inspection is returned.
 */
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { digestArtifacts } from '../../runtime/repository-observation/contract-artifact-observation.ts';
import { loadWorkflowConfig } from '../../runtime/workflow-configuration/workflow-configuration.ts';
import { parseTasks } from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { completionDocumentPaths } from '../../runtime/managed-documents/validation/managed-documents.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  listChangedPaths,
  type GitState,
} from '../../runtime/repository-transaction/git.ts';
import {
  assertSessionId,
  matchesAllowedPath,
} from '../../foundation/repository-path/repository-path.ts';
import {
  assertOwnedLock,
  assertTaskSessionIsolationLeasesOwned,
  readSessionFile,
  runtimePaths,
  type WorkflowSession,
} from '../../runtime/session-workspace/session-store.ts';
import { assertTaskProjectionSourceDigest } from '../../runtime/managed-documents/transaction/task-projection.ts';
import {
  readFinalizeTransaction,
  type ProtectedTaskApplyAuthorizationBinding,
} from '../../runtime/storage-journal/finalize-transaction.ts';
import { assertPreparedProtectedTaskApplyAuthorization } from '../task-apply-authorization/protected-task-apply-authorization.ts';
import type { ValidatedChangeContract } from '../../modules/assurance/validated-change-contract.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { readFileAtRevision } from '../../runtime/repository-transaction/git-command.ts';

/**
 * Inspects task sessions, executes checks, and reconciles evidence after
 * engine adoption.
 *
 * Invariants:
 * - Adoption reconciliation rejects a session changed since its trusted
 *   checkpoint.
 */

export function inspectSession(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedSessionId: string,
  options: {
    expectedSession?: WorkflowSession;
    projectedTaskIds?: string[];
    projectionSourceDigest?: string;
    authorizedTransitionPaths?: string[];
    /** Exact authenticated internal Grant binding; never accepted from argv. */
    protectedApplyAuthorization?: ProtectedTaskApplyAuthorizationBinding;
  } = {},
): SessionInspection {
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessionId = assertSessionId(requestedSessionId);
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);
  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${session.sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  if (
    options.expectedSession &&
    JSON.stringify(session) !== JSON.stringify(options.expectedSession)
  ) {
    throw workflowError(
      'SESSION_CHANGED_DURING_CHECK',
      'The active session changed while required checks were running.',
      ExitCode.staleState,
    );
  }
  assertPinnedGit(discovered, session);

  if (session.isolation !== undefined) {
    const routingAdmission = changeContract.admissionReader(
      discovered.repositoryRoot,
      session.changeId,
    );
    if (
      routingAdmission.role !== session.isolation.routingRole ||
      routingAdmission.worksetDigest !==
        session.isolation.routingWorksetDigest ||
      routingAdmission.concurrencyEnabled !==
        session.isolation.concurrencyEnabled
    ) {
      throw workflowError(
        'SESSION_ROUTING_WORKSET_STALE',
        'The active task session no longer owns its pinned routing workset.',
        ExitCode.staleState,
      );
    }
    assertTaskSessionIsolationLeasesOwned(runtime, session);
  }

  const { git, contract, planningAssurance } =
    changeContract.loadStableValidatedChangeContract(
      discovered,
      session.changeId,
    );
  if (
    canonicalJson(session.planningAssurance ?? null) !==
    canonicalJson(
      planningAssurance.createTaskBinding(contract, contract.planningAssurance),
    )
  ) {
    throw workflowError(
      'SESSION_PLANNING_ASSURANCE_STALE',
      'Session planning assurance no longer matches the live validated change contract.',
      ExitCode.staleState,
    );
  }
  const policy = contract.guard.tasks[session.taskId];
  if (!policy) {
    throw workflowError(
      'SESSION_TASK_REMOVED',
      `Session task ${session.taskId} no longer exists in guard.json.`,
      ExitCode.staleState,
    );
  }
  assertOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    session.sessionId,
    session.changeId,
    session.taskId,
  );
  if (
    JSON.stringify(policy.allowedPaths) !==
      JSON.stringify(session.allowedPaths) ||
    JSON.stringify(policy.requiredChecks) !==
      JSON.stringify(session.requiredChecks)
  ) {
    throw workflowError(
      'SESSION_POLICY_TAMPERED',
      'Session task policy does not match the pinned change contract.',
      ExitCode.staleState,
    );
  }

  const artifactDigests = digestArtifacts(
    git.repositoryRoot,
    contract.artifactPaths,
  );
  const tasksPath = path.join(contract.changeDirectory, 'tasks.md');
  const relativeTasksPath = relative(git.repositoryRoot, tasksPath);
  const baselineTasks = readFileAtRevision(
    git.repositoryRoot,
    session.baseline.head,
    `${relativeTasksPath}`,
  );
  const currentTasks = fs.readFileSync(tasksPath, 'utf8');
  assertTaskProjection(
    baselineTasks,
    currentTasks,
    options.projectedTaskIds ?? [],
    options.projectionSourceDigest,
  );
  assertArtifactDrift(
    session,
    contract,
    artifactDigests,
    relativeTasksPath,
    options.projectedTaskIds ?? [],
    resolveAuthorizedArtifactPaths(
      runtime.root,
      session,
      options.protectedApplyAuthorization,
    ),
  );

  const changedPaths = listChangedPaths(
    git.repositoryRoot,
    session.baseline.head,
  );
  const projectedPaths =
    (options.projectedTaskIds?.length ?? 0) > 0 ? [relativeTasksPath] : [];
  const transitionPaths = options.authorizedTransitionPaths ?? [];
  const reconciliationPaths = session.implementationReconciliationPaths ?? [];
  const documentationRemediationPaths =
    session.documentationRemediation?.paths ?? [];
  const allowedTransitionPaths = completionDocumentPaths(git.repositoryRoot);
  if (
    transitionPaths.some(
      (transitionPath) => !allowedTransitionPaths.includes(transitionPath),
    )
  ) {
    throw workflowError(
      'UNAUTHORIZED_TRANSITION_PATH',
      'A transition path is not an active generated completion document.',
      ExitCode.staleState,
    );
  }
  const unexpectedPaths = changedPaths.filter(
    (changedPath) =>
      !projectedPaths.includes(changedPath) &&
      !transitionPaths.includes(changedPath) &&
      !reconciliationPaths.includes(changedPath) &&
      !documentationRemediationPaths.includes(changedPath) &&
      !policy.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );
  if (unexpectedPaths.length > 0) {
    throw workflowError(
      'OUT_OF_SCOPE_PATHS',
      `Session contains ${unexpectedPaths.length} out-of-scope path(s).`,
      ExitCode.verification,
      { details: { changedPaths, unexpectedPaths } },
    );
  }

  return {
    git,
    session,
    contract,
    policy,
    artifactDigests,
    changedPaths,
    unexpectedPaths,
    fingerprint: fingerprintRepositoryProjection(
      git.repositoryRoot,
      session.baseline.head,
      git.statusEntries,
    ),
    tasksPath,
    baselineTasks,
  };
}

function assertPinnedGit(git: GitState, session: WorkflowSession): void {
  if (git.repositoryRealPath !== session.repositoryRoot) {
    throw workflowError(
      'REPOSITORY_IDENTITY_CHANGED',
      'Session repository identity does not match the current repository.',
      ExitCode.staleState,
    );
  }
  if (git.gitCommonDirectory !== session.gitCommonDirectory) {
    throw workflowError(
      'GIT_COMMON_DIRECTORY_CHANGED',
      'Session Git common-directory identity has changed.',
      ExitCode.staleState,
    );
  }
  if (git.branch !== session.branch) {
    throw workflowError(
      'SESSION_BRANCH_CHANGED',
      `Session branch changed from ${session.branch} to ${git.branch ?? 'detached HEAD'}.`,
      ExitCode.staleState,
    );
  }
  if (git.head !== session.baseline.head) {
    throw workflowError(
      'SESSION_HEAD_CHANGED',
      'HEAD changed after session start.',
      ExitCode.staleState,
      { details: { baseline: session.baseline.head, actual: git.head } },
    );
  }
}

function resolveAuthorizedArtifactPaths(
  runtimeRoot: string,
  session: WorkflowSession,
  explicitAuthorization: ProtectedTaskApplyAuthorizationBinding | undefined,
): string[] {
  const transaction = readFinalizeTransaction(runtimeRoot, session.sessionId);
  if (
    explicitAuthorization !== undefined &&
    transaction !== null &&
    (transaction.protectedApply === undefined ||
      canonicalJson(transaction.protectedApply) !==
        canonicalJson(explicitAuthorization))
  ) {
    throw protectedTaskApplyInspectionAuthorizationInvalid(
      'The requested protected Apply authorization does not own the durable finalize transaction.',
    );
  }
  const authorization = transaction?.protectedApply ?? explicitAuthorization;
  if (authorization === undefined) return [];
  if (transaction !== null) {
    if (
      transaction.changeId !== session.changeId ||
      transaction.taskId !== session.taskId ||
      transaction.branch !== session.branch ||
      canonicalJson(transaction.baseline) !== canonicalJson(session.baseline)
    ) {
      throw protectedTaskApplyInspectionAuthorizationInvalid(
        'The protected Apply transaction does not own the current session state.',
      );
    }
  }
  const { parameters } = assertPreparedProtectedTaskApplyAuthorization(
    runtimeRoot,
    authorization,
  );
  if (
    parameters.sessionId !== session.sessionId ||
    parameters.changeId !== session.changeId ||
    parameters.taskId !== session.taskId ||
    parameters.branch !== session.branch ||
    canonicalJson(parameters.baseline) !== canonicalJson(session.baseline)
  ) {
    throw protectedTaskApplyInspectionAuthorizationInvalid(
      'The protected Apply Grant does not bind the current session state.',
    );
  }
  return [...parameters.changedPaths];
}

function protectedTaskApplyInspectionAuthorizationInvalid(message: string) {
  return workflowError(
    'PROTECTED_TASK_APPLY_AUTHORIZATION_INVALID',
    message,
    ExitCode.guard,
  );
}

function assertArtifactDrift(
  session: WorkflowSession,
  contract: ValidatedChangeContract,
  currentDigests: Record<string, string>,
  tasksPath: string,
  projectedTaskIds: string[],
  authorizedArtifactPaths: string[],
): void {
  const allPaths = new Set([
    ...Object.keys(session.artifacts),
    ...Object.keys(currentDigests),
  ]);
  for (const artifactPath of allPaths) {
    if (session.artifacts[artifactPath] === currentDigests[artifactPath]) {
      continue;
    }
    if (authorizedArtifactPaths.includes(artifactPath)) continue;
    if (artifactPath === 'workflow/config.json') {
      throw artifactsChanged();
    }
    if (artifactPath === 'workflow/checks.json') {
      if (
        !session.requiredCheckDigests ||
        JSON.stringify(
          digestRequiredCheckDefinitions(
            contract.checks,
            session.requiredChecks,
          ),
        ) !== JSON.stringify(session.requiredCheckDigests)
      ) {
        throw artifactsChanged();
      }
    }
    const projected = artifactPath === tasksPath && projectedTaskIds.length > 0;
    if (
      !projected &&
      !session.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(artifactPath, allowedPath),
      )
    ) {
      throw artifactsChanged();
    }
  }
}

function assertTaskProjection(
  baseline: string,
  current: string,
  projectedTaskIds: string[],
  projectionSourceDigest?: string,
): void {
  if (projectedTaskIds.length > 0) {
    if (!projectionSourceDigest) {
      throw workflowError(
        'TASK_PROJECTION_SOURCE_REQUIRED',
        'Projected tasks require the checked source digest.',
        ExitCode.staleState,
      );
    }
    assertTaskProjectionSourceDigest(
      current,
      projectedTaskIds,
      projectionSourceDigest,
    );
    return;
  }
  const baselineTasks = parseTasks(baseline).map(({ id, completed }) => ({
    id,
    completed,
  }));
  const currentTasks = parseTasks(current).map(({ id, completed }) => ({
    id,
    completed,
  }));
  if (JSON.stringify(baselineTasks) !== JSON.stringify(currentTasks)) {
    throw workflowError(
      'UNAUTHORIZED_TASK_PROJECTION',
      'Task checkboxes may only change through workflow complete-task.',
      ExitCode.staleState,
    );
  }
}

function artifactsChanged() {
  return workflowError(
    'ARTIFACTS_CHANGED',
    'Pinned workflow artifacts changed without preserving the active policy.',
    ExitCode.staleState,
  );
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
