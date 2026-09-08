/**
 * Persists execution grants, epoch context, and evidence while exposing their policy API.
 *
 * Invariants:
 * - Grant consumption and epoch or catalog CAS retain exact owner and evidence bindings.
 * - Prune recovery preserves prepared receipts and current manifest or pinned objects.
 * - Create-only publication, durable creation, and replacement retain distinct atomic ordering.
 *
 * Depends on: execution policy codecs, authority audit, private files, and store locks.
 * Failure modes: reused grant authority, stale epochs, lost evidence, or incomplete recovery.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveAuthorityAuditRepositoryId, } from "../../runtime/storage-journal/authority-audit-ledger.js";
import { recordAuthorityAuditEvent, } from "../../runtime/storage-journal/authority-audit-service.js";
import { authorityRefusalDigest, withAuthorityRefusalAudit, } from "./authority-refusal-audit.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError, } from "../../foundation/errors/errors.js";
import { assertBoundedInteger, assertDigest, assertIdentity, assertJsonValue, assertPositiveInteger, assertReason, assertTimestamp, assertUuid, cloneJson, digest, exactDate, hasExactKeys, IDENTITY, isRecord, isWorkflowError, JSON_POINTER, MAX_DOCUMENT_BYTES, normalizeInvalid, parseDocument, UUID_V4, } from "./execution-governance-values.js";
import { assemblePromptFromManifest, assertEpochCarryForwardSourceMembership, assessAttemptResultEligibility, invalidContextManifest, invalidEpochTransition, performEpochRollover, validateContextManifest, validateEpochTransitionReceipt, validateWorkflowContextState, } from "./execution-governance-context.js";
import { compactEpochTransitionReceipts, DEFAULT_RETENTION_POLICY, invalidRetentionRecord, markEpochEvidenceExpiring, pinEvidence, planEvidencePruning, transitionKey, validateEpochTransitionStub, validateEvidenceRetentionRecord, validateRetentionPolicy, } from "./execution-governance-retention.js";
export { buildRepairContext, canonicalRepairContext, parseRepairContext, createRepairBudget, consumeRepairBudget, canonicalRepairBudget, parseRepairBudget, } from "./execution-governance-repair.js";
export { buildContextManifest, canonicalContextManifest, parseContextManifest, assemblePromptFromManifest, assessAttemptResultEligibility, performEpochRollover, canonicalEpochTransitionReceipt, parseEpochTransitionReceipt, } from "./execution-governance-context.js";
export { DEFAULT_RETENTION_POLICY, pinEvidence, markEpochEvidenceExpiring, planEvidencePruning, canonicalEvidenceRetentionRecord, parseEvidenceRetentionRecord, compactEpochTransitionReceipts, canonicalEpochTransitionStub, } from "./execution-governance-retention.js";
export const EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE = 'HARNESS_EXECUTION_BUDGET_GRANT_V1';
const MAX_GRANT_USES = 16;
export function createExecutionBudgetGrantRequest(input) {
    const request = {
        schemaVersion: 1,
        kind: 'execution-budget-grant-request',
        requestId: input.requestId,
        workflowId: input.workflowId,
        epoch: input.epoch,
        jobId: input.jobId,
        mandateBinding: assertExecutionGrantMandateBinding(input.mandateBinding, invalidGrantRequest),
        requestedChanges: sortChanges(input.requestedChanges, invalidGrantRequest),
        rationale: input.rationale,
        expiresAfterAttempts: input.expiresAfterAttempts,
        createdAt: exactDate(input.createdAt, 'EXECUTION_GRANT_REQUEST_INVALID'),
    };
    validateExecutionBudgetGrantRequest(request);
    return request;
}
export function canonicalExecutionBudgetGrantRequest(request) {
    validateExecutionBudgetGrantRequest(request);
    return `${canonicalJson(request)}\n`;
}
export function parseExecutionBudgetGrantRequest(raw) {
    try {
        const value = parseDocument(raw);
        validateExecutionBudgetGrantRequest(value);
        return value;
    }
    catch (error) {
        throw normalizeInvalid(error, 'EXECUTION_GRANT_REQUEST_INVALID', 'Execution-budget grant request is malformed.');
    }
}
export function createExecutionBudgetGrantEnvelope(request, input) {
    validateExecutionBudgetGrantRequest(request);
    if (!Number.isSafeInteger(input.maxUses) ||
        input.maxUses < 1 ||
        input.maxUses > request.expiresAfterAttempts) {
        throw invalidGrant('Grant uses must be positive and no greater than the requested attempt bound.');
    }
    const issuedAt = exactDate(input.issuedAt, 'EXECUTION_BUDGET_GRANT_INVALID');
    if (new Date(issuedAt).getTime() < new Date(request.createdAt).getTime()) {
        throw invalidGrant('Grant cannot be issued before its bound request.');
    }
    const payload = {
        schemaVersion: 1,
        kind: 'execution-budget-grant.v1',
        grantId: input.grantId,
        requestDigest: digest(canonicalExecutionBudgetGrantRequest(request)),
        workflowId: request.workflowId,
        epoch: request.epoch,
        jobId: request.jobId,
        mandateBinding: assertExecutionGrantMandateBinding(request.mandateBinding, invalidGrant),
        allowedChanges: request.requestedChanges.map((change) => cloneChange(change, invalidGrant)),
        maxUses: input.maxUses,
        issuedAt,
        issuer: input.issuer,
    };
    const envelope = { payload, signature: input.signature };
    validateExecutionBudgetGrantEnvelope(envelope);
    return envelope;
}
export function canonicalExecutionBudgetGrantSigningBytes(payload) {
    validateExecutionBudgetGrantPayload(payload);
    return `${EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE}\n${canonicalJson(payload)}\n`;
}
export function canonicalExecutionBudgetGrantEnvelope(envelope) {
    validateExecutionBudgetGrantEnvelope(envelope);
    return `${canonicalJson(envelope)}\n`;
}
export function parseExecutionBudgetGrantEnvelope(raw) {
    try {
        const value = parseDocument(raw);
        validateExecutionBudgetGrantEnvelope(value);
        return value;
    }
    catch (error) {
        throw normalizeInvalid(error, 'EXECUTION_BUDGET_GRANT_INVALID', 'Execution-budget grant envelope is malformed.');
    }
}
export function storeExecutionBudgetGrant(storeRoot, envelope, options) {
    validateExecutionBudgetGrantEnvelope(envelope);
    const binding = requireAuditedExecutionBudgetGrant(envelope, {
        request: options?.request,
        mandateBinding: options?.mandateBinding,
        audit: options?.audit,
    });
    try {
        options.verify(canonicalExecutionBudgetGrantSigningBytes(envelope.payload), envelope.signature);
    }
    catch (error) {
        if (isWorkflowError(error))
            throw error;
        throw workflowError('EXECUTION_BUDGET_GRANT_SIGNATURE_INVALID', 'Execution-budget grant signature verification failed.', ExitCode.verification);
    }
    const paths = ensureExecutionBudgetGrantStore(storeRoot);
    const grantId = assertUuid(envelope.payload.grantId, invalidGrant);
    return withExecutionGrantLock(paths, grantId, () => {
        const recordPath = path.join(paths.grants, `${grantId}.json`);
        if (fs.existsSync(recordPath)) {
            throw workflowError('EXECUTION_BUDGET_GRANT_EXISTS', `Execution-budget grant ${grantId} already exists.`, ExitCode.conflict);
        }
        const record = {
            schemaVersion: 3,
            state: 'active',
            envelopeDigest: digest(canonicalExecutionBudgetGrantEnvelope(envelope)),
            envelope,
            remainingUses: envelope.payload.maxUses,
            consumedAttemptIds: [],
            receipts: [],
            revokedAt: null,
            revocationReason: null,
        };
        const pendingPath = path.join(paths.pending, `${grantId}.json`);
        const recordBytes = canonicalGrantRecord(record);
        const pendingStats = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
        if (pendingStats === undefined) {
            createPrivateFileAtomic(pendingPath, recordBytes);
        }
        else if (canonicalGrantRecord(readGrantRecord(pendingPath)) !== recordBytes) {
            throw unsafeGrantStore();
        }
        appendExecutionBudgetGrantAudit(envelope, binding, options.audit, 'issue', envelope.payload.issuedAt, null);
        createPrivateFileAtomic(recordPath, recordBytes);
        unlinkExactPrivateFile(pendingPath, recordBytes);
        return recordPath;
    });
}
export function consumeExecutionBudgetGrant(storeRoot, input) {
    const grantId = assertUuid(input.grantId, invalidGrant);
    assertIdentity(input.workflowId, invalidGrant, 'workflow ID');
    assertPositiveInteger(input.epoch, invalidGrant, 'epoch');
    assertIdentity(input.jobId, invalidGrant, 'job ID');
    assertIdentity(input.attemptId, invalidGrant, 'attempt ID');
    assertDigest(input.requestDigest, invalidGrant, 'grant request digest');
    validateChanges(input.requestedChanges, invalidGrant);
    const consumedAt = exactDate(input.now, 'EXECUTION_BUDGET_GRANT_INVALID');
    const inputBinding = assertExecutionGrantMandateBinding(input.mandateBinding, invalidGrant);
    const audit = assertExecutionBudgetGrantAuditContext(input.audit);
    const paths = ensureExecutionBudgetGrantStore(storeRoot);
    return withExecutionGrantLock(paths, grantId, () => {
        const recordPath = path.join(paths.grants, `${grantId}.json`);
        const record = readGrantRecord(recordPath);
        const payload = record.envelope.payload;
        const storedBinding = requireStoredExecutionBudgetGrantBinding(payload);
        const refusalBinding = executionBudgetGrantRefusalBinding(record.envelope, storedBinding, audit, 'execution-budget.consume', {
            attemptId: input.attemptId,
            workflowId: input.workflowId,
            epoch: input.epoch,
            jobId: input.jobId,
            requestDigest: input.requestDigest,
            requestedBindingDigest: authorityRefusalDigest(inputBinding),
            requestedChangesDigest: authorityRefusalDigest(input.requestedChanges),
        });
        return withAuthorityRefusalAudit(refusalBinding, {
            now: new Date(consumedAt),
            serviceHooks: audit.serviceHooks,
            onRecord: audit.onRecord,
        }, () => {
            const binding = requireCurrentExecutionBudgetGrantBinding(payload, inputBinding);
            if (payload.workflowId !== input.workflowId ||
                payload.epoch !== input.epoch ||
                payload.jobId !== input.jobId) {
                throw workflowError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH', 'Execution-budget grant cannot be reused across a workflow epoch or job.', ExitCode.guard);
            }
            if (payload.requestDigest !== input.requestDigest) {
                throw workflowError('EXECUTION_BUDGET_GRANT_REQUEST_MISMATCH', 'Execution-budget grant is not bound to the expected GrantRequest.', ExitCode.guard);
            }
            if (record.consumedAttemptIds.includes(input.attemptId)) {
                throw workflowError('EXECUTION_BUDGET_GRANT_ATTEMPT_REUSED', `Attempt ${input.attemptId} already consumed this grant.`, ExitCode.conflict);
            }
            if (record.state === 'revoked') {
                throw workflowError('EXECUTION_BUDGET_GRANT_REVOKED', `Execution-budget grant ${grantId} was revoked.`, ExitCode.guard);
            }
            if (record.remainingUses < 1 || record.state === 'consumed') {
                throw workflowError('EXECUTION_BUDGET_GRANT_EXHAUSTED', `Execution-budget grant ${grantId} has no remaining uses.`, ExitCode.guard);
            }
            if (canonicalJson(input.requestedChanges) !==
                canonicalJson(payload.allowedChanges)) {
                throw workflowError('EXECUTION_BUDGET_GRANT_CHANGE_MISMATCH', 'Execution-budget grant does not authorize the requested execution-policy change.', ExitCode.guard);
            }
            const previousConsumedAt = record.receipts.at(-1)?.consumedAt;
            if (new Date(consumedAt).getTime() <
                new Date(payload.issuedAt).getTime() ||
                (previousConsumedAt !== undefined &&
                    new Date(consumedAt).getTime() <
                        new Date(previousConsumedAt).getTime())) {
                throw workflowError('EXECUTION_BUDGET_GRANT_TIME_INVALID', 'Execution-budget grant use predates issuance or a prior use.', ExitCode.staleState);
            }
            const receiptCore = {
                schemaVersion: 1,
                kind: 'execution-budget-consume-receipt',
                grantId,
                requestDigest: payload.requestDigest,
                workflowId: payload.workflowId,
                epoch: payload.epoch,
                jobId: payload.jobId,
                mandateBinding: binding,
                attemptId: input.attemptId,
                useNumber: record.receipts.length + 1,
                remainingUses: record.remainingUses - 1,
                consumedAt,
            };
            const receipt = {
                ...receiptCore,
                receiptId: digest(canonicalJson(receiptCore)),
            };
            validateExecutionBudgetConsumeReceipt(receipt, payload);
            const next = {
                ...record,
                schemaVersion: 3,
                receipts: [...record.receipts, receipt],
                consumedAttemptIds: [...record.consumedAttemptIds, input.attemptId],
                remainingUses: record.remainingUses - 1,
                state: record.remainingUses - 1 === 0 ? 'consumed' : 'active',
            };
            appendExecutionBudgetGrantAudit(record.envelope, binding, audit, 'consume', consumedAt, receipt);
            replacePrivateFileAtomic(recordPath, canonicalGrantRecord(next));
            return receipt;
        });
    });
}
export function inspectExecutionBudgetGrant(storeRoot, grantId) {
    const paths = ensureExecutionBudgetGrantStore(storeRoot);
    const record = readGrantRecordRequired(path.join(paths.grants, `${assertUuid(grantId, invalidGrant)}.json`));
    return inspectionFromRecord(record);
}
export function revokeExecutionBudgetGrant(storeRoot, input) {
    const grantId = assertUuid(input.grantId, invalidGrant);
    assertReason(input.reason, invalidGrant, 'revocation reason');
    const revokedAt = exactDate(input.now, 'EXECUTION_BUDGET_GRANT_INVALID');
    const inputBinding = assertExecutionGrantMandateBinding(input.mandateBinding, invalidGrant);
    const audit = assertExecutionBudgetGrantAuditContext(input.audit);
    const paths = ensureExecutionBudgetGrantStore(storeRoot);
    return withExecutionGrantLock(paths, grantId, () => {
        const recordPath = path.join(paths.grants, `${grantId}.json`);
        const record = readGrantRecord(recordPath);
        const storedBinding = requireStoredExecutionBudgetGrantBinding(record.envelope.payload);
        const refusalBinding = executionBudgetGrantRefusalBinding(record.envelope, storedBinding, audit, 'execution-budget.revoke', {
            reasonDigest: authorityRefusalDigest(input.reason),
            requestedBindingDigest: authorityRefusalDigest(inputBinding),
        });
        return withAuthorityRefusalAudit(refusalBinding, {
            now: new Date(revokedAt),
            serviceHooks: audit.serviceHooks,
            onRecord: audit.onRecord,
        }, () => {
            const binding = requireCurrentExecutionBudgetGrantBinding(record.envelope.payload, inputBinding);
            if (record.state === 'revoked') {
                appendExecutionBudgetGrantAudit(record.envelope, binding, audit, 'revoke', record.revokedAt, record.revocationReason);
                return revokedInspectionFromRecord(record);
            }
            if (record.state === 'consumed') {
                throw workflowError('EXECUTION_BUDGET_GRANT_ALREADY_CONSUMED', `Execution-budget grant ${grantId} was already fully consumed.`, ExitCode.guard);
            }
            const latestAuthorityAt = record.receipts.at(-1)?.consumedAt ??
                record.envelope.payload.issuedAt;
            if (new Date(revokedAt).getTime() < new Date(latestAuthorityAt).getTime()) {
                throw workflowError('EXECUTION_BUDGET_GRANT_TIME_INVALID', 'Execution-budget grant revocation predates issuance or a prior use.', ExitCode.staleState);
            }
            const revoked = {
                ...record,
                schemaVersion: 3,
                state: 'revoked',
                revokedAt,
                revocationReason: input.reason,
            };
            appendExecutionBudgetGrantAudit(record.envelope, binding, audit, 'revoke', revokedAt, input.reason);
            replacePrivateFileAtomic(recordPath, canonicalGrantRecord(revoked));
            return revokedInspectionFromRecord(revoked);
        });
    });
}
function inspectionFromRecord(record) {
    const inspection = {
        state: record.state,
        remainingUses: record.remainingUses,
        receipts: record.receipts.map((receipt) => ({ ...receipt })),
    };
    if (record.state === 'revoked') {
        inspection.revokedAt = record.revokedAt;
        inspection.revocationReason = record.revocationReason;
    }
    return inspection;
}
function revokedInspectionFromRecord(record) {
    if (record.state !== 'revoked' ||
        record.revokedAt == null ||
        record.revocationReason == null) {
        throw unsafeGrantStore();
    }
    return {
        ...inspectionFromRecord(record),
        state: 'revoked',
        revokedAt: record.revokedAt,
        revocationReason: record.revocationReason,
    };
}
function requireAuditedExecutionBudgetGrant(envelope, input) {
    if (input.request === undefined ||
        input.mandateBinding === undefined ||
        input.audit === undefined) {
        throw workflowError('EXECUTION_BUDGET_GRANT_AUDIT_REQUIRED', 'Execution-budget authority requires its exact request and external audit context.', ExitCode.guard);
    }
    validateExecutionBudgetGrantRequest(input.request);
    const payloadBinding = assertExecutionGrantMandateBinding(envelope.payload.mandateBinding, invalidGrant);
    const requestBinding = assertExecutionGrantMandateBinding(input.request.mandateBinding, invalidGrantRequest);
    const binding = assertExecutionGrantMandateBinding(input.mandateBinding, invalidGrant);
    assertExecutionBudgetGrantAuditContext(input.audit);
    if (canonicalJson(binding) !== canonicalJson(payloadBinding) ||
        canonicalJson(binding) !== canonicalJson(requestBinding) ||
        envelope.payload.requestDigest !==
            digest(canonicalExecutionBudgetGrantRequest(input.request)) ||
        envelope.payload.workflowId !== input.request.workflowId ||
        envelope.payload.epoch !== input.request.epoch ||
        envelope.payload.jobId !== input.request.jobId ||
        canonicalJson(envelope.payload.allowedChanges) !==
            canonicalJson(input.request.requestedChanges)) {
        throw workflowError('EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH', 'Execution-budget grant, request, and Task Mandate bindings do not match exactly.', ExitCode.guard);
    }
    return binding;
}
function requireCurrentExecutionBudgetGrantBinding(payload, requested) {
    const binding = requireStoredExecutionBudgetGrantBinding(payload);
    if (canonicalJson(binding) !== canonicalJson(requested)) {
        throw workflowError('EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH', 'Execution-budget grant does not match the exact Execution Job Task Mandate binding.', ExitCode.guard);
    }
    return binding;
}
function requireStoredExecutionBudgetGrantBinding(payload) {
    return assertExecutionGrantMandateBinding(payload.mandateBinding, unsafeGrantStore);
}
function executionBudgetGrantRefusalBinding(envelope, binding, audit, operation, refusalIdentity) {
    const grantDigest = digest(canonicalExecutionBudgetGrantEnvelope(envelope));
    return {
        scope: {
            // The external root always comes from the parsed durable grant envelope,
            // never from the caller's requested binding.
            externalAuditRoot: binding.externalAuditRoot,
            repositoryRoot: audit.repositoryRoot,
            repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
        },
        family: 'execution-budget-grant',
        operation,
        subjectId: envelope.payload.grantId,
        actor: audit.actor ?? { kind: 'engine', identity: 'workflow-engine' },
        taskId: binding.mandateTaskId,
        changeId: binding.changeId,
        workflowId: envelope.payload.workflowId,
        grantDigest,
        bindingDigest: grantDigest,
        refusalIdentity: {
            grantId: envelope.payload.grantId,
            ...refusalIdentity,
        },
    };
}
function appendExecutionBudgetGrantAudit(envelope, binding, rawAudit, transition, occurredAt, detail) {
    const audit = assertExecutionBudgetGrantAuditContext(rawAudit);
    const grantDigest = digest(canonicalExecutionBudgetGrantEnvelope(envelope));
    const transitionDetail = transition === 'consume'
        ? detail.receiptId
        : transition === 'revoke'
            ? detail
            : envelope.payload.requestDigest;
    const idempotencyKey = digest(canonicalJson({
        schemaVersion: 1,
        kind: 'execution-budget-audit-idempotency.v1',
        transition,
        grantDigest,
        detail: transitionDetail,
    }));
    const outcomeDigest = digest(canonicalJson({
        schemaVersion: 1,
        kind: 'execution-budget-audit-outcome.v1',
        transition,
        grantId: envelope.payload.grantId,
        requestDigest: envelope.payload.requestDigest,
        mandateBinding: binding,
        detail: transitionDetail,
    }));
    const entry = recordAuthorityAuditEvent({
        externalAuditRoot: binding.externalAuditRoot,
        repositoryRoot: audit.repositoryRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    }, {
        eventType: transition === 'issue'
            ? 'escalation-request'
            : transition === 'consume'
                ? 'grant-consume'
                : 'revoke',
        occurredAt,
        idempotencyKey,
        actor: audit.actor ??
            (transition === 'issue'
                ? { kind: 'human', identity: envelope.payload.issuer }
                : { kind: 'engine', identity: 'workflow-engine' }),
        taskId: binding.mandateTaskId,
        changeId: binding.changeId,
        workflowId: envelope.payload.workflowId,
        grantDigest,
        candidateBundleDigest: null,
        prestateDigest: null,
        poststateDigest: outcomeDigest,
        command: {
            name: `execution-budget.${transition}`,
            argvDigest: digest(canonicalJson({
                grantId: envelope.payload.grantId,
                jobId: envelope.payload.jobId,
                transition,
            })),
        },
        providerInvocation: null,
        externalEffect: null,
        result: transition === 'consume'
            ? 'succeeded'
            : transition === 'revoke'
                ? 'revoked'
                : 'recorded',
        outcomeDigest,
        errorCode: null,
    }, audit.serviceHooks);
    audit.onRecord?.(entry);
    return entry;
}
export function inspectExecutionBudgetGrantAuthorization(storeRoot, grantId) {
    const paths = ensureExecutionBudgetGrantStore(storeRoot);
    const record = readGrantRecordRequired(path.join(paths.grants, `${assertUuid(grantId, invalidGrant)}.json`));
    return {
        envelope: structuredClone(record.envelope),
        payload: structuredClone(record.envelope.payload),
        state: record.state,
        remainingUses: record.remainingUses,
        receipts: record.receipts.map((receipt) => ({ ...receipt })),
    };
}
/**
 * Enumerate every durably published execution-budget grant without creating
 * or repairing store state. Metrics include active, consumed, and revoked
 * grants, including grants that have never been consumed by an Attempt.
 */
export function listExecutionBudgetGrantMetrics(storeRoot) {
    if (typeof storeRoot !== 'string' || storeRoot.length < 1) {
        throw unsafeGrantStore();
    }
    const root = path.resolve(storeRoot);
    const grants = path.join(root, 'execution-budget-grants');
    const stats = fs.lstatSync(grants, { throwIfNoEntry: false });
    if (stats === undefined)
        return Object.freeze([]);
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(grants) !== grants) {
        throw unsafeGrantStore();
    }
    const records = fs
        .readdirSync(grants, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => {
        const match = entry.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/);
        if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
            throw unsafeGrantStore();
        }
        const grantId = match[1];
        const record = readGrantRecord(path.join(grants, entry.name));
        if (record.envelope.payload.grantId !== grantId) {
            throw unsafeGrantStore();
        }
        return {
            grantId,
            requestDigest: record.envelope.payload.requestDigest,
            consumedAttemptIds: [...record.consumedAttemptIds].sort(),
        };
    });
    return Object.freeze(records.map((record) => Object.freeze({
        ...record,
        consumedAttemptIds: Object.freeze([...record.consumedAttemptIds]),
    })));
}
/**
 * Creates the first durable context generation and its retention catalog as one
 * atomic workflow envelope. Context objects are published before the envelope,
 * so an interrupted initialization can leave only unreachable content objects.
 */
export function initializeDurableEpochContextStore(storeRoot, input) {
    validateContextManifest(input.manifest);
    validateWorkflowContextState(input.workflow);
    assertContextManifestBinding(input.workflow, input.manifest);
    const updatedAt = exactDate(input.now, 'EXECUTION_CONTEXT_INVALID');
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflow.workflowId, () => {
        const statePath = durableStatePath(paths, input.workflow.workflowId);
        if (fs.lstatSync(statePath, { throwIfNoEntry: false }) !== undefined) {
            throw workflowError('EXECUTION_CONTEXT_EXISTS', `Durable context for ${input.workflow.workflowId} already exists.`, ExitCode.conflict);
        }
        persistManifestItems(paths, input.workflow.workflowId, input.manifest, input.items);
        const context = {
            schemaVersion: 1,
            kind: 'durable-epoch-context',
            generation: 1,
            workflow: structuredClone(input.workflow),
            currentManifest: structuredClone(input.manifest),
            transitionReceipts: [],
            transitionStubs: [],
            updatedAt,
        };
        const retention = {
            schemaVersion: 1,
            kind: 'durable-retention-catalog',
            workflowId: input.workflow.workflowId,
            generation: 1,
            records: manifestRetentionRecords(input.manifest, updatedAt),
            updatedAt,
        };
        const state = {
            schemaVersion: 1,
            kind: 'durable-execution-governance-state',
            context,
            retention,
        };
        createDurablePrivateFileAtomic(statePath, canonicalDurableGovernanceState(state));
        return structuredClone(context);
    });
}
export function inspectDurableEpochContextStore(storeRoot, workflowId) {
    assertIdentity(workflowId, invalidDurableContext, 'workflow ID');
    const state = readDurableGovernanceState(ensureDurableGovernanceStore(storeRoot), workflowId);
    return structuredClone(state.context);
}
/**
 * Applies transition-receipt TTL and count bounds without requiring another
 * semantic epoch rollover. Receipt retention is operational maintenance: it
 * may advance the durable context envelope generation, but it must not change
 * the current epoch, manifest, workflow binding, or evidence catalog.
 */
export function compactDurableEpochTransitionReceipts(storeRoot, input) {
    assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
    assertPositiveInteger(input.expectedContextGeneration, invalidDurableContext, 'expected context generation');
    const updatedAt = exactDate(input.now, 'RETENTION_POLICY_INVALID');
    const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
    validateRetentionPolicy(policy);
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflowId, () => {
        let state = readDurableGovernanceState(paths, input.workflowId);
        recoverPreparedPruneReceipts(paths, input.workflowId, state);
        state = readDurableGovernanceState(paths, input.workflowId);
        if (state.context.generation !== input.expectedContextGeneration) {
            throw workflowError('EXECUTION_CONTEXT_CAS_MISMATCH', 'Durable context changed before transition receipts were compacted.', ExitCode.staleState);
        }
        const fullReceiptsBefore = state.context.transitionReceipts.length;
        const stubsBefore = state.context.transitionStubs.length;
        const compacted = compactEpochTransitionReceipts(state.context.transitionReceipts, state.context.transitionStubs, { now: input.now, policy });
        const changed = canonicalJson(compacted.full) !==
            canonicalJson(state.context.transitionReceipts) ||
            canonicalJson(compacted.stubs) !==
                canonicalJson(state.context.transitionStubs);
        if (!changed) {
            return Object.freeze({
                workflowId: input.workflowId,
                changed: false,
                contextGeneration: state.context.generation,
                fullReceiptsBefore,
                fullReceiptsAfter: fullReceiptsBefore,
                stubsBefore,
                stubsAfter: stubsBefore,
                discarded: Object.freeze([...compacted.discarded]),
            });
        }
        const context = {
            ...state.context,
            generation: state.context.generation + 1,
            transitionReceipts: compacted.full,
            transitionStubs: compacted.stubs,
            updatedAt,
        };
        replacePrivateFileAtomic(durableStatePath(paths, input.workflowId), canonicalDurableGovernanceState({ ...state, context }));
        return Object.freeze({
            workflowId: input.workflowId,
            changed: true,
            contextGeneration: context.generation,
            fullReceiptsBefore,
            fullReceiptsAfter: context.transitionReceipts.length,
            stubsBefore,
            stubsAfter: context.transitionStubs.length,
            discarded: Object.freeze([...compacted.discarded]),
        });
    });
}
/**
 * Revalidate one exact current context and execute a short synchronous
 * acceptance operation while holding the same per-workflow lock used by epoch
 * rollover. Callers receive no raw lock primitive and must not perform
 * long-running provider or tool work inside the callback.
 */
export function withCurrentDurableEpochContextStore(storeRoot, input, operation) {
    assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
    assertPositiveInteger(input.expectedGeneration, invalidDurableContext, 'expected generation');
    assertPositiveInteger(input.expectedEpoch, invalidDurableContext, 'expected epoch');
    assertDigest(input.expectedContextDigest, invalidDurableContext, 'expected context digest');
    validateContextManifest(input.expectedManifest);
    if (input.expectedManifest.workflowId !== input.workflowId ||
        input.expectedManifest.epoch !== input.expectedEpoch ||
        input.expectedManifest.contextDigest !== input.expectedContextDigest) {
        throw invalidDurableContext('Expected context manifest does not match its acceptance binding.');
    }
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflowId, () => {
        const state = readDurableGovernanceState(paths, input.workflowId);
        if (state.context.generation !== input.expectedGeneration ||
            state.context.workflow.status !== 'active' ||
            state.context.workflow.currentEpoch !== input.expectedEpoch ||
            state.context.workflow.contextDigest !== input.expectedContextDigest ||
            canonicalJson(state.context.currentManifest) !==
                canonicalJson(input.expectedManifest)) {
            throw workflowError('EXECUTION_CONTEXT_CAS_MISMATCH', 'Durable context changed before the guarded acceptance operation.', ExitCode.staleState);
        }
        return operation(structuredClone(state.context));
    });
}
export function inspectDurableRetentionCatalog(storeRoot, workflowId) {
    assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
    const state = readDurableGovernanceState(ensureDurableGovernanceStore(storeRoot), workflowId);
    return structuredClone(state.retention);
}
/**
 * Rolls the current epoch under a context-generation CAS. Only the new
 * manifest is retained as the assembly authority; historical manifests are
 * represented by bounded transition receipts/stubs, not prompt inputs.
 */
export function rolloverDurableEpochContextStore(storeRoot, input) {
    assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
    validateContextManifest(input.nextManifest);
    const createdAt = exactDate(input.createdAt, 'EPOCH_TRANSITION_INVALID');
    const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
    validateRetentionPolicy(policy);
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflowId, () => {
        let state = readDurableGovernanceState(paths, input.workflowId);
        recoverPreparedPruneReceipts(paths, input.workflowId, state);
        state = readDurableGovernanceState(paths, input.workflowId);
        assertContextCas(state.context, input);
        if (input.nextManifest.workflowId !== input.workflowId) {
            throw invalidEpochTransition('The next context manifest belongs to another workflow.');
        }
        if (state.context.workflow.status !== 'active') {
            throw invalidEpochTransition('A terminal workflow cannot advance to another epoch.');
        }
        const transition = performEpochRollover({
            workflow: state.context.workflow,
            nextManifest: input.nextManifest,
            reason: input.reason,
            restartFrom: input.restartFrom,
            carriedForward: input.carriedForward,
            carryForwardManifest: input.carryForwardManifest,
            invalidated: input.invalidated,
            verification: input.verification,
            createdAt: input.createdAt,
        });
        assertEpochCarryForwardSourceMembership(transition.receipt.carryForwardManifest, state.context.currentManifest, input.nextManifest);
        persistManifestItems(paths, input.workflowId, input.nextManifest, input.items);
        const compacted = compactEpochTransitionReceipts([...state.context.transitionReceipts, transition.receipt], state.context.transitionStubs, { now: input.createdAt, policy });
        const context = {
            ...state.context,
            generation: state.context.generation + 1,
            workflow: transition.workflow,
            currentManifest: structuredClone(input.nextManifest),
            transitionReceipts: compacted.full,
            transitionStubs: compacted.stubs,
            updatedAt: createdAt,
        };
        const expired = markEpochEvidenceExpiring(state.retention.records, {
            endedEpoch: state.context.workflow.currentEpoch,
            endedAt: input.createdAt,
            policy,
        });
        const records = [
            ...expired,
            ...manifestRetentionRecords(input.nextManifest, createdAt),
        ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
        assertUniqueEvidenceIds(records);
        const retention = {
            ...state.retention,
            generation: state.retention.generation + 1,
            records,
            updatedAt: createdAt,
        };
        const next = {
            ...state,
            context,
            retention,
        };
        replacePrivateFileAtomic(durableStatePath(paths, input.workflowId), canonicalDurableGovernanceState(next));
        return structuredClone(context);
    });
}
/** Prompt assembly is deliberately a current-manifest-only traversal. */
export function assembleCurrentPromptFromStore(storeRoot, input) {
    assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
    assertPositiveInteger(input.expectedEpoch, invalidDurableContext, 'expected epoch');
    assertDigest(input.expectedContextDigest, invalidDurableContext, 'expected context digest');
    const paths = ensureDurableGovernanceStore(storeRoot);
    const state = readDurableGovernanceState(paths, input.workflowId);
    if (state.context.workflow.currentEpoch !== input.expectedEpoch) {
        throw workflowError('EXECUTION_CONTEXT_STALE_EPOCH', `Epoch ${input.expectedEpoch} is not the current epoch for ${input.workflowId}.`, ExitCode.staleState);
    }
    if (state.context.workflow.contextDigest !== input.expectedContextDigest) {
        throw workflowError('EXECUTION_CONTEXT_STALE_MANIFEST', `The expected manifest is not current for ${input.workflowId}.`, ExitCode.staleState);
    }
    return assemblePromptFromManifest(state.context.currentManifest, (reference) => ({
        ...reference,
        content: readDurableContentObject(paths, input.workflowId, reference.digest),
    }));
}
export function assessStoredAttemptResultEligibility(storeRoot, workflowId, job, result) {
    const state = inspectDurableEpochContextStore(storeRoot, workflowId);
    return assessAttemptResultEligibility(state.workflow, job, result);
}
export function storeDurableEvidence(storeRoot, input) {
    assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
    validateEvidenceRetentionRecord(input.record);
    if (input.record.retention === 'pinned') {
        throw workflowError('RETENTION_PIN_REQUIRES_HUMAN', 'Pinned evidence must be created through an explicit human pin decision.', ExitCode.guard);
    }
    if (typeof input.content !== 'string' ||
        Buffer.byteLength(input.content) > MAX_DOCUMENT_BYTES ||
        digest(input.content) !== input.record.digest) {
        throw workflowError('RETENTION_EVIDENCE_DIGEST_MISMATCH', 'Evidence content does not match its retention digest.', ExitCode.verification);
    }
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflowId, () => {
        let state = readDurableGovernanceState(paths, input.workflowId);
        recoverPreparedPruneReceipts(paths, input.workflowId, state);
        state = readDurableGovernanceState(paths, input.workflowId);
        assertCatalogCas(state.retention, input.expectedCatalogGeneration);
        if (input.record.workflowId !== input.workflowId) {
            throw invalidRetentionRecord('Evidence belongs to another workflow.');
        }
        if (input.record.epoch > state.context.workflow.currentEpoch ||
            (input.record.retention === 'active' &&
                input.record.epoch !== state.context.workflow.currentEpoch)) {
            throw workflowError('RETENTION_STALE_EPOCH', 'Only the current epoch may publish active evidence.', ExitCode.staleState);
        }
        assertCurrentManifestEvidenceBinding(state.context.currentManifest, input.record);
        if (state.retention.records.some(({ evidenceId }) => evidenceId === input.record.evidenceId)) {
            throw workflowError('RETENTION_EVIDENCE_EXISTS', `Evidence ${input.record.evidenceId} already exists.`, ExitCode.conflict);
        }
        publishDurableContentObject(paths, input.workflowId, input.record.digest, input.content);
        const updatedAt = new Date().toISOString();
        const retention = {
            ...state.retention,
            generation: state.retention.generation + 1,
            records: [...state.retention.records, structuredClone(input.record)].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
            updatedAt,
        };
        replaceDurableGovernanceState(paths, {
            ...state,
            retention,
        });
        return structuredClone(retention);
    });
}
export function pinDurableEvidence(storeRoot, input) {
    assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
    assertIdentity(input.evidenceId, invalidRetentionRecord, 'evidence ID');
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflowId, () => {
        let state = readDurableGovernanceState(paths, input.workflowId);
        recoverPreparedPruneReceipts(paths, input.workflowId, state);
        state = readDurableGovernanceState(paths, input.workflowId);
        assertCatalogCas(state.retention, input.expectedCatalogGeneration);
        const index = state.retention.records.findIndex(({ evidenceId }) => evidenceId === input.evidenceId);
        if (index < 0)
            throw retentionEvidenceNotFound(input.evidenceId);
        const records = state.retention.records.map((record, recordIndex) => recordIndex === index
            ? pinEvidence(record, input.decision)
            : structuredClone(record));
        const retention = {
            ...state.retention,
            generation: state.retention.generation + 1,
            records,
            updatedAt: exactDate(input.decision.pinnedAt, 'RETENTION_RECORD_INVALID'),
        };
        replaceDurableGovernanceState(paths, { ...state, retention });
        return structuredClone(retention);
    });
}
export function readDurableEvidence(storeRoot, workflowId, evidenceId) {
    assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
    assertIdentity(evidenceId, invalidRetentionRecord, 'evidence ID');
    const paths = ensureDurableGovernanceStore(storeRoot);
    const state = readDurableGovernanceState(paths, workflowId);
    const record = state.retention.records.find((candidate) => candidate.evidenceId === evidenceId);
    if (record === undefined)
        throw retentionEvidenceNotFound(evidenceId);
    return {
        record: structuredClone(record),
        content: readDurableContentObject(paths, workflowId, record.digest),
    };
}
/**
 * Performs one explicit pruning pass. The prepared receipt is durable before
 * the catalog CAS, and object deletion happens only after the catalog no longer
 * names the records. A later mutation recovers a prepared pass idempotently.
 */
export function pruneDurableEvidence(storeRoot, input) {
    assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
    const now = exactDate(input.now, 'RETENTION_RECORD_INVALID');
    const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
    validateRetentionPolicy(policy);
    const paths = ensureDurableGovernanceStore(storeRoot);
    return withDurableGovernanceLock(paths, input.workflowId, () => {
        let state = readDurableGovernanceState(paths, input.workflowId);
        recoverPreparedPruneReceipts(paths, input.workflowId, state);
        state = readDurableGovernanceState(paths, input.workflowId);
        if (state.context.generation !== input.expectedContextGeneration ||
            state.context.workflow.currentEpoch !== input.expectedEpoch ||
            state.context.workflow.contextDigest !== input.expectedContextDigest) {
            throw workflowError('EXECUTION_CONTEXT_CAS_MISMATCH', 'Durable context changed before evidence pruning.', ExitCode.staleState);
        }
        assertCatalogCas(state.retention, input.expectedCatalogGeneration);
        const plan = planEvidencePruning({
            records: state.retention.records,
            currentEpoch: state.context.workflow.currentEpoch,
            currentManifest: state.context.currentManifest,
            now: input.now,
            policy,
        });
        const deleting = new Set(plan.delete);
        const deleted = state.retention.records
            .filter(({ evidenceId }) => deleting.has(evidenceId))
            .map(({ evidenceId, digest: evidenceDigest }) => ({
            evidenceId,
            digest: evidenceDigest,
        }))
            .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
        const retention = {
            ...state.retention,
            generation: state.retention.generation + 1,
            records: state.retention.records
                .filter(({ evidenceId }) => !deleting.has(evidenceId))
                .map((record) => structuredClone(record)),
            updatedAt: now,
        };
        const receipt = {
            schemaVersion: 1,
            kind: 'durable-evidence-prune',
            receiptId: crypto.randomUUID(),
            state: 'prepared',
            workflowId: input.workflowId,
            contextGeneration: state.context.generation,
            epoch: state.context.workflow.currentEpoch,
            contextDigest: state.context.workflow.contextDigest,
            catalogGenerationBefore: state.retention.generation,
            catalogDigestBefore: durableRetentionCatalogDigest(state.retention),
            catalogGenerationAfter: retention.generation,
            catalogDigestAfter: durableRetentionCatalogDigest(retention),
            deleted,
            preparedAt: now,
            completedAt: null,
            abortedAt: null,
            abortReason: null,
        };
        const receiptPath = durablePruneReceiptPath(paths, input.workflowId, receipt.receiptId);
        createDurablePrivateFileAtomic(receiptPath, canonicalDurablePruneReceipt(receipt));
        const next = { ...state, retention };
        replaceDurableGovernanceState(paths, next);
        deleteUnreferencedReceiptObjects(paths, next, receipt);
        const complete = {
            ...receipt,
            state: 'complete',
            completedAt: now,
        };
        replacePrivateFileAtomic(receiptPath, canonicalDurablePruneReceipt(complete));
        return {
            catalog: structuredClone(retention),
            receipt: structuredClone(complete),
        };
    });
}
export function listDurablePruneReceipts(storeRoot, workflowId) {
    assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
    const paths = ensureDurableGovernanceStore(storeRoot);
    const directory = durableWorkflowReceiptDirectory(paths, workflowId, true);
    const receipts = fs
        .readdirSync(directory)
        .filter((name) => !isDurablePruneReceiptTemporary(name))
        .map((name) => {
        if (!UUID_V4.test(name.replace(/\.json$/, '')) ||
            !name.endsWith('.json')) {
            throw unsafeDurableGovernanceStore();
        }
        const receipt = readDurablePruneReceipt(path.join(directory, name));
        if (receipt.workflowId !== workflowId) {
            throw unsafeDurableGovernanceStore();
        }
        return receipt;
    });
    return receipts
        .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt) ||
        left.receiptId.localeCompare(right.receiptId))
        .map((receipt) => structuredClone(receipt));
}
function canonicalDurableGovernanceState(state) {
    validateDurableGovernanceState(state);
    return boundedDurableDocument(`${canonicalJson(state)}\n`);
}
function canonicalDurableRetentionCatalog(catalog) {
    validateDurableRetentionCatalog(catalog);
    return boundedDurableDocument(`${canonicalJson(catalog)}\n`);
}
function durableRetentionCatalogDigest(catalog) {
    return digest(canonicalDurableRetentionCatalog(catalog));
}
function canonicalDurablePruneReceipt(receipt) {
    validateDurablePruneReceipt(receipt);
    return boundedDurableDocument(`${canonicalJson(receipt)}\n`);
}
function boundedDurableDocument(content) {
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
        throw workflowError('EXECUTION_GOVERNANCE_STORE_CAPACITY', 'Durable execution-governance document exceeds its size bound.', ExitCode.guard);
    }
    return content;
}
function validateDurableGovernanceState(value) {
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
function validateDurablePruneReceipt(value) {
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
function assertContextManifestBinding(workflow, manifest) {
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
function assertCurrentManifestEvidenceBinding(manifest, record) {
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
function assertContextCas(context, expected) {
    assertPositiveInteger(expected.expectedGeneration, invalidDurableContext, 'expected generation');
    assertPositiveInteger(expected.expectedEpoch, invalidDurableContext, 'expected epoch');
    assertDigest(expected.expectedContextDigest, invalidDurableContext, 'expected context digest');
    if (context.generation !== expected.expectedGeneration ||
        context.workflow.currentEpoch !== expected.expectedEpoch ||
        context.workflow.contextDigest !== expected.expectedContextDigest) {
        throw workflowError('EXECUTION_CONTEXT_CAS_MISMATCH', 'Durable context changed before the epoch transition.', ExitCode.staleState);
    }
}
function assertCatalogCas(catalog, expectedGeneration) {
    assertPositiveInteger(expectedGeneration, invalidRetentionRecord, 'expected catalog generation');
    if (catalog.generation !== expectedGeneration) {
        throw workflowError('RETENTION_CATALOG_CAS_MISMATCH', 'The retention catalog changed before the requested operation.', ExitCode.staleState);
    }
}
function manifestRetentionRecords(manifest, createdAt) {
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
function assertUniqueEvidenceIds(records) {
    const ids = new Set(records.map(({ evidenceId }) => evidenceId));
    if (ids.size !== records.length) {
        throw invalidRetentionRecord('Evidence IDs must be unique.');
    }
}
function persistManifestItems(paths, workflowId, manifest, items) {
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
function ensureDurableGovernanceStore(storeRoot) {
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
function ensurePrivateDirectory(directory, create) {
    if (create) {
        try {
            fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST') {
                throw unsafeDurableGovernanceStore();
            }
        }
    }
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o077) !== 0) {
        throw unsafeDurableGovernanceStore();
    }
}
function workflowStorageKey(workflowId) {
    return crypto.createHash('sha256').update(workflowId).digest('hex');
}
function durableStatePath(paths, workflowId) {
    return path.join(paths.states, `${workflowStorageKey(workflowId)}.json`);
}
function durableWorkflowObjectDirectory(paths, workflowId, create) {
    const directory = path.join(paths.objects, workflowStorageKey(workflowId));
    ensurePrivateDirectory(directory, create);
    return directory;
}
function durableObjectPath(paths, workflowId, contentDigest) {
    assertDigest(contentDigest, unsafeDurableGovernanceStore, 'object digest');
    return path.join(durableWorkflowObjectDirectory(paths, workflowId, true), `${contentDigest.slice('sha256:'.length)}.blob`);
}
function durableWorkflowReceiptDirectory(paths, workflowId, create) {
    const directory = path.join(paths.pruneReceipts, workflowStorageKey(workflowId));
    ensurePrivateDirectory(directory, create);
    return directory;
}
function durablePruneReceiptPath(paths, workflowId, receiptId) {
    assertUuid(receiptId, unsafeDurableGovernanceStore);
    return path.join(durableWorkflowReceiptDirectory(paths, workflowId, true), `${receiptId}.json`);
}
function readDurableGovernanceState(paths, workflowId) {
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
function replaceDurableGovernanceState(paths, state) {
    replacePrivateFileAtomic(durableStatePath(paths, state.context.workflow.workflowId), canonicalDurableGovernanceState(state));
}
function publishDurableContentObject(paths, workflowId, contentDigest, content) {
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
function readDurableContentObject(paths, workflowId, contentDigest) {
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
function readPrivateFile(filePath, maximumBytes) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600 ||
            stats.size > maximumBytes) {
            throw unsafeDurableGovernanceStore();
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    catch (error) {
        if (isWorkflowError(error) &&
            error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE') {
            throw error;
        }
        throw unsafeDurableGovernanceStore();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function readDurablePruneReceipt(filePath) {
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
function recoverPreparedPruneReceipts(paths, workflowId, state) {
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
function isDurablePruneReceiptTemporary(name) {
    const [receiptId, json, pid, temporaryId, suffix, ...extra] = name.split('.');
    return (extra.length === 0 &&
        json === 'json' &&
        suffix === 'tmp' &&
        UUID_V4.test(receiptId ?? '') &&
        /^[1-9][0-9]*$/.test(pid ?? '') &&
        UUID_V4.test(temporaryId ?? ''));
}
function deleteUnreferencedReceiptObjects(paths, state, receipt) {
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
function withDurableGovernanceLock(paths, workflowId, operation) {
    const lockPath = path.join(paths.locks, `${workflowStorageKey(workflowId)}.lock`);
    let descriptor;
    let ownedStats;
    for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
        let createdThisAttempt = false;
        try {
            descriptor = fs.openSync(lockPath, fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW, 0o600);
            createdThisAttempt = true;
            fs.fchmodSync(descriptor, 0o600);
            const lockRecord = {
                schemaVersion: 1,
                workflowId,
                pid: process.pid,
                createdAt: new Date().toISOString(),
            };
            fs.writeFileSync(descriptor, `${canonicalJson(lockRecord)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
            ownedStats = fs.fstatSync(descriptor);
            fsyncDirectory(paths.locks);
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            ownedStats = undefined;
            if (createdThisAttempt) {
                try {
                    fs.unlinkSync(lockPath);
                    fsyncDirectory(paths.locks);
                }
                catch (cleanupError) {
                    if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
                        throw unsafeDurableGovernanceStore();
                    }
                }
            }
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
            if (!reclaimDeadDurableGovernanceLock(lockPath, workflowId)) {
                throw workflowError('EXECUTION_GOVERNANCE_OPERATION_CONFLICT', `Workflow ${workflowId} already has a governance operation in progress.`, ExitCode.conflict);
            }
        }
    }
    if (descriptor === undefined || ownedStats === undefined) {
        throw workflowError('EXECUTION_GOVERNANCE_OPERATION_CONFLICT', `Workflow ${workflowId} already has a governance operation in progress.`, ExitCode.conflict);
    }
    let result;
    let operationError;
    try {
        result = operation();
    }
    catch (error) {
        operationError = error;
    }
    fs.closeSync(descriptor);
    let releaseError;
    try {
        const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (current === undefined ||
            current.dev !== ownedStats.dev ||
            current.ino !== ownedStats.ino) {
            throw unsafeDurableGovernanceStore();
        }
        fs.unlinkSync(lockPath);
        fsyncDirectory(paths.locks);
    }
    catch (error) {
        releaseError = error;
    }
    if (operationError !== undefined)
        throw operationError;
    if (releaseError !== undefined)
        throw releaseError;
    return result;
}
function reclaimDeadDurableGovernanceLock(lockPath, workflowId) {
    const raw = readPrivateFile(lockPath, 4_096);
    let value;
    try {
        value = parseDocument(raw);
    }
    catch {
        throw unsafeDurableGovernanceStore();
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'workflowId', 'pid', 'createdAt']) ||
        value.schemaVersion !== 1 ||
        value.workflowId !== workflowId ||
        !Number.isSafeInteger(value.pid) ||
        value.pid < 1 ||
        `${canonicalJson(value)}\n` !== raw) {
        throw unsafeDurableGovernanceStore();
    }
    assertTimestamp(value.createdAt, unsafeDurableGovernanceStore, 'lock createdAt');
    try {
        process.kill(value.pid, 0);
        return false;
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ESRCH')
            return false;
    }
    try {
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return true;
        throw error;
    }
}
function retentionEvidenceNotFound(evidenceId) {
    return workflowError('RETENTION_EVIDENCE_NOT_FOUND', `Evidence ${evidenceId} does not exist in the current catalog.`, ExitCode.staleState);
}
function validateExecutionBudgetGrantRequest(value) {
    const keys = [
        'schemaVersion',
        'kind',
        'requestId',
        'workflowId',
        'epoch',
        'jobId',
        'mandateBinding',
        'requestedChanges',
        'rationale',
        'expiresAfterAttempts',
        'createdAt',
    ];
    if (!isRecord(value) ||
        !hasExactKeys(value, keys) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'execution-budget-grant-request') {
        throw invalidGrantRequest('Grant request has an invalid shape.');
    }
    assertUuid(value.requestId, invalidGrantRequest);
    assertIdentity(value.workflowId, invalidGrantRequest, 'workflow ID');
    assertPositiveInteger(value.epoch, invalidGrantRequest, 'epoch');
    assertIdentity(value.jobId, invalidGrantRequest, 'job ID');
    assertExecutionGrantMandateBinding(value.mandateBinding, invalidGrantRequest);
    validateChanges(value.requestedChanges, invalidGrantRequest);
    assertReason(value.rationale, invalidGrantRequest, 'rationale');
    assertBoundedInteger(value.expiresAfterAttempts, 1, MAX_GRANT_USES, invalidGrantRequest, 'attempt bound');
    assertTimestamp(value.createdAt, invalidGrantRequest, 'createdAt');
}
function validateExecutionBudgetGrantPayload(value) {
    const keys = [
        'schemaVersion',
        'kind',
        'grantId',
        'requestDigest',
        'workflowId',
        'epoch',
        'jobId',
        'mandateBinding',
        'allowedChanges',
        'maxUses',
        'issuedAt',
        'issuer',
    ];
    if (!isRecord(value) ||
        !hasExactKeys(value, keys) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'execution-budget-grant.v1') {
        throw invalidGrant('Grant payload has an invalid shape.');
    }
    assertUuid(value.grantId, invalidGrant);
    assertDigest(value.requestDigest, invalidGrant, 'request digest');
    assertIdentity(value.workflowId, invalidGrant, 'workflow ID');
    assertPositiveInteger(value.epoch, invalidGrant, 'epoch');
    assertIdentity(value.jobId, invalidGrant, 'job ID');
    assertExecutionGrantMandateBinding(value.mandateBinding, invalidGrant);
    validateChanges(value.allowedChanges, invalidGrant);
    assertBoundedInteger(value.maxUses, 1, MAX_GRANT_USES, invalidGrant, 'maximum uses');
    assertTimestamp(value.issuedAt, invalidGrant, 'issuedAt');
    assertIdentity(value.issuer, invalidGrant, 'issuer');
}
function validateExecutionBudgetGrantEnvelope(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['payload', 'signature']) ||
        typeof value.signature !== 'string' ||
        value.signature.length < 1 ||
        value.signature.length > 16_384 ||
        value.signature.includes('\0')) {
        throw invalidGrant('Grant envelope has an invalid shape or signature.');
    }
    validateExecutionBudgetGrantPayload(value.payload);
}
function validateExecutionBudgetConsumeReceipt(value, payload) {
    const keys = [
        'schemaVersion',
        'kind',
        'receiptId',
        'grantId',
        'requestDigest',
        'workflowId',
        'epoch',
        'jobId',
        'mandateBinding',
        'attemptId',
        'useNumber',
        'remainingUses',
        'consumedAt',
    ];
    if (!isRecord(value) ||
        !hasExactKeys(value, keys) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'execution-budget-consume-receipt') {
        throw unsafeGrantStore();
    }
    assertDigest(value.receiptId, unsafeGrantStore, 'receipt ID');
    assertUuid(value.grantId, unsafeGrantStore);
    assertDigest(value.requestDigest, unsafeGrantStore, 'request digest');
    assertIdentity(value.workflowId, unsafeGrantStore, 'workflow ID');
    assertPositiveInteger(value.epoch, unsafeGrantStore, 'epoch');
    assertIdentity(value.jobId, unsafeGrantStore, 'job ID');
    assertExecutionGrantMandateBinding(value.mandateBinding, unsafeGrantStore);
    assertIdentity(value.attemptId, unsafeGrantStore, 'attempt ID');
    assertBoundedInteger(value.useNumber, 1, MAX_GRANT_USES, unsafeGrantStore, 'use');
    assertBoundedInteger(value.remainingUses, 0, MAX_GRANT_USES - 1, unsafeGrantStore, 'remaining uses');
    assertTimestamp(value.consumedAt, unsafeGrantStore, 'consumedAt');
    const { receiptId: _receiptId, ...core } = value;
    if (value.receiptId !== digest(canonicalJson(core)))
        throw unsafeGrantStore();
    if (payload &&
        (value.grantId !== payload.grantId ||
            value.requestDigest !== payload.requestDigest ||
            value.workflowId !== payload.workflowId ||
            value.epoch !== payload.epoch ||
            value.jobId !== payload.jobId ||
            canonicalJson(value.mandateBinding) !==
                canonicalJson(payload.mandateBinding) ||
            value.useNumber + value.remainingUses !== payload.maxUses)) {
        throw unsafeGrantStore();
    }
}
function canonicalGrantRecord(record) {
    validateGrantRecord(record);
    return `${canonicalJson(record)}\n`;
}
function validateGrantRecord(value) {
    if (isRecord(value) &&
        typeof value.schemaVersion === 'number' &&
        value.schemaVersion !== 3) {
        throw unsupportedSchemaVersion(value.schemaVersion);
    }
    const currentKeys = [
        'schemaVersion',
        'state',
        'envelopeDigest',
        'envelope',
        'remainingUses',
        'consumedAttemptIds',
        'receipts',
        'revokedAt',
        'revocationReason',
    ];
    if (!isRecord(value) ||
        value.schemaVersion !== 3 ||
        !hasExactKeys(value, currentKeys) ||
        !['active', 'consumed', 'revoked'].includes(String(value.state))) {
        throw unsafeGrantStore();
    }
    validateExecutionBudgetGrantEnvelope(value.envelope);
    assertDigest(value.envelopeDigest, unsafeGrantStore, 'envelope digest');
    if (value.envelopeDigest !==
        digest(canonicalExecutionBudgetGrantEnvelope(value.envelope))) {
        throw unsafeGrantStore();
    }
    const payload = value.envelope.payload;
    assertBoundedInteger(value.remainingUses, 0, payload.maxUses, unsafeGrantStore, 'remaining uses');
    if (!Array.isArray(value.consumedAttemptIds) ||
        !Array.isArray(value.receipts) ||
        value.consumedAttemptIds.length !== value.receipts.length ||
        value.receipts.length + value.remainingUses !==
            payload.maxUses ||
        (value.state === 'active' && value.remainingUses === 0) ||
        (value.state === 'consumed' && value.remainingUses !== 0) ||
        (value.state === 'revoked' && value.remainingUses === 0)) {
        throw unsafeGrantStore();
    }
    if (value.state === 'revoked') {
        assertTimestamp(value.revokedAt, unsafeGrantStore, 'revokedAt');
        assertReason(value.revocationReason, unsafeGrantStore, 'revocation reason');
        const latestAuthorityAt = value.receipts.at(-1)?.consumedAt ?? payload.issuedAt;
        if (new Date(value.revokedAt).getTime() <
            new Date(latestAuthorityAt).getTime()) {
            throw unsafeGrantStore();
        }
    }
    else if (value.revokedAt !== null || value.revocationReason !== null) {
        throw unsafeGrantStore();
    }
    const attemptIds = new Set();
    for (let index = 0; index < value.receipts.length; index += 1) {
        const receipt = value.receipts[index];
        validateExecutionBudgetConsumeReceipt(receipt, payload);
        if (receipt.useNumber !== index + 1 ||
            receipt.remainingUses !== payload.maxUses - index - 1 ||
            value.consumedAttemptIds[index] !== receipt.attemptId ||
            attemptIds.has(receipt.attemptId)) {
            throw unsafeGrantStore();
        }
        attemptIds.add(receipt.attemptId);
    }
}
function readGrantRecord(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > MAX_DOCUMENT_BYTES) {
        throw unsafeGrantStore();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        const value = parseDocument(raw);
        validateGrantRecord(value);
        if (canonicalGrantRecord(value) !== raw)
            throw unsafeGrantStore();
        return value;
    }
    catch (error) {
        if (isWorkflowError(error) &&
            (error.code === 'EXECUTION_BUDGET_GRANT_STORE_UNSAFE' ||
                error.code === 'UNSUPPORTED_SCHEMA_VERSION')) {
            throw error;
        }
        throw unsafeGrantStore();
    }
}
function readGrantRecordRequired(filePath) {
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
        throw workflowError('EXECUTION_BUDGET_GRANT_NOT_FOUND', 'Execution-budget grant does not exist or is not available.', ExitCode.staleState);
    }
    return readGrantRecord(filePath);
}
function ensureExecutionBudgetGrantStore(storeRoot) {
    if (typeof storeRoot !== 'string' || storeRoot.length < 1) {
        throw unsafeGrantStore();
    }
    const root = path.resolve(storeRoot);
    ensurePlainDirectory(root, false);
    const grants = path.join(root, 'execution-budget-grants');
    const pending = path.join(root, 'execution-budget-grants-pending-audit');
    const locks = path.join(root, 'execution-budget-locks');
    ensurePlainDirectory(grants, true);
    ensurePlainDirectory(pending, true);
    ensurePlainDirectory(locks, true);
    return { root, grants, pending, locks };
}
function ensurePlainDirectory(directory, create) {
    if (create) {
        try {
            fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
        }
    }
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink())
        throw unsafeGrantStore();
}
function withExecutionGrantLock(paths, grantId, operation) {
    const lockPath = path.join(paths.locks, `${grantId}.lock`);
    let descriptor;
    let ownsLock = false;
    let result;
    let operationError;
    try {
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
            ownsLock = true;
            fs.writeFileSync(descriptor, `${canonicalJson({ grantId, pid: process.pid })}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workflowError('EXECUTION_BUDGET_GRANT_OPERATION_CONFLICT', `Execution-budget grant ${grantId} already has an operation in progress.`, ExitCode.conflict);
            }
            throw error;
        }
        result = operation();
    }
    catch (error) {
        operationError = error;
    }
    if (descriptor !== undefined)
        fs.closeSync(descriptor);
    let releaseError;
    if (ownsLock) {
        try {
            fs.unlinkSync(lockPath);
            fsyncDirectory(paths.locks);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT')
                releaseError = error;
        }
    }
    if (operationError !== undefined)
        throw operationError;
    if (releaseError !== undefined)
        throw releaseError;
    return result;
}
function createPrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporary, filePath);
        fs.unlinkSync(temporary);
        fsyncDirectory(path.dirname(filePath));
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
    }
}
// Durable-governance callers hold the workflow lock, so a no-overwrite check
// followed by rename avoids the hard-link alias window of the cross-process
// grant publisher while preserving atomic visibility to unlocked readers.
function createDurablePrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
            const error = new Error(`File ${filePath} already exists.`);
            Object.assign(error, { code: 'EEXIST' });
            throw error;
        }
        fs.renameSync(temporary, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
    }
}
function replacePrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
    }
}
function unlinkExactPrivateFile(filePath, expected) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        fs.readFileSync(filePath, 'utf8') !== expected) {
        throw unsafeGrantStore();
    }
    fs.unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
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
function cloneChange(change, invalid) {
    return {
        path: change.path,
        from: cloneJson(change.from, invalid),
        to: cloneJson(change.to, invalid),
    };
}
function sortChanges(changes, invalid) {
    if (!Array.isArray(changes))
        return changes;
    return changes
        .map((change) => cloneChange(change, invalid))
        .sort((left, right) => left.path.localeCompare(right.path));
}
function validateChanges(value, invalid) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
        throw invalid('Execution-budget changes must be a non-empty bounded list.');
    }
    let previous = '';
    for (const change of value) {
        if (!isRecord(change) ||
            !hasExactKeys(change, ['path', 'from', 'to']) ||
            typeof change.path !== 'string' ||
            !JSON_POINTER.test(change.path) ||
            change.path <= previous) {
            throw invalid('Execution-budget changes must use sorted unique JSON-pointer paths.');
        }
        assertJsonValue(change.from, invalid);
        assertJsonValue(change.to, invalid);
        if (canonicalJson(change.from) === canonicalJson(change.to)) {
            throw invalid('Execution-budget change must alter its value.');
        }
        previous = change.path;
    }
}
function assertExecutionGrantMandateBinding(value, invalid) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'mandateTaskId',
            'mandateId',
            'mandateDigest',
            'changeId',
            'externalAuditRoot',
        ]) ||
        value.schemaVersion !== 1 ||
        typeof value.mandateTaskId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
        typeof value.mandateId !== 'string' ||
        !UUID_V4.test(value.mandateId) ||
        typeof value.mandateDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
        typeof value.changeId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
        typeof value.externalAuditRoot !== 'string' ||
        !path.isAbsolute(value.externalAuditRoot) ||
        path.normalize(value.externalAuditRoot) !== value.externalAuditRoot ||
        value.externalAuditRoot.length > 4_096) {
        throw invalid('Task Mandate binding is malformed.');
    }
    return structuredClone(value);
}
function assertExecutionBudgetGrantAuditContext(value) {
    if (!isRecord(value) ||
        typeof value.repositoryRoot !== 'string' ||
        !path.isAbsolute(value.repositoryRoot) ||
        path.normalize(value.repositoryRoot) !== value.repositoryRoot ||
        typeof value.repositoryIdentity !== 'string' ||
        value.repositoryIdentity.length < 1 ||
        (value.serviceHooks !== undefined && !isRecord(value.serviceHooks)) ||
        (value.actor !== undefined &&
            (!isRecord(value.actor) ||
                !hasExactKeys(value.actor, ['kind', 'identity']) ||
                !['agent', 'engine', 'human'].includes(String(value.actor.kind)) ||
                typeof value.actor.identity !== 'string' ||
                !IDENTITY.test(value.actor.identity))) ||
        (value.onRecord !== undefined && typeof value.onRecord !== 'function')) {
        throw workflowError('EXECUTION_BUDGET_GRANT_AUDIT_REQUIRED', 'Execution-budget authority requires an exact repository audit context.', ExitCode.guard);
    }
    return value;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function invalidGrantRequest(message) {
    return workflowError('EXECUTION_GRANT_REQUEST_INVALID', message, ExitCode.usage);
}
function invalidGrant(message) {
    return workflowError('EXECUTION_BUDGET_GRANT_INVALID', message, ExitCode.usage);
}
function unsupportedSchemaVersion(schemaVersion) {
    return workflowError('UNSUPPORTED_SCHEMA_VERSION', `Execution-budget grant record schema version ${schemaVersion} is unsupported; only schema version 3 is current.`, ExitCode.guard, { details: { schemaVersion, supportedSchemaVersion: 3 } });
}
function unsafeGrantStore() {
    return workflowError('EXECUTION_BUDGET_GRANT_STORE_UNSAFE', 'Execution-budget grant store is missing, malformed, or unsafe.', ExitCode.staleState);
}
function invalidDurableContext(message) {
    return workflowError('EXECUTION_CONTEXT_INVALID', message, ExitCode.usage);
}
function unsafeDurableGovernanceStore() {
    return workflowError('EXECUTION_GOVERNANCE_STORE_UNSAFE', 'Durable execution-governance state is missing, malformed, or unsafe.', ExitCode.staleState);
}
