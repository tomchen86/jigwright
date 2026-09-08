/**
 * Serializes grant and workflow mutations with their distinct private lock protocols.
 *
 * Invariants:
 * - Grant locks retain exclusive-create ownership and their existing conflict semantics.
 * - Workflow locks retain owner records, dead-owner recovery, inode checks, and directory durability.
 * - Operation failures retain precedence over failures while releasing the lock.
 *
 * Depends on: private files, storage paths, canonical owner records, and workflow errors.
 * Failure modes: concurrent grant use, stale workflow locks, or releasing a lock owned by another process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { parseDocument, isRecord, hasExactKeys, assertTimestamp, } from "./execution-governance-values.js";
import { unsafeDurableGovernanceStore, } from "./execution-governance-store-contracts.js";
import { workflowStorageKey } from "./execution-governance-store-objects.js";
import { fsyncDirectory, isNodeError, readPrivateFile, } from "./execution-governance-private-files.js";
export function withDurableGovernanceLock(paths, workflowId, operation) {
    const lockPath = path.join(paths.locks, `${workflowStorageKey(workflowId)}.lock`);
    let descriptor;
    let ownedStats;
    for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
        let createdThisAttempt = false;
        try {
            descriptor = fs.openSync(lockPath, fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW, 0o600);
            createdThisAttempt = true;
            fs.fchmodSync(descriptor, 0o600);
            const lockRecord = {
                schemaVersion: 1,
                workflowId,
                pid: process.pid,
                createdAt: new Date().toISOString(),
            };
            fs.writeFileSync(descriptor, `${canonicalJson(lockRecord)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
            ownedStats = fs.fstatSync(descriptor);
            fsyncDirectory(paths.locks);
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            ownedStats = undefined;
            if (createdThisAttempt) {
                try {
                    fs.unlinkSync(lockPath);
                    fsyncDirectory(paths.locks);
                }
                catch (cleanupError) {
                    if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
                        throw unsafeDurableGovernanceStore();
                    }
                }
            }
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
            if (!reclaimDeadDurableGovernanceLock(lockPath, workflowId)) {
                throw workflowError('EXECUTION_GOVERNANCE_OPERATION_CONFLICT', `Workflow ${workflowId} already has a governance operation in progress.`, ExitCode.conflict);
            }
        }
    }
    if (descriptor === undefined || ownedStats === undefined) {
        throw workflowError('EXECUTION_GOVERNANCE_OPERATION_CONFLICT', `Workflow ${workflowId} already has a governance operation in progress.`, ExitCode.conflict);
    }
    let result;
    let operationError;
    try {
        result = operation();
    }
    catch (error) {
        operationError = error;
    }
    fs.closeSync(descriptor);
    let releaseError;
    try {
        const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (current === undefined ||
            current.dev !== ownedStats.dev ||
            current.ino !== ownedStats.ino) {
            throw unsafeDurableGovernanceStore();
        }
        fs.unlinkSync(lockPath);
        fsyncDirectory(paths.locks);
    }
    catch (error) {
        releaseError = error;
    }
    if (operationError !== undefined)
        throw operationError;
    if (releaseError !== undefined)
        throw releaseError;
    return result;
}
function reclaimDeadDurableGovernanceLock(lockPath, workflowId) {
    const raw = readPrivateFile(lockPath, 4_096);
    let value;
    try {
        value = parseDocument(raw);
    }
    catch {
        throw unsafeDurableGovernanceStore();
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'workflowId', 'pid', 'createdAt']) ||
        value.schemaVersion !== 1 ||
        value.workflowId !== workflowId ||
        !Number.isSafeInteger(value.pid) ||
        value.pid < 1 ||
        `${canonicalJson(value)}\n` !== raw) {
        throw unsafeDurableGovernanceStore();
    }
    assertTimestamp(value.createdAt, unsafeDurableGovernanceStore, 'lock createdAt');
    try {
        process.kill(value.pid, 0);
        return false;
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ESRCH')
            return false;
    }
    try {
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return true;
        throw error;
    }
}
export function withExecutionGrantLock(paths, grantId, operation) {
    const lockPath = path.join(paths.locks, `${grantId}.lock`);
    let descriptor;
    let ownsLock = false;
    let result;
    let operationError;
    try {
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
            ownsLock = true;
            fs.writeFileSync(descriptor, `${canonicalJson({ grantId, pid: process.pid })}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workflowError('EXECUTION_BUDGET_GRANT_OPERATION_CONFLICT', `Execution-budget grant ${grantId} already has an operation in progress.`, ExitCode.conflict);
            }
            throw error;
        }
        result = operation();
    }
    catch (error) {
        operationError = error;
    }
    if (descriptor !== undefined)
        fs.closeSync(descriptor);
    let releaseError;
    if (ownsLock) {
        try {
            fs.unlinkSync(lockPath);
            fsyncDirectory(paths.locks);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT')
                releaseError = error;
        }
    }
    if (operationError !== undefined)
        throw operationError;
    if (releaseError !== undefined)
        throw releaseError;
    return result;
}
