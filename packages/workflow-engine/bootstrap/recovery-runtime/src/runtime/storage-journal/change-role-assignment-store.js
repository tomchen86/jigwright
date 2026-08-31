import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertChangeRoleAssignmentRefV1 as assertDurableAssignmentRef, createChangeRoleAssignmentRefV1, } from "../../modules/provider-orchestration/agent-runtime-durable-authority.js";
import { assertAgentRolePlanV2Snapshot, } from "../../modules/provider-orchestration/agent-role-plan.js";
import { assertCentralRoleProviderDefaultSnapshotV1, } from "../../modules/provider-orchestration/central-role-provider-default.js";
import { createChangeRoleAssignmentProtectedContextV1, } from "../../modules/provider-orchestration/change-role-assignment.js";
import { assertChangeRoleAssignmentRecordV1, } from "../../modules/provider-orchestration/change-role-assignment-record.js";
import { assertPrivateInvestigationDirectory, ensurePrivateInvestigationDirectory, privatePathExists, withPrivateRuntimeLock, } from "./investigation-session-store.js";
import { changeRoleAssignmentObjectPathV1 as assignmentObjectPath, changeRoleAssignmentRefPathV1 as assignmentRefPath, changeRoleAssignmentStorePathsV1 as storePaths, } from "../session-workspace/provider-runtime-authority-paths.js";
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_REF_BYTES = 2 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const NO_FOLLOW_CREATE = fs.constants.O_RDWR |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
/**
 * Observe one structurally valid immutable assignment without evaluating its
 * authority sources or applying publication recovery. This historical path is
 * deliberately callback-free, lock-free, and write-free.
 */
export function inspectHistoricalChangeRoleAssignmentRecordV1(paths, requestedChangeId, requestedPlanningGeneration) {
    const changeId = assertChangeId(requestedChangeId);
    const planningGeneration = assertDigest(requestedPlanningGeneration);
    const locations = storePaths(paths);
    const refPath = assignmentRefPath(locations, changeId, planningGeneration);
    const refDirectoryBefore = readAssignmentDirectorySnapshot(paths, path.dirname(refPath));
    assertNoAssignmentPublicationWindow(refDirectoryBefore, refPath);
    const refStats = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (refStats === undefined) {
        const refDirectoryAfter = readAssignmentDirectorySnapshot(paths, path.dirname(refPath));
        assertSameAssignmentDirectorySnapshot(refDirectoryBefore, refDirectoryAfter);
        assertNoAssignmentPublicationWindow(refDirectoryAfter, refPath);
        return null;
    }
    const beforeRef = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
    const ref = assertAssignmentRef(beforeRef.value, changeId, planningGeneration);
    const objectPath = assignmentObjectPath(locations, ref.recordDigest);
    const objectDirectoryBefore = readAssignmentDirectorySnapshot(paths, path.dirname(objectPath));
    assertNoAssignmentPublicationWindow(objectDirectoryBefore, objectPath);
    const beforeObject = readBoundedCanonicalSnapshot(paths, objectPath, MAX_OBJECT_BYTES);
    const record = assertChangeRoleAssignmentRecordV1(beforeObject.value, {
        changeId,
        planningGeneration,
        recordDigest: ref.recordDigest,
    });
    const afterObject = readBoundedCanonicalSnapshot(paths, objectPath, MAX_OBJECT_BYTES);
    if (!sameCanonicalSnapshot(beforeObject, afterObject)) {
        throw storeOperationConflict();
    }
    const objectDirectoryAfter = readAssignmentDirectorySnapshot(paths, path.dirname(objectPath));
    assertSameAssignmentDirectorySnapshot(objectDirectoryBefore, objectDirectoryAfter);
    assertNoAssignmentPublicationWindow(objectDirectoryAfter, objectPath);
    const afterRef = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
    if (!sameCanonicalSnapshot(beforeRef, afterRef)) {
        throw storeOperationConflict();
    }
    const refDirectoryAfter = readAssignmentDirectorySnapshot(paths, path.dirname(refPath));
    assertSameAssignmentDirectorySnapshot(refDirectoryBefore, refDirectoryAfter);
    assertNoAssignmentPublicationWindow(refDirectoryAfter, refPath);
    return Object.freeze({
        schemaVersion: 1,
        kind: 'historical-change-role-assignment-observation.v1',
        authorityEligible: false,
        operationalWrites: false,
        sourceAuthority: 'not-evaluated',
        record,
    });
}
/**
 * Read the single assignment selected for a change/planning generation.
 * Absence is the only nullable state; unsafe, malformed, or incomplete state
 * fails closed.
 */
export function readChangeRoleAssignmentRecordV1(paths, requestedChangeId, requestedPlanningGeneration, requestedCentralSnapshotVerifier, requestedChangeOverrideSnapshotVerifier, requestedHostConfigurationVerifier, requestedProviderRegistryVerifier, requestedDataAuthorizationVerifier, requestedSessionCapabilityVerifier, requestedProtectedContextVerifier) {
    const verifyCentralSnapshot = assertCentralSnapshotVerifier(requestedCentralSnapshotVerifier);
    const verifyChangeOverrideSnapshot = assertChangeOverrideSnapshotVerifier(requestedChangeOverrideSnapshotVerifier);
    const verifyHostConfiguration = assertHostConfigurationVerifier(requestedHostConfigurationVerifier);
    const verifyProviderRegistry = assertProviderRegistryVerifier(requestedProviderRegistryVerifier);
    const verifyDataAuthorization = assertDataAuthorizationVerifier(requestedDataAuthorizationVerifier);
    const verifySessionCapability = assertSessionCapabilityVerifier(requestedSessionCapabilityVerifier);
    const verifyProtectedContext = assertProtectedContextVerifier(requestedProtectedContextVerifier);
    const changeId = assertChangeId(requestedChangeId);
    const planningGeneration = assertDigest(requestedPlanningGeneration);
    const locations = storePaths(paths);
    const refPath = assignmentRefPath(locations, changeId, planningGeneration);
    if (!privatePathExists(paths, refPath, storeInvalid))
        return null;
    const beforeRef = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
    const ref = assertAssignmentRef(beforeRef.value, changeId, planningGeneration);
    const record = assertChangeRoleAssignmentRecordV1(readBoundedCanonicalJson(paths, assignmentObjectPath(locations, ref.recordDigest), MAX_OBJECT_BYTES), {
        changeId,
        planningGeneration,
        recordDigest: ref.recordDigest,
    });
    assertVerifiedCentralSnapshot(record, verifyCentralSnapshot);
    assertVerifiedChangeOverrideSnapshot(record, verifyChangeOverrideSnapshot);
    assertVerifiedHostConfiguration(record, verifyHostConfiguration);
    assertVerifiedProviderRegistry(record, verifyProviderRegistry);
    assertVerifiedDataAuthorization(record, verifyDataAuthorization);
    assertVerifiedSessionCapability(record, verifySessionCapability);
    assertVerifiedProtectedContext(record, verifyProtectedContext);
    const afterRef = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
    if (!sameStableFile(beforeRef.identity, afterRef.identity) ||
        !beforeRef.bytes.equals(afterRef.bytes) ||
        canonicalJson(beforeRef.value) !== canonicalJson(afterRef.value)) {
        throw storeInvalid();
    }
    return record;
}
/**
 * Publish a content object and one absent-to-digest generation ref. Exact
 * retries converge; the same change/generation can never be replaced.
 */
export function createOrReadExactChangeRoleAssignmentRecordV1(paths, candidate, requestedCentralSnapshotVerifier, requestedChangeOverrideSnapshotVerifier, requestedHostConfigurationVerifier, requestedProviderRegistryVerifier, requestedDataAuthorizationVerifier, requestedSessionCapabilityVerifier, requestedProtectedContextVerifier) {
    const verifyCentralSnapshot = assertCentralSnapshotVerifier(requestedCentralSnapshotVerifier);
    const verifyChangeOverrideSnapshot = assertChangeOverrideSnapshotVerifier(requestedChangeOverrideSnapshotVerifier);
    const verifyHostConfiguration = assertHostConfigurationVerifier(requestedHostConfigurationVerifier);
    const verifyProviderRegistry = assertProviderRegistryVerifier(requestedProviderRegistryVerifier);
    const verifyDataAuthorization = assertDataAuthorizationVerifier(requestedDataAuthorizationVerifier);
    const verifySessionCapability = assertSessionCapabilityVerifier(requestedSessionCapabilityVerifier);
    const verifyProtectedContext = assertProtectedContextVerifier(requestedProtectedContextVerifier);
    const record = assertChangeRoleAssignmentRecordV1(candidate);
    assertVerifiedCentralSnapshot(record, verifyCentralSnapshot);
    assertVerifiedChangeOverrideSnapshot(record, verifyChangeOverrideSnapshot);
    assertVerifiedHostConfiguration(record, verifyHostConfiguration);
    assertVerifiedProviderRegistry(record, verifyProviderRegistry);
    assertVerifiedDataAuthorization(record, verifyDataAuthorization);
    assertVerifiedSessionCapability(record, verifySessionCapability);
    assertVerifiedProtectedContext(record, verifyProtectedContext);
    const locations = storePaths(paths);
    const lockIdentity = sha256(canonicalJson({
        schemaVersion: 1,
        kind: 'change-role-assignment-generation-lock',
        changeId: record.changeId,
        planningGeneration: record.planningGeneration,
    }));
    return withPrivateRuntimeLock(paths, path.join(paths.locks, 'change-role-assignments', `${lockIdentity}.lock`), () => {
        const current = readChangeRoleAssignmentRecordV1(paths, record.changeId, record.planningGeneration, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext);
        if (current !== null) {
            if (current.recordDigest !== record.recordDigest) {
                throw storeConflict();
            }
            return current;
        }
        assertVerifiedCentralSnapshot(record, verifyCentralSnapshot);
        assertVerifiedChangeOverrideSnapshot(record, verifyChangeOverrideSnapshot);
        assertVerifiedHostConfiguration(record, verifyHostConfiguration);
        assertVerifiedProviderRegistry(record, verifyProviderRegistry);
        assertVerifiedDataAuthorization(record, verifyDataAuthorization);
        assertVerifiedSessionCapability(record, verifySessionCapability);
        assertVerifiedProtectedContext(record, verifyProtectedContext);
        publishCanonicalCreateOnly(paths, assignmentObjectPath(locations, record.recordDigest), record, MAX_OBJECT_BYTES);
        const ref = createChangeRoleAssignmentRefV1(record, storeInvalid);
        publishCanonicalCreateOnly(paths, assignmentRefPath(locations, record.changeId, record.planningGeneration), ref, MAX_REF_BYTES);
        const published = readChangeRoleAssignmentRecordV1(paths, record.changeId, record.planningGeneration, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext);
        if (published?.recordDigest !== record.recordDigest) {
            throw storeInvalid();
        }
        return published;
    }, 'CHANGE_ROLE_ASSIGNMENT_STORE_OPERATION_CONFLICT', storeInvalid);
}
function assertCentralSnapshotVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertChangeOverrideSnapshotVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertHostConfigurationVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertProviderRegistryVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertDataAuthorizationVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertSessionCapabilityVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertProtectedContextVerifier(value) {
    if (typeof value !== 'function')
        throw storeInvalid();
    return value;
}
function assertVerifiedCentralSnapshot(record, verifyCentralSnapshot) {
    try {
        const verified = assertCentralRoleProviderDefaultSnapshotV1(verifyCentralSnapshot(record.central));
        if (canonicalJson(verified) !== canonicalJson(record.central)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function assertVerifiedChangeOverrideSnapshot(record, verifyChangeOverrideSnapshot) {
    if (record.changeOverride === null)
        return;
    try {
        const verified = assertAgentRolePlanV2Snapshot(verifyChangeOverrideSnapshot(record.changeOverride));
        if (canonicalJson(verified) !== canonicalJson(record.changeOverride)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function assertVerifiedHostConfiguration(record, verifyHostConfiguration) {
    try {
        const verified = verifyHostConfiguration(record.host);
        if (canonicalJson(verified) !== canonicalJson(record.host)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function assertVerifiedProviderRegistry(record, verifyProviderRegistry) {
    try {
        const verified = verifyProviderRegistry(record.providerRegistry);
        if (canonicalJson(verified) !== canonicalJson(record.providerRegistry)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function assertVerifiedDataAuthorization(record, verifyDataAuthorization) {
    try {
        const verified = verifyDataAuthorization(record.dataAuthorization.snapshot);
        if (canonicalJson(verified) !==
            canonicalJson(record.dataAuthorization.snapshot)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function assertVerifiedSessionCapability(record, verifySessionCapability) {
    try {
        const verified = verifySessionCapability(record.sessionCapabilities);
        if (canonicalJson(verified) !== canonicalJson(record.sessionCapabilities)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function assertVerifiedProtectedContext(record, verifyProtectedContext) {
    if (record.resolution.protectedContext === null)
        throw storeInvalid();
    try {
        const verified = verifyProtectedContext(record.resolution.protectedContext);
        const admitted = createChangeRoleAssignmentProtectedContextV1({
            classification: verified.classification,
            pathRoleSourceDigest: verified.pathRoleSourceDigest,
            policySourceDigest: verified.policySourceDigest,
            inputManifestDigest: verified.inputManifestDigest,
            relevantTargetDigest: verified.relevantTargetDigest,
        });
        if (canonicalJson(admitted) !== canonicalJson(verified) ||
            canonicalJson(verified) !==
                canonicalJson(record.resolution.protectedContext)) {
            throw storeInvalid();
        }
    }
    catch {
        throw storeInvalid();
    }
}
function readAssignmentDirectorySnapshot(paths, directory) {
    const before = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (before === undefined) {
        assertPrivateInvestigationDirectory(paths, path.dirname(directory), storeInvalid);
        if (fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
            throw storeOperationConflict();
        }
        return Object.freeze({ identity: null, names: Object.freeze([]) });
    }
    assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
    const names = readBoundedAssignmentDirectoryNames(directory);
    const after = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (after === undefined ||
        !sameStableFile(before, after) ||
        names.length > MAX_DIRECTORY_ENTRIES) {
        throw storeOperationConflict();
    }
    return Object.freeze({ identity: before, names: Object.freeze(names) });
}
function readBoundedAssignmentDirectoryNames(directory) {
    let handle;
    let operationError = null;
    const names = [];
    try {
        handle = fs.opendirSync(directory);
        for (;;) {
            const entry = handle.readSync();
            if (entry === null)
                break;
            names.push(entry.name);
            if (names.length > MAX_DIRECTORY_ENTRIES)
                throw storeInvalid();
        }
    }
    catch (error) {
        operationError = normalizeAssignmentStoreError(error);
    }
    let cleanupError = null;
    if (handle !== undefined) {
        try {
            handle.closeSync();
        }
        catch {
            cleanupError = storeInvalid();
        }
    }
    if (operationError !== null)
        throw operationError;
    if (cleanupError !== null)
        throw cleanupError;
    return names.sort(compareCodeUnits);
}
function normalizeAssignmentStoreError(error) {
    if (error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('CHANGE_ROLE_ASSIGNMENT_STORE_')) {
        return error;
    }
    return storeInvalid();
}
function assertSameAssignmentDirectorySnapshot(before, after) {
    if ((before.identity === null) !== (after.identity === null) ||
        (before.identity !== null &&
            after.identity !== null &&
            !sameStableFile(before.identity, after.identity)) ||
        canonicalJson(before.names) !== canonicalJson(after.names)) {
        throw storeOperationConflict();
    }
}
function assertNoAssignmentPublicationWindow(directory, targetPath) {
    const targetName = path.basename(targetPath);
    const escapedTargetName = targetName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const exactTemporary = new RegExp(`^${escapedTargetName}\\.[1-9][0-9]*\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.publish\\.tmp$`, 'u');
    for (const name of directory.names) {
        if (!name.startsWith(`${targetName}.`))
            continue;
        if (exactTemporary.test(name))
            throw storeOperationConflict();
        throw storeInvalid();
    }
}
function sameCanonicalSnapshot(before, after) {
    return (sameStableFile(before.identity, after.identity) &&
        before.bytes.equals(after.bytes) &&
        canonicalJson(before.value) === canonicalJson(after.value));
}
function assertAssignmentRef(value, changeId, planningGeneration) {
    return assertDurableAssignmentRef(value, changeId, planningGeneration, storeInvalid);
}
function publishCanonicalCreateOnly(paths, filePath, value, maxBytes) {
    const content = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    if (content.length === 0 || content.length > maxBytes)
        throw storeInvalid();
    ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), storeInvalid);
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
        if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
            throw storeConflict();
        }
        return;
    }
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.publish.tmp`;
    let descriptor;
    let linked = false;
    let convergedExisting = false;
    let operationError = null;
    try {
        descriptor = fs.openSync(temporaryPath, NO_FOLLOW_CREATE, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        assertPrivateFileStats(fs.fstatSync(descriptor), content.length);
        try {
            fs.linkSync(temporaryPath, filePath);
            linked = true;
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
            if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
                throw storeConflict();
            }
            convergedExisting = true;
        }
        if (!convergedExisting)
            fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        operationError = normalizeAssignmentStoreError(error);
    }
    const cleanupError = cleanupAssignmentPublicationTemporary(descriptor, temporaryPath, linked);
    if (operationError !== null)
        throw operationError;
    if (cleanupError !== null)
        throw cleanupError;
    if (convergedExisting)
        return;
    if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
        throw storeInvalid();
    }
}
function cleanupAssignmentPublicationTemporary(descriptor, temporaryPath, linked) {
    let cleanupFailed = false;
    if (descriptor !== undefined) {
        try {
            fs.closeSync(descriptor);
        }
        catch {
            cleanupFailed = true;
        }
    }
    try {
        fs.rmSync(temporaryPath, { force: true });
        fsyncDirectory(path.dirname(temporaryPath));
    }
    catch {
        if (linked)
            cleanupFailed = true;
    }
    return cleanupFailed ? storeInvalid() : null;
}
function readBoundedCanonicalJson(paths, filePath, maxBytes) {
    return readBoundedCanonicalSnapshot(paths, filePath, maxBytes).value;
}
function readBoundedCanonicalSnapshot(paths, filePath, maxBytes) {
    const snapshot = readBoundedFileSnapshot(paths, filePath, maxBytes);
    const bytes = snapshot.bytes;
    let source;
    let value;
    try {
        source = UTF8.decode(bytes);
        value = JSON.parse(source);
    }
    catch {
        throw storeInvalid();
    }
    if (`${canonicalJson(value)}\n` !== source)
        throw storeInvalid();
    return Object.freeze({ value, bytes, identity: snapshot.identity });
}
function readBoundedCanonicalBytes(paths, filePath, maxBytes) {
    return readBoundedFileSnapshot(paths, filePath, maxBytes).bytes;
}
function readBoundedFileSnapshot(paths, filePath, maxBytes) {
    assertPrivateInvestigationDirectory(paths, path.dirname(filePath), storeInvalid);
    const absolute = path.resolve(filePath);
    if (absolute !== filePath)
        throw storeInvalid();
    const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (before === undefined)
        throw storeInvalid();
    assertPrivateFileStats(before, maxBytes);
    let descriptor;
    try {
        const noFollow = fs.constants.O_NOFOLLOW;
        const nonBlock = fs.constants.O_NONBLOCK;
        if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
            throw storeInvalid();
        }
        descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow | nonBlock);
        const opened = fs.fstatSync(descriptor);
        assertPrivateFileStats(opened, maxBytes);
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
            error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID') {
            throw error;
        }
        throw storeInvalid();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function assertPrivateFileStats(stats, maxBytes) {
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size < 1 ||
        stats.size > maxBytes) {
        throw storeInvalid();
    }
}
function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function sameStableFile(left, right) {
    return (sameFile(left, right) &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
function fsyncDirectory(directory) {
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
function assertChangeId(value) {
    if (typeof value !== 'string' ||
        !CHANGE_ID.test(value) ||
        value === 'archive') {
        throw storeInvalid();
    }
    return value;
}
function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value))
        throw storeInvalid();
    return value;
}
function storeInvalid() {
    return workflowError('CHANGE_ROLE_ASSIGNMENT_STORE_INVALID', 'Durable change role-assignment state is unsafe, malformed, or stale.', ExitCode.staleState);
}
function storeConflict() {
    return workflowError('CHANGE_ROLE_ASSIGNMENT_STORE_CONFLICT', 'A different role assignment already owns this change planning generation.', ExitCode.conflict);
}
function storeOperationConflict() {
    return workflowError('CHANGE_ROLE_ASSIGNMENT_STORE_OPERATION_CONFLICT', 'Durable change role-assignment state changed during observation.', ExitCode.conflict);
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function hasExactKeys(value, keys) {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    return (actual.length === expected.size && actual.every((key) => expected.has(key)));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
