/**
 * Validates durable context, retention, and prune envelopes with their exact CAS bindings.
 *
 * Invariants:
 * - Canonical envelopes bind context and retention to the same workflow and exact manifest.
 * - Prepared prune records retain before and after catalog digests and their transition state.
 */
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode, } from "../../foundation/errors/errors.js";
import { digest, MAX_DOCUMENT_BYTES, isRecord, hasExactKeys, assertPositiveInteger, assertTimestamp, assertIdentity, assertDigest, assertUuid, assertReason, } from "./execution-governance-values.js";
import { validateContextManifest, validateEpochTransitionReceipt, } from "./execution-governance-context.js";
import { DEFAULT_RETENTION_POLICY, transitionKey, validateEpochTransitionStub, validateEvidenceRetentionRecord, invalidRetentionRecord, } from "./execution-governance-retention.js";
export function canonicalDurableGovernanceState(state) {
    validateDurableGovernanceState(state);
    return boundedDurableDocument(`${canonicalJson(state)}\n`);
}
function canonicalDurableRetentionCatalog(catalog) {
    validateDurableRetentionCatalog(catalog);
    return boundedDurableDocument(`${canonicalJson(catalog)}\n`);
}
export function durableRetentionCatalogDigest(catalog) {
    return digest(canonicalDurableRetentionCatalog(catalog));
}
export function canonicalDurablePruneReceipt(receipt) {
    validateDurablePruneReceipt(receipt);
    return boundedDurableDocument(`${canonicalJson(receipt)}\n`);
}
function boundedDurableDocument(content) {
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
        throw workflowError('EXECUTION_GOVERNANCE_STORE_CAPACITY', 'Durable execution-governance document exceeds its size bound.', ExitCode.guard);
    }
    return content;
}
export function validateDurableGovernanceState(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'kind', 'context', 'retention']) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'durable-execution-governance-state') {
        throw unsafeDurableGovernanceStore();
    }
    validateDurableEpochContextState(value.context);
    validateDurableRetentionCatalog(value.retention);
    const context = value.context;
    const retention = value.retention;
    if (retention.workflowId !== context.workflow.workflowId) {
        throw unsafeDurableGovernanceStore();
    }
    const currentItems = new Map(context.currentManifest.items.map(({ identity, digest: itemDigest }) => [
        identity,
        itemDigest,
    ]));
    for (const record of retention.records) {
        if (record.epoch > context.workflow.currentEpoch ||
            (record.retention === 'active' &&
                record.epoch !== context.workflow.currentEpoch)) {
            throw unsafeDurableGovernanceStore();
        }
        if (record.itemIdentity !== null) {
            const currentDigest = currentItems.get(record.itemIdentity);
            if (record.epoch === context.workflow.currentEpoch &&
                currentDigest !== undefined &&
                currentDigest !== record.digest) {
                throw unsafeDurableGovernanceStore();
            }
        }
    }
    for (const [identity, itemDigest] of currentItems) {
        if (!retention.records.some((record) => record.itemIdentity === identity &&
            record.digest === itemDigest &&
            record.epoch === context.workflow.currentEpoch &&
            record.evidenceClass === 'manifest-item' &&
            record.retention !== 'expiring')) {
            throw unsafeDurableGovernanceStore();
        }
    }
}
function validateDurableEpochContextState(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'generation',
            'workflow',
            'currentManifest',
            'transitionReceipts',
            'transitionStubs',
            'updatedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'durable-epoch-context') {
        throw unsafeDurableGovernanceStore();
    }
    assertPositiveInteger(value.generation, unsafeDurableGovernanceStore, 'context generation');
    validateStoredWorkflowContextState(value.workflow);
    validateContextManifest(value.currentManifest);
    assertStoredContextManifestBinding(value.workflow, value.currentManifest);
    if (!Array.isArray(value.transitionReceipts) ||
        value.transitionReceipts.length >
            DEFAULT_RETENTION_POLICY.maxFullTransitionReceipts ||
        !Array.isArray(value.transitionStubs) ||
        value.transitionStubs.length > 200) {
        throw unsafeDurableGovernanceStore();
    }
    const transitionKeys = new Set();
    for (const receipt of value.transitionReceipts) {
        validateEpochTransitionReceipt(receipt);
        if (receipt.workflowId !== value.workflow.workflowId ||
            transitionKeys.has(transitionKey(receipt))) {
            throw unsafeDurableGovernanceStore();
        }
        transitionKeys.add(transitionKey(receipt));
    }
    for (const stub of value.transitionStubs) {
        validateEpochTransitionStub(stub);
        if (stub.workflowId !== value.workflow.workflowId ||
            transitionKeys.has(transitionKey(stub))) {
            throw unsafeDurableGovernanceStore();
        }
        transitionKeys.add(transitionKey(stub));
    }
    assertTimestamp(value.updatedAt, unsafeDurableGovernanceStore, 'context updatedAt');
}
function validateStoredWorkflowContextState(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'workflowId',
            'currentEpoch',
            'contractVersion',
            'contextDigest',
            'snapshotDigest',
            'status',
            'checkpoint',
            'blocker',
        ])) {
        throw unsafeDurableGovernanceStore();
    }
    assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
    assertPositiveInteger(value.currentEpoch, unsafeDurableGovernanceStore, 'current epoch');
    assertPositiveInteger(value.contractVersion, unsafeDurableGovernanceStore, 'contract version');
    assertDigest(value.contextDigest, unsafeDurableGovernanceStore, 'context digest');
    assertDigest(value.snapshotDigest, unsafeDurableGovernanceStore, 'snapshot digest');
    assertIdentity(value.checkpoint, unsafeDurableGovernanceStore, 'checkpoint');
    if (!['active', 'completed', 'cancelled', 'superseded'].includes(String(value.status))) {
        throw unsafeDurableGovernanceStore();
    }
    if (value.blocker !== null) {
        if (!isRecord(value.blocker) ||
            !hasExactKeys(value.blocker, ['kind', 'since'])) {
            throw unsafeDurableGovernanceStore();
        }
        assertIdentity(value.blocker.kind, unsafeDurableGovernanceStore, 'blocker kind');
        assertTimestamp(value.blocker.since, unsafeDurableGovernanceStore, 'blocker since');
    }
}
function validateDurableRetentionCatalog(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'workflowId',
            'generation',
            'records',
            'updatedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'durable-retention-catalog') {
        throw unsafeDurableGovernanceStore();
    }
    assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
    assertPositiveInteger(value.generation, unsafeDurableGovernanceStore, 'catalog generation');
    if (!Array.isArray(value.records) || value.records.length > 8_192) {
        throw unsafeDurableGovernanceStore();
    }
    let previous = '';
    for (const record of value.records) {
        validateEvidenceRetentionRecord(record);
        if (record.workflowId !== value.workflowId ||
            record.evidenceId <= previous) {
            throw unsafeDurableGovernanceStore();
        }
        previous = record.evidenceId;
    }
    assertTimestamp(value.updatedAt, unsafeDurableGovernanceStore, 'catalog updatedAt');
}
export function validateDurablePruneReceipt(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'receiptId',
            'state',
            'workflowId',
            'contextGeneration',
            'epoch',
            'contextDigest',
            'catalogGenerationBefore',
            'catalogDigestBefore',
            'catalogGenerationAfter',
            'catalogDigestAfter',
            'deleted',
            'preparedAt',
            'completedAt',
            'abortedAt',
            'abortReason',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'durable-evidence-prune' ||
        !['prepared', 'complete', 'aborted'].includes(String(value.state))) {
        throw unsafeDurableGovernanceStore();
    }
    assertUuid(value.receiptId, unsafeDurableGovernanceStore);
    assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
    assertPositiveInteger(value.contextGeneration, unsafeDurableGovernanceStore, 'context generation');
    assertPositiveInteger(value.epoch, unsafeDurableGovernanceStore, 'epoch');
    assertDigest(value.contextDigest, unsafeDurableGovernanceStore, 'context digest');
    assertPositiveInteger(value.catalogGenerationBefore, unsafeDurableGovernanceStore, 'catalog generation before');
    if (value.catalogGenerationAfter !== value.catalogGenerationBefore + 1) {
        throw unsafeDurableGovernanceStore();
    }
    assertDigest(value.catalogDigestBefore, unsafeDurableGovernanceStore, 'catalog digest before');
    assertDigest(value.catalogDigestAfter, unsafeDurableGovernanceStore, 'catalog digest after');
    if (!Array.isArray(value.deleted) || value.deleted.length > 8_192) {
        throw unsafeDurableGovernanceStore();
    }
    let previous = '';
    for (const entry of value.deleted) {
        if (!isRecord(entry) || !hasExactKeys(entry, ['evidenceId', 'digest'])) {
            throw unsafeDurableGovernanceStore();
        }
        assertIdentity(entry.evidenceId, unsafeDurableGovernanceStore, 'evidence ID');
        assertDigest(entry.digest, unsafeDurableGovernanceStore, 'evidence digest');
        if (entry.evidenceId <= previous)
            throw unsafeDurableGovernanceStore();
        previous = entry.evidenceId;
    }
    assertTimestamp(value.preparedAt, unsafeDurableGovernanceStore, 'preparedAt');
    if (value.state === 'prepared') {
        if (value.completedAt !== null ||
            value.abortedAt !== null ||
            value.abortReason !== null) {
            throw unsafeDurableGovernanceStore();
        }
    }
    else if (value.state === 'complete') {
        assertTimestamp(value.completedAt, unsafeDurableGovernanceStore, 'completedAt');
        if (value.abortedAt !== null || value.abortReason !== null) {
            throw unsafeDurableGovernanceStore();
        }
    }
    else {
        assertTimestamp(value.abortedAt, unsafeDurableGovernanceStore, 'abortedAt');
        assertReason(value.abortReason, unsafeDurableGovernanceStore, 'abort reason');
        if (value.completedAt !== null)
            throw unsafeDurableGovernanceStore();
    }
}
export function assertContextManifestBinding(workflow, manifest) {
    if (workflow.workflowId !== manifest.workflowId ||
        workflow.currentEpoch !== manifest.epoch ||
        workflow.contractVersion !== manifest.contractVersion ||
        workflow.contextDigest !== manifest.contextDigest ||
        workflow.snapshotDigest !== manifest.baselineDigest) {
        throw invalidDurableContext('Workflow state must exactly bind the current context manifest.');
    }
}
function assertStoredContextManifestBinding(workflow, manifest) {
    try {
        assertContextManifestBinding(workflow, manifest);
    }
    catch {
        throw unsafeDurableGovernanceStore();
    }
}
export function assertCurrentManifestEvidenceBinding(manifest, record) {
    if (record.evidenceClass === 'manifest-item' &&
        record.itemIdentity === null) {
        throw invalidRetentionRecord('Manifest-item evidence requires an item identity.');
    }
    if (record.itemIdentity === null)
        return;
    const reference = manifest.items.find(({ identity }) => identity === record.itemIdentity);
    if (record.epoch === manifest.epoch &&
        reference !== undefined &&
        reference.digest !== record.digest) {
        throw workflowError('RETENTION_MANIFEST_DIGEST_MISMATCH', `Evidence ${record.evidenceId} conflicts with the current manifest digest.`, ExitCode.staleState);
    }
}
export function assertContextCas(context, expected) {
    assertPositiveInteger(expected.expectedGeneration, invalidDurableContext, 'expected generation');
    assertPositiveInteger(expected.expectedEpoch, invalidDurableContext, 'expected epoch');
    assertDigest(expected.expectedContextDigest, invalidDurableContext, 'expected context digest');
    if (context.generation !== expected.expectedGeneration ||
        context.workflow.currentEpoch !== expected.expectedEpoch ||
        context.workflow.contextDigest !== expected.expectedContextDigest) {
        throw workflowError('EXECUTION_CONTEXT_CAS_MISMATCH', 'Durable context changed before the epoch transition.', ExitCode.staleState);
    }
}
export function assertCatalogCas(catalog, expectedGeneration) {
    assertPositiveInteger(expectedGeneration, invalidRetentionRecord, 'expected catalog generation');
    if (catalog.generation !== expectedGeneration) {
        throw workflowError('RETENTION_CATALOG_CAS_MISMATCH', 'The retention catalog changed before the requested operation.', ExitCode.staleState);
    }
}
export function manifestRetentionRecords(manifest, createdAt) {
    return manifest.items
        .map(({ identity, digest: itemDigest }) => ({
        schemaVersion: 1,
        kind: 'evidence-retention',
        evidenceId: `manifest-${manifest.epoch}-${crypto
            .createHash('sha256')
            .update(identity)
            .digest('hex')
            .slice(0, 32)}`,
        itemIdentity: identity,
        workflowId: manifest.workflowId,
        epoch: manifest.epoch,
        evidenceClass: 'manifest-item',
        digest: itemDigest,
        retention: 'active',
        createdAt,
        expiresAt: null,
        pin: null,
    }))
        .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}
export function assertUniqueEvidenceIds(records) {
    const ids = new Set(records.map(({ evidenceId }) => evidenceId));
    if (ids.size !== records.length) {
        throw invalidRetentionRecord('Evidence IDs must be unique.');
    }
}
export function invalidDurableContext(message) {
    return workflowError('EXECUTION_CONTEXT_INVALID', message, ExitCode.usage);
}
export function unsafeDurableGovernanceStore() {
    return workflowError('EXECUTION_GOVERNANCE_STORE_UNSAFE', 'Durable execution-governance state is missing, malformed, or unsafe.', ExitCode.staleState);
}
