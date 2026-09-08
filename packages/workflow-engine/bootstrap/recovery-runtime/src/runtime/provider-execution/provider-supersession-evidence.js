/**
 * Read bounded immutable artifacts and verify exact supersession evidence snapshots.
 *
 * Invariants:
 * - Artifact digest bytes, retained evidence rules, no-follow reads, and stable file checks remain exact.
 * - Snapshot stability is revalidated against the same canonical evidence objects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { privatePathExists, readPrivateCanonicalJson, } from "../storage-journal/investigation-private-files.js";
import { readCompleteProviderRetentionReceipt, providerRetentionArtifact, } from "../storage-journal/provider-retention-receipt.js";
import { providerInvocationSupersessionUnsafe, createProviderInvocationEvidenceSnapshot, } from "./provider-invocation-supersession-schema.js";
import { digestText, isRecord, digestBuffer, } from "./provider-supersession-values.js";
const MAX_EVIDENCE_ARTIFACT_BYTES = 1_048_576;
export function assertSnapshotStableCurrent(paths, expected, record, request, terminalExact) {
    const current = currentEvidenceSnapshot(paths, record, request, expected);
    for (const key of [
        'invocationId',
        'attempt',
        'requestDigest',
        'manifestDigest',
        'subjectDigest',
        'createdAt',
    ]) {
        if (current[key] !== expected[key]) {
            throw providerInvocationSupersessionUnsafe();
        }
    }
    if (terminalExact &&
        (current.promptDigest !== expected.promptDigest ||
            current.rawOutputDigest !== expected.rawOutputDigest ||
            current.semanticOutputDigest !== expected.semanticOutputDigest ||
            current.terminalStatus !== expected.terminalStatus ||
            current.terminalAt !== expected.terminalAt ||
            current.failureCode !== expected.failureCode ||
            current.invocationRevision !== expected.invocationRevision)) {
        throw providerInvocationSupersessionUnsafe();
    }
    if (!terminalExact &&
        (expected.terminalStatus !== null ||
            expected.terminalAt !== null ||
            expected.failureCode !== null ||
            expected.invocationRevision !== 0)) {
        // The successor snapshot records its immutable prepared identity. Its
        // state/revision may advance after publication, but the snapshot itself
        // must never masquerade as terminal evidence.
        if (expected.terminalStatus !== null ||
            expected.terminalAt !== null ||
            expected.failureCode !== null ||
            expected.invocationRevision !== 0) {
            throw providerInvocationSupersessionUnsafe();
        }
    }
}
export function currentEvidenceSnapshot(paths, record, request, retainedFallback) {
    const prompt = artifactDigest(paths, record, 'runtime/prompt.json');
    const raw = artifactDigest(paths, record, 'runtime/semantic-output.json');
    const observedSemanticOutputDigest = record.result !== null
        ? digestText(canonicalJson(record.result.output))
        : failedSemanticOutputDigest(paths, record);
    const semanticOutputDigest = observedSemanticOutputDigest === null &&
        retainedFallback !== undefined &&
        retainedFallback.rawOutputDigest === raw
        ? retainedFallback.semanticOutputDigest
        : observedSemanticOutputDigest;
    return createProviderInvocationEvidenceSnapshot({
        schemaVersion: 1,
        kind: 'provider-invocation-evidence-snapshot',
        invocationId: record.invocationId,
        attempt: record.attempt,
        requestDigest: record.requestDigest,
        manifestDigest: record.manifestDigest,
        subjectDigest: request.targetDigest,
        promptDigest: prompt,
        rawOutputDigest: raw,
        semanticOutputDigest,
        terminalStatus: record.state === 'succeeded' || record.state === 'failed'
            ? record.state
            : null,
        terminalAt: record.state === 'succeeded' || record.state === 'failed'
            ? record.updatedAt
            : null,
        failureCode: record.state === 'failed' ? record.failure.code : null,
        invocationRevision: record.revision,
        createdAt: record.createdAt,
    });
}
function failedSemanticOutputDigest(paths, record) {
    const evidencePath = path.join(paths.invocations, record.invocationId, 'repair-evidence.json');
    if (!privatePathExists(paths, evidencePath, providerInvocationSupersessionUnsafe)) {
        return null;
    }
    const value = readPrivateCanonicalJson(paths, evidencePath, providerInvocationSupersessionUnsafe);
    if (!isRecord(value) ||
        value.kind !== 'provider-repair-evidence' ||
        value.failedInvocationId !== record.invocationId ||
        !isRecord(value.repairContext) ||
        !Object.hasOwn(value.repairContext, 'previousOutput')) {
        throw providerInvocationSupersessionUnsafe();
    }
    return digestText(canonicalJson(value.repairContext.previousOutput));
}
function artifactDigest(paths, record, name) {
    const filePath = path.join(paths.invocations, record.invocationId, ...name.split('/'));
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stats) {
        const content = readPrivateArtifact(paths, filePath);
        return content.byteLength === 0 ? null : digestBuffer(content);
    }
    if (record.state !== 'succeeded' && record.state !== 'failed')
        return null;
    const receipt = readCompleteProviderRetentionReceipt(paths, record.invocationId, {
        requestDigest: record.requestDigest,
        manifestDigest: record.manifestDigest,
        invocationRevision: record.revision,
        terminalState: record.state,
        terminalAt: record.updatedAt,
    });
    const retained = receipt === null ? null : providerRetentionArtifact(receipt, name);
    return retained === null || retained.bytes === 0 ? null : retained.digest;
}
function readPrivateArtifact(paths, filePath) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > MAX_EVIDENCE_ARTIFACT_BYTES ||
        fs.realpathSync(filePath) !== path.resolve(filePath) ||
        !path.resolve(filePath).startsWith(`${path.resolve(paths.root)}${path.sep}`)) {
        throw providerInvocationSupersessionUnsafe();
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
    try {
        const opened = fs.fstatSync(descriptor);
        if (!sameFile(before, opened))
            throw providerInvocationSupersessionUnsafe();
        const content = fs.readFileSync(descriptor);
        const afterOpened = fs.fstatSync(descriptor);
        const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
        if (!afterPath ||
            !sameFile(opened, afterOpened) ||
            !sameFile(afterOpened, afterPath) ||
            opened.size !== content.byteLength ||
            opened.mtimeMs !== afterOpened.mtimeMs ||
            opened.ctimeMs !== afterOpened.ctimeMs) {
            throw providerInvocationSupersessionUnsafe();
        }
        return content;
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function sameFile(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        (right.mode & 0o777) === 0o600);
}
