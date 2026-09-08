/**
 * Reconciles native session publication residue against its exact target and scope.
 *
 * Invariants:
 * - Only the single validated temporary entry can be discarded or reconciled.
 * - Recovery retains target identity, link count, digest, and scope checks.
 *
 * Depends on: Native session envelopes, bounded file snapshots, and recovery directory layout.
 * Failure modes: Foreign residue is deleted or an incomplete publication becomes resumable state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertProviderNativeSessionContinuationAuthorityEnvelopeV1 } from "../../modules/provider-orchestration/agent-runtime-durable-authority.js";
import { assertProviderNativeSessionClaimV1, assertProviderNativeSessionCompletionV1, assertProviderNativeSessionHandleV1, } from "../../modules/provider-orchestration/provider-native-session.js";
import { assertPrivateInvestigationDirectory } from "./investigation-private-files.js";
import { assertDigest, MAX_OBJECT_BYTES, MAX_HANDLE_BYTES, MAX_CONTINUATION_AUTHORITY_BYTES, isDigest, TURN_REF, MAX_TURN, MAX_REF_BYTES, assertClaimRef, assertCompletionRef, } from "./provider-native-session-contracts.js";
import { storeInvalid, compareCodeUnits, isRecord, } from "./provider-native-session-values.js";
import { UTF8, sameStableFile, readBoundedCanonicalSnapshotWithLinkCount, assertPrivateFileStats, sameFile, fsyncDirectory, readBoundedCanonicalSnapshot, } from "./provider-native-session-files.js";
const PUBLICATION_TEMP = /^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/u;
export function publicationRecoveryDirectory(locations, scopeKey) {
    return path.join(locations.recovery, assertDigest(scopeKey));
}
export function publicationTemporaryPath(locations, scopeKey, filePath) {
    const target = publicationRecoveryTarget(locations, scopeKey, filePath);
    const encodedTarget = Buffer.from(target.relativePath, 'utf8').toString('base64url');
    return path.join(publicationRecoveryDirectory(locations, scopeKey), `v1.${encodedTarget}.${crypto.randomUUID()}.publish.tmp`);
}
export function publicationRecoveryTarget(locations, scopeKey, requestedFilePath) {
    const expectedScopeKey = assertDigest(scopeKey);
    const filePath = path.resolve(requestedFilePath);
    if (filePath !== requestedFilePath)
        throw storeInvalid();
    const nativeRelativePath = path.relative(locations.root, filePath);
    if (nativeRelativePath.length === 0 ||
        path.isAbsolute(nativeRelativePath) ||
        nativeRelativePath === '..' ||
        nativeRelativePath.startsWith(`..${path.sep}`)) {
        throw storeInvalid();
    }
    const relativePath = nativeRelativePath.split(path.sep).join('/');
    const parts = relativePath.split('/');
    const objectKinds = Object.freeze({
        claims: Object.freeze({
            suffix: '.claim.json',
            kind: 'claim',
            maxBytes: MAX_OBJECT_BYTES,
        }),
        completions: Object.freeze({
            suffix: '.completion.json',
            kind: 'completion',
            maxBytes: MAX_OBJECT_BYTES,
        }),
        handles: Object.freeze({
            suffix: '.handle.json',
            kind: 'handle',
            maxBytes: MAX_HANDLE_BYTES,
        }),
        'continuation-authorities': Object.freeze({
            suffix: '.continuation-authority.json',
            kind: 'continuation-authority',
            maxBytes: MAX_CONTINUATION_AUTHORITY_BYTES,
        }),
    });
    if (parts.length === 3 &&
        parts[1] === 'sha256' &&
        Object.hasOwn(objectKinds, parts[0])) {
        const definition = objectKinds[parts[0]];
        const fileName = parts[2];
        if (!fileName.endsWith(definition.suffix))
            throw storeInvalid();
        const digest = fileName.slice(0, -definition.suffix.length);
        if (!isDigest(digest))
            throw storeInvalid();
        return Object.freeze({
            filePath,
            relativePath,
            maxBytes: definition.maxBytes,
            kind: definition.kind,
            digest,
            turn: null,
        });
    }
    if (parts.length === 4 &&
        parts[0] === 'chains' &&
        parts[1] === 'sha256' &&
        parts[2] === expectedScopeKey) {
        const match = TURN_REF.exec(parts[3]);
        if (match === null)
            throw storeInvalid();
        const turn = Number(match[1]);
        if (turn < 1 || turn > MAX_TURN)
            throw storeInvalid();
        return Object.freeze({
            filePath,
            relativePath,
            maxBytes: MAX_REF_BYTES,
            kind: match[2] === 'claim' ? 'claim-ref' : 'completion-ref',
            digest: null,
            turn,
        });
    }
    throw storeInvalid();
}
function recoveryTargetFromName(locations, scopeKey, name) {
    const match = PUBLICATION_TEMP.exec(name);
    if (match === null)
        throw storeInvalid();
    let relativePath;
    try {
        const bytes = Buffer.from(match[1], 'base64url');
        if (bytes.toString('base64url') !== match[1])
            throw storeInvalid();
        relativePath = UTF8.decode(bytes);
    }
    catch {
        throw storeInvalid();
    }
    if (relativePath.length === 0 ||
        relativePath.includes('\\') ||
        relativePath.startsWith('/')) {
        throw storeInvalid();
    }
    const filePath = path.join(locations.root, ...relativePath.split('/'));
    const target = publicationRecoveryTarget(locations, scopeKey, filePath);
    if (target.relativePath !== relativePath)
        throw storeInvalid();
    return target;
}
export function recoverScopePublication(paths, locations, scopeKey) {
    const directory = publicationRecoveryDirectory(locations, scopeKey);
    const before = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (before === undefined)
        return;
    assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
    const names = fs.readdirSync(directory).sort(compareCodeUnits);
    const after = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (after === undefined ||
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        (before.mode & 0o777) !== 0o700 ||
        !sameStableFile(before, after) ||
        names.length > 1) {
        throw storeInvalid();
    }
    if (names.length === 0)
        return;
    const name = names[0];
    const target = recoveryTargetFromName(locations, scopeKey, name);
    const temporaryPath = path.join(directory, name);
    const targetBefore = fs.lstatSync(target.filePath, {
        throwIfNoEntry: false,
    });
    if (targetBefore === undefined) {
        assertDiscardableRecoveryTemporary(paths, temporaryPath, target.maxBytes);
        if (fs.lstatSync(target.filePath, { throwIfNoEntry: false }) !== undefined) {
            throw storeInvalid();
        }
    }
    else {
        const temporary = readBoundedCanonicalSnapshotWithLinkCount(paths, temporaryPath, target.maxBytes, 2);
        assertPublicationRecoveryValue(temporary.value, target, scopeKey);
        assertPrivateFileStats(targetBefore, target.maxBytes, 2);
        const targetAfter = fs.lstatSync(target.filePath, {
            throwIfNoEntry: false,
        });
        if (targetAfter === undefined ||
            !sameStableFile(targetBefore, targetAfter) ||
            !sameFile(targetAfter, temporary.identity)) {
            throw storeInvalid();
        }
    }
    try {
        fs.unlinkSync(temporaryPath);
        fsyncDirectory(directory);
    }
    catch {
        throw storeInvalid();
    }
    if (fs.readdirSync(directory).length !== 0)
        throw storeInvalid();
    if (targetBefore !== undefined) {
        const recovered = readBoundedCanonicalSnapshot(paths, target.filePath, target.maxBytes);
        assertPublicationRecoveryValue(recovered.value, target, scopeKey);
    }
}
function assertDiscardableRecoveryTemporary(paths, temporaryPath, maxBytes) {
    assertPrivateInvestigationDirectory(paths, path.dirname(temporaryPath), storeInvalid);
    const absolute = path.resolve(temporaryPath);
    if (absolute !== temporaryPath)
        throw storeInvalid();
    const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (before === undefined)
        throw storeInvalid();
    assertDiscardableRecoveryTemporaryStats(before, maxBytes);
    let descriptor;
    try {
        const noFollow = fs.constants.O_NOFOLLOW;
        const nonBlock = fs.constants.O_NONBLOCK;
        if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
            throw storeInvalid();
        }
        descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow | nonBlock);
        const opened = fs.fstatSync(descriptor);
        assertDiscardableRecoveryTemporaryStats(opened, maxBytes);
        const current = fs.lstatSync(absolute, { throwIfNoEntry: false });
        if (current === undefined ||
            !sameStableFile(before, opened) ||
            !sameStableFile(opened, current) ||
            fs.realpathSync(absolute) !== absolute) {
            throw storeInvalid();
        }
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
function assertDiscardableRecoveryTemporaryStats(stats, maxBytes) {
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size < 0 ||
        stats.size > maxBytes) {
        throw storeInvalid();
    }
}
export function assertPublicationRecoveryValue(value, target, scopeKey) {
    try {
        if (target.kind === 'claim') {
            const claim = assertProviderNativeSessionClaimV1(value);
            if (claim.scope.scopeKey !== scopeKey ||
                claim.claimDigest !== target.digest) {
                throw storeInvalid();
            }
            return;
        }
        if (target.kind === 'completion') {
            const completion = assertProviderNativeSessionCompletionV1(value);
            if (completion.scope.scopeKey !== scopeKey ||
                completion.completionDigest !== target.digest) {
                throw storeInvalid();
            }
            return;
        }
        if (target.kind === 'handle') {
            const handle = assertProviderNativeSessionHandleV1(value, {
                handleDigest: target.digest ?? undefined,
            });
            if (handle.scopeKey !== scopeKey)
                throw storeInvalid();
            return;
        }
        if (target.kind === 'continuation-authority') {
            const authority = assertProviderNativeSessionContinuationAuthorityEnvelopeV1(value, storeInvalid);
            if (authority.scopeKey !== scopeKey ||
                authority.completionDigest !== target.digest) {
                throw storeInvalid();
            }
            return;
        }
        if (target.turn === null)
            throw storeInvalid();
        if (target.kind === 'claim-ref') {
            assertClaimRef(value, scopeKey, target.turn);
            return;
        }
        if (!isRecord(value) || !isDigest(value.claimDigest)) {
            throw storeInvalid();
        }
        assertCompletionRef(value, scopeKey, target.turn, value.claimDigest);
    }
    catch {
        throw storeInvalid();
    }
}
