/**
 * Owns prepared audit append locks and their exact release and dead-owner recovery checks.
 *
 * Invariants:
 * - Only the recorded owner releases its exact private lock and associated prepared alias.
 * - Dead-owner reclamation retains the existing canonical record and namespace checks.
 *
 * Depends on: prepared-lock filesystem safety, audit owner contracts, and private directory checks.
 * Failure modes: concurrent audit mutation, abandoned locks, or releasing another process lock.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { reclaimDeadPreparedLock, publishPreparedExclusiveLock, } from "../repository-transaction/filesystem-safety.js";
import { LOCK_NAME, LOCK_KEYS, UUID_V4, PREPARED_LOCK_ALIAS, LOCK_RECLAIM_CLAIM, } from "./authority-audit-contracts.js";
import { lockBusy, lockUnsafe, isNodeError, isPlainRecord, hasExactKeys, } from "./authority-audit-values.js";
import { readDescriptorContent, assertExactDirectoryEntries, fsyncDirectory, } from "./authority-audit-private-files.js";
export function withLedgerLock(paths, repositoryId, operation) {
    assertLockEntriesBeforeAcquire(paths);
    const reclaimed = reclaimDeadPreparedLock(paths.appendLock, (content) => parseLockOwner(content, repositoryId));
    if (reclaimed === 'occupied') {
        throw lockBusy();
    }
    if (reclaimed === 'unsafe') {
        throw lockUnsafe();
    }
    const ownerToken = crypto.randomUUID();
    const content = `${canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-lock.v1',
        repositoryId,
        pid: process.pid,
        ownerToken,
    })}\n`;
    let descriptor;
    try {
        descriptor = publishPreparedExclusiveLock(paths.appendLock, content, ownerToken, lockUnsafe);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw lockBusy();
        }
        throw error;
    }
    const assertOwned = () => {
        if (descriptor === undefined) {
            throw lockUnsafe();
        }
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(paths.appendLock, {
            throwIfNoEntry: false,
        });
        if (!observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content) {
            throw lockUnsafe();
        }
    };
    let result;
    try {
        assertOwned();
        assertExactDirectoryEntries(paths.locks, [LOCK_NAME]);
        result = operation();
        assertOwned();
    }
    catch (error) {
        releaseLedgerLock(paths, descriptor, assertOwned);
        descriptor = undefined;
        throw error;
    }
    releaseLedgerLock(paths, descriptor, assertOwned);
    descriptor = undefined;
    return result;
}
function releaseLedgerLock(paths, descriptor, assertOwned) {
    assertOwned();
    fs.closeSync(descriptor);
    fs.unlinkSync(paths.appendLock);
    fsyncDirectory(paths.locks);
}
function parseLockOwner(content, repositoryId) {
    if (Buffer.byteLength(content) > 1_024) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return null;
    }
    if (!isPlainRecord(parsed) ||
        !hasExactKeys(parsed, LOCK_KEYS) ||
        parsed.schemaVersion !== 1 ||
        parsed.kind !== 'authority-audit-lock.v1' ||
        parsed.repositoryId !== repositoryId ||
        !Number.isSafeInteger(parsed.pid) ||
        typeof parsed.pid !== 'number' ||
        parsed.pid < 1 ||
        typeof parsed.ownerToken !== 'string' ||
        !UUID_V4.test(parsed.ownerToken) ||
        content !== `${canonicalJson(parsed)}\n`) {
        return null;
    }
    return { pid: parsed.pid, ownerToken: parsed.ownerToken };
}
function assertLockEntriesBeforeAcquire(paths) {
    const entries = fs.readdirSync(paths.locks);
    const hasLock = entries.includes(LOCK_NAME);
    for (const entry of entries) {
        if (entry === LOCK_NAME) {
            continue;
        }
        const isPreparedAlias = PREPARED_LOCK_ALIAS.test(entry);
        const isReclaimClaim = LOCK_RECLAIM_CLAIM.test(entry);
        if (!hasLock || (!isPreparedAlias && !isReclaimClaim)) {
            throw lockUnsafe();
        }
    }
}
