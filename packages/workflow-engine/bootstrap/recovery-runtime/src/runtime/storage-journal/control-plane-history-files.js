/**
 * Builds supervisor history paths and enforces private bounded record reads.
 *
 * Invariants:
 * - Directories and files retain exact private modes and canonical containment checks.
 * - Record byte bounds and filesystem synchronization semantics remain unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertDigest, HISTORY_DIRECTORY_NAME, MAX_HISTORY_RECORD_BYTES, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, storageUnsafe, } from "./control-plane-history-values.js";
export function controlPlaneSupervisorHistoryDirectory(storageRoot) {
    return path.join(storageRoot, HISTORY_DIRECTORY_NAME);
}
export function controlPlaneSupervisorHistoryRecordPath(storageRoot, recordDigest) {
    assertDigest(recordDigest);
    return path.join(controlPlaneSupervisorHistoryDirectory(storageRoot), `${recordDigest.slice('sha256:'.length)}.json`);
}
export function controlPlaneSupervisorHistoryPendingPath(storageRoot, recordDigest) {
    assertDigest(recordDigest);
    return path.join(controlPlaneSupervisorHistoryDirectory(storageRoot), `.${recordDigest.slice('sha256:'.length)}.json.pending`);
}
export function assertStorageRoot(storageRoot) {
    const stats = typeof storageRoot === 'string'
        ? fs.lstatSync(storageRoot, { throwIfNoEntry: false })
        : undefined;
    if (typeof storageRoot !== 'string' ||
        !path.isAbsolute(storageRoot) ||
        path.resolve(storageRoot) !== storageRoot ||
        stats === undefined ||
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        fs.realpathSync(storageRoot) !== storageRoot) {
        throw storageUnsafe('Supervisor history storage root is not an exact private directory.');
    }
    return storageRoot;
}
export function ensureHistoryDirectory(storageRoot) {
    const directory = controlPlaneSupervisorHistoryDirectory(storageRoot);
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing === undefined) {
        try {
            fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
            fsyncDirectory(storageRoot);
        }
        catch {
            throw storageUnsafe('Supervisor history directory could not be created safely.');
        }
    }
    assertPrivateDirectory(directory);
    return directory;
}
export function assertPrivateDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stats === undefined ||
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        fs.realpathSync(directory) !== directory) {
        throw storageUnsafe('Supervisor history directory is missing, indirect, or not private.');
    }
}
export function assertPrivateRecordBytes(filePath, expected, expectedLinks) {
    const observed = readPrivateRecordText(filePath, expectedLinks);
    if (observed !== expected) {
        throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_CONFLICT', 'Existing supervisor history path contains different canonical bytes.', ExitCode.conflict);
    }
}
export function readPrivateRecordText(filePath, expectedLinks) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stats === undefined ||
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== expectedLinks ||
        (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
        stats.size < 1 ||
        stats.size > MAX_HISTORY_RECORD_BYTES ||
        fs.realpathSync(filePath) !== filePath) {
        throw storageUnsafe('Supervisor history record is indirect, linked, oversized, or not private.');
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        const raw = fs.readFileSync(descriptor, 'utf8');
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            opened.nlink !== expectedLinks ||
            opened.size !== stats.size ||
            Buffer.byteLength(raw) !== stats.size) {
            throw storageUnsafe('Supervisor history record changed while it was read.');
        }
        return raw;
    }
    finally {
        fs.closeSync(descriptor);
    }
}
export function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
