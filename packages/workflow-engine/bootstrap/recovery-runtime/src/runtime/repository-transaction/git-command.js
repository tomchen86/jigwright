/**
 * Executes the pinned Git binary with trusted environments and bounded approval timing.
 *
 * Invariants:
 * - Executable identity, subprocess errors, and text or buffer output handling remain unchanged.
 * - Every protected Git subprocess observes the active admission deadline.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { createTrustedExecutionEnvironment } from "../process-environment/execution-environment.js";
import { activePostApprovalGitTimeout, isProcessTimeout, postApprovalAdmissionTimeout, } from "./post-approval-budget.js";
export function runGit(cwd, args, allowFailure = false) {
    return executeGit(cwd, args, allowFailure, {});
}
/**
 * Read one exact tracked path from a pinned Git tree or commit. Missing paths
 * remain distinguishable from empty files, and the literal tree lookup prevents
 * pathspec expansion before the blob is read.
 */
/** Raw bytes of the blob at `objectId`. */
export function readBlobBytes(repositoryRoot, objectId) {
    return runGitBuffer(repositoryRoot, ['cat-file', 'blob', objectId]);
}
/** Text of the annotated tag object at `ref`. */
export function readTagObject(repositoryRoot, ref) {
    return runGit(repositoryRoot, ['cat-file', 'tag', ref]);
}
/**
 * Content of `filePath` at `revision`. Unlike readFileAtCommit this requires
 * the path to exist and lets Git's own failure surface.
 */
export function readFileAtRevision(repositoryRoot, revision, filePath) {
    return runGit(repositoryRoot, ['show', `${revision}:${filePath}`]);
}
export function readFileAtCommit(repositoryRoot, commit, filePath) {
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
export function protectedBranchRef(branch) {
    return `refs/remotes/origin/${branch}`;
}
export function runGitWithEnvironment(cwd, args, environment) {
    return executeGit(cwd, args, false, environment);
}
function executeGit(cwd, args, allowFailure, environment) {
    const executable = resolveGitExecutable();
    const postApprovalTimeout = activePostApprovalGitTimeout(args);
    const commandArgs = args[0] === 'diff'
        ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
        : args;
    const result = spawnSync(executable, [
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
    ], {
        encoding: 'utf8',
        shell: false,
        maxBuffer: 64 * 1024 * 1024,
        timeout: postApprovalTimeout?.processTimeoutMs,
        env: {
            ...createTrustedExecutionEnvironment([executable]),
            ...environment,
        },
    });
    if (result.error) {
        if (postApprovalTimeout !== undefined && isProcessTimeout(result.error)) {
            throw postApprovalAdmissionTimeout();
        }
        throw workflowError('GIT_EXECUTION_FAILED', `Unable to run Git: ${result.error.message}`, ExitCode.unsafeEnvironment, { details: { args } });
    }
    if (result.status !== 0 && !allowFailure) {
        throw workflowError('GIT_COMMAND_FAILED', `Git command failed: git ${args.join(' ')}`, ExitCode.unsafeEnvironment, {
            details: {
                args,
                status: result.status,
                stderr: result.stderr.trim(),
            },
        });
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
export function runGitBuffer(cwd, args, options = {}) {
    const requestedTimeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
        throw workflowError('GIT_TIMEOUT_INVALID', 'Git timeout must be a positive integer number of milliseconds.', ExitCode.usage, { details: { timeoutMs: requestedTimeoutMs } });
    }
    const postApprovalTimeout = activePostApprovalGitTimeout(args);
    const timeoutMs = postApprovalTimeout === undefined ||
        postApprovalTimeout.processTimeoutMs === undefined
        ? requestedTimeoutMs
        : Math.min(requestedTimeoutMs, postApprovalTimeout.processTimeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw workflowError('GIT_TIMEOUT_INVALID', 'Git timeout must be a positive integer number of milliseconds.', ExitCode.usage, { details: { timeoutMs } });
    }
    const executable = resolveGitExecutable();
    const commandArgs = args[0] === 'diff'
        ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
        : args;
    const result = spawnSync(executable, [
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
    ], {
        shell: false,
        maxBuffer: 80 * 1024 * 1024,
        timeout: timeoutMs,
        input: options.input,
        env: {
            ...createTrustedExecutionEnvironment([executable]),
            GIT_NO_LAZY_FETCH: '1',
        },
    });
    if (result.error) {
        if (postApprovalTimeout !== undefined && isProcessTimeout(result.error)) {
            throw postApprovalAdmissionTimeout();
        }
        throw workflowError('GIT_EXECUTION_FAILED', `Unable to run Git: ${result.error.message}`, ExitCode.unsafeEnvironment, { details: { args } });
    }
    if (result.status !== 0 && !options.allowFailure) {
        throw workflowError('GIT_COMMAND_FAILED', `Git command failed: git ${args.join(' ')}`, ExitCode.unsafeEnvironment, {
            details: {
                args,
                status: result.status,
                stderr: result.stderr?.toString('utf8').trim(),
            },
        });
    }
    return result.stdout;
}
let pinnedGitExecutable;
export function resolveGitExecutable() {
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
        }
        catch {
            continue;
        }
    }
    throw workflowError('GIT_EXECUTABLE_UNAVAILABLE', 'Git is not available from a trusted system location.', ExitCode.unsafeEnvironment);
}
function gitExecutableCandidates() {
    if (process.platform === 'win32') {
        const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)'];
        return programFiles.flatMap((directory) => [
            path.join(directory, 'Git', 'cmd', 'git.exe'),
            path.join(directory, 'Git', 'bin', 'git.exe'),
        ]);
    }
    return ['/usr/bin/git', '/bin/git'];
}
