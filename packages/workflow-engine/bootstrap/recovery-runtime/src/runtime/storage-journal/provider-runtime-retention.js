/**
 * Validates and digests invocation artifacts across live files and completed retention receipts.
 *
 * Invariants:
 * - Live and retained artifacts retain exact membership, byte, digest, and snapshot bindings.
 * - Runtime authority is checked before retention evidence, and returned digests remain sorted.
 *
 * Depends on: provider authority, host-wrapper evidence, retention receipts, and bounded private file reads.
 * Failure modes: pruned evidence cannot replay or missing and tampered artifacts are accepted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertProviderInvocationCancellationRequestV1 } from "../../modules/authority/provider-invocation-cancellation-grant.js";
import { recreateProviderInvocationRequest, } from "../../modules/provider-orchestration/provider-contracts.js";
import { MAX_HUMAN_RESOLUTION_BYTES, readPrivateBuffer, readPrivateFile, walkPrivateDirectory, } from "./investigation-private-files.js";
import { hasExactKeys, isDigest, isRecord, isTimestamp, sha256, } from "./investigation-store-values.js";
import { HOST_WRAPPER_DIRECTORIES, digestHostWrapperRuntimeEntries, } from "./provider-host-wrapper-evidence.js";
import { PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS, providerRetentionArtifact, providerRetentionReviewRootArtifact, readCompleteProviderRetentionReceipt, readProviderRetentionReceipt, } from "./provider-retention-receipt.js";
import { assertProviderInvocationOutputManifestBinding, assertProviderRuntimeDurableAuthorities, } from "./provider-runtime-authority.js";
import { assertProviderInvocationRuntimeEvidence } from "./provider-runtime-evidence-contract.js";
const PROVIDER_REPAIR_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BLIND_PROVIDER_CORE_ROOT_FILES = [
    'manifest.json',
    'request.json',
    'state.json',
];
export const PROVIDER_POLICY_ROOT_FILE = 'execution-policy.json';
const BLIND_PROVIDER_RUNTIME_FILES = [
    'prompt.json',
    'schema.json',
    'semantic-output.json',
];
const OPTIONAL_PROVIDER_ROOT_FILES = [
    'cancellation-request.json',
    'repair-evidence.json',
    'repair-lineage.json',
];
export function digestPrivateDirectoryEntries(paths, directory, makeError) {
    if (!walkPrivateDirectory(paths, directory, makeError, false)) {
        throw makeError();
    }
    const manifestContent = readPrivateFile(path.join(directory, 'manifest.json'), makeError);
    let manifest;
    try {
        manifest = JSON.parse(manifestContent);
    }
    catch {
        throw makeError();
    }
    const snapshotArtifacts = isRecord(manifest) &&
        manifest.kind === 'plan-review-manifest' &&
        manifest.planningTarget !== undefined
        ? planReviewSnapshotArtifacts(manifest.planningTarget, makeError)
        : null;
    const rootNames = fs.readdirSync(directory).sort();
    const runtimePath = path.join(directory, 'runtime');
    const runtimeStats = fs.lstatSync(runtimePath, { throwIfNoEntry: false });
    const reviewRootPath = path.join(directory, 'review-root');
    const optionalRootFiles = OPTIONAL_PROVIDER_ROOT_FILES.filter((name) => rootNames.includes(name));
    const hostWrapperDirectories = HOST_WRAPPER_DIRECTORIES.filter((name) => rootNames.includes(name));
    const rootFiles = [
        PROVIDER_POLICY_ROOT_FILE,
        ...BLIND_PROVIDER_CORE_ROOT_FILES,
    ];
    const expectedRootNames = [
        ...rootFiles,
        ...optionalRootFiles,
        ...hostWrapperDirectories,
        ...(runtimeStats ? ['runtime'] : []),
        ...(snapshotArtifacts === null ? [] : ['review-root']),
    ].sort();
    if (canonicalJson(rootNames) !== canonicalJson(expectedRootNames)) {
        throw makeError();
    }
    const files = rootFiles.map((name) => {
        const content = readPrivateFile(path.join(directory, name), makeError);
        if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
            throw makeError();
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            throw makeError();
        }
        if (`${canonicalJson(parsed)}\n` !== content) {
            throw makeError();
        }
        return { name, digest: sha256(content) };
    });
    let request;
    try {
        request = recreateProviderInvocationRequest(JSON.parse(readPrivateFile(path.join(directory, 'request.json'), makeError)));
    }
    catch {
        throw makeError();
    }
    let state;
    try {
        state = JSON.parse(readPrivateFile(path.join(directory, 'state.json'), makeError));
    }
    catch {
        throw makeError();
    }
    const runtimeEvidence = assertProviderInvocationRuntimeEvidence(state, request, makeError);
    assertProviderInvocationOutputManifestBinding(runtimeEvidence, manifest, makeError);
    assertProviderRuntimeDurableAuthorities(paths, request, runtimeEvidence, runtimeEvidence.result, runtimeEvidence.runtimeReceipt, makeError);
    let retentionReceipt = null;
    try {
        if (isRecord(state) &&
            Number.isSafeInteger(state.revision) &&
            state.revision >= 0 &&
            (state.state === 'succeeded' || state.state === 'failed') &&
            typeof state.updatedAt === 'string' &&
            isTimestamp(state.updatedAt) &&
            isDigest(state.requestDigest) &&
            isDigest(state.manifestDigest)) {
            retentionReceipt = readCompleteProviderRetentionReceipt(paths, path.basename(directory), {
                requestDigest: state.requestDigest,
                manifestDigest: state.manifestDigest,
                invocationRevision: state.revision,
                terminalState: state.state,
                terminalAt: state.updatedAt,
            });
        }
        else if (readProviderRetentionReceipt(paths, path.basename(directory)) !== null) {
            throw makeError();
        }
    }
    catch {
        throw makeError();
    }
    const providerDefinitionSnapshot = runtimeEvidence.result?.runtimeObservation?.providerDefinitionSnapshot;
    const hostExecutionBinding = runtimeEvidence.runtimeReceipt?.schemaVersion === 4
        ? runtimeEvidence.runtimeReceipt.hostExecutionBinding
        : null;
    const retainedHostArtifacts = retentionReceipt === null
        ? []
        : PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.filter((name) => providerRetentionArtifact(retentionReceipt, name) !== null);
    const succeededWithHostWrapper = runtimeEvidence.state === 'succeeded' &&
        providerDefinitionSnapshot?.kind === 'agent-provider-profile-snapshot' &&
        providerDefinitionSnapshot.trustTier === 'host-wrapper';
    const hasHostWrapperArtifacts = hostWrapperDirectories.length > 0 || retainedHostArtifacts.length > 0;
    if (runtimeEvidence.state === 'succeeded' &&
        (succeededWithHostWrapper
            ? hostWrapperDirectories.length !== HOST_WRAPPER_DIRECTORIES.length
            : hostWrapperDirectories.length !== 0)) {
        throw makeError();
    }
    if ((hostExecutionBinding === null &&
        hasHostWrapperArtifacts &&
        (runtimeEvidence.state === 'succeeded' ||
            runtimeEvidence.state === 'failed')) ||
        (hostExecutionBinding !== null &&
            runtimeEvidence.state !== 'succeeded' &&
            runtimeEvidence.state !== 'failed') ||
        (hostExecutionBinding !== null &&
            hostExecutionBinding.phase !== 'assignment-admitted' &&
            !hasHostWrapperArtifacts) ||
        (runtimeEvidence.state === 'succeeded' &&
            (succeededWithHostWrapper
                ? hostExecutionBinding?.phase !== 'native-terminal'
                : hostExecutionBinding !== null))) {
        throw makeError();
    }
    if (hasHostWrapperArtifacts) {
        files.push(...digestHostWrapperRuntimeEntries(paths, directory, request, runtimeEvidence, retentionReceipt, makeError));
    }
    for (const name of optionalRootFiles) {
        const content = readPrivateFile(path.join(directory, name), makeError);
        if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
            throw makeError();
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            throw makeError();
        }
        if (`${canonicalJson(parsed)}\n` !== content) {
            throw makeError();
        }
        assertOptionalProviderRootArtifact(name, parsed, request, makeError);
        files.push({ name, digest: sha256(content) });
    }
    const runtimeRequired = runtimeEvidence.result !== null &&
        runtimeEvidence.result.runtimeObservation !== null &&
        !succeededWithHostWrapper;
    appendProviderRuntimeArtifactDigests(paths, runtimePath, runtimeStats, runtimeRequired, retentionReceipt, files, makeError);
    if (snapshotArtifacts !== null) {
        appendPlanReviewSnapshotArtifactDigests(paths, reviewRootPath, snapshotArtifacts, retentionReceipt, files, makeError);
    }
    return files.sort((left, right) => left.name.localeCompare(right.name));
}
function planReviewSnapshotArtifacts(value, makeError) {
    if (!isRecord(value) || !Array.isArray(value.artifacts)) {
        throw makeError();
    }
    const artifacts = value.artifacts.map((entry) => {
        if (!isRecord(entry) ||
            typeof entry.snapshotFile !== 'string' ||
            !/^\d{4}\.artifact$/.test(entry.snapshotFile) ||
            !isDigest(entry.sha256) ||
            !Number.isSafeInteger(entry.byteLength) ||
            entry.byteLength < 0 ||
            !Number.isSafeInteger(entry.lineCount) ||
            entry.lineCount < 0) {
            throw makeError();
        }
        return {
            snapshotFile: entry.snapshotFile,
            sha256: entry.sha256,
            byteLength: entry.byteLength,
            lineCount: entry.lineCount,
        };
    });
    if (new Set(artifacts.map(({ snapshotFile }) => snapshotFile)).size !==
        artifacts.length) {
        throw makeError();
    }
    return artifacts;
}
function snapshotLineCount(content) {
    if (content.byteLength === 0)
        return 0;
    let count = 1;
    for (const byte of content) {
        if (byte === 0x0a)
            count += 1;
    }
    return content.at(-1) === 0x0a ? count - 1 : count;
}
function assertOptionalProviderRootArtifact(name, value, request, makeError) {
    if (name === 'cancellation-request.json') {
        try {
            const cancellation = assertProviderInvocationCancellationRequestV1(value);
            if (cancellation.binding.invocationId !== request.invocationId) {
                throw makeError();
            }
        }
        catch {
            throw makeError();
        }
        return;
    }
    if (!isRecord(value)) {
        throw makeError();
    }
    if (name === 'repair-evidence.json') {
        if (!hasExactKeys(value, [
            'contextDigest',
            'epoch',
            'evidenceDigest',
            'failedAttemptId',
            'failedInvocationId',
            'failureCode',
            'failureFingerprint',
            'jobId',
            'kind',
            'recordedAt',
            'repairContext',
            'schemaVersion',
            'workflowId',
        ]) ||
            value.schemaVersion !== 1 ||
            value.kind !== 'provider-repair-evidence' ||
            value.failedInvocationId !== request.invocationId ||
            !isTimestamp(value.recordedAt) ||
            typeof value.evidenceDigest !== 'string' ||
            !PROVIDER_REPAIR_DIGEST.test(value.evidenceDigest)) {
            throw makeError();
        }
        const payload = { ...value };
        delete payload.evidenceDigest;
        if (`sha256:${sha256(canonicalJson(payload))}` !== value.evidenceDigest) {
            throw makeError();
        }
        return;
    }
    if (!hasExactKeys(value, [
        'contextDigest',
        'createdAt',
        'epoch',
        'failedAttemptId',
        'failedInvocationId',
        'failureFingerprint',
        'jobId',
        'kind',
        'lineageDigest',
        'repairBudget',
        'repairContext',
        'repairEvidenceDigest',
        'repairKind',
        'replacementAttemptId',
        'replacementInvocationId',
        'replacementRequestDigest',
        'retryMode',
        'schemaVersion',
        'workflowId',
    ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-repair-lineage' ||
        value.retryMode !== 'repair' ||
        (value.repairKind !== 'schema' && value.repairKind !== 'semantic') ||
        value.replacementInvocationId !== request.invocationId ||
        value.replacementRequestDigest !== request.requestDigest ||
        !isTimestamp(value.createdAt) ||
        typeof value.lineageDigest !== 'string' ||
        !PROVIDER_REPAIR_DIGEST.test(value.lineageDigest) ||
        typeof value.repairEvidenceDigest !== 'string' ||
        !PROVIDER_REPAIR_DIGEST.test(value.repairEvidenceDigest)) {
        throw makeError();
    }
    const payload = { ...value };
    delete payload.lineageDigest;
    if (`sha256:${sha256(canonicalJson(payload))}` !== value.lineageDigest) {
        throw makeError();
    }
}
function appendProviderRuntimeArtifactDigests(paths, runtimePath, runtimeStats, runtimeRequired, retentionReceipt, files, makeError) {
    const retainedRuntimeArtifacts = BLIND_PROVIDER_RUNTIME_FILES.map((name) => retentionReceipt === null
        ? null
        : providerRetentionArtifact(retentionReceipt, `runtime/${name}`));
    const receiptCarriesRuntime = retainedRuntimeArtifacts.every((artifact) => artifact !== null);
    if (retainedRuntimeArtifacts.some((artifact) => artifact !== null) &&
        !receiptCarriesRuntime) {
        throw makeError();
    }
    if (!runtimeStats) {
        if (runtimeRequired && !receiptCarriesRuntime) {
            throw makeError();
        }
        if (receiptCarriesRuntime) {
            for (let index = 0; index < BLIND_PROVIDER_RUNTIME_FILES.length; index += 1) {
                files.push({
                    name: `runtime/${BLIND_PROVIDER_RUNTIME_FILES[index]}`,
                    digest: retainedRuntimeArtifacts[index].digest,
                });
            }
        }
    }
    else {
        if (runtimeStats.isSymbolicLink() ||
            !runtimeStats.isDirectory() ||
            !walkPrivateDirectory(paths, runtimePath, makeError, false)) {
            throw makeError();
        }
        const runtimeNames = fs.readdirSync(runtimePath).sort();
        const expectedRuntimeNames = [...BLIND_PROVIDER_RUNTIME_FILES].sort();
        if (receiptCarriesRuntime
            ? runtimeNames.some((name) => !expectedRuntimeNames.includes(name))
            : canonicalJson(runtimeNames) !== canonicalJson(expectedRuntimeNames)) {
            throw makeError();
        }
        for (let index = 0; index < BLIND_PROVIDER_RUNTIME_FILES.length; index += 1) {
            const name = BLIND_PROVIDER_RUNTIME_FILES[index];
            const retained = retainedRuntimeArtifacts[index];
            if (!runtimeNames.includes(name)) {
                if (retained === null)
                    throw makeError();
                files.push({ name: `runtime/${name}`, digest: retained.digest });
                continue;
            }
            const content = readPrivateBuffer(path.join(runtimePath, name), makeError);
            if (content.byteLength > MAX_HUMAN_RESOLUTION_BYTES) {
                throw makeError();
            }
            const contentDigest = sha256(content);
            if (retained !== null &&
                (retained.digest !== contentDigest ||
                    retained.bytes !== content.byteLength)) {
                throw makeError();
            }
            files.push({
                name: `runtime/${name}`,
                digest: retained?.digest ?? contentDigest,
            });
        }
    }
}
function appendPlanReviewSnapshotArtifactDigests(paths, reviewRootPath, snapshotArtifacts, retentionReceipt, files, makeError) {
    const retainedReviewRoot = retentionReceipt === null
        ? null
        : providerRetentionArtifact(retentionReceipt, 'review-root');
    const expectedRetainedReviewRoot = providerRetentionReviewRootArtifact(snapshotArtifacts.map((artifact) => ({
        name: `review-root/${artifact.snapshotFile}`,
        digest: artifact.sha256,
        bytes: artifact.byteLength,
    })));
    if (retainedReviewRoot !== null &&
        canonicalJson(retainedReviewRoot) !==
            canonicalJson(expectedRetainedReviewRoot)) {
        throw makeError();
    }
    const reviewRootStats = fs.lstatSync(reviewRootPath, {
        throwIfNoEntry: false,
    });
    if (!reviewRootStats?.isDirectory() ||
        reviewRootStats.isSymbolicLink() ||
        !walkPrivateDirectory(paths, reviewRootPath, makeError, false)) {
        throw makeError();
    }
    const expectedFiles = snapshotArtifacts
        .map(({ snapshotFile }) => snapshotFile)
        .sort();
    const observedFiles = fs.readdirSync(reviewRootPath).sort();
    if (retainedReviewRoot === null
        ? canonicalJson(observedFiles) !== canonicalJson(expectedFiles)
        : observedFiles.some((name) => !expectedFiles.includes(name))) {
        throw makeError();
    }
    for (const artifact of snapshotArtifacts) {
        if (!observedFiles.includes(artifact.snapshotFile)) {
            if (retainedReviewRoot === null)
                throw makeError();
            files.push({
                name: `review-root/${artifact.snapshotFile}`,
                digest: artifact.sha256,
            });
            continue;
        }
        const content = readPrivateBuffer(path.join(reviewRootPath, artifact.snapshotFile), makeError, artifact.byteLength);
        if (content.byteLength !== artifact.byteLength ||
            sha256(content) !== artifact.sha256 ||
            snapshotLineCount(content) !== artifact.lineCount) {
            throw makeError();
        }
        files.push({
            name: `review-root/${artifact.snapshotFile}`,
            digest: artifact.sha256,
        });
    }
}
