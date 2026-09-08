/**
 * Acquires and reclaims task worktree and exclusive-resource leases with durable owner observations.
 *
 * Invariants:
 * - Lease reclamation requires the same stable session and dead owner observations.
 * - Partial acquisition rolls back only owned publications and preserves descriptor cleanup order.
 */
import { ensurePlainDirectory, publishPreparedExclusiveLock, withPreparedLockCleanupClaim, preparedLockTemporaryPath, assertPlainDirectory, } from "../repository-transaction/filesystem-safety.js";
import path from 'node:path';
import crypto from 'node:crypto';
import { isWorkflowSession, } from "./workflow-session-records.js";
import { invalidSessionLock, isNodeError, readDescriptorContent, fsyncDirectory, } from "./session-store-values.js";
import fs from 'node:fs';
import { releaseOwnedLock, assertOwnedLock, parseManagedSessionLock, } from "./session-operation-locks.js";
import { assertSessionId, assertChangeId, assertTaskId } from "./paths.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function acquireTaskSessionIsolationLeases(runtime, session, testHooks = {}) {
    const acquired = [];
    try {
        for (const [index, leasePath] of taskSessionIsolationLeasePaths(runtime, session).entries()) {
            testHooks.beforePublication?.({ index, leasePath });
            const observation = observeTaskSessionIsolationLease(runtime, leasePath);
            if (observation.state === 'occupied') {
                throw taskSessionLeaseConflict(leasePath);
            }
            if (observation.state === 'reclaimable') {
                reclaimObservedTaskSessionIsolationLease(observation);
            }
            ensurePlainDirectory(path.dirname(leasePath));
            const ownerToken = crypto.randomUUID();
            const content = `${JSON.stringify({
                sessionId: session.sessionId,
                ownerToken,
                changeId: session.changeId,
                taskId: session.taskId,
                pid: process.pid,
            })}\n`;
            try {
                const descriptor = publishPreparedExclusiveLock(leasePath, content, ownerToken, invalidSessionLock);
                acquired.push({
                    runtimeRoot: runtime.root,
                    filePath: leasePath,
                    descriptor,
                    content,
                });
            }
            catch (error) {
                if (isNodeError(error) && error.code === 'EEXIST') {
                    throw taskSessionLeaseConflict(leasePath);
                }
                throw error;
            }
        }
        return Object.freeze({ publications: Object.freeze([...acquired]) });
    }
    catch (error) {
        rollbackRuntimeFilePublications(acquired, error);
        throw error;
    }
}
export function closeTaskSessionIsolationLeaseAcquisition(acquisition) {
    closeRuntimeFilePublications(acquisition.publications);
}
export function rollbackTaskSessionIsolationLeaseAcquisition(acquisition) {
    rollbackRuntimeFilePublications(acquisition.publications);
}
export function closeOwnedRuntimeFilePublication(publication) {
    fs.closeSync(publication.descriptor);
}
export function assertOwnedRuntimeFilePublication(publication, makeUnsafeError = invalidSessionLock) {
    try {
        if (!assertExistingRuntimeDirectoryChain(publication.runtimeRoot, path.dirname(publication.filePath))) {
            throw makeUnsafeError();
        }
        const before = fs.lstatSync(publication.filePath, {
            throwIfNoEntry: false,
        });
        const owned = fs.fstatSync(publication.descriptor);
        const content = readDescriptorContent(publication.descriptor, Buffer.byteLength(publication.content));
        const after = fs.lstatSync(publication.filePath, {
            throwIfNoEntry: false,
        });
        if (!before?.isFile() ||
            before.isSymbolicLink() ||
            !after?.isFile() ||
            after.isSymbolicLink() ||
            !owned.isFile() ||
            before.dev !== owned.dev ||
            before.ino !== owned.ino ||
            after.dev !== owned.dev ||
            after.ino !== owned.ino ||
            before.nlink !== 1 ||
            owned.nlink !== 1 ||
            after.nlink !== 1 ||
            before.size !== owned.size ||
            after.size !== owned.size ||
            (before.mode & 0o777) !== 0o600 ||
            (owned.mode & 0o777) !== 0o600 ||
            (after.mode & 0o777) !== 0o600 ||
            owned.size !== Buffer.byteLength(publication.content) ||
            content !== publication.content) {
            throw makeUnsafeError();
        }
    }
    catch (error) {
        if (isNodeError(error))
            throw makeUnsafeError();
        throw error;
    }
}
export function rollbackOwnedRuntimeFilePublication(publication) {
    try {
        if (!assertExistingRuntimeDirectoryChain(publication.runtimeRoot, path.dirname(publication.filePath))) {
            throw invalidSessionLock();
        }
        withPreparedLockCleanupClaim(publication.filePath, () => {
            const owned = fs.fstatSync(publication.descriptor);
            const observed = fs.lstatSync(publication.filePath, {
                throwIfNoEntry: false,
            });
            if (!observed)
                return;
            if (observed.dev !== owned.dev || observed.ino !== owned.ino)
                return;
            if (!observed.isFile() ||
                observed.isSymbolicLink() ||
                !owned.isFile() ||
                observed.nlink !== 1 ||
                owned.nlink !== 1 ||
                observed.size !== Buffer.byteLength(publication.content) ||
                owned.size !== Buffer.byteLength(publication.content) ||
                (observed.mode & 0o777) !== 0o600 ||
                (owned.mode & 0o777) !== 0o600 ||
                readDescriptorContent(publication.descriptor, Buffer.byteLength(publication.content)) !== publication.content) {
                throw invalidSessionLock();
            }
            const final = fs.lstatSync(publication.filePath, {
                throwIfNoEntry: false,
            });
            if (!final)
                return;
            if (final.dev !== owned.dev || final.ino !== owned.ino)
                return;
            if (!final.isFile() ||
                final.isSymbolicLink() ||
                final.nlink !== 1 ||
                final.size !== Buffer.byteLength(publication.content) ||
                (final.mode & 0o777) !== 0o600 ||
                readDescriptorContent(publication.descriptor, Buffer.byteLength(publication.content)) !== publication.content) {
                throw invalidSessionLock();
            }
            const stable = fs.lstatSync(publication.filePath, {
                throwIfNoEntry: false,
            });
            if (!stable)
                return;
            if (stable.dev !== owned.dev || stable.ino !== owned.ino)
                return;
            if (!stable.isFile() ||
                stable.isSymbolicLink() ||
                stable.nlink !== 1 ||
                stable.size !== Buffer.byteLength(publication.content) ||
                (stable.mode & 0o777) !== 0o600) {
                throw invalidSessionLock();
            }
            try {
                fs.unlinkSync(publication.filePath);
            }
            catch (error) {
                if (!isNodeError(error) || error.code !== 'ENOENT')
                    throw error;
            }
            fsyncDirectory(path.dirname(publication.filePath));
        });
    }
    finally {
        fs.closeSync(publication.descriptor);
    }
}
function closeRuntimeFilePublications(publications) {
    const errors = [];
    for (const publication of publications) {
        try {
            closeOwnedRuntimeFilePublication(publication);
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, 'Runtime publication descriptors failed to close.');
    }
}
function rollbackRuntimeFilePublications(publications, primaryError) {
    const errors = [];
    for (const publication of [...publications].reverse()) {
        try {
            rollbackOwnedRuntimeFilePublication(publication);
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (primaryError !== undefined) {
        if (errors.length > 0) {
            throw new AggregateError([primaryError, ...errors], 'Task-session lease acquisition failed and cleanup was incomplete.');
        }
        throw primaryError;
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, 'Task-session lease cleanup was incomplete.');
    }
}
export function releaseTaskSessionIsolationLeases(runtime, session) {
    for (const leasePath of taskSessionIsolationLeasePaths(runtime, session)) {
        releaseOwnedLock(leasePath, session.sessionId);
    }
}
export function assertTaskSessionIsolationLeasesOwned(runtime, session) {
    for (const leasePath of taskSessionIsolationLeasePaths(runtime, session)) {
        assertOwnedLock(leasePath, session.sessionId, session.changeId, session.taskId);
    }
}
export function taskSessionIsolationLeasePaths(runtime, session) {
    const root = path.join(runtime.root, 'task-isolation');
    return [
        path.join(root, 'worktrees', `${session.isolation.worktreeDigest.slice('sha256:'.length)}.lock`),
        ...session.isolation.resources.map((resource) => path.join(root, 'resources', `${resource.digest.slice('sha256:'.length)}.lock`)),
    ];
}
export function observeTaskSessionIsolationLease(runtime, leasePath) {
    if (!assertExistingRuntimeDirectoryChain(runtime.root, path.dirname(leasePath))) {
        return Object.freeze({ state: 'absent', leasePath });
    }
    const before = fs.lstatSync(leasePath, { throwIfNoEntry: false });
    if (!before)
        return Object.freeze({ state: 'absent', leasePath });
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        ![1, 2].includes(before.nlink) ||
        (before.mode & 0o777) !== 0o600) {
        throw invalidSessionLock();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(leasePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        const content = fs.readFileSync(descriptor, 'utf8');
        const after = fs.lstatSync(leasePath, { throwIfNoEntry: false });
        const value = parseManagedSessionLock(content);
        if (!after ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            !opened.isFile() ||
            ![1, 2].includes(opened.nlink) ||
            opened.nlink !== after.nlink ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.size !== Buffer.byteLength(content) ||
            value === null) {
            throw invalidSessionLock();
        }
        try {
            assertSessionId(value.sessionId);
            assertChangeId(value.changeId);
            assertTaskId(value.taskId);
        }
        catch {
            throw invalidSessionLock();
        }
        const temporaryPath = opened.nlink === 2
            ? preparedLockTemporaryPath(leasePath, value.pid, value.ownerToken)
            : null;
        if (temporaryPath !== null) {
            const temporary = fs.lstatSync(temporaryPath, {
                throwIfNoEntry: false,
            });
            if (!temporary?.isFile() ||
                temporary.isSymbolicLink() ||
                temporary.dev !== opened.dev ||
                temporary.ino !== opened.ino ||
                temporary.nlink !== 2 ||
                (temporary.mode & 0o777) !== 0o600) {
                throw invalidSessionLock();
            }
        }
        const sessionPath = path.join(runtime.sessions, `${value.sessionId}.json`);
        const owner = observeStableWorkflowSession(runtime.root, sessionPath);
        if (owner === null) {
            return processIsAlive(value.pid)
                ? Object.freeze({ state: 'occupied', leasePath })
                : Object.freeze({
                    state: 'reclaimable',
                    leasePath,
                    dev: opened.dev,
                    ino: opened.ino,
                    nlink: opened.nlink,
                    content,
                    temporaryPath,
                    owner: Object.freeze({
                        kind: 'missing',
                        runtimeRoot: runtime.root,
                        sessionPath,
                        pid: value.pid,
                    }),
                });
        }
        if (owner.session.changeId !== value.changeId ||
            owner.session.taskId !== value.taskId ||
            !taskSessionIsolationLeasePaths(runtime, owner.session).includes(leasePath)) {
            throw invalidSessionLock();
        }
        if (owner.session.state === 'active' ||
            owner.session.state === 'revising') {
            return Object.freeze({ state: 'occupied', leasePath });
        }
        return Object.freeze({
            state: 'reclaimable',
            leasePath,
            dev: opened.dev,
            ino: opened.ino,
            nlink: opened.nlink,
            content,
            temporaryPath,
            owner: Object.freeze({ kind: 'terminal', observation: owner }),
        });
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ELOOP') {
            throw invalidSessionLock();
        }
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function observeStableWorkflowSession(runtimeRoot, sessionPath) {
    if (!assertExistingRuntimeDirectoryChain(runtimeRoot, path.dirname(sessionPath))) {
        return null;
    }
    const before = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
    if (!before)
        return null;
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600) {
        throw invalidSessionLock();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(sessionPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        const content = fs.readFileSync(descriptor, 'utf8');
        const after = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
        let value;
        try {
            value = JSON.parse(content);
        }
        catch {
            throw invalidSessionLock();
        }
        if (!after ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            !opened.isFile() ||
            opened.nlink !== 1 ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.size !== Buffer.byteLength(content) ||
            `${JSON.stringify(value, null, 2)}\n` !== content ||
            !isWorkflowSession(value) ||
            value.sessionId !== path.basename(sessionPath, '.json')) {
            throw invalidSessionLock();
        }
        return Object.freeze({
            session: value,
            runtimeRoot,
            sessionPath,
            dev: opened.dev,
            ino: opened.ino,
            content,
        });
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ELOOP') {
            throw invalidSessionLock();
        }
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function reclaimObservedTaskSessionIsolationLease(observation) {
    assertPlainDirectory(path.dirname(observation.leasePath));
    withPreparedLockCleanupClaim(observation.leasePath, () => {
        if (observation.owner.kind === 'terminal') {
            assertStableSessionObservation(observation.owner.observation);
        }
        else {
            if (observeStableWorkflowSession(observation.owner.runtimeRoot, observation.owner.sessionPath) !== null ||
                processIsAlive(observation.owner.pid)) {
                throw invalidSessionLock();
            }
        }
        let descriptor;
        try {
            descriptor = fs.openSync(observation.leasePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const opened = fs.fstatSync(descriptor);
            const content = fs.readFileSync(descriptor, 'utf8');
            const current = fs.lstatSync(observation.leasePath, {
                throwIfNoEntry: false,
            });
            if (!current ||
                current.dev !== observation.dev ||
                current.ino !== observation.ino ||
                opened.dev !== observation.dev ||
                opened.ino !== observation.ino ||
                opened.nlink !== observation.nlink ||
                (opened.mode & 0o777) !== 0o600 ||
                content !== observation.content) {
                throw invalidSessionLock();
            }
            if (observation.temporaryPath !== null) {
                const temporary = fs.lstatSync(observation.temporaryPath, {
                    throwIfNoEntry: false,
                });
                if (!temporary?.isFile() ||
                    temporary.dev !== opened.dev ||
                    temporary.ino !== opened.ino ||
                    temporary.nlink !== 2) {
                    throw invalidSessionLock();
                }
                fs.unlinkSync(observation.temporaryPath);
            }
            const final = fs.lstatSync(observation.leasePath, {
                throwIfNoEntry: false,
            });
            if (!final || final.dev !== opened.dev || final.ino !== opened.ino) {
                throw invalidSessionLock();
            }
            fs.unlinkSync(observation.leasePath);
            fsyncDirectory(path.dirname(observation.leasePath));
        }
        catch (error) {
            if (isNodeError(error) &&
                ['ENOENT', 'ELOOP'].includes(error.code ?? '')) {
                throw invalidSessionLock();
            }
            throw error;
        }
        finally {
            if (descriptor !== undefined)
                fs.closeSync(descriptor);
        }
    });
}
function assertStableSessionObservation(observation) {
    const current = observeStableWorkflowSession(observation.runtimeRoot, observation.sessionPath);
    if (!current ||
        current.dev !== observation.dev ||
        current.ino !== observation.ino ||
        current.content !== observation.content) {
        throw invalidSessionLock();
    }
}
function assertExistingRuntimeDirectoryChain(runtimeRoot, targetDirectory) {
    const root = path.resolve(runtimeRoot);
    const target = path.resolve(targetDirectory);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw invalidSessionLock();
    }
    let current = root;
    for (const part of relative === '' ? [] : relative.split(path.sep)) {
        const stats = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stats)
            return false;
        if (!stats.isDirectory() ||
            stats.isSymbolicLink() ||
            fs.realpathSync(current) !== current) {
            throw invalidSessionLock();
        }
        current = path.join(current, part);
    }
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats)
        return false;
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(current) !== current) {
        throw invalidSessionLock();
    }
    return true;
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !(isNodeError(error) && error.code === 'ESRCH');
    }
}
export function taskSessionLeaseConflict(leasePath) {
    return workflowError('TASK_SESSION_LEASE_CONFLICT', 'A task-session worktree or resource lease is already owned.', ExitCode.conflict, { details: { lease: path.basename(leasePath) } });
}
