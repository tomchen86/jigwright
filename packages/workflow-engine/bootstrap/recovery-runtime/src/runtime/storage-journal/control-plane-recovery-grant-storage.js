/** Private record publication and interrupted-write recovery. Inode, byte, mode,
 * ownership and fsync checks form one protocol and retain their original order. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExitCode } from "../../foundation/errors/errors.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { verifyRecordDigest, rawDigest, isRecord, recoveryRecordCorrupt, recoveryError, RECOVERY_GRANT_ID, } from "../../modules/authority/control-plane-recovery-grant-values.js";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 1024 * 1024;
export const RECOVERY_RECORD_NAME = /^[0-9a-f]{64}\.json$/;
export const RECOVERY_RECORD_TEMPORARY = /^\.([0-9a-f]{64}\.json)\.(absent|[0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
export function recoveryRecordsDirectory(storageRoot, create) {
    const root = path.resolve(storageRoot);
    if (root !== storageRoot) {
        throw recoveryError('HARNESS_RECOVERY_STATE_UNSAFE', 'Recovery state root must be an exact absolute path.', ExitCode.unsafeEnvironment);
    }
    const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!rootStats?.isDirectory() ||
        rootStats.isSymbolicLink() ||
        fs.realpathSync(root) !== root ||
        (rootStats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !ownedByCurrentUser(rootStats)) {
        throw recoveryStateUnsafe();
    }
    const directory = path.join(root, 'control-plane-recovery-grants');
    if (create && !fs.lstatSync(directory, { throwIfNoEntry: false })) {
        try {
            fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
            fsyncDirectory(root);
        }
        catch (error) {
            if (!isNodeCode(error, 'EEXIST'))
                throw recoveryStateUnsafe();
        }
    }
    return directory;
}
export function recoveryRecordPath(storageRoot, recoveryGrantId, createDirectory) {
    if (!RECOVERY_GRANT_ID.test(recoveryGrantId)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant ID is malformed.');
    }
    const directory = recoveryRecordsDirectory(storageRoot, createDirectory);
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
        assertPrivateDirectory(directory);
    }
    return path.join(directory, `${rawDigest(`control-plane-recovery\0${recoveryGrantId}`).slice('sha256:'.length)}.json`);
}
export function recoveryGrantIdFromRecordPath(directory, entry) {
    const value = readCanonicalRecord(path.join(directory, entry));
    if (!isRecord(value) ||
        !isRecord(value.envelope) ||
        !isRecord(value.envelope.payload) ||
        typeof value.envelope.payload.grantId !== 'string') {
        throw recoveryRecordCorrupt();
    }
    const grantId = value.envelope.payload.grantId;
    const expected = `${rawDigest(`control-plane-recovery\0${grantId}`).slice('sha256:'.length)}.json`;
    if (entry !== expected)
        throw recoveryRecordCorrupt();
    return grantId;
}
export function assertPrivateDirectory(directory) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!path.isAbsolute(directory) ||
        path.resolve(directory) !== directory ||
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory ||
        (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !ownedByCurrentUser(stats)) {
        throw recoveryStateUnsafe();
    }
}
export function readCanonicalRecord(filePath, allowedLinkCounts = [1]) {
    const inspected = inspectPrivateRecordFile(filePath, allowedLinkCounts);
    if (inspected.value === null)
        throw recoveryRecordCorrupt();
    return inspected.value;
}
function inspectPrivateRecordFile(filePath, allowedLinkCounts) {
    if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
        throw recoveryRecordCorrupt();
    }
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before?.isFile() ||
        before.isSymbolicLink() ||
        !allowedLinkCounts.includes(before.nlink) ||
        (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !ownedByCurrentUser(before) ||
        safeRealpath(filePath) !== filePath ||
        before.size > MAX_RECORD_BYTES) {
        throw recoveryRecordCorrupt();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const openedBefore = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
            throw recoveryRecordCorrupt();
        }
        const raw = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
            throw recoveryRecordCorrupt();
        }
        let bytes;
        try {
            bytes = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        }
        catch {
            return { bytes: '', raw, stats: openedAfter, value: null };
        }
        try {
            if (!bytes.endsWith('\n')) {
                return { bytes, raw, stats: openedAfter, value: null };
            }
            const value = JSON.parse(bytes);
            if (`${canonicalJson(value)}\n` !== bytes) {
                return { bytes, raw, stats: openedAfter, value: null };
            }
            return { bytes, raw, stats: openedAfter, value };
        }
        catch {
            return { bytes, raw, stats: openedAfter, value: null };
        }
    }
    catch (error) {
        if (isWorkflowCode(error))
            throw error;
        throw recoveryRecordCorrupt();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function writeExclusive(filePath, bytes) {
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    try {
        fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, bytes, 'utf8');
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
}
export function replaceAtomic(filePath, bytes, expectedOldRecordDigest, nextRecordDigest) {
    const directory = path.dirname(filePath);
    const expectation = {
        targetName: path.basename(filePath),
        expectedOldRecordDigest,
        nextRecordDigest,
        bytes,
    };
    reconcileRecoveryRecordTemporaries(directory, expectation);
    const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (expectedOldRecordDigest === null && existing) {
        const current = readCanonicalRecord(filePath);
        if (!isRecord(current) ||
            current.recordDigest !== nextRecordDigest ||
            serializeRecord(current) !== bytes) {
            throw recoveryRecordCorrupt();
        }
        assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
        return;
    }
    const expected = expectedOldRecordDigest === null
        ? 'absent'
        : expectedOldRecordDigest.slice('sha256:'.length);
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${expected}.${nextRecordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`);
    try {
        writeExclusive(temporary, bytes);
        if (expectedOldRecordDigest === null) {
            try {
                fs.linkSync(temporary, filePath);
            }
            catch (error) {
                if (!isNodeCode(error, 'EEXIST'))
                    throw recoveryStateUnsafe();
                const raced = readCanonicalRecord(filePath);
                if (!isRecord(raced) ||
                    raced.recordDigest !== nextRecordDigest ||
                    serializeRecord(raced) !== bytes) {
                    throw recoveryRecordCorrupt();
                }
                unlinkOwnedPreparationIfPresent(temporary, bytes);
                assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
                return;
            }
            assertExactHardLinkPair(temporary, filePath);
            const published = readCanonicalRecord(filePath, [2]);
            if (!isRecord(published) ||
                published.recordDigest !== nextRecordDigest ||
                serializeRecord(published) !== bytes) {
                throw recoveryRecordCorrupt();
            }
            fsyncDirectory(directory);
            unlinkExactAlias(temporary, filePath);
            fsyncDirectory(directory);
            assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
            return;
        }
        else {
            const currentValue = readCanonicalRecord(filePath);
            if (!isRecord(currentValue) ||
                currentValue.recordDigest !== expectedOldRecordDigest) {
                throw recoveryRecordCorrupt();
            }
        }
        fs.renameSync(temporary, filePath);
        fsyncDirectory(directory);
        assertExactPublishedRecord(filePath, nextRecordDigest, bytes);
    }
    finally {
        unlinkOwnedPreparationIfPresent(temporary, bytes);
    }
}
function assertExactPublishedRecord(filePath, expectedRecordDigest, expectedBytes) {
    const published = readCanonicalRecord(filePath);
    if (!isRecord(published) ||
        published.recordDigest !== expectedRecordDigest ||
        serializeRecord(published) !== expectedBytes) {
        throw recoveryRecordCorrupt();
    }
}
export function reconcileRecoveryRecordTemporaries(directory, expectation) {
    assertPrivateDirectory(directory);
    reconcileCleanupQuarantine(directory);
    const entries = fs.readdirSync(directory).sort();
    const recognized = entries
        .map((entry) => ({
        entry,
        current: RECOVERY_RECORD_TEMPORARY.exec(entry),
    }))
        .filter((match) => match.current !== null);
    if (entries.some((entry) => !RECOVERY_RECORD_NAME.test(entry) &&
        !RECOVERY_RECORD_TEMPORARY.test(entry))) {
        throw recoveryRecordCorrupt();
    }
    for (const match of recognized) {
        const temporaryPath = path.join(directory, match.entry);
        const targetName = match.current[1];
        const targetPath = path.join(directory, targetName);
        if (expectation?.targetName === targetName &&
            !expectationMatchesPreparation(expectation, targetName, match)) {
            throw recoveryRecordCorrupt();
        }
        const inspected = inspectPrivateRecordFile(temporaryPath, [1, 2]);
        const targetStats = fs.lstatSync(targetPath, {
            throwIfNoEntry: false,
        });
        if (targetStats && sameInode(inspected.stats, targetStats)) {
            assertExactHardLinkPair(temporaryPath, targetPath);
            if (inspected.value === null)
                throw recoveryRecordCorrupt();
            assertPreparedRecord(inspected.value, targetName, match.current[3]);
            const targetValue = readCanonicalRecord(targetPath, [2]);
            if (canonicalJson(targetValue) !== canonicalJson(inspected.value)) {
                throw recoveryRecordCorrupt();
            }
            unlinkExactAlias(temporaryPath, targetPath);
            fsyncDirectory(directory);
            continue;
        }
        if (inspected.stats.nlink !== 1)
            throw recoveryRecordCorrupt();
        if (!isRecord(inspected.value)) {
            if (expectationMatchesPreparation(expectation, targetName, match) &&
                isStrictBytePrefix(inspected.raw, expectation.bytes)) {
                unlinkExactSingleFile(temporaryPath, inspected.stats);
                fsyncDirectory(directory);
                continue;
            }
            const namedExpected = match.current[2];
            if (!targetStats && namedExpected === 'absent')
                continue;
            if (targetStats?.nlink === 1) {
                const currentValue = readCanonicalRecord(targetPath);
                if (isRecord(currentValue) &&
                    namedExpected !== 'absent' &&
                    currentValue.recordDigest === `sha256:${namedExpected}`) {
                    continue;
                }
            }
            throw recoveryRecordCorrupt();
        }
        assertPreparedRecord(inspected.value, targetName, match.current[3]);
        if (!targetStats) {
            if (expectationMatchesPreparation(expectation, targetName, match) &&
                inspected.bytes === expectation.bytes) {
                unlinkExactSingleFile(temporaryPath, inspected.stats);
                fsyncDirectory(directory);
                continue;
            }
            if (match.current[2] === 'absent')
                continue;
            throw recoveryRecordCorrupt();
        }
        const currentValue = readCanonicalRecord(targetPath);
        if (canonicalJson(currentValue) === canonicalJson(inspected.value)) {
            unlinkExactSingleFile(temporaryPath, inspected.stats);
            fsyncDirectory(directory);
            continue;
        }
        if (!isRecord(currentValue)) {
            throw recoveryRecordCorrupt();
        }
        const namedExpected = match.current[2];
        if (namedExpected === 'absent' ||
            currentValue.recordDigest !== `sha256:${namedExpected}`) {
            throw recoveryRecordCorrupt();
        }
        if (expectationMatchesPreparation(expectation, targetName, match) &&
            inspected.bytes === expectation.bytes) {
            unlinkExactSingleFile(temporaryPath, inspected.stats);
            fsyncDirectory(directory);
        }
    }
    const expectedTarget = expectation === undefined
        ? undefined
        : path.join(directory, expectation.targetName);
    if (expectedTarget &&
        fs.lstatSync(expectedTarget, { throwIfNoEntry: false })) {
        const stats = fs.lstatSync(expectedTarget);
        if (stats.nlink !== 1)
            throw recoveryRecordCorrupt();
    }
}
function reconcileCleanupQuarantine(recordsDirectory) {
    const quarantineRoot = path.join(path.dirname(recordsDirectory), 'control-plane-recovery-cleanup-quarantine');
    if (fs.lstatSync(quarantineRoot, { throwIfNoEntry: false }) === undefined) {
        return;
    }
    assertPrivateDirectory(quarantineRoot);
    for (const entry of fs.readdirSync(quarantineRoot).sort()) {
        if (!/^cleanup-[A-Za-z0-9]{6}$/.test(entry)) {
            throw recoveryRecordCorrupt();
        }
        const operationDirectory = path.join(quarantineRoot, entry);
        assertPrivateDirectory(operationDirectory);
        const contents = fs.readdirSync(operationDirectory).sort();
        if (contents.length === 0) {
            continue;
        }
        const ambiguousTargets = contents.filter((name) => /^ambiguous-target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name));
        for (const ambiguous of ambiguousTargets) {
            inspectPrivateRecordFile(path.join(operationDirectory, ambiguous), [1]);
        }
        const authoritative = contents.filter((name) => !ambiguousTargets.includes(name));
        if (canonicalJson(authoritative) !== canonicalJson(['residue']) &&
            canonicalJson(authoritative) !== canonicalJson(['anchor', 'residue'])) {
            throw recoveryRecordCorrupt();
        }
        const residue = path.join(operationDirectory, 'residue');
        const inspected = inspectPrivateRecordFile(residue, [1, 2]);
        if (inspected.stats.nlink === 1) {
            if (canonicalJson(authoritative) !== canonicalJson(['residue'])) {
                throw recoveryRecordCorrupt();
            }
            continue;
        }
        if (!isRecord(inspected.value)) {
            throw recoveryRecordCorrupt();
        }
        const target = path.join(recordsDirectory, expectedRecoveryRecordName(inspected.value));
        detachQuarantinedHardLink(operationDirectory, residue, target, inspected.value);
    }
}
function expectationMatchesPreparation(expectation, targetName, match) {
    if (expectation === undefined || expectation.targetName !== targetName) {
        return false;
    }
    const expected = expectation.expectedOldRecordDigest === null
        ? 'absent'
        : expectation.expectedOldRecordDigest.slice('sha256:'.length);
    return (match.current[2] === expected &&
        match.current[3] === expectation.nextRecordDigest.slice('sha256:'.length));
}
function assertPreparedRecord(value, targetName, namedNextDigest) {
    if (!isRecord(value) ||
        !verifyRecordDigest(value) ||
        expectedRecoveryRecordName(value) !== targetName ||
        (namedNextDigest !== undefined &&
            value.recordDigest !== `sha256:${namedNextDigest}`)) {
        throw recoveryRecordCorrupt();
    }
}
function isStrictBytePrefix(prefix, exact) {
    const expected = Buffer.from(exact, 'utf8');
    return (prefix.length < expected.length &&
        prefix.equals(expected.subarray(0, prefix.length)));
}
function unlinkOwnedPreparationIfPresent(temporary, expectedBytes) {
    const stats = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (stats === undefined || stats.nlink === 2)
        return;
    const inspected = inspectPrivateRecordFile(temporary, [1]);
    const exact = Buffer.from(expectedBytes, 'utf8');
    if (!inspected.raw.equals(exact) &&
        !isStrictBytePrefix(inspected.raw, expectedBytes)) {
        throw recoveryRecordCorrupt();
    }
    unlinkExactSingleFile(temporary, inspected.stats);
    fsyncDirectory(path.dirname(temporary));
}
function unlinkExactSingleFile(filePath, expected) {
    quarantineVerifiedPath(filePath, expected, [1]);
}
function assertExactHardLinkPair(leftPath, rightPath) {
    const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
    const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
    if (left === undefined ||
        right === undefined ||
        !sameInode(left, right) ||
        left.nlink !== 2 ||
        right.nlink !== 2) {
        throw recoveryRecordCorrupt();
    }
}
function unlinkExactAlias(alias, anchor) {
    assertExactHardLinkPair(alias, anchor);
    const aliasStats = fs.lstatSync(alias);
    const anchorBefore = fs.lstatSync(anchor);
    const value = readCanonicalRecord(alias, [2]);
    if (!isRecord(value))
        throw recoveryRecordCorrupt();
    const quarantined = quarantineVerifiedPath(alias, aliasStats, [2], {
        filePath: anchor,
        stats: anchorBefore,
    });
    detachQuarantinedHardLink(quarantined.operationDirectory, quarantined.residue, anchor, value);
    const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
    if (anchorStats === undefined ||
        sameInode(anchorBefore, anchorStats) ||
        anchorStats.nlink !== 1 ||
        anchorStats.size !== Buffer.byteLength(serializeRecord(value)) ||
        (anchorStats.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !ownedByCurrentUser(anchorStats)) {
        throw recoveryRecordCorrupt();
    }
}
function quarantineVerifiedPath(filePath, expected, allowedLinkCounts, anchor) {
    const sourceDirectory = path.dirname(filePath);
    const storageRoot = path.dirname(sourceDirectory);
    assertPrivateDirectory(storageRoot);
    const quarantineRoot = path.join(storageRoot, 'control-plane-recovery-cleanup-quarantine');
    const existingRoot = fs.lstatSync(quarantineRoot, {
        throwIfNoEntry: false,
    });
    if (existingRoot === undefined) {
        try {
            fs.mkdirSync(quarantineRoot, { mode: PRIVATE_DIRECTORY_MODE });
            fsyncDirectory(storageRoot);
        }
        catch (error) {
            if (!isNodeCode(error, 'EEXIST'))
                throw recoveryStateUnsafe();
        }
    }
    assertPrivateDirectory(quarantineRoot);
    const operationDirectory = fs.mkdtempSync(path.join(quarantineRoot, 'cleanup-'));
    fs.chmodSync(operationDirectory, PRIVATE_DIRECTORY_MODE);
    fsyncDirectory(quarantineRoot);
    const residue = path.join(operationDirectory, 'residue');
    try {
        fs.renameSync(filePath, residue);
        fsyncDirectory(sourceDirectory);
        fsyncDirectory(operationDirectory);
    }
    catch {
        throw recoveryRecordCorrupt();
    }
    const moved = fs.lstatSync(residue, { throwIfNoEntry: false });
    if (moved === undefined ||
        !sameFileAfterRename(expected, moved, allowedLinkCounts)) {
        throw recoveryRecordCorrupt();
    }
    if (anchor !== undefined) {
        const observedAnchor = fs.lstatSync(anchor.filePath, {
            throwIfNoEntry: false,
        });
        if (observedAnchor === undefined ||
            !sameInode(anchor.stats, observedAnchor) ||
            observedAnchor.nlink !== 2 ||
            observedAnchor.size !== anchor.stats.size ||
            (observedAnchor.mode & 0o777) !== PRIVATE_FILE_MODE ||
            !ownedByCurrentUser(observedAnchor)) {
            throw recoveryRecordCorrupt();
        }
    }
    return { operationDirectory, residue };
}
function detachQuarantinedHardLink(operationDirectory, residue, target, value) {
    const expectedName = expectedRecoveryRecordName(value);
    assertPreparedRecord(value, expectedName, undefined);
    if (path.basename(target) !== expectedName)
        throw recoveryRecordCorrupt();
    const bytes = serializeRecord(value);
    const anchor = path.join(operationDirectory, 'anchor');
    const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
    if (anchorStats === undefined) {
        assertExactHardLinkPair(residue, target);
        const targetValue = readCanonicalRecord(target, [2]);
        if (canonicalJson(targetValue) !== canonicalJson(value)) {
            throw recoveryRecordCorrupt();
        }
        try {
            fs.renameSync(target, anchor);
            fsyncDirectory(path.dirname(target));
            fsyncDirectory(operationDirectory);
        }
        catch {
            throw recoveryRecordCorrupt();
        }
    }
    assertExactHardLinkPair(residue, anchor);
    const residueValue = readCanonicalRecord(residue, [2]);
    const movedAnchorValue = readCanonicalRecord(anchor, [2]);
    if (canonicalJson(residueValue) !== canonicalJson(value) ||
        canonicalJson(movedAnchorValue) !== canonicalJson(value)) {
        throw recoveryRecordCorrupt();
    }
    let targetBeforePublish = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetBeforePublish !== undefined) {
        const inspectedTarget = inspectPrivateRecordFile(target, [1]);
        if (inspectedTarget.value === null) {
            if (!isStrictBytePrefix(inspectedTarget.raw, bytes)) {
                throw recoveryRecordCorrupt();
            }
            const ambiguous = path.join(operationDirectory, `ambiguous-target-${crypto.randomUUID()}`);
            try {
                fs.renameSync(target, ambiguous);
                fsyncDirectory(path.dirname(target));
                fsyncDirectory(operationDirectory);
            }
            catch {
                throw recoveryRecordCorrupt();
            }
            const movedAmbiguous = fs.lstatSync(ambiguous, {
                throwIfNoEntry: false,
            });
            if (movedAmbiguous === undefined ||
                !sameFileAfterRename(inspectedTarget.stats, movedAmbiguous, [1])) {
                throw recoveryRecordCorrupt();
            }
            targetBeforePublish = undefined;
        }
    }
    if (targetBeforePublish === undefined) {
        writeExclusive(target, bytes);
        assertExactPublishedRecord(target, value.recordDigest, bytes);
    }
    else {
        const current = readCanonicalRecord(target);
        assertPreparedRecord(current, expectedName, undefined);
    }
    const targetStats = fs.lstatSync(target);
    const oldStats = fs.lstatSync(residue);
    if (targetStats.nlink !== 1 || sameInode(targetStats, oldStats)) {
        throw recoveryRecordCorrupt();
    }
}
function expectedRecoveryRecordName(value) {
    if (!isRecord(value.envelope) ||
        !isRecord(value.envelope.payload) ||
        typeof value.envelope.payload.grantId !== 'string' ||
        !RECOVERY_GRANT_ID.test(value.envelope.payload.grantId)) {
        throw recoveryRecordCorrupt();
    }
    return `${rawDigest(`control-plane-recovery\0${value.envelope.payload.grantId}`).slice('sha256:'.length)}.json`;
}
function sameFileAfterRename(left, right, allowedLinkCounts) {
    return (sameInode(left, right) &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        allowedLinkCounts.includes(right.nlink) &&
        (right.mode & 0o777) === PRIVATE_FILE_MODE &&
        left.mtimeMs === right.mtimeMs &&
        ownedByCurrentUser(right));
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function sameInode(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function sameFileSnapshot(left, right, allowedLinkCounts) {
    return (sameInode(left, right) &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        allowedLinkCounts.includes(right.nlink) &&
        (right.mode & 0o777) === PRIVATE_FILE_MODE &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs &&
        ownedByCurrentUser(right));
}
function ownedByCurrentUser(stats) {
    return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}
function safeRealpath(filePath) {
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return null;
    }
}
export function serializeRecord(value) {
    const bytes = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
        throw recoveryRecordCorrupt();
    return bytes;
}
function recoveryStateUnsafe() {
    return recoveryError('HARNESS_RECOVERY_STATE_UNSAFE', 'Recovery state must remain in exact private non-symlink storage.', ExitCode.unsafeEnvironment);
}
function isWorkflowCode(error) {
    return error instanceof Error && 'code' in error;
}
function isNodeCode(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code);
}
