/**
 * Acquires and reclaims task worktree and exclusive-resource leases with durable owner observations.
 *
 * Invariants:
 * - Lease reclamation requires the same stable session and dead owner observations.
 * - Partial acquisition rolls back only owned publications and preserves descriptor cleanup order.
 */
import {
  ensurePlainDirectory,
  publishPreparedExclusiveLock,
  withPreparedLockCleanupClaim,
  preparedLockTemporaryPath,
  assertPlainDirectory,
} from '../repository-transaction/filesystem-safety.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type runtimePaths,
  type WorkflowSession,
  isWorkflowSession,
} from './workflow-session-records.ts';
import {
  invalidSessionLock,
  isNodeError,
  readDescriptorContent,
  fsyncDirectory,
} from './session-store-values.ts';
import fs from 'node:fs';
import {
  releaseOwnedLock,
  assertOwnedLock,
  parseManagedSessionLock,
} from './session-operation-locks.ts';
import { assertSessionId, assertChangeId, assertTaskId } from './paths.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

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

export function taskSessionIsolationLeasePaths(
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

export function observeTaskSessionIsolationLease(
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

export function taskSessionLeaseConflict(leasePath: string) {
  return workflowError(
    'TASK_SESSION_LEASE_CONFLICT',
    'A task-session worktree or resource lease is already owned.',
    ExitCode.conflict,
    { details: { lease: path.basename(leasePath) } },
  );
}
