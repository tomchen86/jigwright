import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { defaultSessionRuntimeLayoutPort } from '@jigwright/core/session-runtime-layout-port';

import {
  isPlanningAssuranceBinding,
  type PlanningAssuranceBinding,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertPlainDirectory,
  ensurePlainDirectory,
  preparedLockTemporaryPath,
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
  withPreparedLockCleanupClaim,
} from '../repository-transaction/filesystem-safety.ts';
import { runGit } from '../repository-transaction/git.ts';
import {
  assertHumanResolutionLifecycleBarrier,
  reclaimHumanResolutionJournalTemporaries,
} from '../storage-journal/investigation-session-store.ts';
import { assertGrantLifecycleBarrier } from '../storage-journal/grant-store.ts';
import {
  assertChangeId,
  assertSessionId,
  assertTaskId,
  matchesAllowedPath,
  normalizePolicyPath,
} from './paths.ts';

const MAINTAINER_GRANT_STATE_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const SESSION_LOCK_OWNER_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_REVISION_LEASE_ID =
  /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type TaskSessionResourceLease = Readonly<{
  kind: 'destructive-database' | 'exclusive';
  digest: `sha256:${string}`;
}>;

export type TaskSessionIsolationBinding = Readonly<{
  schemaVersion: 1;
  routingRole: 'single' | 'primary' | 'concurrent';
  routingWorksetDigest: `sha256:${string}`;
  concurrencyEnabled: boolean;
  worktreeDigest: `sha256:${string}`;
  resources: readonly TaskSessionResourceLease[];
}>;

export type OwnedRuntimeFilePublication = Readonly<{
  runtimeRoot: string;
  filePath: string;
  descriptor: number;
  content: string;
}>;

export type TaskSessionIsolationLeaseAcquisitionHooks = Readonly<{
  beforePublication?: (
    input: Readonly<{
      index: number;
      leasePath: string;
    }>,
  ) => void;
}>;

export type TaskSessionIsolationLeaseAcquisition = Readonly<{
  publications: readonly OwnedRuntimeFilePublication[];
}>;

export type WorkflowSession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'revising' | 'aborted' | 'committed';
  changeId: string;
  taskId: string;
  /** Durable top-level task mandate authorization for production sessions. */
  mandateBinding?: {
    schemaVersion: 1;
    mandateTaskId: string;
    mandateId: string;
    mandateDigest: string;
    changeId: string;
    externalAuditRoot: string;
  } | null;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: {
    head: string;
    tree: string;
  };
  artifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  /** Durable worktree, workset, and exclusive-resource lease identities. */
  isolation: TaskSessionIsolationBinding;
  requiredCheckDigests: Record<string, string>;
  /** Engine identity against which the current durable check evidence ran. */
  checkEvidenceEngineDigest?: `sha256:${string}`;
  planningAssurance: PlanningAssuranceBinding | null;
  /** Current same-session planning-authority lease while execution is paused. */
  revisionLeaseId?: string;
  /** Immutable post-implementation semantic reconciliation authority. */
  implementationReconciliationReportId?: string;
  /** Exact engine-owned Git projection authorized by that reconciliation. */
  implementationReconciliationPaths?: string[];
  /** Authenticated reviewer-requested documentation paths for this session. */
  documentationRemediation?: {
    reviewRecordDigests: string[];
    paths: string[];
  };
  createdAt: string;
  latestCheckReportId?: string;
  completionReportId?: string;
  finishReportId?: string;
  commitReportId?: string;
  commitHash?: string;
  committedAt?: string;
  abortedAt?: string;
  abortReason?: string;
};

export function runtimePaths(
  gitCommonDirectory: string,
  runtimeDirectory: string,
) {
  return defaultSessionRuntimeLayoutPort.resolve({
    gitCommonDirectory,
    runtimeDirectory,
  });
}

export function withSessionOperation<T>(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
  operation: () => T,
): T {
  ensurePlainDirectory(runtime.operations);
  const lockPath = path.join(runtime.operations, `${sessionId}.lock`);
  const ownerToken = crypto.randomUUID();
  const content = `${JSON.stringify({
    sessionId,
    ownerToken,
    pid: process.pid,
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        lockPath,
        content,
        ownerToken,
        invalidSessionLock,
      );
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        attempt === 0 &&
        reclaimDeadSessionOperationLock(lockPath, sessionId)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'SESSION_OPERATION_CONFLICT',
          `Session ${sessionId} already has an operation in progress.`,
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }

  try {
    return operation();
  } finally {
    releaseSessionOperationLock(lockPath, descriptor, content);
  }
}

function releaseSessionOperationLock(
  lockPath: string,
  descriptor: number | undefined,
  content: string,
): void {
  if (descriptor === undefined) {
    throw invalidSessionLock();
  }
  try {
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    let observedContent: string | undefined;
    try {
      observedContent = fs.readFileSync(lockPath, 'utf8');
    } catch {
      observedContent = undefined;
    }
    if (
      !owned.isFile() ||
      owned.nlink !== 1 ||
      (owned.mode & 0o777) !== 0o600 ||
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1 ||
      (observed.mode & 0o777) !== 0o600 ||
      observed.dev !== owned.dev ||
      observed.ino !== owned.ino ||
      observedContent !== content ||
      readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content
    ) {
      throw invalidSessionLock();
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  } finally {
    fs.closeSync(descriptor);
  }
}

function reclaimDeadSessionOperationLock(
  lockPath: string,
  expectedSessionId: string,
): boolean {
  const result = reclaimDeadPreparedLock(lockPath, (content) => {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      value.sessionId !== expectedSessionId ||
      typeof value.ownerToken !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      `${JSON.stringify(value)}\n` !== content
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      ownerToken: value.ownerToken,
    };
  });
  return result === 'absent' || result === 'reclaimed';
}

export type RepositoryLifecycleOperationOptions = Readonly<{
  allowMaintainerGrantId?: string;
  allowHumanResolutionGrantId?: string;
  allowHumanResolutionChangeId?: string;
  allowGrantChallengeIds?: readonly string[];
}>;

/**
 * Observe the repository-wide lifecycle admission boundary without acquiring,
 * reclaiming, or publishing authority. Any existing lifecycle owner or
 * reclaimer is reported as a conflict; the mutating operation remains
 * responsible for its bounded dead-owner recovery before revalidating.
 */
export function assertRepositoryLifecyclePreflightAdmission(
  runtime: ReturnType<typeof runtimePaths>,
  requestedChangeId: string,
  options: RepositoryLifecycleOperationOptions = {},
): void {
  const changeId = assertChangeId(requestedChangeId);
  assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
  assertHumanResolutionLifecycleBarrier(
    runtime.root,
    options.allowHumanResolutionGrantId ?? null,
    options.allowHumanResolutionChangeId ?? null,
  );
  assertMaintainerReservationCompatibility(
    runtime,
    options.allowMaintainerGrantId,
  );
  for (const directory of [runtime.sessions, runtime.locks]) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
      assertPlainDirectory(directory);
    }
  }
  const operationsStats = fs.lstatSync(runtime.operations, {
    throwIfNoEntry: false,
  });
  if (operationsStats) {
    assertPlainDirectory(runtime.operations);
    const lifecycleLockName = 'repository-lifecycle.lock';
    if (
      fs
        .readdirSync(runtime.operations)
        .some(
          (name) =>
            name === lifecycleLockName ||
            name.startsWith(`${lifecycleLockName}.reclaim.`),
        )
    ) {
      throw workflowError(
        'REPOSITORY_LIFECYCLE_CONFLICT',
        'Another repository lifecycle transition is in progress.',
        ExitCode.conflict,
      );
    }
  }
  const changeLockName = `${changeId}.lock`;
  if (
    fs.lstatSync(runtime.locks, { throwIfNoEntry: false }) &&
    fs
      .readdirSync(runtime.locks)
      .some(
        (name) =>
          name === changeLockName ||
          name.startsWith(`${changeLockName}.reclaim.`),
      )
  ) {
    throw workflowError(
      'REPOSITORY_LIFECYCLE_CONFLICT',
      `Another lifecycle transition already owns change ${changeId}.`,
      ExitCode.conflict,
    );
  }
}

type RepositoryLifecycleLease = Readonly<{
  assertOwned(): void;
  release(): void;
}>;

export function withRepositoryLifecycleOperation<T>(
  runtime: ReturnType<typeof runtimePaths>,
  operation: (assertOwned: () => void) => T,
  options: RepositoryLifecycleOperationOptions = {},
): T {
  const lease = acquireRepositoryLifecycleLease(runtime, options);
  let result: T;
  try {
    result = operation(lease.assertOwned);
  } catch (operationError) {
    releaseAfterOperationError(lease, operationError);
  }
  lease.release();
  return result!;
}

export async function withRepositoryLifecycleOperationAsync<T>(
  runtime: ReturnType<typeof runtimePaths>,
  operation: (assertOwned: () => void) => Promise<T>,
  options: RepositoryLifecycleOperationOptions = {},
): Promise<T> {
  const lease = acquireRepositoryLifecycleLease(runtime, options);
  let result: T;
  try {
    result = await operation(lease.assertOwned);
  } catch (operationError) {
    releaseAfterOperationError(lease, operationError);
  }
  lease.release();
  return result!;
}

function acquireRepositoryLifecycleLease(
  runtime: ReturnType<typeof runtimePaths>,
  options: RepositoryLifecycleOperationOptions,
): RepositoryLifecycleLease {
  assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
  assertHumanResolutionLifecycleBarrier(
    runtime.root,
    options.allowHumanResolutionGrantId ?? null,
    options.allowHumanResolutionChangeId ?? null,
  );
  ensurePlainDirectory(runtime.operations);
  const lockPath = path.join(runtime.operations, 'repository-lifecycle.lock');
  const ownerToken = crypto.randomUUID();
  const content = `${JSON.stringify({
    kind: 'repository-lifecycle',
    ownerToken,
    pid: process.pid,
  })}\n`;
  let descriptor: number | undefined;
  const assertOwned = () => {
    if (descriptor === undefined) {
      throw invalidRepositoryLifecycleLock(
        'Repository lifecycle lock ownership was lost.',
      );
    }
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    let observedContent: string | undefined;
    try {
      observedContent = fs.readFileSync(lockPath, 'utf8');
    } catch {
      observedContent = undefined;
    }
    if (
      !owned.isFile() ||
      owned.nlink !== 1 ||
      (owned.mode & 0o777) !== 0o600 ||
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1 ||
      (observed.mode & 0o777) !== 0o600 ||
      observed.dev !== owned.dev ||
      observed.ino !== owned.ino ||
      observedContent !== content ||
      readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content
    ) {
      throw invalidRepositoryLifecycleLock(
        'Repository lifecycle lock ownership changed during the transition.',
      );
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        lockPath,
        content,
        ownerToken,
        () =>
          invalidRepositoryLifecycleLock(
            'Repository lifecycle reclaim state is unsafe.',
          ),
      );
      break;
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        attempt === 0 &&
        reclaimDeadRepositoryLifecycleLock(lockPath)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'REPOSITORY_LIFECYCLE_CONFLICT',
          'Another repository lifecycle transition is in progress.',
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw invalidRepositoryLifecycleLock(
      'Repository lifecycle lock could not be acquired.',
    );
  }

  const release = () => {
    try {
      assertOwned();
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      throw error;
    }
    if (descriptor === undefined) {
      throw invalidRepositoryLifecycleLock(
        'Repository lifecycle lock ownership was lost.',
      );
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  };

  try {
    reclaimHumanResolutionJournalTemporaries(runtime.root, assertOwned);
    const assertLifecycleOwned = () => {
      assertOwned();
      assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
      assertHumanResolutionLifecycleBarrier(
        runtime.root,
        options.allowHumanResolutionGrantId ?? null,
        options.allowHumanResolutionChangeId ?? null,
      );
    };
    assertHumanResolutionLifecycleBarrier(
      runtime.root,
      options.allowHumanResolutionGrantId ?? null,
      options.allowHumanResolutionChangeId ?? null,
    );
    assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
    assertMaintainerReservationCompatibility(
      runtime,
      options.allowMaintainerGrantId,
    );
    return { assertOwned: assertLifecycleOwned, release };
  } catch (setupError) {
    try {
      release();
    } catch (releaseError) {
      throw new AggregateError(
        [setupError, releaseError],
        'Repository lifecycle setup and lock release both failed.',
        { cause: releaseError },
      );
    }
    throw setupError;
  }
}

function releaseAfterOperationError(
  lease: RepositoryLifecycleLease,
  operationError: unknown,
): never {
  try {
    lease.release();
  } catch (releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      'Repository lifecycle operation and lock release both failed.',
      { cause: releaseError },
    );
  }
  throw operationError;
}

function reclaimDeadRepositoryLifecycleLock(lockPath: string): boolean {
  const result = reclaimDeadPreparedLock(lockPath, (content) => {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      value.kind !== 'repository-lifecycle' ||
      typeof value.ownerToken !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      `${JSON.stringify(value)}\n` !== content
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      ownerToken: value.ownerToken,
    };
  });
  return result === 'absent' || result === 'reclaimed';
}

function readDescriptorContent(descriptor: number, byteLength: number): string {
  const bytes = Buffer.alloc(byteLength);
  const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
  return bytes.subarray(0, count).toString('utf8');
}

export type TaskWorktreeRegistration = Readonly<{
  worktreePath: string;
  head: string | null;
  branchRef: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}>;

export function assertTaskSessionWorktreeRegistration(
  repositoryRoot: string,
  repositoryRealPath: string,
  branch: string,
  head: string,
): void {
  const expectedWorktree = fs.realpathSync(repositoryRealPath);
  const expectedBranchRef = `refs/heads/${branch}`;
  const registrations = readTaskWorktreeRegistrations(repositoryRoot);
  const current = registrations.filter(
    (registration) =>
      path.resolve(registration.worktreePath) ===
      path.resolve(expectedWorktree),
  );
  if (current.length !== 1) {
    throw taskWorktreeRegistrationInvalid(
      'The current worktree must have one exact Git registration.',
    );
  }
  const currentRegistration = current[0]!;
  const currentStats = fs.lstatSync(currentRegistration.worktreePath, {
    throwIfNoEntry: false,
  });
  if (
    !currentStats?.isDirectory() ||
    currentStats.isSymbolicLink() ||
    fs.realpathSync(currentRegistration.worktreePath) !== expectedWorktree ||
    currentRegistration.head !== head ||
    currentRegistration.branchRef !== expectedBranchRef ||
    currentRegistration.detached ||
    currentRegistration.bare ||
    currentRegistration.prunable
  ) {
    throw taskWorktreeRegistrationInvalid(
      'The current worktree Git registration does not match its exact branch and HEAD.',
    );
  }
  const branchRegistrations = registrations.filter(
    (registration) => registration.branchRef === expectedBranchRef,
  );
  if (branchRegistrations.length !== 1) {
    throw workflowError(
      'TASK_SESSION_WORKTREE_REGISTRATION_CONFLICT',
      `Branch ${branch} has more than one Git worktree registration.`,
      ExitCode.conflict,
      {
        details: {
          branch,
          registrationCount: branchRegistrations.length,
        },
        recovery:
          'Remove or prune the duplicate Git worktree registration explicitly, then rerun task preflight.',
      },
    );
  }
}

function readTaskWorktreeRegistrations(
  repositoryRoot: string,
): TaskWorktreeRegistration[] {
  return parseTaskWorktreeRegistrations(
    runGit(repositoryRoot, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
      '--expire',
      'now',
    ]),
  );
}

export function parseTaskWorktreeRegistrations(
  porcelain: string,
): TaskWorktreeRegistration[] {
  const fields = porcelain.split('\0');
  const registrations: TaskWorktreeRegistration[] = [];
  let current: string[] = [];
  const finish = (): void => {
    if (current.length === 0) return;
    const worktreeField = current[0];
    if (!worktreeField?.startsWith('worktree ')) {
      throw taskWorktreeRegistrationInvalid(
        'Git did not begin a worktree registration with its path.',
      );
    }
    const worktreePath = worktreeField.slice('worktree '.length);
    if (!path.isAbsolute(worktreePath)) {
      throw taskWorktreeRegistrationInvalid(
        'Git returned a non-absolute worktree registration path.',
      );
    }
    let head: string | null;
    let branchRef: string | null;
    let detached: boolean;
    let bare: boolean;
    let metadataOffset: number;
    if (current[1] === 'bare') {
      head = null;
      branchRef = null;
      detached = false;
      bare = true;
      metadataOffset = 2;
    } else {
      const headField = current[1];
      if (!headField?.startsWith('HEAD ')) {
        throw taskWorktreeRegistrationInvalid(
          'Git did not place a worktree HEAD immediately after its path.',
        );
      }
      head = headField.slice('HEAD '.length);
      if (!GIT_OBJECT_ID.test(head)) {
        throw taskWorktreeRegistrationInvalid(
          'Git returned an invalid worktree HEAD.',
        );
      }
      const identityField = current[2];
      if (identityField?.startsWith('branch ')) {
        branchRef = identityField.slice('branch '.length);
        if (!/^refs\/heads\/.+$/u.test(branchRef)) {
          throw taskWorktreeRegistrationInvalid(
            'Git returned a non-local or empty worktree branch registration.',
          );
        }
        detached = false;
      } else if (identityField === 'detached') {
        branchRef = null;
        detached = true;
      } else {
        throw taskWorktreeRegistrationInvalid(
          'Git did not place one branch or detached identity after the worktree HEAD.',
        );
      }
      bare = false;
      metadataOffset = 3;
    }
    let locked = false;
    let prunable = false;
    for (const metadata of current.slice(metadataOffset)) {
      if (metadata === 'locked' || metadata.startsWith('locked ')) {
        if (locked) {
          throw taskWorktreeRegistrationInvalid(
            'Git returned a duplicate worktree locked field.',
          );
        }
        locked = true;
      } else if (metadata === 'prunable' || metadata.startsWith('prunable ')) {
        if (prunable) {
          throw taskWorktreeRegistrationInvalid(
            'Git returned a duplicate worktree prunable field.',
          );
        }
        prunable = true;
      } else {
        throw taskWorktreeRegistrationInvalid(
          'Git returned an unknown or out-of-order worktree registration field.',
        );
      }
    }
    if (locked && prunable) {
      throw taskWorktreeRegistrationInvalid(
        'Git returned a contradictory worktree registration.',
      );
    }
    registrations.push(
      Object.freeze({
        worktreePath: path.resolve(worktreePath),
        head,
        branchRef,
        detached,
        bare,
        locked,
        prunable,
      }),
    );
    current = [];
  };

  for (const field of fields) {
    if (field === '') {
      finish();
      continue;
    }
    current.push(field);
  }
  finish();
  return registrations;
}

function taskWorktreeRegistrationInvalid(message: string) {
  return workflowError(
    'TASK_SESSION_WORKTREE_REGISTRATION_INVALID',
    message,
    ExitCode.staleState,
  );
}

export function createTaskSessionIsolationBinding(
  input: Readonly<{
    routingRole: TaskSessionIsolationBinding['routingRole'];
    routingWorksetDigest: string;
    concurrencyEnabled: boolean;
    repositoryRoot: string;
    resources: readonly Readonly<{
      kind: TaskSessionResourceLease['kind'];
      identity: string;
    }>[];
  }>,
): TaskSessionIsolationBinding {
  if (!isSha256Digest(input.routingWorksetDigest)) {
    throw workflowError(
      'TASK_SESSION_ISOLATION_INVALID',
      'Task-session routing workset identity is invalid.',
      ExitCode.staleState,
    );
  }
  const resources = input.resources
    .map((resource) =>
      Object.freeze({
        kind: resource.kind,
        digest: isolationDigest(resource.kind, resource.identity),
      }),
    )
    .sort((left, right) =>
      `${left.kind}:${left.digest}`.localeCompare(
        `${right.kind}:${right.digest}`,
      ),
    );
  if (
    resources.some(
      (resource, index) =>
        index > 0 &&
        resource.kind === resources[index - 1]!.kind &&
        resource.digest === resources[index - 1]!.digest,
    )
  ) {
    throw workflowError(
      'TASK_SESSION_ISOLATION_INVALID',
      'Task-session exclusive resources must be unique.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    routingRole: input.routingRole,
    routingWorksetDigest: input.routingWorksetDigest,
    concurrencyEnabled: input.concurrencyEnabled,
    worktreeDigest: isolationDigest('worktree', input.repositoryRoot),
    resources: Object.freeze(resources),
  });
}

export function acquireTaskSessionIsolationLeases(
  runtime: ReturnType<typeof runtimePaths>,
  session: Pick<
    WorkflowSession,
    'sessionId' | 'changeId' | 'taskId' | 'isolation'
  >,
  testHooks: TaskSessionIsolationLeaseAcquisitionHooks = {},
): TaskSessionIsolationLeaseAcquisition {
  const acquired: OwnedRuntimeFilePublication[] = [];
  try {
    for (const [index, leasePath] of taskSessionIsolationLeasePaths(
      runtime,
      session,
    ).entries()) {
      testHooks.beforePublication?.({ index, leasePath });
      const observation = observeTaskSessionIsolationLease(runtime, leasePath);
      if (observation.state === 'occupied') {
        throw taskSessionLeaseConflict(leasePath);
      }
      if (observation.state === 'reclaimable') {
        reclaimObservedTaskSessionIsolationLease(observation);
      }
      ensurePlainDirectory(path.dirname(leasePath));
      const ownerToken = crypto.randomUUID();
      const content = `${JSON.stringify({
        sessionId: session.sessionId,
        ownerToken,
        changeId: session.changeId,
        taskId: session.taskId,
        pid: process.pid,
      })}\n`;
      try {
        const descriptor = publishPreparedExclusiveLock(
          leasePath,
          content,
          ownerToken,
          invalidSessionLock,
        );
        acquired.push({
          runtimeRoot: runtime.root,
          filePath: leasePath,
          descriptor,
          content,
        });
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw taskSessionLeaseConflict(leasePath);
        }
        throw error;
      }
    }
    return Object.freeze({ publications: Object.freeze([...acquired]) });
  } catch (error) {
    rollbackRuntimeFilePublications(acquired, error);
    throw error;
  }
}

export function closeTaskSessionIsolationLeaseAcquisition(
  acquisition: TaskSessionIsolationLeaseAcquisition,
): void {
  closeRuntimeFilePublications(acquisition.publications);
}

export function rollbackTaskSessionIsolationLeaseAcquisition(
  acquisition: TaskSessionIsolationLeaseAcquisition,
): void {
  rollbackRuntimeFilePublications(acquisition.publications);
}

export function closeOwnedRuntimeFilePublication(
  publication: OwnedRuntimeFilePublication,
): void {
  fs.closeSync(publication.descriptor);
}

export function assertOwnedRuntimeFilePublication(
  publication: OwnedRuntimeFilePublication,
  makeUnsafeError: () => Error = invalidSessionLock,
): void {
  try {
    if (
      !assertExistingRuntimeDirectoryChain(
        publication.runtimeRoot,
        path.dirname(publication.filePath),
      )
    ) {
      throw makeUnsafeError();
    }
    const before = fs.lstatSync(publication.filePath, {
      throwIfNoEntry: false,
    });
    const owned = fs.fstatSync(publication.descriptor);
    const content = readDescriptorContent(
      publication.descriptor,
      Buffer.byteLength(publication.content),
    );
    const after = fs.lstatSync(publication.filePath, {
      throwIfNoEntry: false,
    });
    if (
      !before?.isFile() ||
      before.isSymbolicLink() ||
      !after?.isFile() ||
      after.isSymbolicLink() ||
      !owned.isFile() ||
      before.dev !== owned.dev ||
      before.ino !== owned.ino ||
      after.dev !== owned.dev ||
      after.ino !== owned.ino ||
      before.nlink !== 1 ||
      owned.nlink !== 1 ||
      after.nlink !== 1 ||
      before.size !== owned.size ||
      after.size !== owned.size ||
      (before.mode & 0o777) !== 0o600 ||
      (owned.mode & 0o777) !== 0o600 ||
      (after.mode & 0o777) !== 0o600 ||
      owned.size !== Buffer.byteLength(publication.content) ||
      content !== publication.content
    ) {
      throw makeUnsafeError();
    }
  } catch (error) {
    if (isNodeError(error)) throw makeUnsafeError();
    throw error;
  }
}

export function rollbackOwnedRuntimeFilePublication(
  publication: OwnedRuntimeFilePublication,
): void {
  try {
    if (
      !assertExistingRuntimeDirectoryChain(
        publication.runtimeRoot,
        path.dirname(publication.filePath),
      )
    ) {
      throw invalidSessionLock();
    }
    withPreparedLockCleanupClaim(publication.filePath, () => {
      const owned = fs.fstatSync(publication.descriptor);
      const observed = fs.lstatSync(publication.filePath, {
        throwIfNoEntry: false,
      });
      if (!observed) return;
      if (observed.dev !== owned.dev || observed.ino !== owned.ino) return;
      if (
        !observed.isFile() ||
        observed.isSymbolicLink() ||
        !owned.isFile() ||
        observed.nlink !== 1 ||
        owned.nlink !== 1 ||
        observed.size !== Buffer.byteLength(publication.content) ||
        owned.size !== Buffer.byteLength(publication.content) ||
        (observed.mode & 0o777) !== 0o600 ||
        (owned.mode & 0o777) !== 0o600 ||
        readDescriptorContent(
          publication.descriptor,
          Buffer.byteLength(publication.content),
        ) !== publication.content
      ) {
        throw invalidSessionLock();
      }
      const final = fs.lstatSync(publication.filePath, {
        throwIfNoEntry: false,
      });
      if (!final) return;
      if (final.dev !== owned.dev || final.ino !== owned.ino) return;
      if (
        !final.isFile() ||
        final.isSymbolicLink() ||
        final.nlink !== 1 ||
        final.size !== Buffer.byteLength(publication.content) ||
        (final.mode & 0o777) !== 0o600 ||
        readDescriptorContent(
          publication.descriptor,
          Buffer.byteLength(publication.content),
        ) !== publication.content
      ) {
        throw invalidSessionLock();
      }
      const stable = fs.lstatSync(publication.filePath, {
        throwIfNoEntry: false,
      });
      if (!stable) return;
      if (stable.dev !== owned.dev || stable.ino !== owned.ino) return;
      if (
        !stable.isFile() ||
        stable.isSymbolicLink() ||
        stable.nlink !== 1 ||
        stable.size !== Buffer.byteLength(publication.content) ||
        (stable.mode & 0o777) !== 0o600
      ) {
        throw invalidSessionLock();
      }
      try {
        fs.unlinkSync(publication.filePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
      fsyncDirectory(path.dirname(publication.filePath));
    });
  } finally {
    fs.closeSync(publication.descriptor);
  }
}

function closeRuntimeFilePublications(
  publications: readonly OwnedRuntimeFilePublication[],
): void {
  const errors: unknown[] = [];
  for (const publication of publications) {
    try {
      closeOwnedRuntimeFilePublication(publication);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Runtime publication descriptors failed to close.',
    );
  }
}

function rollbackRuntimeFilePublications(
  publications: readonly OwnedRuntimeFilePublication[],
  primaryError?: unknown,
): never | void {
  const errors: unknown[] = [];
  for (const publication of [...publications].reverse()) {
    try {
      rollbackOwnedRuntimeFilePublication(publication);
    } catch (error) {
      errors.push(error);
    }
  }
  if (primaryError !== undefined) {
    if (errors.length > 0) {
      throw new AggregateError(
        [primaryError, ...errors],
        'Task-session lease acquisition failed and cleanup was incomplete.',
      );
    }
    throw primaryError;
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Task-session lease cleanup was incomplete.',
    );
  }
}

export function releaseTaskSessionIsolationLeases(
  runtime: ReturnType<typeof runtimePaths>,
  session: Pick<
    WorkflowSession,
    'sessionId' | 'changeId' | 'taskId' | 'isolation'
  >,
): void {
  for (const leasePath of taskSessionIsolationLeasePaths(runtime, session)) {
    releaseOwnedLock(leasePath, session.sessionId);
  }
}

export function assertTaskSessionIsolationLeasesOwned(
  runtime: ReturnType<typeof runtimePaths>,
  session: Pick<
    WorkflowSession,
    'sessionId' | 'changeId' | 'taskId' | 'isolation'
  >,
): void {
  for (const leasePath of taskSessionIsolationLeasePaths(runtime, session)) {
    assertOwnedLock(
      leasePath,
      session.sessionId,
      session.changeId,
      session.taskId,
    );
  }
}

function taskSessionIsolationLeasePaths(
  runtime: ReturnType<typeof runtimePaths>,
  session: Pick<WorkflowSession, 'isolation'>,
): string[] {
  const root = path.join(runtime.root, 'task-isolation');
  return [
    path.join(
      root,
      'worktrees',
      `${session.isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
    ),
    ...session.isolation.resources.map((resource) =>
      path.join(
        root,
        'resources',
        `${resource.digest.slice('sha256:'.length)}.lock`,
      ),
    ),
  ];
}

type StableSessionObservation = Readonly<{
  session: WorkflowSession;
  runtimeRoot: string;
  sessionPath: string;
  dev: number;
  ino: number;
  content: string;
}>;

type TaskSessionLeaseObservation =
  | Readonly<{ state: 'absent'; leasePath: string }>
  | Readonly<{ state: 'occupied'; leasePath: string }>
  | Readonly<{
      state: 'reclaimable';
      leasePath: string;
      dev: number;
      ino: number;
      nlink: number;
      content: string;
      temporaryPath: string | null;
      owner:
        | Readonly<{ kind: 'terminal'; observation: StableSessionObservation }>
        | Readonly<{
            kind: 'missing';
            runtimeRoot: string;
            sessionPath: string;
            pid: number;
          }>;
    }>;

function observeTaskSessionIsolationLease(
  runtime: ReturnType<typeof runtimePaths>,
  leasePath: string,
): TaskSessionLeaseObservation {
  if (
    !assertExistingRuntimeDirectoryChain(runtime.root, path.dirname(leasePath))
  ) {
    return Object.freeze({ state: 'absent', leasePath });
  }
  const before = fs.lstatSync(leasePath, { throwIfNoEntry: false });
  if (!before) return Object.freeze({ state: 'absent', leasePath });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    ![1, 2].includes(before.nlink) ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw invalidSessionLock();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      leasePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.lstatSync(leasePath, { throwIfNoEntry: false });
    const value = parseManagedSessionLock(content);
    if (
      !after ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !opened.isFile() ||
      ![1, 2].includes(opened.nlink) ||
      opened.nlink !== after.nlink ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== Buffer.byteLength(content) ||
      value === null
    ) {
      throw invalidSessionLock();
    }
    try {
      assertSessionId(value.sessionId);
      assertChangeId(value.changeId);
      assertTaskId(value.taskId);
    } catch {
      throw invalidSessionLock();
    }
    const temporaryPath =
      opened.nlink === 2
        ? preparedLockTemporaryPath(leasePath, value.pid, value.ownerToken)
        : null;
    if (temporaryPath !== null) {
      const temporary = fs.lstatSync(temporaryPath, {
        throwIfNoEntry: false,
      });
      if (
        !temporary?.isFile() ||
        temporary.isSymbolicLink() ||
        temporary.dev !== opened.dev ||
        temporary.ino !== opened.ino ||
        temporary.nlink !== 2 ||
        (temporary.mode & 0o777) !== 0o600
      ) {
        throw invalidSessionLock();
      }
    }
    const sessionPath = path.join(runtime.sessions, `${value.sessionId}.json`);
    const owner = observeStableWorkflowSession(runtime.root, sessionPath);
    if (owner === null) {
      return processIsAlive(value.pid)
        ? Object.freeze({ state: 'occupied' as const, leasePath })
        : Object.freeze({
            state: 'reclaimable' as const,
            leasePath,
            dev: opened.dev,
            ino: opened.ino,
            nlink: opened.nlink,
            content,
            temporaryPath,
            owner: Object.freeze({
              kind: 'missing' as const,
              runtimeRoot: runtime.root,
              sessionPath,
              pid: value.pid,
            }),
          });
    }
    if (
      owner.session.changeId !== value.changeId ||
      owner.session.taskId !== value.taskId ||
      !taskSessionIsolationLeasePaths(runtime, owner.session).includes(
        leasePath,
      )
    ) {
      throw invalidSessionLock();
    }
    if (
      owner.session.state === 'active' ||
      owner.session.state === 'revising'
    ) {
      return Object.freeze({ state: 'occupied', leasePath });
    }
    return Object.freeze({
      state: 'reclaimable' as const,
      leasePath,
      dev: opened.dev,
      ino: opened.ino,
      nlink: opened.nlink,
      content,
      temporaryPath,
      owner: Object.freeze({ kind: 'terminal' as const, observation: owner }),
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw invalidSessionLock();
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function observeStableWorkflowSession(
  runtimeRoot: string,
  sessionPath: string,
): StableSessionObservation | null {
  if (
    !assertExistingRuntimeDirectoryChain(runtimeRoot, path.dirname(sessionPath))
  ) {
    return null;
  }
  const before = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
  if (!before) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw invalidSessionLock();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      sessionPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw invalidSessionLock();
    }
    if (
      !after ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== Buffer.byteLength(content) ||
      `${JSON.stringify(value, null, 2)}\n` !== content ||
      !isWorkflowSession(value) ||
      value.sessionId !== path.basename(sessionPath, '.json')
    ) {
      throw invalidSessionLock();
    }
    return Object.freeze({
      session: value,
      runtimeRoot,
      sessionPath,
      dev: opened.dev,
      ino: opened.ino,
      content,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw invalidSessionLock();
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function reclaimObservedTaskSessionIsolationLease(
  observation: Extract<TaskSessionLeaseObservation, { state: 'reclaimable' }>,
): void {
  assertPlainDirectory(path.dirname(observation.leasePath));
  withPreparedLockCleanupClaim(observation.leasePath, () => {
    if (observation.owner.kind === 'terminal') {
      assertStableSessionObservation(observation.owner.observation);
    } else {
      if (
        observeStableWorkflowSession(
          observation.owner.runtimeRoot,
          observation.owner.sessionPath,
        ) !== null ||
        processIsAlive(observation.owner.pid)
      ) {
        throw invalidSessionLock();
      }
    }
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        observation.leasePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const opened = fs.fstatSync(descriptor);
      const content = fs.readFileSync(descriptor, 'utf8');
      const current = fs.lstatSync(observation.leasePath, {
        throwIfNoEntry: false,
      });
      if (
        !current ||
        current.dev !== observation.dev ||
        current.ino !== observation.ino ||
        opened.dev !== observation.dev ||
        opened.ino !== observation.ino ||
        opened.nlink !== observation.nlink ||
        (opened.mode & 0o777) !== 0o600 ||
        content !== observation.content
      ) {
        throw invalidSessionLock();
      }
      if (observation.temporaryPath !== null) {
        const temporary = fs.lstatSync(observation.temporaryPath, {
          throwIfNoEntry: false,
        });
        if (
          !temporary?.isFile() ||
          temporary.dev !== opened.dev ||
          temporary.ino !== opened.ino ||
          temporary.nlink !== 2
        ) {
          throw invalidSessionLock();
        }
        fs.unlinkSync(observation.temporaryPath);
      }
      const final = fs.lstatSync(observation.leasePath, {
        throwIfNoEntry: false,
      });
      if (!final || final.dev !== opened.dev || final.ino !== opened.ino) {
        throw invalidSessionLock();
      }
      fs.unlinkSync(observation.leasePath);
      fsyncDirectory(path.dirname(observation.leasePath));
    } catch (error) {
      if (
        isNodeError(error) &&
        ['ENOENT', 'ELOOP'].includes(error.code ?? '')
      ) {
        throw invalidSessionLock();
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  });
}

function assertStableSessionObservation(
  observation: StableSessionObservation,
): void {
  const current = observeStableWorkflowSession(
    observation.runtimeRoot,
    observation.sessionPath,
  );
  if (
    !current ||
    current.dev !== observation.dev ||
    current.ino !== observation.ino ||
    current.content !== observation.content
  ) {
    throw invalidSessionLock();
  }
}

function assertExistingRuntimeDirectoryChain(
  runtimeRoot: string,
  targetDirectory: string,
): boolean {
  const root = path.resolve(runtimeRoot);
  const target = path.resolve(targetDirectory);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidSessionLock();
  }
  let current = root;
  for (const part of relative === '' ? [] : relative.split(path.sep)) {
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) return false;
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw invalidSessionLock();
    }
    current = path.join(current, part);
  }
  const stats = fs.lstatSync(current, { throwIfNoEntry: false });
  if (!stats) return false;
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(current) !== current
  ) {
    throw invalidSessionLock();
  }
  return true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

function taskSessionLeaseConflict(leasePath: string) {
  return workflowError(
    'TASK_SESSION_LEASE_CONFLICT',
    'A task-session worktree or resource lease is already owned.',
    ExitCode.conflict,
    { details: { lease: path.basename(leasePath) } },
  );
}

function isolationDigest(kind: string, identity: string): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`jigwright.task-session-isolation.v1\n${kind}\n${identity}`)
    .digest('hex')}`;
}

export function listActiveWorkflowSessionIds(
  runtime: ReturnType<typeof runtimePaths>,
): string[] {
  return listActiveWorkflowSessions(runtime).map(
    (session) => session.sessionId,
  );
}

export function assertTaskSessionAdmission(
  runtime: ReturnType<typeof runtimePaths>,
  candidate: Pick<
    WorkflowSession,
    'changeId' | 'repositoryRoot' | 'branch' | 'allowedPaths' | 'isolation'
  >,
): void {
  const active = listActiveWorkflowSessions(runtime);
  if (active.length >= 2) {
    throw workflowError(
      'TASK_SESSION_CAPACITY_REACHED',
      'At most two write-capable task sessions may be active.',
      ExitCode.conflict,
      {
        details: {
          activeSessionIds: active.map((session) => session.sessionId),
        },
      },
    );
  }

  for (const existing of active) {
    if (existing.changeId === candidate.changeId) {
      throw taskSessionIdentityConflict(
        'TASK_SESSION_CHANGE_CONFLICT',
        'Concurrent task writers must belong to different changes.',
        existing,
      );
    }
    if (
      path.resolve(existing.repositoryRoot) ===
      path.resolve(candidate.repositoryRoot)
    ) {
      throw taskSessionIdentityConflict(
        'TASK_SESSION_WORKTREE_CONFLICT',
        'Concurrent task writers must use different worktrees.',
        existing,
      );
    }
    if (existing.branch === candidate.branch) {
      throw taskSessionIdentityConflict(
        'TASK_SESSION_BRANCH_CONFLICT',
        'Concurrent task writers must use different branches.',
        existing,
      );
    }
    if (taskWriteScopesOverlap(existing.allowedPaths, candidate.allowedPaths)) {
      throw workflowError(
        'TASK_SESSION_SCOPE_CONFLICT',
        'Concurrent task writers must declare disjoint write scopes.',
        ExitCode.conflict,
        {
          details: {
            conflictingSessionId: existing.sessionId,
            conflictingChangeId: existing.changeId,
            existingAllowedPaths: [...existing.allowedPaths],
            candidateAllowedPaths: [...candidate.allowedPaths],
          },
        },
      );
    }
    const serializedKinds = taskSerializedScopeKinds(
      existing.allowedPaths,
    ).filter((kind) =>
      taskSerializedScopeKinds(candidate.allowedPaths).includes(kind),
    );
    if (
      serializedKinds.length > 0 &&
      (existing.isolation.concurrencyEnabled ||
        candidate.isolation.concurrencyEnabled)
    ) {
      throw workflowError(
        'TASK_SESSION_SERIALIZED_SCOPE_CONFLICT',
        'Concurrent task writers cannot share a serialized policy, base-spec, generated-document, or remote-effect class.',
        ExitCode.conflict,
        {
          details: {
            conflictingSessionId: existing.sessionId,
            conflictingChangeId: existing.changeId,
            serializedKinds,
          },
        },
      );
    }
    const existingResources = new Set(
      existing.isolation.resources.map(({ digest }) => digest),
    );
    const resourceConflicts = candidate.isolation.resources
      .filter(({ digest }) => existingResources.has(digest))
      .map(({ kind, digest }) => ({ kind, digest }));
    if (resourceConflicts.length > 0) {
      throw workflowError(
        'TASK_SESSION_RESOURCE_CONFLICT',
        'Concurrent task writers must own distinct exclusive resources.',
        ExitCode.conflict,
        {
          details: {
            conflictingSessionId: existing.sessionId,
            conflictingChangeId: existing.changeId,
            resourceConflicts,
          },
        },
      );
    }
  }
  for (const leasePath of taskSessionIsolationLeasePaths(runtime, candidate)) {
    const observation = observeTaskSessionIsolationLease(runtime, leasePath);
    if (observation.state === 'occupied') {
      throw taskSessionLeaseConflict(leasePath);
    }
  }
}

type SerializedTaskScopeKind =
  'base-spec' | 'policy' | 'generated-document' | 'remote-effect';

function taskSerializedScopeKinds(
  allowedPaths: readonly string[],
): SerializedTaskScopeKind[] {
  const definitions: readonly Readonly<{
    kind: SerializedTaskScopeKind;
    root: string;
  }>[] = [
    { kind: 'base-spec', root: 'openspec/specs' },
    { kind: 'policy', root: 'workflow' },
    {
      kind: 'generated-document',
      root: 'docs/CURRENT_AND_NEXT_STEPS.md',
    },
    { kind: 'remote-effect', root: '.github' },
  ];
  return definitions
    .filter(({ root }) =>
      allowedPaths.some((allowedPath) =>
        taskWritePatternsOverlap(allowedPath, `${root}/**`),
      ),
    )
    .map(({ kind }) => kind);
}

function taskSessionIdentityConflict(
  code:
    | 'TASK_SESSION_CHANGE_CONFLICT'
    | 'TASK_SESSION_WORKTREE_CONFLICT'
    | 'TASK_SESSION_BRANCH_CONFLICT',
  message: string,
  existing: WorkflowSession,
) {
  return workflowError(code, message, ExitCode.conflict, {
    details: {
      conflictingSessionId: existing.sessionId,
      conflictingChangeId: existing.changeId,
    },
  });
}

function taskWriteScopesOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((leftPattern) =>
    right.some((rightPattern) =>
      taskWritePatternsOverlap(leftPattern, rightPattern),
    ),
  );
}

function taskWritePatternsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizePolicyPath(left);
  const normalizedRight = normalizePolicyPath(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftPrefix = normalizedLeft.endsWith('/**');
  const rightPrefix = normalizedRight.endsWith('/**');
  if (!leftPrefix && !rightPrefix) return false;
  if (leftPrefix) {
    const rightCandidate = rightPrefix
      ? normalizedRight.slice(0, -3)
      : normalizedRight;
    if (matchesAllowedPath(rightCandidate, normalizedLeft)) return true;
  }
  if (rightPrefix) {
    const leftCandidate = leftPrefix
      ? normalizedLeft.slice(0, -3)
      : normalizedLeft;
    return matchesAllowedPath(leftCandidate, normalizedRight);
  }
  return false;
}

export function listConflictingActiveWorkflowSessionIds(
  runtime: ReturnType<typeof runtimePaths>,
  scope: {
    changeId: string;
    repositoryRoot?: string;
    targetRef?: string;
  },
): string[] {
  const repositoryRoot =
    scope.repositoryRoot === undefined
      ? undefined
      : path.resolve(scope.repositoryRoot);
  const targetBranch = scope.targetRef?.startsWith('refs/heads/')
    ? scope.targetRef.slice('refs/heads/'.length)
    : undefined;
  return listActiveWorkflowSessions(runtime)
    .filter(
      (session) =>
        session.changeId === scope.changeId ||
        (repositoryRoot !== undefined &&
          path.resolve(session.repositoryRoot) === repositoryRoot) ||
        (targetBranch !== undefined && session.branch === targetBranch),
    )
    .map((session) => session.sessionId);
}

function listActiveWorkflowSessions(
  runtime: ReturnType<typeof runtimePaths>,
): WorkflowSession[] {
  const stats = fs.lstatSync(runtime.sessions, { throwIfNoEntry: false });
  if (!stats) {
    return [];
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw workflowError(
      'SESSION_DIRECTORY_UNSAFE',
      'Workflow session directory is unsafe.',
      ExitCode.staleState,
    );
  }
  return fs
    .readdirSync(runtime.sessions)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readSessionFile(path.join(runtime.sessions, entry)))
    .filter(
      (session) => session.state === 'active' || session.state === 'revising',
    )
    .sort((left, right) =>
      left.sessionId < right.sessionId
        ? -1
        : left.sessionId > right.sessionId
          ? 1
          : 0,
    );
}

function assertMaintainerReservationCompatibility(
  runtime: ReturnType<typeof runtimePaths>,
  allowedGrantId: string | undefined,
): void {
  // Maintainer authority remains a repository-wide human-only fence. The
  // change-scoped relaxation applies only to ordinary active sessions.
  const reservedDirectory = path.join(
    runtime.root,
    'maintainer-grants',
    'reserved',
  );
  const stats = fs.lstatSync(reservedDirectory, { throwIfNoEntry: false });
  if (!stats) {
    return;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(reservedDirectory) !== path.resolve(reservedDirectory) ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_STORE_UNSAFE',
      'Maintainer grant reservation storage is unsafe.',
      ExitCode.staleState,
    );
  }
  const entries = fs.readdirSync(reservedDirectory);
  if (entries.some((entry) => !MAINTAINER_GRANT_STATE_FILE.test(entry))) {
    throw workflowError(
      'MAINTAINER_GRANT_STORE_UNSAFE',
      'Maintainer grant reservation storage contains an invalid entry.',
      ExitCode.staleState,
    );
  }
  const reservations = entries
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
  if (
    reservations.length === 0 ||
    (allowedGrantId !== undefined &&
      reservations.length === 1 &&
      reservations[0] === allowedGrantId)
  ) {
    return;
  }
  throw workflowError(
    'ACTIVE_AUTHORITY_CONFLICT',
    'A maintainer authority reservation already owns the repository lifecycle.',
    ExitCode.conflict,
    { details: { grantIds: reservations } },
  );
}

function invalidRepositoryLifecycleLock(message: string) {
  return workflowError(
    'REPOSITORY_LIFECYCLE_LOCK_INVALID',
    message,
    ExitCode.staleState,
  );
}

export function readSessionFile(sessionPath: string): WorkflowSession {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'SESSION_UNREADABLE',
      `Unable to read session: ${path.basename(sessionPath, '.json')}`,
      ExitCode.staleState,
      {
        details: {
          sessionPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }

  if (!isWorkflowSession(value)) {
    throw workflowError(
      'INVALID_SESSION',
      `Session file is malformed: ${sessionPath}`,
      ExitCode.staleState,
    );
  }

  const expectedSessionId = path.basename(sessionPath, '.json');
  if (value.sessionId !== expectedSessionId) {
    throw workflowError(
      'SESSION_ID_MISMATCH',
      `Session content does not match filename ${expectedSessionId}.`,
      ExitCode.staleState,
    );
  }

  return value;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function releaseOwnedLock(lockPath: string, sessionId: string): void {
  withPreparedLockCleanupClaim(lockPath, () => {
    let descriptor: number | undefined;
    try {
      try {
        descriptor = fs.openSync(
          lockPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return;
        }
        throw error;
      }
      const opened = fs.fstatSync(descriptor);
      const content = fs.readFileSync(descriptor, 'utf8');
      const value = parseManagedSessionLock(content);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        value === null
      ) {
        throw invalidSessionLock();
      }
      if (value.sessionId !== sessionId) {
        return;
      }
      const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (
        !observed ||
        observed.dev !== opened.dev ||
        observed.ino !== opened.ino
      ) {
        return;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      fsyncDirectory(path.dirname(lockPath));
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  });
}

export function assertOwnedLock(
  lockPath: string,
  sessionId: string,
  changeId: string,
  taskId: string,
): void {
  let value: ReturnType<typeof parseManagedSessionLock>;
  try {
    value = parseManagedSessionLock(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    throw invalidSessionLock();
  }

  if (
    value?.sessionId !== sessionId ||
    value.changeId !== changeId ||
    value.taskId !== taskId
  ) {
    throw invalidSessionLock();
  }
}

function parseManagedSessionLock(content: string): {
  sessionId: string;
  changeId: string;
  taskId: string;
  ownerToken: string;
  pid: number;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    `${JSON.stringify(value)}\n` !== content
  ) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join('\0') !==
      ['changeId', 'ownerToken', 'pid', 'sessionId', 'taskId'].join('\0') ||
    typeof value.ownerToken !== 'string' ||
    !SESSION_LOCK_OWNER_TOKEN.test(value.ownerToken) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1
  ) {
    return null;
  }
  return value as {
    sessionId: string;
    changeId: string;
    taskId: string;
    ownerToken: string;
    pid: number;
  };
}

export function createSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `session-${timestamp}-${crypto.randomUUID()}`;
}

function isWorkflowSession(value: unknown): value is WorkflowSession {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }
  const allowedFields = new Set([
    'schemaVersion',
    'sessionId',
    'state',
    'changeId',
    'taskId',
    'mandateBinding',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'artifacts',
    'allowedPaths',
    'requiredChecks',
    'isolation',
    'requiredCheckDigests',
    'checkEvidenceEngineDigest',
    'planningAssurance',
    'revisionLeaseId',
    'implementationReconciliationReportId',
    'implementationReconciliationPaths',
    'documentationRemediation',
    'createdAt',
    'latestCheckReportId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
    'commitHash',
    'committedAt',
    'abortedAt',
    'abortReason',
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    return false;
  }
  if (
    typeof value.sessionId !== 'string' ||
    !['active', 'revising', 'aborted', 'committed'].includes(
      String(value.state),
    ) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isRecord(value.baseline) ||
    typeof value.baseline.head !== 'string' ||
    typeof value.baseline.tree !== 'string' ||
    !isStringRecord(value.artifacts) ||
    !isStringArray(value.allowedPaths) ||
    !isStringArray(value.requiredChecks)
  ) {
    return false;
  }
  if (
    value.mandateBinding !== undefined &&
    value.mandateBinding !== null &&
    !isTaskMandateBinding(value.mandateBinding, value.changeId)
  ) {
    return false;
  }
  if (
    !Object.hasOwn(value, 'isolation') ||
    !isTaskSessionIsolationBinding(value.isolation)
  ) {
    return false;
  }
  for (const field of [
    'implementationReconciliationReportId',
    'latestCheckReportId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
  ]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isDigest(fieldValue)) {
      return false;
    }
  }
  if (
    !Object.hasOwn(value, 'requiredCheckDigests') ||
    !isStringRecord(value.requiredCheckDigests)
  ) {
    return false;
  }
  if (
    value.implementationReconciliationPaths !== undefined &&
    (!isStringArray(value.implementationReconciliationPaths) ||
      value.implementationReconciliationPaths.length === 0 ||
      new Set(value.implementationReconciliationPaths).size !==
        value.implementationReconciliationPaths.length ||
      JSON.stringify(value.implementationReconciliationPaths) !==
        JSON.stringify([...value.implementationReconciliationPaths].sort()) ||
      value.implementationReconciliationPaths.some(
        (candidatePath) =>
          !candidatePath.startsWith('workflow/semantic-ledger/') ||
          candidatePath.includes('..'),
      ))
  ) {
    return false;
  }
  if (
    value.implementationReconciliationPaths !== undefined &&
    value.implementationReconciliationReportId === undefined
  ) {
    return false;
  }
  if (
    value.documentationRemediation !== undefined &&
    (!isRecord(value.documentationRemediation) ||
      Object.keys(value.documentationRemediation).sort().join('\0') !==
        ['paths', 'reviewRecordDigests'].join('\0') ||
      !isStringArray(value.documentationRemediation.reviewRecordDigests) ||
      value.documentationRemediation.reviewRecordDigests.length === 0 ||
      value.documentationRemediation.reviewRecordDigests.some(
        (candidate) => !isDigest(candidate),
      ) ||
      !isCanonicalStringSet(
        value.documentationRemediation.reviewRecordDigests,
      ) ||
      !isStringArray(value.documentationRemediation.paths) ||
      value.documentationRemediation.paths.length === 0 ||
      !isCanonicalStringSet(value.documentationRemediation.paths) ||
      value.documentationRemediation.paths.some(
        (candidate) =>
          !isCanonicalDocumentationRemediationPath(candidate) ||
          (!candidate.startsWith('docs/') &&
            !/(?:^|\/)README\.md$/.test(candidate)),
      ))
  ) {
    return false;
  }
  if (
    value.checkEvidenceEngineDigest !== undefined &&
    !isSha256Digest(value.checkEvidenceEngineDigest)
  ) {
    return false;
  }
  if (
    !Object.hasOwn(value, 'planningAssurance') ||
    (value.planningAssurance !== null &&
      !isPlanningAssuranceBinding(value.planningAssurance))
  ) {
    return false;
  }
  if (
    value.revisionLeaseId !== undefined &&
    (typeof value.revisionLeaseId !== 'string' ||
      !TASK_REVISION_LEASE_ID.test(value.revisionLeaseId))
  ) {
    return false;
  }
  if (
    (value.state === 'revising') !==
    (typeof value.revisionLeaseId === 'string')
  ) {
    // An aborted session may retain its terminal lease pointer for audit.
    if (value.state !== 'aborted' || value.revisionLeaseId === undefined) {
      return false;
    }
  }
  if (
    (value.commitHash !== undefined && !isCommitHash(value.commitHash)) ||
    (value.commitReportId === undefined) !== (value.commitHash === undefined)
  ) {
    return false;
  }
  if (
    value.state === 'active' &&
    value.commitReportId !== undefined &&
    (value.finishReportId === undefined || value.committedAt !== undefined)
  ) {
    return false;
  }
  if (
    value.state === 'revising' &&
    (value.latestCheckReportId !== undefined ||
      value.completionReportId !== undefined ||
      value.finishReportId !== undefined ||
      value.commitReportId !== undefined ||
      value.commitHash !== undefined ||
      value.committedAt !== undefined)
  ) {
    return false;
  }
  if (
    value.state === 'aborted' &&
    (typeof value.abortedAt !== 'string' ||
      Number.isNaN(Date.parse(value.abortedAt)) ||
      typeof value.abortReason !== 'string' ||
      !value.abortReason)
  ) {
    return false;
  }
  if (
    value.state === 'committed' &&
    (!isDigest(value.latestCheckReportId) ||
      !isDigest(value.completionReportId) ||
      !isDigest(value.finishReportId) ||
      !isDigest(value.commitReportId) ||
      !isCommitHash(value.commitHash) ||
      typeof value.committedAt !== 'string' ||
      Number.isNaN(Date.parse(value.committedAt)))
  ) {
    return false;
  }
  return true;
}

function isTaskSessionIsolationBinding(
  value: unknown,
): value is TaskSessionIsolationBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'concurrencyEnabled',
        'resources',
        'routingRole',
        'routingWorksetDigest',
        'schemaVersion',
        'worktreeDigest',
      ]
        .sort()
        .join('\0') ||
    value.schemaVersion !== 1 ||
    !['single', 'primary', 'concurrent'].includes(String(value.routingRole)) ||
    typeof value.concurrencyEnabled !== 'boolean' ||
    !isSha256Digest(value.routingWorksetDigest) ||
    !isSha256Digest(value.worktreeDigest) ||
    !Array.isArray(value.resources)
  ) {
    return false;
  }
  const resources = value.resources;
  if (
    resources.some(
      (resource) =>
        !isRecord(resource) ||
        Object.keys(resource).sort().join('\0') !== 'digest\0kind' ||
        !['destructive-database', 'exclusive'].includes(
          String(resource.kind),
        ) ||
        !isSha256Digest(resource.digest),
    )
  ) {
    return false;
  }
  const identities = resources.map(
    (resource) => `${String(resource.kind)}:${String(resource.digest)}`,
  );
  return (
    new Set(identities).size === identities.length &&
    JSON.stringify(identities) === JSON.stringify([...identities].sort())
  );
}

function isCanonicalDocumentationRemediationPath(candidate: string): boolean {
  try {
    return (
      normalizePolicyPath(candidate) === candidate && !candidate.endsWith('/**')
    );
  } catch {
    return false;
  }
}

function isTaskMandateBinding(value: unknown, changeId: string): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.join('\0') !==
    [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'mandateTaskId',
      'schemaVersion',
    ]
      .sort()
      .join('\0')
  ) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    value.changeId === changeId &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    typeof value.mandateTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    isDigest(value.mandateDigest)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isCommitHash(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isCanonicalStringSet(value: string[]): boolean {
  return (
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function invalidSessionLock() {
  return workflowError(
    'SESSION_LOCK_INVALID',
    'The active session lock is missing or does not match the session.',
    ExitCode.staleState,
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
