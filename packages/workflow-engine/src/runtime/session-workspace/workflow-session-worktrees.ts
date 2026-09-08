/**
 * Binds task sessions to registered Git worktrees and deterministic isolation identities.
 *
 * Invariants:
 * - Registrations preserve exact worktree, branch, lock, and object-identity validation.
 * - Resource and worktree digests retain their original canonical inputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { runGit } from '../repository-transaction/git.ts';
import { GIT_OBJECT_ID, isSha256Digest } from './session-store-values.ts';
import type {
  TaskSessionIsolationBinding,
  TaskSessionResourceLease,
} from './workflow-session-records.ts';
import crypto from 'node:crypto';

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

function isolationDigest(kind: string, identity: string): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`jigwright.task-session-isolation.v1\n${kind}\n${identity}`)
    .digest('hex')}`;
}
