import fs from 'node:fs';
import path from 'node:path';
export function fingerprintIgnoredEntry(digest, repositoryRoot, ignoredPath) {
    const absolutePath = path.join(repositoryRoot, ignoredPath);
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, 'ignored-kind', 'missing');
        return;
    }
    updateFramed(digest, 'ignored-stat', fingerprintStats(stats, true));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, 'ignored-kind', 'symlink');
        updateFramed(digest, 'ignored-link', fs.readlinkSync(absolutePath));
    }
    else if (stats.isFile()) {
        updateFramed(digest, 'ignored-kind', 'file');
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, 'ignored-kind', 'directory');
    }
    else {
        throw new Error('unsupported ignored filesystem entry');
    }
}
export function fingerprintTrackedEntry(digest, repositoryRoot, trackedPath, includeVolatileMetadata, budget) {
    const absolutePath = path.join(repositoryRoot, trackedPath);
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, 'tracked-kind', 'missing');
        return;
    }
    updateFramed(digest, 'tracked-stat', fingerprintStats(stats, includeVolatileMetadata));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, 'tracked-kind', 'symlink');
        updateFramed(digest, 'tracked-link', fs.readlinkSync(absolutePath));
    }
    else if (stats.isFile()) {
        updateFramed(digest, 'tracked-kind', 'file');
        if (budget) {
            updateFramedFile(digest, 'tracked-content', absolutePath, stats, budget);
        }
        else {
            updateFramed(digest, 'tracked-content', fs.readFileSync(absolutePath));
        }
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, 'tracked-kind', 'directory');
    }
    else {
        throw new Error('unsupported tracked filesystem entry');
    }
}
export function fingerprintStats(stats, includeVolatileMetadata) {
    return [
        stats.dev,
        stats.ino,
        stats.mode,
        stats.nlink,
        stats.uid,
        stats.gid,
        stats.size,
        stats.mtimeNs,
        ...(includeVolatileMetadata ? [stats.ctimeNs] : []),
    ].join(':');
}
export function updateFramed(digest, domain, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    digest.update(`${domain.length}:${domain}:${bytes.length}:`);
    digest.update(bytes);
}
export function updateBoundedFramed(digest, domain, value, budget) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    consumeProjectionBytes(budget, bytes.length);
    updateFramed(digest, domain, bytes);
}
export function updateFramedFile(digest, domain, absolutePath, expected, budget) {
    if (expected.size < 0n ||
        expected.size > BigInt(MAX_GOVERNED_PROJECTION_FILE_BYTES)) {
        throw new Error('Governed projection file-size limit exceeded.');
    }
    const size = Number(expected.size);
    consumeProjectionBytes(budget, size);
    const domainPrefix = `${domain.length}:${domain}:${size}:`;
    digest.update(domainPrefix);
    const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
    const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() ||
            opened.dev !== expected.dev ||
            opened.ino !== expected.ino ||
            opened.size !== expected.size ||
            opened.mode !== expected.mode ||
            opened.nlink !== expected.nlink) {
            throw new Error('Governed projection file identity changed.');
        }
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let consumed = 0;
        while (consumed < size) {
            const requested = Math.min(buffer.length, size - consumed);
            const read = fs.readSync(descriptor, buffer, 0, requested, null);
            if (read <= 0) {
                throw new Error('Governed projection file was truncated.');
            }
            digest.update(buffer.subarray(0, read));
            consumed += read;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (consumed !== size ||
            after.dev !== expected.dev ||
            after.ino !== expected.ino ||
            after.size !== expected.size ||
            after.mode !== expected.mode ||
            after.nlink !== expected.nlink ||
            after.mtimeNs !== expected.mtimeNs) {
            throw new Error('Governed projection file changed while being read.');
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
}
export function readDirectoryEntriesBounded(absoluteDirectory, budget) {
    const entries = [];
    const directory = fs.opendirSync(absoluteDirectory);
    try {
        for (;;) {
            const entry = directory.readSync();
            if (!entry) {
                break;
            }
            consumeProjectionEntries(budget, 1);
            entries.push(entry);
        }
    }
    finally {
        directory.closeSync();
    }
    return entries;
}
export function consumeProjectionEntries(budget, count) {
    if (!Number.isSafeInteger(count) ||
        count < 0 ||
        count > budget.remainingEntries) {
        throw new Error('Governed projection entry limit exceeded.');
    }
    budget.remainingEntries -= count;
}
function consumeProjectionBytes(budget, count) {
    if (!Number.isSafeInteger(count) ||
        count < 0 ||
        count > budget.remainingBytes) {
        throw new Error('Governed projection aggregate byte limit exceeded.');
    }
    budget.remainingBytes -= count;
}
export const MAX_GOVERNED_PROJECTION_ENTRIES = 100_000;
const MAX_GOVERNED_PROJECTION_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_GOVERNED_PROJECTION_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_GOVERNED_PROJECTION_DEPTH = 64;
// macOS may asynchronously rewrite com.apple.provenance and bump ctime without
// any governed change, so the projection omits volatile ctime on Darwin exactly
// as the persisted repository projection does.
export const INCLUDE_VOLATILE_PROJECTION_METADATA = process.platform !== 'darwin';
