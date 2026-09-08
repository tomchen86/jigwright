/**
 * Read and persist immutable provider requests, manifests, and plan-review snapshot files.
 *
 * Invariants:
 * - Private file checks, canonical bytes, snapshot digests, and atomic publication stay exact.
 * - Snapshot ownership and content bindings are revalidated on reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { readPrivateCanonicalJson, privatePathExists, ensurePrivateInvestigationDirectory, assertPrivateInvestigationDirectory, } from "./investigation-private-files.js";
import { assertInvocationId, } from "../session-workspace/paths.js";
import { readCompleteProviderRetentionReceipt, providerRetentionArtifact, providerRetentionReviewRootArtifact, } from "./provider-retention-receipt.js";
import { planReviewSnapshotLineCount } from "../../modules/assurance/plan-review.js";
import { providerInvocationDirectory, invocationUnsafe, invocationInvalid, providerInvocationStatePath, sha256Buffer, fsyncDirectory, } from "./provider-invocation-common.js";
import { assertProviderRequest, assertProviderInvocationManifest, } from "./provider-invocation-validation.js";
export function readPlanReviewSnapshotRuntime(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    if (manifest.kind !== 'plan-review-manifest' ||
        manifest.planningTarget === undefined) {
        return null;
    }
    assertPlanReviewSnapshotFiles(paths, invocationId, manifest);
    const root = path.join(providerInvocationDirectory(paths, invocationId), 'review-root');
    return {
        root,
        files: manifest.planningTarget.artifacts.map((artifact) => ({
            id: `planning-snapshot:${artifact.path}`,
            path: path.join(root, artifact.snapshotFile),
        })),
    };
}
export function readProviderInvocationRequest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const value = readPrivateCanonicalJson(paths, path.join(providerInvocationDirectory(paths, invocationId), 'request.json'), invocationUnsafe);
    const request = assertProviderRequest(value);
    if (request.invocationId !== invocationId) {
        throw invocationInvalid();
    }
    return request;
}
export function readBlindSurveyManifest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    if (manifest.kind !== 'blind-survey-manifest') {
        throw invocationInvalid();
    }
    return manifest;
}
export function readProviderInvocationManifest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const value = readPrivateCanonicalJson(paths, path.join(providerInvocationDirectory(paths, invocationId), 'manifest.json'), invocationUnsafe);
    return assertProviderInvocationManifest(value);
}
export function providerInvocationExists(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return privatePathExists(paths, providerInvocationStatePath(paths, invocationId), invocationUnsafe);
}
export function createPlanReviewSnapshotFiles(paths, invocationDirectory, manifest, files) {
    if (manifest.kind !== 'plan-review-manifest') {
        if (files !== undefined)
            throw invocationInvalid();
        return;
    }
    if (manifest.planningTarget === undefined) {
        if (files !== undefined)
            throw invocationInvalid();
        return;
    }
    if (!Array.isArray(files))
        throw invocationInvalid();
    const expected = manifest.planningTarget.artifacts;
    if (files.length !== expected.length)
        throw invocationInvalid();
    const byName = new Map(files.map((entry) => [entry.snapshotFile, entry]));
    if (byName.size !== files.length)
        throw invocationInvalid();
    const root = path.join(invocationDirectory, 'review-root');
    ensurePrivateInvestigationDirectory(paths, root, invocationUnsafe);
    for (const artifact of expected) {
        const supplied = byName.get(artifact.snapshotFile);
        if (!supplied ||
            !Buffer.isBuffer(supplied.content) ||
            supplied.content.byteLength !== artifact.byteLength ||
            sha256Buffer(supplied.content) !== artifact.sha256 ||
            planReviewSnapshotLineCount(supplied.content) !== artifact.lineCount) {
            throw invocationInvalid();
        }
        createPrivateSnapshotFile(path.join(root, artifact.snapshotFile), supplied.content);
    }
    assertPlanReviewSnapshotFiles(paths, path.basename(invocationDirectory), manifest, invocationDirectory);
}
export function assertPlanReviewSnapshotFiles(paths, requestedInvocationId, manifest, knownDirectory, record) {
    if (manifest.kind !== 'plan-review-manifest' ||
        manifest.planningTarget === undefined) {
        return;
    }
    const directory = knownDirectory ??
        providerInvocationDirectory(paths, assertInvocationId(requestedInvocationId));
    const root = path.join(directory, 'review-root');
    assertPrivateInvestigationDirectory(paths, root, invocationUnsafe);
    const names = fs.readdirSync(root).sort();
    const expectedNames = manifest.planningTarget.artifacts
        .map(({ snapshotFile }) => snapshotFile)
        .sort();
    const retentionReceipt = record === undefined ||
        (record.state !== 'succeeded' && record.state !== 'failed')
        ? null
        : readCompleteProviderRetentionReceipt(paths, record.invocationId, {
            requestDigest: record.requestDigest,
            manifestDigest: record.manifestDigest,
            invocationRevision: record.revision,
            terminalState: record.state,
            terminalAt: record.updatedAt,
        });
    const retainedReviewRoot = retentionReceipt === null
        ? null
        : providerRetentionArtifact(retentionReceipt, 'review-root');
    const expectedRetainedReviewRoot = providerRetentionReviewRootArtifact(manifest.planningTarget.artifacts.map((artifact) => ({
        name: `review-root/${artifact.snapshotFile}`,
        digest: artifact.sha256,
        bytes: artifact.byteLength,
    })));
    if ((retainedReviewRoot === null
        ? canonicalJson(names) !== canonicalJson(expectedNames)
        : names.some((name) => !expectedNames.includes(name))) ||
        (retainedReviewRoot !== null &&
            canonicalJson(retainedReviewRoot) !==
                canonicalJson(expectedRetainedReviewRoot))) {
        throw invocationInvalid();
    }
    for (const artifact of manifest.planningTarget.artifacts) {
        if (!names.includes(artifact.snapshotFile)) {
            if (retainedReviewRoot === null)
                throw invocationInvalid();
            continue;
        }
        const content = readPrivateSnapshotFile(path.join(root, artifact.snapshotFile));
        if (content.byteLength !== artifact.byteLength ||
            sha256Buffer(content) !== artifact.sha256 ||
            planReviewSnapshotLineCount(content) !== artifact.lineCount) {
            throw invocationInvalid();
        }
    }
}
function createPrivateSnapshotFile(filePath, content) {
    const pendingPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.pending`);
    const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (existing) {
        if (!readPrivateSnapshotFile(filePath).equals(content)) {
            throw invocationInvalid();
        }
        const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
        if (pending) {
            if (!readPrivateSnapshotFile(pendingPath).equals(content)) {
                throw invocationInvalid();
            }
            fs.unlinkSync(pendingPath);
            fsyncDirectory(path.dirname(filePath));
        }
        return;
    }
    const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
    if (pending) {
        if (!readPrivateSnapshotFile(pendingPath).equals(content)) {
            throw invocationInvalid();
        }
    }
    else {
        createPendingSnapshotFile(pendingPath, content);
    }
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
        throw invocationInvalid();
    }
    fs.renameSync(pendingPath, filePath);
    fsyncDirectory(path.dirname(filePath));
    if (!readPrivateSnapshotFile(filePath).equals(content)) {
        throw invocationInvalid();
    }
}
function createPendingSnapshotFile(filePath, content) {
    const flags = fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, flags, 0o600);
    }
    catch {
        throw invocationInvalid();
    }
    try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600) {
            throw invocationInvalid();
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function readPrivateSnapshotFile(filePath) {
    const flags = fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, flags);
    }
    catch {
        throw invocationInvalid();
    }
    try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600) {
            throw invocationInvalid();
        }
        return fs.readFileSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
export function readPrivateCanonicalDocument(paths, filePath, makeError) {
    assertPrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600) {
        throw makeError();
    }
    const flags = fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, flags);
    }
    catch {
        throw makeError();
    }
    try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() ||
            opened.nlink !== 1 ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino) {
            throw makeError();
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
