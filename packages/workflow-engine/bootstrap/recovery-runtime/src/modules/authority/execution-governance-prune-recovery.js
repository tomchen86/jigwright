/**
 * Reconciles prepared prune receipts against the published catalog before deleting objects.
 *
 * Invariants:
 * - The before-catalog digest aborts a prepared prune; the exact after digest permits completion.
 * - Objects still referenced by the manifest or catalog survive receipt recovery.
 * - Deletion and receipt completion preserve their existing directory-fsync order.
 *
 * Depends on: prune and catalog codecs, content objects, and private file publication.
 * Failure modes: deletion before catalog publication, lost referenced objects, or ambiguous prepared receipts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAX_DOCUMENT_BYTES, parseDocument, isWorkflowError, UUID_V4, digest, } from "./execution-governance-values.js";
import { validateDurablePruneReceipt, canonicalDurablePruneReceipt, unsafeDurableGovernanceStore, durableRetentionCatalogDigest, } from "./execution-governance-store-contracts.js";
import { readPrivateFile, replacePrivateFileAtomic, fsyncDirectory, } from "./execution-governance-private-files.js";
import { durableWorkflowReceiptDirectory, durableWorkflowObjectDirectory, durableObjectPath, } from "./execution-governance-store-objects.js";
export function readDurablePruneReceipt(filePath) {
    try {
        const raw = readPrivateFile(filePath, MAX_DOCUMENT_BYTES);
        const value = parseDocument(raw);
        validateDurablePruneReceipt(value);
        if (canonicalDurablePruneReceipt(value) !== raw) {
            throw unsafeDurableGovernanceStore();
        }
        return value;
    }
    catch (error) {
        if (isWorkflowError(error) &&
            error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE') {
            throw error;
        }
        throw unsafeDurableGovernanceStore();
    }
}
export function recoverPreparedPruneReceipts(paths, workflowId, state) {
    const directory = durableWorkflowReceiptDirectory(paths, workflowId, true);
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
        if (isDurablePruneReceiptTemporary(name))
            continue;
        if (!name.endsWith('.json') || !UUID_V4.test(name.slice(0, -5))) {
            throw unsafeDurableGovernanceStore();
        }
        const receiptPath = path.join(directory, name);
        const receipt = readDurablePruneReceipt(receiptPath);
        if (receipt.workflowId !== workflowId || receipt.state !== 'prepared') {
            if (receipt.workflowId !== workflowId) {
                throw unsafeDurableGovernanceStore();
            }
            continue;
        }
        const currentDigest = durableRetentionCatalogDigest(state.retention);
        const recoveredAt = new Date().toISOString();
        if (currentDigest === receipt.catalogDigestBefore) {
            const aborted = {
                ...receipt,
                state: 'aborted',
                abortedAt: recoveredAt,
                abortReason: 'Pruning stopped before catalog publication.',
            };
            replacePrivateFileAtomic(receiptPath, canonicalDurablePruneReceipt(aborted));
            continue;
        }
        if (currentDigest !== receipt.catalogDigestAfter) {
            throw unsafeDurableGovernanceStore();
        }
        deleteUnreferencedReceiptObjects(paths, state, receipt);
        const complete = {
            ...receipt,
            state: 'complete',
            completedAt: recoveredAt,
        };
        replacePrivateFileAtomic(receiptPath, canonicalDurablePruneReceipt(complete));
    }
}
export function isDurablePruneReceiptTemporary(name) {
    const [receiptId, json, pid, temporaryId, suffix, ...extra] = name.split('.');
    return (extra.length === 0 &&
        json === 'json' &&
        suffix === 'tmp' &&
        UUID_V4.test(receiptId ?? '') &&
        /^[1-9][0-9]*$/.test(pid ?? '') &&
        UUID_V4.test(temporaryId ?? ''));
}
export function deleteUnreferencedReceiptObjects(paths, state, receipt) {
    if (durableRetentionCatalogDigest(state.retention) !==
        receipt.catalogDigestAfter ||
        state.context.generation !== receipt.contextGeneration ||
        state.context.workflow.currentEpoch !== receipt.epoch ||
        state.context.workflow.contextDigest !== receipt.contextDigest) {
        throw unsafeDurableGovernanceStore();
    }
    const referenced = new Set([
        ...state.context.currentManifest.items.map(({ digest: itemDigest }) => itemDigest),
        ...state.retention.records.map(({ digest: evidenceDigest }) => evidenceDigest),
    ]);
    const objectDirectory = durableWorkflowObjectDirectory(paths, receipt.workflowId, true);
    let changed = false;
    for (const entry of receipt.deleted) {
        if (referenced.has(entry.digest))
            continue;
        const objectPath = durableObjectPath(paths, receipt.workflowId, entry.digest);
        if (fs.lstatSync(objectPath, { throwIfNoEntry: false }) === undefined) {
            continue;
        }
        const content = readPrivateFile(objectPath, MAX_DOCUMENT_BYTES);
        if (digest(content) !== entry.digest) {
            throw unsafeDurableGovernanceStore();
        }
        fs.unlinkSync(objectPath);
        changed = true;
    }
    if (changed)
        fsyncDirectory(objectDirectory);
}
