/**
 * Discovers repository state and fingerprints tracked, changed, and ignored worktree content.
 *
 * Invariants:
 * - Projection framing and excluded-path handling retain the existing bytes and ordering.
 * - Discovery rejects hidden index state and uses the same controlled untracked paths.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError, WorkflowError, } from "../../foundation/errors/errors.js";
import { normalizeChangedPath } from "../../foundation/repository-path/repository-path.js";
import { runGit } from "./git-command.js";
import { fingerprintIgnoredEntry, fingerprintStats, fingerprintTrackedEntry, updateFramed, } from "./git-projection-files.js";
import { hasHiddenIndexFlag, listControlledUntrackedPaths, listRepositoryIgnoredPaths, listTrackedPaths, listTrackedPathsAtCommit, splitNull, } from "./git-tracked-paths.js";
export function discoverRepository(cwd) {
    const repositoryRoot = runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
    const repositoryRealPath = fs.realpathSync(repositoryRoot);
    const commonDirectoryValue = runGit(repositoryRoot, [
        'rev-parse',
        '--git-common-dir',
    ]).trim();
    const gitCommonDirectory = fs.realpathSync(path.isAbsolute(commonDirectoryValue)
        ? commonDirectoryValue
        : path.resolve(repositoryRoot, commonDirectoryValue));
    const branchValue = runGit(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true).trim();
    const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const tree = runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']).trim();
    const hiddenIndexEntries = splitNull(runGit(repositoryRoot, ['ls-files', '-v', '-z'])).filter(hasHiddenIndexFlag);
    if (hiddenIndexEntries.length > 0) {
        throw workflowError('UNSAFE_INDEX_FLAGS', 'Git index contains assume-unchanged or skip-worktree entries.', ExitCode.unsafeEnvironment, {
            details: {
                entryCount: hiddenIndexEntries.length,
                paths: hiddenIndexEntries.map((entry) => entry.slice(2)),
            },
            recovery: 'Clear assume-unchanged and skip-worktree flags before using the workflow.',
        });
    }
    const rawStatus = runGit(repositoryRoot, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
    ]);
    const controlledUntrackedPaths = listControlledUntrackedPaths(repositoryRoot);
    return {
        repositoryRoot,
        repositoryRealPath,
        gitCommonDirectory,
        branch: branchValue || null,
        head,
        tree,
        statusEntries: [
            ...splitNull(rawStatus),
            ...controlledUntrackedPaths.map((entry) => `controlled-untracked:${entry}`),
        ],
    };
}
export function listChangedPaths(repositoryRoot, baselineHead) {
    const diffPaths = splitNull(runGit(repositoryRoot, [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        '--diff-filter=ACDMRTUXB',
        baselineHead,
        '--',
    ]));
    const untrackedPaths = listControlledUntrackedPaths(repositoryRoot);
    return [
        ...new Set([...diffPaths, ...untrackedPaths].map(normalizeChangedPath)),
    ].sort();
}
export function fingerprintWorkingState(repositoryRoot, baselineHead, statusEntries) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, true);
}
// macOS may rewrite com.apple.provenance asynchronously without changing the
// Git projection. Persisted evidence therefore omits tracked and controlled-
// changed entry ctime only on Darwin; check mutation detection stays strict.
export function fingerprintRepositoryProjection(repositoryRoot, baselineHead, statusEntries) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, process.platform !== 'darwin', true);
}
export function fingerprintRepositoryProjectionExcludingPaths(repositoryRoot, baselineHead, statusEntries, excludedPaths) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, process.platform !== 'darwin', true, false, undefined, new Set(excludedPaths));
}
/**
 * Reconstruct the repository projection that existed before workflow-owned
 * staging. The caller must separately prove that the pinned candidate was
 * created from an empty managed index and that the current index is the exact
 * candidate tree. This keeps report currentness sensitive to worktree and
 * ignored-path drift without treating the later staging phase as candidate
 * mutation.
 */
export function fingerprintUnstagedRepositoryProjection(repositoryRoot, baselineHead, statusEntries) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, process.platform !== 'darwin', true, true, '');
}
export function fingerprintRepositoryWorktree(repositoryRoot, baselineHead) {
    return fingerprintState(repositoryRoot, baselineHead, [], process.platform !== 'darwin', false, true);
}
function fingerprintState(repositoryRoot, baselineHead, statusEntries, includeVolatileMetadata, includeIndex = true, trackedFromBaseline = false, pinnedIndexState, excludedPaths = new Set()) {
    try {
        const digest = crypto.createHash('sha256');
        const trackedPaths = (trackedFromBaseline
            ? listTrackedPathsAtCommit(repositoryRoot, baselineHead)
            : listTrackedPaths(repositoryRoot)).filter((entry) => !excludedPaths.has(entry));
        const changedPaths = listChangedPaths(repositoryRoot, baselineHead).filter((entry) => !excludedPaths.has(entry));
        const ignoredPaths = listRepositoryIgnoredPaths(repositoryRoot).filter((entry) => !excludedPaths.has(entry));
        if (includeIndex) {
            const indexState = pinnedIndexState ??
                runGit(repositoryRoot, [
                    'diff',
                    '--cached',
                    '--raw',
                    '-z',
                    baselineHead,
                    '--',
                ]);
            updateFramed(digest, 'index', indexState);
            for (const statusEntry of statusEntries) {
                if (statusEntryNamesExcludedPath(statusEntry, excludedPaths))
                    continue;
                updateFramed(digest, 'status', statusEntry);
            }
        }
        for (const trackedPath of trackedPaths) {
            updateFramed(digest, 'tracked-path', trackedPath);
            fingerprintTrackedEntry(digest, repositoryRoot, trackedPath, includeVolatileMetadata);
        }
        for (const changedPath of changedPaths) {
            updateFramed(digest, 'changed-path', changedPath);
            const absolutePath = path.join(repositoryRoot, changedPath);
            const stats = fs.lstatSync(absolutePath, {
                bigint: true,
                throwIfNoEntry: false,
            });
            if (!stats) {
                updateFramed(digest, 'changed-kind', 'missing');
                continue;
            }
            updateFramed(digest, 'changed-stat', fingerprintStats(stats, includeVolatileMetadata));
            if (stats.isSymbolicLink()) {
                updateFramed(digest, 'changed-kind', 'symlink');
                updateFramed(digest, 'changed-link', fs.readlinkSync(absolutePath));
            }
            else if (stats.isFile()) {
                updateFramed(digest, 'changed-kind', 'file');
                updateFramed(digest, 'changed-content', fs.readFileSync(absolutePath));
            }
            else if (stats.isDirectory()) {
                updateFramed(digest, 'changed-kind', 'directory');
            }
            else {
                throw new Error('unsupported changed filesystem entry');
            }
        }
        for (const ignoredPath of ignoredPaths) {
            updateFramed(digest, 'ignored-path', ignoredPath);
            fingerprintIgnoredEntry(digest, repositoryRoot, ignoredPath);
        }
        return digest.digest('hex');
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw error;
        }
        throw workflowError('WORKTREE_FINGERPRINT_FAILED', 'Unable to fingerprint the current Git working state safely.', ExitCode.staleState);
    }
}
function statusEntryNamesExcludedPath(entry, excludedPaths) {
    for (const excludedPath of excludedPaths) {
        if (entry === `controlled-untracked:${excludedPath}` ||
            entry === `? ${excludedPath}` ||
            entry === `! ${excludedPath}` ||
            entry.endsWith(` ${excludedPath}`)) {
            return true;
        }
    }
    return false;
}
