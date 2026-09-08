/**
 * Fingerprints planning artifacts and selected governed runtime directory closures.
 *
 * Invariants:
 * - Selected roots, path framing, and volatile metadata choices stay unchanged.
 * - Recursive traversal preserves entry, depth, and byte checks before consuming content.
 *
 * Depends on: bounded projection files, runtime input descriptors, and filesystem metadata.
 * Failure modes: runtime drift is omitted or unrelated artifacts alter a provider projection.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { consumeProjectionEntries, fingerprintStats, INCLUDE_VOLATILE_PROJECTION_METADATA, MAX_GOVERNED_PROJECTION_DEPTH, readDirectoryEntriesBounded, updateFramed, updateFramedFile, } from "./git-projection-files.js";
export function digestPlanningArtifactsProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    digestPlanningTree(digest, repositoryRoot, 'openspec/changes', budget, 0);
    return digest.digest('hex');
}
function digestPlanningTree(digest, repositoryRoot, relativeDirectory, budget, depth) {
    if (depth > MAX_GOVERNED_PROJECTION_DEPTH) {
        throw new Error('Governed projection directory depth exceeded.');
    }
    const absolute = path.join(repositoryRoot, relativeDirectory);
    const directoryStats = fs.lstatSync(absolute, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!directoryStats?.isDirectory()) {
        updateFramed(digest, 'planning-missing', relativeDirectory);
        return;
    }
    const entries = readDirectoryEntriesBounded(absolute, budget);
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const childRelative = path.join(relativeDirectory, entry.name);
        updateFramed(digest, 'planning-path', childRelative);
        const absoluteChild = path.join(repositoryRoot, childRelative);
        if (entry.isSymbolicLink()) {
            updateFramed(digest, 'planning-kind', 'symlink');
            updateFramed(digest, 'planning-link', fs.readlinkSync(absoluteChild));
        }
        else if (entry.isDirectory()) {
            updateFramed(digest, 'planning-kind', 'directory');
            digestPlanningTree(digest, repositoryRoot, childRelative, budget, depth + 1);
        }
        else if (entry.isFile()) {
            updateFramed(digest, 'planning-kind', 'file');
            const childStats = fs.lstatSync(absoluteChild, {
                bigint: true,
                throwIfNoEntry: false,
            });
            if (!childStats?.isFile()) {
                throw new Error('Planning entry changed while being fingerprinted.');
            }
            updateFramedFile(digest, 'planning-content', absoluteChild, childStats, budget);
        }
        else {
            updateFramed(digest, 'planning-kind', 'other');
        }
    }
}
export function digestGovernedRuntimeInputs(inputs, budget) {
    const digest = crypto.createHash('sha256');
    const sorted = [...inputs].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    consumeProjectionEntries(budget, sorted.length);
    for (const input of sorted) {
        updateFramed(digest, 'runtime-id', input.id);
        updateFramed(digest, 'runtime-kind', input.kind ?? 'file');
        if (input.kind === 'directory-closure') {
            const expectedFiles = new Set(input.expectedFiles);
            const mutableContentPaths = new Set(input.mutableContentPaths);
            if (expectedFiles.size !== input.expectedFiles.length ||
                mutableContentPaths.size !== input.mutableContentPaths.length ||
                [...expectedFiles, ...mutableContentPaths].some((relativePath) => relativePath === '' ||
                    relativePath === '..' ||
                    path.isAbsolute(relativePath) ||
                    path.posix.normalize(relativePath) !== relativePath ||
                    relativePath.startsWith('../') ||
                    relativePath.includes('\\') ||
                    relativePath.includes('\0') ||
                    relativePath.includes('/')) ||
                [...mutableContentPaths].some((relativePath) => !expectedFiles.has(relativePath))) {
                throw new Error('Invalid governed runtime directory policy.');
            }
            fingerprintRuntimeDirectoryClosure(digest, input.path, expectedFiles, mutableContentPaths, budget);
        }
        else {
            fingerprintWorktreeEntry(digest, input.path, 'runtime', true, budget);
        }
    }
    return digest.digest('hex');
}
function fingerprintRuntimeDirectoryClosure(digest, absoluteDirectory, expectedFiles, mutableContentPaths, budget) {
    const directoryStats = fs.lstatSync(absoluteDirectory, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!directoryStats?.isDirectory() || directoryStats.isSymbolicLink()) {
        updateFramed(digest, 'runtime-tree-kind', directoryStats ? 'not-directory' : 'missing');
        return;
    }
    updateFramed(digest, 'runtime-tree-directory-stat', fingerprintStats(directoryStats, INCLUDE_VOLATILE_PROJECTION_METADATA));
    const entryNames = [];
    let unexpectedEntry = false;
    const directory = fs.opendirSync(absoluteDirectory);
    try {
        for (;;) {
            const entry = directory.readSync();
            if (!entry) {
                break;
            }
            consumeProjectionEntries(budget, 1);
            if (!expectedFiles.has(entry.name)) {
                unexpectedEntry = true;
                break;
            }
            entryNames.push(entry.name);
        }
    }
    finally {
        directory.closeSync();
    }
    if (unexpectedEntry) {
        updateFramed(digest, 'runtime-tree-kind', 'unexpected-entry');
        return;
    }
    entryNames.sort();
    for (const entryName of entryNames) {
        updateFramed(digest, 'runtime-tree-entry', entryName);
    }
    for (const relativePath of [...expectedFiles].sort()) {
        const absolutePath = path.join(absoluteDirectory, relativePath);
        updateFramed(digest, 'runtime-tree-path', relativePath);
        const stats = fs.lstatSync(absolutePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (!stats) {
            updateFramed(digest, 'runtime-tree-kind', 'missing');
        }
        else if (stats.isSymbolicLink()) {
            updateFramed(digest, 'runtime-tree-kind', 'symlink');
            updateFramed(digest, 'runtime-tree-link', fs.readlinkSync(absolutePath));
        }
        else if (stats.isFile()) {
            updateFramed(digest, 'runtime-tree-kind', 'file');
            if (mutableContentPaths.has(relativePath)) {
                updateFramed(digest, 'runtime-tree-mutable-file-identity', [
                    stats.dev,
                    stats.ino,
                    stats.mode,
                    stats.nlink,
                    stats.uid,
                    stats.gid,
                ].join(':'));
            }
            else {
                updateFramed(digest, 'runtime-tree-file-stat', fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
                updateFramedFile(digest, 'runtime-tree-file-content', absolutePath, stats, budget);
            }
        }
        else {
            updateFramed(digest, 'runtime-tree-kind', 'other');
            updateFramed(digest, 'runtime-tree-other-stat', fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
        }
    }
}
export function fingerprintWorktreeEntry(digest, absolutePath, domain, includeContent, budget) {
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, `${domain}-kind`, 'missing');
        return;
    }
    updateFramed(digest, `${domain}-stat`, fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, `${domain}-kind`, 'symlink');
        updateFramed(digest, `${domain}-link`, fs.readlinkSync(absolutePath));
    }
    else if (stats.isFile()) {
        updateFramed(digest, `${domain}-kind`, 'file');
        if (includeContent) {
            updateFramedFile(digest, `${domain}-content`, absolutePath, stats, budget);
        }
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, `${domain}-kind`, 'directory');
    }
    else {
        updateFramed(digest, `${domain}-kind`, 'other');
    }
}
