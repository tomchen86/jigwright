/**
 * Publishes and reads private workflow context envelopes and content-addressed objects.
 *
 * Invariants:
 * - Content digests and canonical envelope bytes are checked before returning stored values.
 * - Context items publish before their owning envelope and never overwrite a different object.
 *
 * Depends on: store contracts, canonical values, and private file publication.
 * Failure modes: digest collisions, unsafe storage paths, or context envelopes naming unavailable objects.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { isRecord, hasExactKeys, assertIdentity, digest, assertDigest, assertUuid, MAX_DOCUMENT_BYTES, parseDocument, isWorkflowError, } from "./execution-governance-values.js";
import { invalidContextManifest } from "./execution-governance-context.js";
import { unsafeDurableGovernanceStore, validateDurableGovernanceState, canonicalDurableGovernanceState, } from "./execution-governance-store-contracts.js";
import { ensurePrivateDirectory, readPrivateFile, replacePrivateFileAtomic, createDurablePrivateFileAtomic, isNodeError, } from "./execution-governance-private-files.js";
export function persistManifestItems(paths, workflowId, manifest, items) {
    if (!Array.isArray(items) || items.length !== manifest.items.length) {
        throw invalidContextManifest('Stored context items must exactly match the manifest item set.');
    }
    const byIdentity = new Map();
    for (const item of items) {
        if (!isRecord(item) || !hasExactKeys(item, ['identity', 'content'])) {
            throw invalidContextManifest('Stored context item is malformed.');
        }
        assertIdentity(item.identity, invalidContextManifest, 'context item identity');
        if (typeof item.content !== 'string' ||
            Buffer.byteLength(item.content) > 262_144 ||
            byIdentity.has(item.identity)) {
            throw invalidContextManifest('Stored context item content is invalid.');
        }
        byIdentity.set(item.identity, item.content);
    }
    for (const reference of manifest.items) {
        const content = byIdentity.get(reference.identity);
        if (content === undefined || digest(content) !== reference.digest) {
            throw workflowError('CONTEXT_ITEM_MISMATCH', `Context item ${reference.identity} does not match its manifest digest.`, ExitCode.verification);
        }
    }
    for (const reference of manifest.items) {
        const content = byIdentity.get(reference.identity);
        publishDurableContentObject(paths, workflowId, reference.digest, content);
    }
}
export function ensureDurableGovernanceStore(storeRoot) {
    if (typeof storeRoot !== 'string' ||
        storeRoot.length < 1 ||
        storeRoot.includes('\0')) {
        throw unsafeDurableGovernanceStore();
    }
    const hostRoot = path.resolve(storeRoot);
    ensurePrivateDirectory(hostRoot, false);
    const root = path.join(hostRoot, 'execution-governance-store');
    ensurePrivateDirectory(root, true);
    const states = path.join(root, 'states');
    const objects = path.join(root, 'objects');
    const locks = path.join(root, 'locks');
    const pruneReceipts = path.join(root, 'prune-receipts');
    ensurePrivateDirectory(states, true);
    ensurePrivateDirectory(objects, true);
    ensurePrivateDirectory(locks, true);
    ensurePrivateDirectory(pruneReceipts, true);
    return { root, states, objects, locks, pruneReceipts };
}
export function workflowStorageKey(workflowId) {
    return crypto.createHash('sha256').update(workflowId).digest('hex');
}
export function durableStatePath(paths, workflowId) {
    return path.join(paths.states, `${workflowStorageKey(workflowId)}.json`);
}
export function durableWorkflowObjectDirectory(paths, workflowId, create) {
    const directory = path.join(paths.objects, workflowStorageKey(workflowId));
    ensurePrivateDirectory(directory, create);
    return directory;
}
export function durableObjectPath(paths, workflowId, contentDigest) {
    assertDigest(contentDigest, unsafeDurableGovernanceStore, 'object digest');
    return path.join(durableWorkflowObjectDirectory(paths, workflowId, true), `${contentDigest.slice('sha256:'.length)}.blob`);
}
export function durableWorkflowReceiptDirectory(paths, workflowId, create) {
    const directory = path.join(paths.pruneReceipts, workflowStorageKey(workflowId));
    ensurePrivateDirectory(directory, create);
    return directory;
}
export function durablePruneReceiptPath(paths, workflowId, receiptId) {
    assertUuid(receiptId, unsafeDurableGovernanceStore);
    return path.join(durableWorkflowReceiptDirectory(paths, workflowId, true), `${receiptId}.json`);
}
export function readDurableGovernanceState(paths, workflowId) {
    const statePath = durableStatePath(paths, workflowId);
    if (fs.lstatSync(statePath, { throwIfNoEntry: false }) === undefined) {
        throw workflowError('EXECUTION_CONTEXT_NOT_FOUND', `Durable context for ${workflowId} does not exist.`, ExitCode.staleState);
    }
    try {
        const raw = readPrivateFile(statePath, MAX_DOCUMENT_BYTES);
        const value = parseDocument(raw);
        validateDurableGovernanceState(value);
        if (value.context.workflow.workflowId !== workflowId ||
            canonicalDurableGovernanceState(value) !== raw) {
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
export function replaceDurableGovernanceState(paths, state) {
    replacePrivateFileAtomic(durableStatePath(paths, state.context.workflow.workflowId), canonicalDurableGovernanceState(state));
}
export function publishDurableContentObject(paths, workflowId, contentDigest, content) {
    if (typeof content !== 'string' ||
        Buffer.byteLength(content) > MAX_DOCUMENT_BYTES ||
        digest(content) !== contentDigest) {
        throw workflowError('EXECUTION_CONTENT_OBJECT_MISMATCH', 'Content-addressed object does not match its digest.', ExitCode.verification);
    }
    const objectPath = durableObjectPath(paths, workflowId, contentDigest);
    if (fs.lstatSync(objectPath, { throwIfNoEntry: false }) !== undefined) {
        if (readPrivateFile(objectPath, MAX_DOCUMENT_BYTES) !== content) {
            throw unsafeDurableGovernanceStore();
        }
        return;
    }
    try {
        createDurablePrivateFileAtomic(objectPath, content);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST')
            throw error;
    }
    if (readPrivateFile(objectPath, MAX_DOCUMENT_BYTES) !== content) {
        throw unsafeDurableGovernanceStore();
    }
}
export function readDurableContentObject(paths, workflowId, contentDigest) {
    try {
        const content = readPrivateFile(durableObjectPath(paths, workflowId, contentDigest), MAX_DOCUMENT_BYTES);
        if (digest(content) !== contentDigest) {
            throw unsafeDurableGovernanceStore();
        }
        return content;
    }
    catch (error) {
        if (isWorkflowError(error) &&
            error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE') {
            throw error;
        }
        throw unsafeDurableGovernanceStore();
    }
}
