import {
  type TaskMandatePreparationAuthorization,
  type TaskMandateOptions,
} from '../../modules/authority/task-mandate-access-contract.ts';
import type { StableValidatedChangeContractLoader } from '../../modules/assurance/validated-change-contract.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { ChangeRoutingAdmissionReader } from '../../modules/lifecycle/change-routing.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  ensurePlainDirectory,
  publishPreparedExclusiveLock,
} from '../../runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import {
  assertChangeId,
  assertSessionId,
  assertTaskId,
} from '../../foundation/repository-path/repository-path.ts';
import { reclaimDeadChangeTransitionLock } from '../../runtime/session-workspace/planning-lock.ts';
import {
  acquireTaskSessionIsolationLeases,
  assertOwnedRuntimeFilePublication,
  assertTaskSessionWorktreeRegistration,
  assertRepositoryLifecyclePreflightAdmission,
  assertTaskSessionAdmission,
  closeOwnedRuntimeFilePublication,
  closeTaskSessionIsolationLeaseAcquisition,
  createTaskSessionIsolationBinding,
  createSessionId,
  readSessionFile,
  rollbackOwnedRuntimeFilePublication,
  rollbackTaskSessionIsolationLeaseAcquisition,
  runtimePaths,
  type OwnedRuntimeFilePublication,
  type TaskSessionIsolationLeaseAcquisition,
  type TaskSessionIsolationBinding,
  type WorkflowSession,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import { type TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import {
  assertTaskMandateOptional,
  resolveTaskAuthorizationRequirement,
  type TaskAuthorizationRequirement,
} from '../../adapters/consumer/repository/work-registry/task-authorization-policy.ts';
import { assertDisposableDatabaseForRepository } from '../../adapters/consumer/repository/work-registry/database-policy.ts';

/**
 * Admits, publishes, inspects, and aborts task execution sessions.
 *
 * Invariants:
 * - A task session cannot start from detached HEAD.
 */

export type SessionStartOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  testHooks?: Readonly<{
    beforeIsolationLeasePublication?: (
      input: Readonly<{
        index: number;
        leasePath: string;
      }>,
    ) => void;
    afterSessionPublication?: (
      input: Readonly<{
        sessionPath: string;
      }>,
    ) => void;
  }>;
}>;

export type TaskSessionPreflightV1 = Readonly<{
  schemaVersion: 1;
  kind: 'task-session-preflight.v1';
  authority: 'advisory';
  status: 'ready' | 'mandate-required';
  changeId: string;
  taskId: string;
  observed: Readonly<{
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string;
    head: string;
    tree: string;
  }>;
  routing: Readonly<{
    role: TaskSessionIsolationBinding['routingRole'];
    worksetDigest: string;
    concurrencyEnabled: boolean;
  }>;
  scope: Readonly<{
    allowedPaths: readonly string[];
    requiredChecks: readonly string[];
    authorization: TaskAuthorizationRequirement;
  }>;
  isolation: TaskSessionIsolationBinding;
  mutationBoundary: Readonly<{
    git: 'read-only';
    runtime: 'read-only';
    grants: 'not-requested';
  }>;
}>;

type ValidatedChangeContract =
  ReturnType<StableValidatedChangeContractLoader>['contract'];

export type { WorkflowSession } from '../../runtime/session-workspace/session-store.ts';

export type {
  SessionCheck,
  SessionCheckOptions,
} from '../../modules/lifecycle/session-check.ts';

export function assertProductionChangeRoutingAdmission(
  changeContract: ChangeContractServices,
  repositoryRoot: string,
  changeId: string,
): ReturnType<ChangeRoutingAdmissionReader> {
  return changeContract.admissionReader(repositoryRoot, changeId);
}

export function startSession(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  options: SessionStartOptions = {},
): WorkflowSession {
  const initial = inspectSessionStart(
    changeContract,
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  const runtime = runtimePaths(
    initial.git.gitCommonDirectory,
    initial.contract.config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
    reclaimDeadChangeTransitionLock(
      runtime,
      initial.changeId,
      assertRepositoryLock,
    );
    return persistSessionStart(
      inspectSessionStart(
        changeContract,
        cwd,
        requestedChangeId,
        requestedTaskId,
      ),
      undefined,
      undefined,
      options.environment,
      options.testHooks,
    );
  });
}

export function preflightTaskSession(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  options: SessionStartOptions = {},
): TaskSessionPreflightV1 {
  const inspection = inspectSessionStart(
    changeContract,
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  assertRepositoryLifecyclePreflightAdmission(runtime, inspection.changeId);
  const admission = inspectTaskSessionAdmission(
    inspection,
    runtime,
    options.environment,
  );
  const authorization = resolveTaskAuthorizationRequirement(
    inspection.git.repositoryRoot,
    inspection.contract.config,
    admission.policy.allowedPaths,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'task-session-preflight.v1' as const,
    authority: 'advisory' as const,
    status: authorization.requiresMandate
      ? ('mandate-required' as const)
      : ('ready' as const),
    changeId: inspection.changeId,
    taskId: inspection.taskId,
    observed: Object.freeze({
      repositoryRoot: inspection.git.repositoryRealPath,
      gitCommonDirectory: inspection.git.gitCommonDirectory,
      branch: inspection.branch,
      head: inspection.git.head,
      tree: inspection.git.tree,
    }),
    routing: Object.freeze({
      role: inspection.routingAdmission.role,
      worksetDigest: inspection.routingAdmission.worksetDigest,
      concurrencyEnabled: inspection.routingAdmission.concurrencyEnabled,
    }),
    scope: Object.freeze({
      allowedPaths: Object.freeze([...admission.policy.allowedPaths]),
      requiredChecks: Object.freeze([...admission.policy.requiredChecks]),
      authorization,
    }),
    isolation: admission.isolation,
    mutationBoundary: Object.freeze({
      git: 'read-only' as const,
      runtime: 'read-only' as const,
      grants: 'not-requested' as const,
    }),
  });
}

export function startMandatedSession(
  taskMandate: Pick<
    TaskMandatePreparationAuthorization,
    'authorizeTaskMandateOperation'
  >,
  changeContract: ChangeContractServices,
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  requestedMandateTaskId: string,
  options: TaskMandateOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowSession {
  const initial = inspectSessionStart(
    changeContract,
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  const authorization = taskMandate.authorizeTaskMandateOperation(
    cwd,
    requestedMandateTaskId,
    { kind: 'isolated-repository-write' },
    { ...options, changeId: initial.changeId },
  );
  const runtime = runtimePaths(
    initial.git.gitCommonDirectory,
    initial.contract.config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
    reclaimDeadChangeTransitionLock(
      runtime,
      initial.changeId,
      assertRepositoryLock,
    );
    return persistSessionStart(
      inspectSessionStart(
        changeContract,
        cwd,
        requestedChangeId,
        requestedTaskId,
      ),
      authorization.binding,
      undefined,
      environment,
    );
  });
}

function inspectSessionStart(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): {
  changeId: string;
  taskId: string;
  git: ReturnType<typeof discoverRepository>;
  contract: ValidatedChangeContract;
  branch: string;
  routingAdmission: ReturnType<ChangeRoutingAdmissionReader>;
  planningAssurance: ReturnType<StableValidatedChangeContractLoader>['planningAssurance'];
} {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  const discovered = discoverRepository(cwd);
  const { git, contract, planningAssurance } =
    changeContract.loadStableValidatedChangeContract(discovered, changeId);
  const routingAdmission = assertProductionChangeRoutingAdmission(
    changeContract,
    git.repositoryRoot,
    changeId,
  );
  const task = contract.tasks.find((candidate) => candidate.id === taskId);

  if (!task) {
    throw workflowError(
      'UNKNOWN_TASK',
      `Task ${taskId} does not exist in change ${changeId}.`,
      ExitCode.guard,
    );
  }
  if (task.completed) {
    throw workflowError(
      'TASK_ALREADY_COMPLETED',
      `Task ${taskId} is already checked in tasks.md.`,
      ExitCode.guard,
      { recovery: 'Select the next incomplete task.' },
    );
  }
  if (!git.branch) {
    throw workflowError(
      'DETACHED_HEAD',
      'Cannot start a workflow session from detached HEAD.',
      ExitCode.guard,
    );
  }
  if (contract.config.protectedBranches.includes(git.branch)) {
    throw workflowError(
      'PROTECTED_BRANCH',
      `Cannot start a workflow session on protected branch ${git.branch}.`,
      ExitCode.guard,
      {
        recovery: `Create branch ${expectedBranch(contract.config.branchTemplate, changeId)}.`,
      },
    );
  }

  const requiredBranch = expectedBranch(
    contract.config.branchTemplate,
    changeId,
  );
  if (git.branch !== requiredBranch) {
    throw workflowError(
      'WRONG_BRANCH',
      `Change ${changeId} requires branch ${requiredBranch}, not ${git.branch}.`,
      ExitCode.guard,
      { details: { actual: git.branch, expected: requiredBranch } },
    );
  }
  assertTaskSessionWorktreeRegistration(
    git.repositoryRoot,
    git.repositoryRealPath,
    git.branch,
    git.head,
  );
  if (git.statusEntries.length > 0) {
    throw workflowError(
      'DIRTY_WORKTREE',
      'Cannot start a workflow session with staged, unstaged, or untracked files.',
      ExitCode.guard,
      {
        details: { entryCount: git.statusEntries.length },
        recovery:
          'Review and commit or otherwise resolve existing work explicitly. The workflow will not stash, reset, or delete it.',
      },
    );
  }

  return {
    changeId,
    taskId,
    git,
    contract,
    branch: git.branch,
    routingAdmission,
    planningAssurance,
  };
}

function persistSessionStart(
  inspection: ReturnType<typeof inspectSessionStart>,
  mandateBinding?: TaskMandateBinding,
  fixedIdentity?: Readonly<{ sessionId: string; createdAt: string }>,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: SessionStartOptions['testHooks'] = {},
): WorkflowSession {
  const { changeId, taskId, git, contract, branch, planningAssurance } =
    inspection;
  const policy = contract.guard.tasks[taskId];
  if (!mandateBinding) {
    assertTaskMandateOptional(
      git.repositoryRoot,
      contract.config,
      policy.allowedPaths,
    );
  }
  const sessionId = fixedIdentity
    ? assertSessionId(fixedIdentity.sessionId)
    : createSessionId();
  const runtime = runtimePaths(
    git.gitCommonDirectory,
    contract.config.runtimeDirectory,
  );
  const { isolation } = inspectTaskSessionAdmission(
    inspection,
    runtime,
    environment,
  );
  const session: WorkflowSession = {
    schemaVersion: 1,
    sessionId,
    state: 'active',
    changeId,
    taskId,
    ...(mandateBinding ? { mandateBinding } : {}),
    repositoryRoot: git.repositoryRealPath,
    gitCommonDirectory: git.gitCommonDirectory,
    branch,
    baseline: { head: git.head, tree: git.tree },
    artifacts: contract.artifactDigests,
    allowedPaths: [...policy.allowedPaths],
    requiredChecks: [...policy.requiredChecks],
    isolation,
    requiredCheckDigests: digestRequiredCheckDefinitions(
      contract.checks,
      policy.requiredChecks,
    ),
    planningAssurance: planningAssurance.createTaskBinding(
      contract,
      contract.planningAssurance,
    ),
    createdAt: fixedIdentity
      ? assertExactSessionTimestamp(fixedIdentity.createdAt)
      : new Date().toISOString(),
  };
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  assertTaskSessionWorktreeRegistration(
    git.repositoryRoot,
    git.repositoryRealPath,
    branch,
    git.head,
  );
  ensurePlainDirectory(runtime.sessions);
  ensurePlainDirectory(runtime.locks);
  const lockPath = path.join(runtime.locks, `${changeId}.lock`);
  let lockPublication: OwnedRuntimeFilePublication | undefined;
  let leaseAcquisition: TaskSessionIsolationLeaseAcquisition | undefined;
  let sessionPublication: OwnedRuntimeFilePublication | undefined;
  try {
    const lockOwnerToken = crypto.randomUUID();
    const lockContent = `${JSON.stringify({
      sessionId,
      ownerToken: lockOwnerToken,
      changeId,
      taskId,
      pid: process.pid,
    })}\n`;
    try {
      lockPublication = {
        runtimeRoot: runtime.root,
        filePath: lockPath,
        descriptor: publishPreparedExclusiveLock(
          lockPath,
          lockContent,
          lockOwnerToken,
          sessionLockInvalid,
        ),
        content: lockContent,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'ACTIVE_SESSION_CONFLICT',
          `Change ${changeId} already has an active session lock.`,
          ExitCode.conflict,
          { details: { lockPath } },
        );
      }
      throw error;
    }
    leaseAcquisition = acquireTaskSessionIsolationLeases(runtime, session, {
      beforePublication: testHooks?.beforeIsolationLeasePublication,
    });
    assertTaskSessionWorktreeRegistration(
      git.repositoryRoot,
      git.repositoryRealPath,
      branch,
      git.head,
    );
    const sessionContent = `${JSON.stringify(session, null, 2)}\n`;
    const publicationToken = crypto.randomUUID();
    try {
      sessionPublication = {
        runtimeRoot: runtime.root,
        filePath: sessionPath,
        descriptor: publishPreparedExclusiveLock(
          sessionPath,
          sessionContent,
          publicationToken,
          () => sessionPublicationConflict(sessionPath),
        ),
        content: sessionContent,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw sessionPublicationConflict(sessionPath);
      }
      throw error;
    }
    testHooks?.afterSessionPublication?.({ sessionPath });
    assertOwnedRuntimeFilePublication(
      sessionPublication,
      sessionWriteVerificationFailed,
    );
    assertOwnedRuntimeFilePublication(lockPublication, sessionLockInvalid);
    for (const leasePublication of leaseAcquisition.publications) {
      assertOwnedRuntimeFilePublication(leasePublication);
    }
    const persisted = readSessionFile(sessionPath);
    if (`${JSON.stringify(persisted, null, 2)}\n` !== sessionContent) {
      throw sessionWriteVerificationFailed();
    }
    assertOwnedRuntimeFilePublication(
      sessionPublication,
      sessionWriteVerificationFailed,
    );
    assertOwnedRuntimeFilePublication(lockPublication, sessionLockInvalid);
    for (const leasePublication of leaseAcquisition.publications) {
      assertOwnedRuntimeFilePublication(leasePublication);
    }
    assertTaskSessionWorktreeRegistration(
      git.repositoryRoot,
      git.repositoryRealPath,
      branch,
      git.head,
    );
  } catch (error) {
    rollbackSessionStartPublications(error, {
      sessionPublication,
      leaseAcquisition,
      lockPublication,
    });
  }

  closeOwnedRuntimeFilePublication(sessionPublication!);
  closeTaskSessionIsolationLeaseAcquisition(leaseAcquisition!);
  closeOwnedRuntimeFilePublication(lockPublication!);

  return session;
}

function rollbackSessionStartPublications(
  primaryError: unknown,
  publications: Readonly<{
    sessionPublication: OwnedRuntimeFilePublication | undefined;
    leaseAcquisition: TaskSessionIsolationLeaseAcquisition | undefined;
    lockPublication: OwnedRuntimeFilePublication | undefined;
  }>,
): never {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    publications.sessionPublication === undefined
      ? undefined
      : () =>
          rollbackOwnedRuntimeFilePublication(publications.sessionPublication!),
    publications.leaseAcquisition === undefined
      ? undefined
      : () =>
          rollbackTaskSessionIsolationLeaseAcquisition(
            publications.leaseAcquisition!,
          ),
    publications.lockPublication === undefined
      ? undefined
      : () =>
          rollbackOwnedRuntimeFilePublication(publications.lockPublication!),
  ]) {
    if (cleanup === undefined) continue;
    try {
      cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Task-session start failed and exact-owned cleanup was incomplete.',
    );
  }
  throw primaryError;
}

function sessionPublicationConflict(sessionPath: string) {
  return workflowError(
    'SESSION_PUBLICATION_CONFLICT',
    'The requested task-session identity already has durable bytes.',
    ExitCode.conflict,
    { details: { sessionPath } },
  );
}

function sessionWriteVerificationFailed() {
  return workflowError(
    'SESSION_WRITE_VERIFICATION_FAILED',
    'Persisted session did not match the exact requested active session bytes.',
    ExitCode.staleState,
  );
}

function inspectTaskSessionAdmission(
  inspection: ReturnType<typeof inspectSessionStart>,
  runtime: ReturnType<typeof runtimePaths>,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<{
  policy: ValidatedChangeContract['guard']['tasks'][string];
  isolation: TaskSessionIsolationBinding;
}> {
  const { changeId, taskId, git, contract, branch, routingAdmission } =
    inspection;
  const policy = contract.guard.tasks[taskId];
  const destructiveDatabase = policy.requiredChecks.some(
    (checkId) => contract.checks.checks[checkId]?.destructiveDatabase === true,
  );
  const databaseIdentity =
    routingAdmission.concurrencyEnabled && destructiveDatabase
      ? assertDisposableDatabaseForRepository(git.repositoryRoot, environment)
          .identity
      : null;
  const isolation = createTaskSessionIsolationBinding({
    routingRole: routingAdmission.role,
    routingWorksetDigest: routingAdmission.worksetDigest,
    concurrencyEnabled: routingAdmission.concurrencyEnabled,
    repositoryRoot: git.repositoryRealPath,
    resources: [
      ...(databaseIdentity === null
        ? []
        : [
            {
              kind: 'destructive-database' as const,
              identity: databaseIdentity,
            },
          ]),
      ...(policy.exclusiveResources ?? []).map((identity) => ({
        kind: 'exclusive' as const,
        identity,
      })),
    ],
  });
  assertTaskSessionAdmission(runtime, {
    changeId,
    repositoryRoot: git.repositoryRealPath,
    branch,
    allowedPaths: policy.allowedPaths,
    isolation,
  });
  return Object.freeze({ policy, isolation });
}

/**
 * Publish one exact session while the caller owns the repository lifecycle
 * lock. Open-task uses this only after releasing its per-change planning lock,
 * so the change-lock pathname can become the durable active-session lock
 * without ever dropping repository-wide exclusion.
 */
export function startMandatedSessionUnderLifecycleLock(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  mandateBinding: TaskMandateBinding,
  identity: Readonly<{ sessionId: string; createdAt: string }>,
  assertRepositoryLock: () => void,
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowSession {
  assertRepositoryLock();
  const inspection = inspectSessionStart(
    changeContract,
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  assertRepositoryLock();
  const session = persistSessionStart(
    inspection,
    mandateBinding,
    identity,
    environment,
  );
  assertRepositoryLock();
  return session;
}

export function startSessionUnderLifecycleLock(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
  identity: Readonly<{ sessionId: string; createdAt: string }>,
  assertRepositoryLock: () => void,
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowSession {
  assertRepositoryLock();
  const inspection = inspectSessionStart(
    changeContract,
    cwd,
    requestedChangeId,
    requestedTaskId,
  );
  assertRepositoryLock();
  const session = persistSessionStart(
    inspection,
    undefined,
    identity,
    environment,
  );
  assertRepositoryLock();
  return session;
}

function assertExactSessionTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw workflowError(
      'SESSION_TIMESTAMP_INVALID',
      'The durable session timestamp is not canonical.',
      ExitCode.staleState,
    );
  }
  return value;
}

function sessionLockInvalid() {
  return workflowError(
    'SESSION_LOCK_INVALID',
    'The active session lock publication is unsafe.',
    ExitCode.staleState,
  );
}

function expectedBranch(template: string, changeId: string): string {
  return template.replaceAll('{changeId}', changeId);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
