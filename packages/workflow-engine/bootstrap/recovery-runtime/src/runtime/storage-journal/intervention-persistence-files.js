/**
 * Reads and publishes private intervention records with their existing atomic file semantics.
 *
 * Invariants:
 * - Creation preserves exclusive linking; replacement preserves rename publication.
 * - Descriptor fsync, directory fsync, temporary cleanup, and error propagation retain their order.
 * - Reads preserve canonical bytes, file permissions, link counts, and bounded sizes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { ensurePlainDirectory } from "../repository-transaction/filesystem-safety.js";
import { PRIVATE_FILE_MODE, MAX_RECORD_BYTES, } from "./intervention-persistence-contracts.js";
import { isNodeError, corruptPersistenceRecord, } from "./intervention-persistence-values.js";
export function createPrivateFileExclusive(filePath, content) {
    ensurePlainDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    let failure;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        failure = error;
    }
    if (descriptor !== undefined) {
        try {
            fs.closeSync(descriptor);
        }
        catch (error) {
            failure ??= error;
        }
    }
    try {
        fs.unlinkSync(temporaryPath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            failure ??= error;
        }
    }
    if (failure !== undefined) {
        throw failure;
    }
}
export function replacePrivateFileAtomic(filePath, content) {
    assertPrivateRegularFile(filePath, 'INTERVENTION_PERSISTENCE_RECORD_UNSAFE');
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    let failure;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        failure = error;
    }
    if (descriptor !== undefined) {
        try {
            fs.closeSync(descriptor);
        }
        catch (error) {
            failure ??= error;
        }
    }
    try {
        fs.unlinkSync(temporaryPath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            failure ??= error;
        }
    }
    if (failure !== undefined) {
        throw failure;
    }
}
export function readCanonicalRecord(filePath, notFoundCode) {
    const content = readPrivateFile(filePath, notFoundCode);
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw workflowError('INTERVENTION_PERSISTENCE_RECORD_CORRUPT', 'Persistence record is not valid JSON.', ExitCode.verification);
    }
    if (`${canonicalJson(value)}\n` !== content) {
        throw corruptPersistenceRecord();
    }
    return value;
}
export function readPrivateFile(filePath, notFoundCode) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        throw workflowError(notFoundCode, 'Intervention persistence record was not found.', ExitCode.conflict);
    }
    assertPrivateRegularFile(filePath, 'INTERVENTION_PERSISTENCE_RECORD_UNSAFE');
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            opened.size > MAX_RECORD_BYTES) {
            throw workflowError('INTERVENTION_PERSISTENCE_RECORD_UNSAFE', 'Persistence record changed while being opened or is too large.', ExitCode.unsafeEnvironment);
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function assertPrivateRegularFile(filePath, code) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw workflowError(code, 'Persistence record is not a private regular file.', ExitCode.unsafeEnvironment);
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
