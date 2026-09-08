/**
 * Reads bounded native session files while checking canonical bytes and file identity.
 *
 * Invariants:
 * - Reads retain size, mode, link count, and no-follow checks.
 * - Stable snapshots compare both pathname and opened descriptor identities.
 *
 * Depends on: Private investigation directories, filesystem metadata, and canonical JSON.
 * Failure modes: Swapped files, hard links, or oversized records become accepted authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertPrivateInvestigationDirectory } from "./investigation-private-files.js";
import { MAX_REF_BYTES } from "./provider-native-session-contracts.js";
import { storeInvalid } from "./provider-native-session-values.js";
export const UTF8 = new TextDecoder('utf-8', { fatal: true });
export function assertRefUnchanged(paths, filePath, before, maxBytes = MAX_REF_BYTES) {
    const after = readBoundedCanonicalSnapshot(paths, filePath, maxBytes);
    if (!sameStableFile(before.identity, after.identity) ||
        !before.bytes.equals(after.bytes) ||
        canonicalJson(before.value) !== canonicalJson(after.value)) {
        throw storeInvalid();
    }
}
export function readBoundedCanonicalJson(paths, filePath, maxBytes) {
    return readBoundedCanonicalSnapshot(paths, filePath, maxBytes).value;
}
export function readBoundedCanonicalSnapshot(paths, filePath, maxBytes) {
    return readBoundedCanonicalSnapshotWithLinkCount(paths, filePath, maxBytes, 1);
}
export function readBoundedCanonicalSnapshotWithLinkCount(paths, filePath, maxBytes, expectedLinks) {
    const snapshot = readBoundedFileSnapshotWithLinkCount(paths, filePath, maxBytes, expectedLinks);
    let source;
    let value;
    try {
        source = UTF8.decode(snapshot.bytes);
        value = JSON.parse(source);
    }
    catch {
        throw storeInvalid();
    }
    if (`${canonicalJson(value)}\n` !== source)
        throw storeInvalid();
    return Object.freeze({
        value,
        bytes: snapshot.bytes,
        identity: snapshot.identity,
    });
}
export function readBoundedCanonicalBytes(paths, filePath, maxBytes) {
    return readBoundedFileSnapshot(paths, filePath, maxBytes).bytes;
}
function readBoundedFileSnapshot(paths, filePath, maxBytes) {
    return readBoundedFileSnapshotWithLinkCount(paths, filePath, maxBytes, 1);
}
function readBoundedFileSnapshotWithLinkCount(paths, filePath, maxBytes, expectedLinks) {
    assertPrivateInvestigationDirectory(paths, path.dirname(filePath), storeInvalid);
    const absolute = path.resolve(filePath);
    if (absolute !== filePath)
        throw storeInvalid();
    const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (before === undefined)
        throw storeInvalid();
    assertPrivateFileStats(before, maxBytes, expectedLinks);
    let descriptor;
    try {
        const noFollow = fs.constants.O_NOFOLLOW;
        const nonBlock = fs.constants.O_NONBLOCK;
        if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
            throw storeInvalid();
        }
        descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow | nonBlock);
        const opened = fs.fstatSync(descriptor);
        assertPrivateFileStats(opened, maxBytes, expectedLinks);
        if (!sameFile(before, opened))
            throw storeInvalid();
        const expectedBytes = opened.size;
        const buffer = Buffer.alloc(expectedBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (count === 0)
                break;
            offset += count;
        }
        const afterRead = fs.fstatSync(descriptor);
        const current = fs.lstatSync(absolute, { throwIfNoEntry: false });
        if (offset !== expectedBytes ||
            current === undefined ||
            !sameStableFile(opened, afterRead) ||
            !sameStableFile(opened, current) ||
            fs.realpathSync(absolute) !== absolute) {
            throw storeInvalid();
        }
        return Object.freeze({
            bytes: buffer.subarray(0, offset),
            identity: opened,
        });
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID') {
            throw error;
        }
        throw storeInvalid();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
export function assertPrivateFileStats(stats, maxBytes, expectedLinks = 1) {
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== expectedLinks ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size < 1 ||
        stats.size > maxBytes) {
        throw storeInvalid();
    }
}
export function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
        fs.fsyncSync(descriptor);
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
export function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
export function sameStableFile(left, right) {
    return (sameFile(left, right) &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
