/**
 * Reads, quarantines, and compare-and-swaps canonical evidence ref documents.
 *
 * Invariants:
 * - Ref changes retain exact expected node or document digests under the ref lock.
 * - Publication validates every target node and keeps rename and fsync ordering.
 *
 * Depends on: evidence node readers, ref locking, canonical JSON, and private files.
 * Failure modes: concurrent writers overwrite refs or a ref points to missing or invalid evidence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertChangeId, } from "../session-workspace/paths.js";
import { readEvidenceNode } from "./evidence-node-store.js";
import { assertNoFollowDirectory, assertPrivateFileStats, ensureNoFollowDirectory, fsyncDirectory, NO_FOLLOW_CREATE, readNoFollow, } from "./evidence-private-files.js";
import { withRefLock } from "./evidence-ref-lock.js";
import { assertNodeId, assertRefName, DIGEST_PATTERN, evidenceObjectPath, evidenceRefPath, hasExactKeys, isDigest, isPlainRecord, objectUnavailable, objectUnsafe, REF_NAME_PATTERN, refCasMismatch, refInvalid, refsDocumentCasMismatch, refUnsafe, sha256, } from "./evidence-store-values.js";
import { exactUnsafePathObservationDigest } from "./evidence-unsafe-observation.js";
export function readEvidenceRefs(paths, changeId) {
    assertChangeId(changeId);
    const refPath = evidenceRefPath(paths, changeId);
    if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
        return {};
    }
    const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (!stats) {
        return {};
    }
    const content = readNoFollow(refPath, refUnsafe);
    return parseRefDocument(content, changeId);
}
export function readEvidenceRefsSnapshot(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const refPath = evidenceRefPath(paths, changeId);
    if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
        return absentEvidenceRefsSnapshot();
    }
    const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (!stats) {
        return absentEvidenceRefsSnapshot();
    }
    const rawDocument = readNoFollow(refPath, refUnsafe);
    const refs = parseRefDocument(rawDocument, changeId);
    return Object.freeze({
        rawDocument,
        digest: sha256(rawDocument),
        refs: Object.freeze({ ...refs }),
    });
}
export function quarantineUnsafeEvidenceRefsDocument(paths, requestedChangeId, expectedObservationDigest) {
    const changeId = assertChangeId(requestedChangeId);
    if (!DIGEST_PATTERN.test(expectedObservationDigest)) {
        throw refInvalid();
    }
    const source = evidenceRefPath(paths, changeId);
    const quarantineDirectory = path.join(paths.root, 'human-resolutions', 'quarantine');
    const target = path.join(quarantineDirectory, `${changeId}.${expectedObservationDigest}.evidence-refs.artifact`);
    return withRefLock(paths, changeId, () => {
        ensureNoFollowDirectory(paths.base, paths.root, quarantineDirectory, refUnsafe);
        const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
        if (!sourceStats) {
            if (fs.lstatSync(target, { throwIfNoEntry: false }) &&
                exactUnsafePathObservationDigest(target, 'evidence-refs') ===
                    expectedObservationDigest) {
                return target;
            }
            throw refsDocumentCasMismatch(expectedObservationDigest, null, null);
        }
        if (exactUnsafePathObservationDigest(source, 'evidence-refs') !==
            expectedObservationDigest) {
            throw refsDocumentCasMismatch(expectedObservationDigest, exactUnsafePathObservationDigest(source, 'evidence-refs'), null);
        }
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
            throw refInvalid();
        }
        fs.renameSync(source, target);
        fsyncDirectory(paths.refs);
        fsyncDirectory(quarantineDirectory);
        if (exactUnsafePathObservationDigest(target, 'evidence-refs') !==
            expectedObservationDigest) {
            throw refInvalid();
        }
        return target;
    });
}
export function compareAndSwapEvidenceRefsDocument(paths, params) {
    const changeId = assertChangeId(params.changeId);
    if (params.expectedDigest !== null &&
        !DIGEST_PATTERN.test(params.expectedDigest)) {
        throw refInvalid();
    }
    const nextRefs = params.nextRefs === null
        ? null
        : validateEvidenceRefsForPublication(paths, params.nextRefs);
    const nextDigest = nextRefs === null ? null : sha256(canonicalRefDocument(changeId, nextRefs));
    return withRefLock(paths, changeId, () => {
        const current = readEvidenceRefsSnapshot(paths, changeId);
        if (current.digest === nextDigest) {
            return current;
        }
        if (current.digest !== params.expectedDigest) {
            throw refsDocumentCasMismatch(params.expectedDigest, current.digest, nextDigest);
        }
        if (nextRefs === null) {
            fs.unlinkSync(evidenceRefPath(paths, changeId));
            fsyncDirectory(paths.refs);
        }
        else {
            writeRefDocument(paths, changeId, nextRefs);
        }
        const published = readEvidenceRefsSnapshot(paths, changeId);
        if (published.digest !== nextDigest) {
            throw refInvalid();
        }
        return published;
    });
}
export function compareAndSwapEvidenceRef(paths, params) {
    assertChangeId(params.changeId);
    assertRefName(params.refName);
    assertNodeId(params.nextNodeId);
    if (params.expectedNodeId !== null &&
        !DIGEST_PATTERN.test(params.expectedNodeId)) {
        throw refInvalid();
    }
    const nextObjectPath = evidenceObjectPath(paths, params.nextNodeId);
    const nextDirectoryExists = assertNoFollowDirectory(paths.base, paths.root, path.dirname(nextObjectPath), objectUnsafe);
    if (!nextDirectoryExists ||
        !fs.lstatSync(nextObjectPath, { throwIfNoEntry: false })) {
        throw objectUnavailable(params.nextNodeId);
    }
    readEvidenceNode(paths, params.nextNodeId);
    withRefLock(paths, params.changeId, () => {
        const current = readEvidenceRefs(paths, params.changeId);
        const observed = current[params.refName] ?? null;
        if (observed !== (params.expectedNodeId ?? null)) {
            throw refCasMismatch(params.refName, params.expectedNodeId, observed);
        }
        const next = { ...current, [params.refName]: params.nextNodeId };
        writeRefDocument(paths, params.changeId, next);
    });
}
function parseRefDocument(content, changeId) {
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw refInvalid();
    }
    if (!isPlainRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'changeId', 'refs']) ||
        value.schemaVersion !== 1 ||
        value.changeId !== changeId ||
        !isPlainRecord(value.refs)) {
        throw refInvalid();
    }
    const refs = value.refs;
    for (const [name, digest] of Object.entries(refs)) {
        if (!REF_NAME_PATTERN.test(name) || !isDigest(digest)) {
            throw refInvalid();
        }
    }
    if (content !== canonicalJson(value)) {
        throw refInvalid();
    }
    return refs;
}
function writeRefDocument(paths, changeId, refs) {
    const refPath = evidenceRefPath(paths, changeId);
    const content = canonicalRefDocument(changeId, refs);
    ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
    const existing = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (existing) {
        assertPrivateFileStats(existing, refUnsafe);
    }
    const temporary = `${refPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
        const current = fs.lstatSync(refPath, { throwIfNoEntry: false });
        if (current) {
            assertPrivateFileStats(current, refUnsafe);
        }
        fs.renameSync(temporary, refPath);
        fsyncDirectory(paths.refs);
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}
function validateEvidenceRefsForPublication(paths, refs) {
    if (!isPlainRecord(refs)) {
        throw refInvalid();
    }
    const validated = {};
    for (const [name, nodeId] of Object.entries(refs)) {
        assertRefName(name);
        assertNodeId(nodeId);
        readEvidenceNode(paths, nodeId);
        validated[name] = nodeId;
    }
    return validated;
}
function canonicalRefDocument(changeId, refs) {
    return canonicalJson({ schemaVersion: 1, changeId, refs });
}
function absentEvidenceRefsSnapshot() {
    return Object.freeze({
        rawDocument: null,
        digest: null,
        refs: null,
    });
}
