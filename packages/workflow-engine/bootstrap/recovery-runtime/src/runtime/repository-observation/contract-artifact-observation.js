/** Canonical repository artifact identity and content observations. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export function digestArtifacts(repositoryRoot, artifactPaths) {
    const root = canonicalRepositoryRoot(repositoryRoot);
    const entries = artifactPaths
        .map((artifactPath) => inspectArtifact(root, artifactPath))
        .sort((left, right) => compareText(left.path, right.path));
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
        throw unsafeContractArtifact();
    }
    return Object.fromEntries(entries.map((entry) => [entry.path, entry.digest]));
}
export function inspectArtifact(repository, artifactPath) {
    let descriptor;
    try {
        if (!path.isAbsolute(artifactPath)) {
            throw new Error('artifact path is not absolute');
        }
        const absolutePath = path.resolve(artifactPath);
        const artifactRelativePath = repositoryRelativePath(repository, absolutePath);
        if (absolutePath !== artifactPath || !artifactRelativePath) {
            throw new Error('artifact path escapes the repository');
        }
        const before = fs.lstatSync(absolutePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (!before?.isFile() ||
            before.isSymbolicLink() ||
            fs.realpathSync(absolutePath) !==
                path.join(repository.canonicalRoot, artifactRelativePath)) {
            throw new Error('artifact is not a canonical regular file');
        }
        descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
            throw new Error('artifact identity changed before reading');
        }
        const content = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (!sameArtifactIdentity(opened, after)) {
            throw new Error('artifact identity changed while reading');
        }
        const mode = logicalGitFileMode(after.mode);
        return {
            path: artifactRelativePath,
            digest: mode === '100644'
                ? crypto.createHash('sha256').update(content).digest('hex')
                : crypto
                    .createHash('sha256')
                    .update('workflow-contract-artifact\0mode:100755\0')
                    .update(content)
                    .digest('hex'),
        };
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'UNSAFE_CONTRACT_ARTIFACT') {
            throw error;
        }
        throw unsafeContractArtifact();
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
export function canonicalRepositoryRoot(repositoryRoot) {
    try {
        const absoluteRoot = path.resolve(repositoryRoot);
        const stats = fs.lstatSync(absoluteRoot);
        const canonicalRoot = fs.realpathSync(absoluteRoot);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('repository root is not canonical');
        }
        return { lexicalRoot: absoluteRoot, canonicalRoot };
    }
    catch {
        throw unsafeContractArtifact();
    }
}
export function repositoryRelativePath(repository, artifactPath) {
    for (const root of [repository.lexicalRoot, repository.canonicalRoot]) {
        const candidate = relative(root, artifactPath);
        if (candidate !== '' &&
            candidate !== '..' &&
            !candidate.startsWith('../') &&
            !path.isAbsolute(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
export function logicalGitFileMode(mode) {
    return (mode & 73n) === 0n ? '100644' : '100755';
}
export function sameArtifactIdentity(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
export function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function unsafeContractArtifact() {
    return workflowError('UNSAFE_CONTRACT_ARTIFACT', 'Workflow contract artifacts must be canonical repository regular files.', ExitCode.guard);
}
export function relative(root, target) {
    return path.relative(root, target).split(path.sep).join('/');
}
