/**
 * Executes the pinned Git binary with trusted environments and bounded approval timing.
 *
 * Invariants:
 * - Executable identity, subprocess errors, and text or buffer output handling remain unchanged.
 * - Every protected Git subprocess observes the active admission deadline.
 *
 * Depends on: trusted execution environments, pinned executable resolution, and approval budgets.
 * Failure modes: Git runs with different authority or command timeouts escape the approval boundary.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { createTrustedExecutionEnvironment } from '../provider-execution/execution-environment.ts';
import {
  activePostApprovalGitTimeout,
  isProcessTimeout,
  postApprovalAdmissionTimeout,
} from './post-approval-budget.ts';

export function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): string {
  return executeGit(cwd, args, allowFailure, {});
}

/**
 * Read one exact tracked path from a pinned Git tree or commit. Missing paths
 * remain distinguishable from empty files, and the literal tree lookup prevents
 * pathspec expansion before the blob is read.
 */
export function readFileAtCommit(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string | undefined {
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${filePath}`,
  ]);
  return listing
    ? runGit(repositoryRoot, ['show', `${commit}:${filePath}`])
    : undefined;
}

/**
 * The remote-tracking ref for a protected branch. Authority operations resolve
 * the protected base through this single spelling rather than a bare local
 * branch, whose freshness is not a contract; both maintainer attestation and
 * archive eligibility consume it so the rule cannot diverge.
 */
export function protectedBranchRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

export function runGitWithEnvironment(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): string {
  return executeGit(cwd, args, false, environment);
}

function executeGit(
  cwd: string,
  args: string[],
  allowFailure: boolean,
  environment: NodeJS.ProcessEnv,
): string {
  const executable = resolveGitExecutable();
  const postApprovalTimeout = activePostApprovalGitTimeout(args);
  const commandArgs =
    args[0] === 'diff'
      ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
      : args;
  const result = spawnSync(
    executable,
    [
      '--no-pager',
      '--no-optional-locks',
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.fileMode=true',
      '-C',
      cwd,
      ...commandArgs,
    ],
    {
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      timeout: postApprovalTimeout?.processTimeoutMs,
      env: {
        ...createTrustedExecutionEnvironment([executable]),
        ...environment,
      },
    },
  );

  if (result.error) {
    if (postApprovalTimeout !== undefined && isProcessTimeout(result.error)) {
      throw postApprovalAdmissionTimeout();
    }
    throw workflowError(
      'GIT_EXECUTION_FAILED',
      `Unable to run Git: ${result.error.message}`,
      ExitCode.unsafeEnvironment,
      { details: { args } },
    );
  }

  if (result.status !== 0 && !allowFailure) {
    throw workflowError(
      'GIT_COMMAND_FAILED',
      `Git command failed: git ${args.join(' ')}`,
      ExitCode.unsafeEnvironment,
      {
        details: {
          args,
          status: result.status,
          stderr: result.stderr.trim(),
        },
      },
    );
  }

  return result.stdout;
}

/**
 * Binary-safe trusted Git primitive for reading pinned objects. It shares the
 * resolved absolute system Git, `shell:false`, clean trusted environment, and
 * the no-pager/locks/replace-objects/fsmonitor hardening, returns raw stdout as
 * a Buffer, accepts optional Buffer stdin (for batched `cat-file`), and adds
 * `GIT_NO_LAZY_FETCH=1` so object reads never trigger a network fetch. It never
 * searches the caller PATH and never runs a shell.
 */
export function runGitBuffer(
  cwd: string,
  args: string[],
  options: {
    input?: Buffer;
    allowFailure?: boolean;
    timeoutMs?: number;
  } = {},
): Buffer {
  const requestedTimeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
    throw workflowError(
      'GIT_TIMEOUT_INVALID',
      'Git timeout must be a positive integer number of milliseconds.',
      ExitCode.usage,
      { details: { timeoutMs: requestedTimeoutMs } },
    );
  }
  const postApprovalTimeout = activePostApprovalGitTimeout(args);
  const timeoutMs =
    postApprovalTimeout === undefined ||
    postApprovalTimeout.processTimeoutMs === undefined
      ? requestedTimeoutMs
      : Math.min(requestedTimeoutMs, postApprovalTimeout.processTimeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw workflowError(
      'GIT_TIMEOUT_INVALID',
      'Git timeout must be a positive integer number of milliseconds.',
      ExitCode.usage,
      { details: { timeoutMs } },
    );
  }
  const executable = resolveGitExecutable();
  const commandArgs =
    args[0] === 'diff'
      ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
      : args;
  const result = spawnSync(
    executable,
    [
      '--no-pager',
      '--no-optional-locks',
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.fileMode=true',
      '-C',
      cwd,
      ...commandArgs,
    ],
    {
      shell: false,
      maxBuffer: 80 * 1024 * 1024,
      timeout: timeoutMs,
      input: options.input,
      env: {
        ...createTrustedExecutionEnvironment([executable]),
        GIT_NO_LAZY_FETCH: '1',
      },
    },
  );

  if (result.error) {
    if (postApprovalTimeout !== undefined && isProcessTimeout(result.error)) {
      throw postApprovalAdmissionTimeout();
    }
    throw workflowError(
      'GIT_EXECUTION_FAILED',
      `Unable to run Git: ${result.error.message}`,
      ExitCode.unsafeEnvironment,
      { details: { args } },
    );
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw workflowError(
      'GIT_COMMAND_FAILED',
      `Git command failed: git ${args.join(' ')}`,
      ExitCode.unsafeEnvironment,
      {
        details: {
          args,
          status: result.status,
          stderr: result.stderr?.toString('utf8').trim(),
        },
      },
    );
  }

  return result.stdout;
}

let pinnedGitExecutable: string | undefined;

export function resolveGitExecutable(): string {
  if (pinnedGitExecutable) {
    return pinnedGitExecutable;
  }

  for (const candidate of gitExecutableCandidates()) {
    try {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      pinnedGitExecutable = fs.realpathSync(candidate);
      return pinnedGitExecutable;
    } catch {
      continue;
    }
  }

  throw workflowError(
    'GIT_EXECUTABLE_UNAVAILABLE',
    'Git is not available from a trusted system location.',
    ExitCode.unsafeEnvironment,
  );
}

function gitExecutableCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)'];
    return programFiles.flatMap((directory) => [
      path.join(directory, 'Git', 'cmd', 'git.exe'),
      path.join(directory, 'Git', 'bin', 'git.exe'),
    ]);
  }
  return ['/usr/bin/git', '/bin/git'];
}
