/**
 * Serializes repository lifecycle operations and checks outstanding grant or resolution barriers.
 *
 * Invariants:
 * - Lifecycle admission precedes ownership transfer and rechecks durable barriers under the lease.
 * - Operation errors keep precedence over release errors and lock cleanup preserves ownership.
 */
import { assertChangeId } from "../../foundation/repository-path/repository-path.js";
import { assertGrantLifecycleBarrier } from "../lifecycle-ledgers/grant-store.js";
import { assertHumanResolutionLifecycleBarrier, reclaimHumanResolutionJournalTemporaries, } from "../lifecycle-ledgers/human-resolution-journal.js";
import fs from 'node:fs';
import { assertPlainDirectory, ensurePlainDirectory, publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from "../repository-transaction/filesystem-safety.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import path from 'node:path';
import crypto from 'node:crypto';
import { readDescriptorContent, isNodeError, fsyncDirectory, isRecord, } from "./session-store-values.js";
const MAINTAINER_GRANT_STATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
/**
 * Observe the repository-wide lifecycle admission boundary without acquiring,
 * reclaiming, or publishing authority. Any existing lifecycle owner or
 * reclaimer is reported as a conflict; the mutating operation remains
 * responsible for its bounded dead-owner recovery before revalidating.
 */
export function assertRepositoryLifecyclePreflightAdmission(runtime, requestedChangeId, options = {}) {
    const changeId = assertChangeId(requestedChangeId);
    assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
    assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
    assertMaintainerReservationCompatibility(runtime, options.allowMaintainerGrantId);
    for (const directory of [runtime.sessions, runtime.locks]) {
        if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
            assertPlainDirectory(directory);
        }
    }
    const operationsStats = fs.lstatSync(runtime.operations, {
        throwIfNoEntry: false,
    });
    if (operationsStats) {
        assertPlainDirectory(runtime.operations);
        const lifecycleLockName = 'repository-lifecycle.lock';
        if (fs
            .readdirSync(runtime.operations)
            .some((name) => name === lifecycleLockName ||
            name.startsWith(`${lifecycleLockName}.reclaim.`))) {
            throw workflowError('REPOSITORY_LIFECYCLE_CONFLICT', 'Another repository lifecycle transition is in progress.', ExitCode.conflict);
        }
    }
    const changeLockName = `${changeId}.lock`;
    if (fs.lstatSync(runtime.locks, { throwIfNoEntry: false }) &&
        fs
            .readdirSync(runtime.locks)
            .some((name) => name === changeLockName ||
            name.startsWith(`${changeLockName}.reclaim.`))) {
        throw workflowError('REPOSITORY_LIFECYCLE_CONFLICT', `Another lifecycle transition already owns change ${changeId}.`, ExitCode.conflict);
    }
}
export function withRepositoryLifecycleOperation(runtime, operation, options = {}) {
    const lease = acquireRepositoryLifecycleLease(runtime, options);
    let result;
    try {
        result = operation(lease.assertOwned);
    }
    catch (operationError) {
        releaseAfterOperationError(lease, operationError);
    }
    lease.release();
    return result;
}
export async function withRepositoryLifecycleOperationAsync(runtime, operation, options = {}) {
    const lease = acquireRepositoryLifecycleLease(runtime, options);
    let result;
    try {
        result = await operation(lease.assertOwned);
    }
    catch (operationError) {
        releaseAfterOperationError(lease, operationError);
    }
    lease.release();
    return result;
}
function acquireRepositoryLifecycleLease(runtime, options) {
    assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
    assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
    ensurePlainDirectory(runtime.operations);
    const lockPath = path.join(runtime.operations, 'repository-lifecycle.lock');
    const ownerToken = crypto.randomUUID();
    const content = `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken,
        pid: process.pid,
    })}\n`;
    let descriptor;
    const assertOwned = () => {
        if (descriptor === undefined) {
            throw invalidRepositoryLifecycleLock('Repository lifecycle lock ownership was lost.');
        }
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        let observedContent;
        try {
            observedContent = fs.readFileSync(lockPath, 'utf8');
        }
        catch {
            observedContent = undefined;
        }
        if (!owned.isFile() ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            !observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.nlink !== 1 ||
            (observed.mode & 0o777) !== 0o600 ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            observedContent !== content ||
            readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content) {
            throw invalidRepositoryLifecycleLock('Repository lifecycle lock ownership changed during the transition.');
        }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            descriptor = publishPreparedExclusiveLock(lockPath, content, ownerToken, () => invalidRepositoryLifecycleLock('Repository lifecycle reclaim state is unsafe.'));
            break;
        }
        catch (error) {
            if (isNodeError(error) &&
                error.code === 'EEXIST' &&
                attempt === 0 &&
                reclaimDeadRepositoryLifecycleLock(lockPath)) {
                continue;
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workflowError('REPOSITORY_LIFECYCLE_CONFLICT', 'Another repository lifecycle transition is in progress.', ExitCode.conflict);
            }
            throw error;
        }
    }
    if (descriptor === undefined) {
        throw invalidRepositoryLifecycleLock('Repository lifecycle lock could not be acquired.');
    }
    const release = () => {
        try {
            assertOwned();
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            throw error;
        }
        if (descriptor === undefined) {
            throw invalidRepositoryLifecycleLock('Repository lifecycle lock ownership was lost.');
        }
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
    };
    try {
        reclaimHumanResolutionJournalTemporaries(runtime.root, assertOwned);
        const assertLifecycleOwned = () => {
            assertOwned();
            assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
            assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
        };
        assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
        assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeIds);
        assertMaintainerReservationCompatibility(runtime, options.allowMaintainerGrantId);
        return { assertOwned: assertLifecycleOwned, release };
    }
    catch (setupError) {
        try {
            release();
        }
        catch (releaseError) {
            throw new AggregateError([setupError, releaseError], 'Repository lifecycle setup and lock release both failed.', { cause: releaseError });
        }
        throw setupError;
    }
}
function releaseAfterOperationError(lease, operationError) {
    try {
        lease.release();
    }
    catch (releaseError) {
        throw new AggregateError([operationError, releaseError], 'Repository lifecycle operation and lock release both failed.', { cause: releaseError });
    }
    throw operationError;
}
function reclaimDeadRepositoryLifecycleLock(lockPath) {
    const result = reclaimDeadPreparedLock(lockPath, (content) => {
        let value;
        try {
            value = JSON.parse(content);
        }
        catch {
            return null;
        }
        if (!isRecord(value) ||
            Object.keys(value).length !== 3 ||
            value.kind !== 'repository-lifecycle' ||
            typeof value.ownerToken !== 'string' ||
            !Number.isSafeInteger(value.pid) ||
            value.pid < 1 ||
            `${JSON.stringify(value)}\n` !== content) {
            return null;
        }
        return {
            pid: value.pid,
            ownerToken: value.ownerToken,
        };
    });
    return result === 'absent' || result === 'reclaimed';
}
function assertMaintainerReservationCompatibility(runtime, allowedGrantId) {
    // Maintainer authority remains a repository-wide human-only fence. The
    // change-scoped relaxation applies only to ordinary active sessions.
    const reservedDirectory = path.join(runtime.root, 'maintainer-grants', 'reserved');
    const stats = fs.lstatSync(reservedDirectory, { throwIfNoEntry: false });
    if (!stats) {
        return;
    }
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(reservedDirectory) !== path.resolve(reservedDirectory) ||
        (stats.mode & 0o777) !== 0o700) {
        throw workflowError('MAINTAINER_GRANT_STORE_UNSAFE', 'Maintainer grant reservation storage is unsafe.', ExitCode.staleState);
    }
    const entries = fs.readdirSync(reservedDirectory);
    if (entries.some((entry) => !MAINTAINER_GRANT_STATE_FILE.test(entry))) {
        throw workflowError('MAINTAINER_GRANT_STORE_UNSAFE', 'Maintainer grant reservation storage contains an invalid entry.', ExitCode.staleState);
    }
    const reservations = entries
        .map((entry) => entry.slice(0, -'.json'.length))
        .sort();
    if (reservations.length === 0 ||
        (allowedGrantId !== undefined &&
            reservations.length === 1 &&
            reservations[0] === allowedGrantId)) {
        return;
    }
    throw workflowError('ACTIVE_AUTHORITY_CONFLICT', 'A maintainer authority reservation already owns the repository lifecycle.', ExitCode.conflict, { details: { grantIds: reservations } });
}
function invalidRepositoryLifecycleLock(message) {
    return workflowError('REPOSITORY_LIFECYCLE_LOCK_INVALID', message, ExitCode.staleState);
}
