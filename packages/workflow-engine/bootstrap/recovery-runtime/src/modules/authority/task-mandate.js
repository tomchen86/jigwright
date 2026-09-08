import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveAuthorityAuditRepositoryId, scanAuthorityAuditLedger, } from "../../runtime/storage-journal/authority-audit-ledger.js";
import { recordAuthorityAuditEvent, } from "../../runtime/storage-journal/authority-audit-service.js";
import { authorityRefusalDigest, withAuthorityRefusalAudit, } from "./authority-refusal-audit.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { ensurePlainDirectory } from "../../runtime/repository-transaction/filesystem-safety.js";
import { discoverRepository, isPostApprovalAdmissionFailure, runGit, } from "../../runtime/repository-transaction/git.js";
import { parseMaintainerPolicy } from "./maintainer-policy.js";
import { createInteractiveSshSigner, } from "../../adapters/signing/ssh/maintainer-signer.js";
import { assertChangeId } from "../../runtime/session-workspace/paths.js";
import { runtimePaths, withRepositoryLifecycleOperation, } from "../../runtime/session-workspace/session-store.js";
import { createTaskMandateProviderLifecycle } from "./task-mandate-provider-lifecycle.js";
function boundTaskMandateProviderLifecycle() {
    return createTaskMandateProviderLifecycle({
        assertTaskMandateBinding,
        assertProviderReservationId,
        discoverRepository,
        taskMandateStorePaths,
        withRepositoryLifecycleOperation,
        readTaskRecord,
        validateTaskMandateEnvelopeForRepository,
        exactDate,
        assertRecordActive,
        assertExactTaskMandateBinding,
        appendTaskMandateAuthorizationAudit,
        assertProviderInvocationAuditInput,
        findTaskMandateProviderReservation,
        appendTaskMandateProviderInvocationAudit,
        assertProviderReservationOperation,
        taskMandateProviderOperationDigest,
        appendTaskMandateProviderReservationAudit,
        authorizeProviderCall,
        replacePrivateFileAtomic,
        taskRecordPath,
        canonicalTaskMandateRecord,
        unsafeStore,
    });
}
import { createTaskMandateRecords } from "./task-mandate-records.js";
function boundTaskMandateRecords() {
    return createTaskMandateRecords({
        hasExactKeys,
        mandateInvalid,
        assertChangeId,
        assertTaskMandateTaskId,
        assertIntent,
        parseProviderDeclarations,
        assertSignature,
        PAYLOAD_KEYS,
        isWorkflowFailure,
        TASK_MANDATE_INACTIVITY_DAYS,
        MANDATE_ID,
        TASK_ID,
        assertExternalAuditRootPath,
        COMMIT_OID,
        exactTimestamp,
        isSortedUniqueProviderReservations,
        unsafeStore,
    });
}
import { createTaskMandatePolicy } from "./task-mandate-policy.js";
function boundTaskMandatePolicy() {
    return createTaskMandatePolicy({
        mandateInvalid,
        hasExactKeys,
        DATA_TYPES,
        TASK_ID,
        canonicalTaskMandateEnvelope,
        assertMandateId,
        assertChangeId,
        assertExternalAuditRootPath,
        PROVIDER_RESERVATION_ID,
        unsafeStore,
        exactTimestamp,
    });
}
import { createTaskMandateAudit } from "./task-mandate-audit.js";
function boundTaskMandateAudit() {
    return createTaskMandateAudit({
        deriveAuthorityAuditRepositoryId,
        taskMandateBinding,
        recordAuthorityAuditEvent,
        unsafeStore,
    });
}
import { createTaskMandateStore } from "./task-mandate-store.js";
function boundTaskMandateStore() {
    return createTaskMandateStore({
        runtimePaths,
        ensurePlainDirectory,
        parseCurrentTaskMandateRecord,
        assertTaskMandateTaskId,
        assertMandateId,
        unsafeStore,
    });
}
export const TASK_MANDATE_SIGNATURE_NAMESPACE_V2 = 'HARNESS_TASK_MANDATE_V2';
export const TASK_MANDATE_INACTIVITY_DAYS = 14;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIGNATURE = /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;
const DATA_TYPES = [
    'diff',
    'repository-metadata',
    'source-code',
    'task-intent',
    'test-output',
];
const PAYLOAD_KEYS = [
    'kind',
    'mandateId',
    'changeId',
    'taskId',
    'repositoryId',
    'repositoryOrigin',
    'externalAuditRoot',
    'policyBlob',
    'baseCommit',
    'intent',
    'preparation',
    'authoritativeEffects',
    'controlPlaneMutation',
    'secretScopes',
    'validUntil',
    'auditRequired',
    'issuedAt',
    'signer',
];
export function parseTaskMandateRequest(value) {
    return boundTaskMandateRecords().parseTaskMandateRequest(value);
}
export function authorizeTaskMandate(cwd, requested, options = {}) {
    const request = parseTaskMandateRequest(requested);
    const context = loadTrustContext(cwd);
    const externalAuditRoot = assertExternalAuditRoot(options.externalAuditRoot);
    scanAuthorityAuditLedger({
        externalAuditRoot,
        repositoryRoot: context.repository.repositoryRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(context.policy.repository.id),
    });
    const now = exactDate(options.now ?? new Date());
    const mandateId = assertMandateId(options.mandateId ?? crypto.randomUUID());
    const paths = taskMandateStorePaths(context.repository.gitCommonDirectory);
    const existingActive = taskRecordPath(paths.active, request.taskId);
    const existingTerminal = taskRecordPath(paths.terminal, request.taskId);
    if (fs.existsSync(existingActive)) {
        throw workflowError('TASK_MANDATE_EXISTS', `Task ${request.taskId} already has an active mandate.`, ExitCode.conflict);
    }
    if (fs.existsSync(existingTerminal)) {
        const terminal = parseCurrentTaskMandateRecord(readPrivateFile(existingTerminal));
        validateTaskMandateEnvelopeForRepository(context.repository.repositoryRoot, terminal.envelope, options.signer);
    }
    const signer = options.signer ??
        createInteractiveSshSigner(context.repository.repositoryRoot, context.policy);
    signer.assertHumanPresent();
    const identity = signer.identity();
    if (!context.policy.trustedSigners.some(({ identity: id }) => id === identity)) {
        throw workflowError('TASK_MANDATE_SIGNER_UNTRUSTED', 'Task mandate signer is not trusted by the exact base policy.', ExitCode.verification);
    }
    const payload = {
        kind: 'task-mandate.v2',
        mandateId,
        changeId: request.changeId,
        taskId: request.taskId,
        repositoryId: context.policy.repository.id,
        repositoryOrigin: context.policy.repository.origin,
        externalAuditRoot,
        policyBlob: context.policyBlob,
        baseCommit: context.repository.head,
        intent: request.intent,
        preparation: {
            repositoryRead: true,
            isolatedRepositoryWrites: true,
            addDeleteRenameFiles: true,
            localCommands: true,
            draftCommits: true,
            candidateAndDesignArtifacts: true,
            providerCalls: cloneProviderDeclarations(request.providerCalls),
            readOnlyConnectors: true,
        },
        authoritativeEffects: false,
        controlPlaneMutation: false,
        secretScopes: [],
        validUntil: {
            taskClosed: true,
            humanRevokes: true,
            repositoryIdentityChanges: true,
            intentReplaced: true,
            inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
        },
        auditRequired: true,
        issuedAt: now.toISOString(),
        signer: identity,
    };
    validateTaskMandatePayload(payload);
    let signature;
    try {
        signature = signer.sign(canonicalTaskMandatePayload(payload), TASK_MANDATE_SIGNATURE_NAMESPACE_V2);
        assertSignature(signature);
        signer.verify(canonicalTaskMandatePayload(payload), signature, identity, TASK_MANDATE_SIGNATURE_NAMESPACE_V2);
    }
    catch (error) {
        if (isWorkflowFailure(error))
            throw error;
        throw workflowError('TASK_MANDATE_SIGNATURE_INVALID', 'Task mandate signature could not be created or verified.', ExitCode.verification);
    }
    const envelope = { payload, signature };
    const record = {
        schemaVersion: 2,
        state: 'active',
        mandateId,
        changeId: request.changeId,
        externalAuditRoot,
        taskId: request.taskId,
        lastActivityAt: now.toISOString(),
        providerUsage: Object.fromEntries(Object.keys(request.providerCalls).map((providerId) => [
            providerId,
            { invocations: 0, budget: 0, reservations: [] },
        ])),
        revokedAt: null,
        revocationReason: null,
        envelope,
    };
    const recordPath = withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        ensureStore(paths);
        assertOwned();
        const active = taskRecordPath(paths.active, request.taskId);
        const terminal = taskRecordPath(paths.terminal, request.taskId);
        if (fs.existsSync(active)) {
            throw workflowError('TASK_MANDATE_EXISTS', `Task ${request.taskId} already has an active mandate.`, ExitCode.conflict);
        }
        if (fs.existsSync(terminal)) {
            const previous = parseCurrentTaskMandateRecord(readPrivateFile(terminal));
            const history = taskHistoryPath(paths.history, request.taskId, previous.mandateId);
            if (fs.existsSync(history))
                throw unsafeStore();
            fs.renameSync(terminal, history);
            fsyncDirectory(paths.terminal);
            fsyncDirectory(paths.history);
        }
        createPrivateFileAtomic(active, canonicalTaskMandateRecord(record));
        assertOwned();
        return active;
    });
    const audit = appendTaskMandateAuthorizationAudit(context.repository.repositoryRoot, record, exactDate(options.now ?? new Date()));
    return { mandateId, recordPath, envelope, audit };
}
export function inspectTaskMandate(cwd, requestedTaskId, options = {}) {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(repository.repositoryRoot, record.envelope, options.signer);
    return inspectRecord(record, exactDate(options.now ?? new Date()));
}
export function inspectActiveTaskMandateBinding(cwd, requestedTaskId, options = {}) {
    return withActiveTaskMandateBinding(cwd, requestedTaskId, options, (binding) => binding);
}
export function withActiveTaskMandateBinding(cwd, requestedTaskId, options, operation) {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        const record = readTaskRecord(paths, taskId);
        validateTaskMandateEnvelopeForRepository(repository.repositoryRoot, record.envelope, options.signer);
        const auditNow = exactDate(options.now ?? new Date());
        assertRecordActive(record, auditNow);
        appendTaskMandateAuthorizationAudit(repository.repositoryRoot, record, auditNow);
        assertOwned();
        return operation(taskMandateBinding(record), assertOwned);
    });
}
export function authorizeTaskMandateOperation(cwd, requestedTaskId, operation, options) {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const changeId = assertChangeId(options.changeId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        const record = readTaskRecord(paths, taskId);
        validateTaskMandateEnvelopeForRepository(repository.repositoryRoot, record.envelope, options.signer);
        const now = exactDate(options.now ?? new Date());
        const refusalBinding = taskMandateRefusalBinding(repository.repositoryRoot, record, 'task-mandate.operation', {
            changeId,
            operationKind: operation.kind,
        });
        return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
            assertRecordActive(record, now);
            assertTaskMandateChange(record, changeId);
            appendTaskMandateAuthorizationAudit(repository.repositoryRoot, record, now);
            assertOwned();
            if (!isPreparationOperation(operation.kind)) {
                throw workflowError('TASK_MANDATE_EFFECT_NOT_AUTHORIZED', `Task mandate does not authorize ${operation.kind}.`, ExitCode.guard);
            }
            record.lastActivityAt = now.toISOString();
            replacePrivateFileAtomic(taskRecordPath(paths.active, taskId), canonicalTaskMandateRecord(record));
            assertOwned();
            return {
                authorized: true,
                mandateId: record.mandateId,
                taskId,
                binding: taskMandateBinding(record),
            };
        });
    });
}
export function authorizeTaskMandateProviderReservation(cwd, binding, requestedReservationId, operation, options = {}) {
    return boundTaskMandateProviderLifecycle().authorizeTaskMandateProviderReservation(cwd, binding, requestedReservationId, operation, options);
}
export function authorizeTaskMandateProviderReservationUnderLifecycleLock(cwd, binding, requestedReservationId, operation, assertOwned, options = {}) {
    return boundTaskMandateProviderLifecycle().authorizeTaskMandateProviderReservationUnderLifecycleLock(cwd, binding, requestedReservationId, operation, assertOwned, options);
}
export function assertActiveTaskMandateBindingUnderLifecycleLock(cwd, binding, assertOwned, options = {}) {
    return boundTaskMandateProviderLifecycle().assertActiveTaskMandateBindingUnderLifecycleLock(cwd, binding, assertOwned, options);
}
export function recordTaskMandateProviderInvocation(cwd, binding, input, options = {}) {
    return boundTaskMandateProviderLifecycle().recordTaskMandateProviderInvocation(cwd, binding, input, options);
}
export function recordTaskMandateProviderInvocationUnderLifecycleLock(cwd, binding, input, assertOwned, options = {}) {
    return boundTaskMandateProviderLifecycle().recordTaskMandateProviderInvocationUnderLifecycleLock(cwd, binding, input, assertOwned, options);
}
export function revokeTaskMandate(cwd, requestedTaskId, options) {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const reason = assertRevocationReason(options.reason);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        ensureStore(paths);
        const terminalPath = taskRecordPath(paths.terminal, taskId);
        if (fs.existsSync(terminalPath)) {
            const terminal = parseCurrentTaskMandateRecord(readPrivateFile(terminalPath));
            validateTaskMandateEnvelopeForRepository(repository.repositoryRoot, terminal.envelope, options.signer);
            if (terminal.schemaVersion === 2) {
                appendTaskMandateAuthorizationAudit(repository.repositoryRoot, terminal, exactDate(options.now ?? new Date()));
                appendTaskMandateRevocationAudit(repository.repositoryRoot, terminal, exactDate(options.now ?? new Date()));
            }
            return inspectRecord(terminal, exactDate(options.now ?? new Date()));
        }
        const record = readTaskRecord(paths, taskId);
        validateTaskMandateEnvelopeForRepository(repository.repositoryRoot, record.envelope, options.signer);
        const now = exactDate(options.now ?? new Date());
        const refusalBinding = taskMandateRefusalBinding(repository.repositoryRoot, record, 'task-mandate.revoke', { reasonDigest: authorityRefusalDigest(reason) });
        return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
            appendTaskMandateAuthorizationAudit(repository.repositoryRoot, record, now);
            const signer = options.signer ?? currentSigner(repository.repositoryRoot);
            signer.assertHumanPresent();
            const currentPolicy = loadPolicyAt(repository.repositoryRoot, repository.head).policy;
            if (!currentPolicy.trustedSigners.some(({ identity }) => identity === signer.identity())) {
                throw workflowError('TASK_MANDATE_SIGNER_UNTRUSTED', 'Task mandate revocation requires a currently trusted signer.', ExitCode.verification);
            }
            record.state = 'revoked';
            record.revokedAt = now.toISOString();
            record.revocationReason = reason;
            assertOwned();
            const activePath = taskRecordPath(paths.active, taskId);
            fs.renameSync(activePath, terminalPath);
            replacePrivateFileAtomic(terminalPath, canonicalTaskMandateRecord(record));
            assertOwned();
            appendTaskMandateRevocationAudit(repository.repositoryRoot, record, now);
            assertOwned();
            return inspectRecord(record, now);
        });
    });
}
export function canonicalTaskMandatePayload(payload) {
    return boundTaskMandateRecords().canonicalTaskMandatePayload(payload);
}
export function canonicalTaskMandateEnvelope(envelope) {
    return boundTaskMandateRecords().canonicalTaskMandateEnvelope(envelope);
}
export function parseTaskMandateEnvelope(raw) {
    return boundTaskMandateRecords().parseTaskMandateEnvelope(raw);
}
function validateTaskMandatePayload(payload) {
    return boundTaskMandateRecords().validateTaskMandatePayload(payload);
}
function validateTaskMandateEnvelopeForRepository(repositoryRoot, envelope, providedSigner) {
    const payload = envelope.payload;
    const base = loadPolicyAt(repositoryRoot, payload.baseCommit);
    const currentHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const current = loadPolicyAt(repositoryRoot, currentHead);
    const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
    if (base.policyBlob !== payload.policyBlob ||
        base.policy.repository.id !== payload.repositoryId ||
        base.policy.repository.origin !== payload.repositoryOrigin ||
        current.policy.repository.id !== payload.repositoryId ||
        current.policy.repository.origin !== payload.repositoryOrigin ||
        origin !== payload.repositoryOrigin ||
        !base.policy.trustedSigners.some(({ identity }) => identity === payload.signer)) {
        throw workflowError('TASK_MANDATE_REPOSITORY_MISMATCH', 'Task mandate no longer matches this repository identity or trust base.', ExitCode.staleState);
    }
    scanAuthorityAuditLedger(taskMandateAuditScope(repositoryRoot, payload));
    const signer = providedSigner ?? createInteractiveSshSigner(repositoryRoot, base.policy);
    try {
        signer.verify(canonicalTaskMandatePayload(payload), envelope.signature, payload.signer, TASK_MANDATE_SIGNATURE_NAMESPACE_V2);
    }
    catch (error) {
        if (isPostApprovalAdmissionFailure(error))
            throw error;
        throw workflowError('TASK_MANDATE_SIGNATURE_INVALID', 'Task mandate signature is invalid for its dedicated domain.', ExitCode.verification);
    }
}
function authorizeProviderCall(record, operation, reservationId, authorizedAt, operationDigest) {
    return boundTaskMandatePolicy().authorizeProviderCall(record, operation, reservationId, authorizedAt, operationDigest);
}
function isPreparationOperation(kind) {
    return boundTaskMandatePolicy().isPreparationOperation(kind);
}
function parseProviderDeclarations(value) {
    return boundTaskMandatePolicy().parseProviderDeclarations(value);
}
function cloneProviderDeclarations(declarations) {
    return boundTaskMandatePolicy().cloneProviderDeclarations(declarations);
}
function inspectRecord(record, now) {
    assertRecordClock(record, now);
    const state = record.state === 'revoked'
        ? 'revoked'
        : isInactive(record, now)
            ? 'expired'
            : 'active';
    return {
        mandateId: record.mandateId,
        changeId: record.changeId,
        externalAuditRoot: record.externalAuditRoot,
        taskId: record.taskId,
        state,
        intent: record.envelope.payload.intent,
        baseCommit: record.envelope.payload.baseCommit,
        signer: record.envelope.payload.signer,
        issuedAt: record.envelope.payload.issuedAt,
        lastActivityAt: record.lastActivityAt,
        providerUsage: Object.fromEntries(Object.entries(record.providerUsage).map(([providerId, usage]) => [
            providerId,
            { invocations: usage.invocations, budget: usage.budget },
        ])),
        inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
        ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
        ...(record.revocationReason
            ? { revocationReason: record.revocationReason }
            : {}),
    };
}
function assertRecordActive(record, now) {
    assertRecordClock(record, now);
    if (record.state === 'revoked') {
        throw workflowError('TASK_MANDATE_REVOKED', 'Task mandate has been revoked.', ExitCode.staleState);
    }
    if (isInactive(record, now)) {
        throw workflowError('TASK_MANDATE_EXPIRED', 'Task mandate expired after fourteen days without activity.', ExitCode.staleState);
    }
}
function assertRecordClock(record, now) {
    const lastActivity = exactTimestamp(record.lastActivityAt);
    if (lastActivity === undefined || lastActivity > now.getTime() + 30_000) {
        throw unsafeStore();
    }
}
function isInactive(record, now) {
    const lastActivity = exactTimestamp(record.lastActivityAt);
    if (lastActivity === undefined)
        throw unsafeStore();
    return (now.getTime() - lastActivity >=
        TASK_MANDATE_INACTIVITY_DAYS * 24 * 60 * 60_000);
}
function taskMandateStorePaths(gitCommonDirectory) {
    return boundTaskMandateStore().taskMandateStorePaths(gitCommonDirectory);
}
function ensureStore(paths) {
    return boundTaskMandateStore().ensureStore(paths);
}
function readTaskRecord(paths, taskId) {
    return boundTaskMandateStore().readTaskRecord(paths, taskId);
}
function canonicalTaskMandateRecord(record) {
    return boundTaskMandateRecords().canonicalTaskMandateRecord(record);
}
function parseCurrentTaskMandateRecord(raw) {
    return boundTaskMandateRecords().parseCurrentTaskMandateRecord(raw);
}
function taskMandateAuditScope(repositoryRoot, payload) {
    return boundTaskMandateAudit().taskMandateAuditScope(repositoryRoot, payload);
}
function taskMandateRefusalBinding(repositoryRoot, record, operation, refusalIdentity) {
    return boundTaskMandateAudit().taskMandateRefusalBinding(repositoryRoot, record, operation, refusalIdentity);
}
function appendTaskMandateAuthorizationAudit(repositoryRoot, record, now) {
    return boundTaskMandateAudit().appendTaskMandateAuthorizationAudit(repositoryRoot, record, now);
}
function appendTaskMandateRevocationAudit(repositoryRoot, record, now) {
    return boundTaskMandateAudit().appendTaskMandateRevocationAudit(repositoryRoot, record, now);
}
function appendTaskMandateProviderReservationAudit(repositoryRoot, record, providerId, reservation) {
    return boundTaskMandateAudit().appendTaskMandateProviderReservationAudit(repositoryRoot, record, providerId, reservation);
}
function appendTaskMandateProviderInvocationAudit(repositoryRoot, record, input) {
    return boundTaskMandateAudit().appendTaskMandateProviderInvocationAudit(repositoryRoot, record, input);
}
function loadTrustContext(cwd) {
    const repository = discoverRepository(cwd);
    const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
    const origin = runGit(repository.repositoryRoot, [
        'remote',
        'get-url',
        'origin',
    ]).trim();
    if (origin !== loaded.policy.repository.origin) {
        throw workflowError('TASK_MANDATE_REPOSITORY_MISMATCH', 'Repository origin differs from its trusted task mandate policy.', ExitCode.guard);
    }
    return { repository, ...loaded };
}
function loadPolicyAt(repositoryRoot, commit) {
    try {
        const content = runGit(repositoryRoot, [
            'show',
            `${commit}:workflow/maintainer-policy.json`,
        ]);
        return {
            policy: parseMaintainerPolicy(JSON.parse(content)),
            policyBlob: runGit(repositoryRoot, [
                'rev-parse',
                `${commit}:workflow/maintainer-policy.json`,
            ]).trim(),
        };
    }
    catch (error) {
        if (isWorkflowFailure(error))
            throw error;
        throw workflowError('TASK_MANDATE_POLICY_INVALID', 'Task mandate trust-base policy is unavailable or invalid.', ExitCode.guard);
    }
}
function currentSigner(repositoryRoot) {
    const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    return createInteractiveSshSigner(repositoryRoot, loadPolicyAt(repositoryRoot, head).policy);
}
function taskRecordPath(directory, taskId) {
    return boundTaskMandateStore().taskRecordPath(directory, taskId);
}
function taskHistoryPath(directory, taskId, mandateId) {
    return boundTaskMandateStore().taskHistoryPath(directory, taskId, mandateId);
}
function createPrivateFileAtomic(filePath, content) {
    return boundTaskMandateStore().createPrivateFileAtomic(filePath, content);
}
function replacePrivateFileAtomic(filePath, content) {
    return boundTaskMandateStore().replacePrivateFileAtomic(filePath, content);
}
function readPrivateFile(filePath) {
    return boundTaskMandateStore().readPrivateFile(filePath);
}
function fsyncDirectory(directory) {
    return boundTaskMandateStore().fsyncDirectory(directory);
}
function assertTaskMandateTaskId(value) {
    return boundTaskMandatePolicy().assertTaskMandateTaskId(value);
}
function taskMandateBinding(record) {
    return boundTaskMandatePolicy().taskMandateBinding(record);
}
function assertTaskMandateBinding(value) {
    return boundTaskMandatePolicy().assertTaskMandateBinding(value);
}
function assertTaskMandateChange(record, changeId) {
    return boundTaskMandatePolicy().assertTaskMandateChange(record, changeId);
}
function assertExactTaskMandateBinding(record, binding) {
    return boundTaskMandatePolicy().assertExactTaskMandateBinding(record, binding);
}
function assertProviderReservationId(value) {
    return boundTaskMandatePolicy().assertProviderReservationId(value);
}
function assertProviderReservationOperation(value) {
    return boundTaskMandatePolicy().assertProviderReservationOperation(value);
}
function taskMandateProviderOperationDigest(operation) {
    return boundTaskMandatePolicy().taskMandateProviderOperationDigest(operation);
}
function findTaskMandateProviderReservation(record, reservationId) {
    return boundTaskMandatePolicy().findTaskMandateProviderReservation(record, reservationId);
}
function assertProviderInvocationAuditInput(value) {
    return boundTaskMandatePolicy().assertProviderInvocationAuditInput(value);
}
function isSortedUniqueProviderReservations(value) {
    return boundTaskMandatePolicy().isSortedUniqueProviderReservations(value);
}
function assertExternalAuditRoot(value) {
    if (value === undefined) {
        throw workflowError('TASK_MANDATE_AUDIT_ROOT_REQUIRED', 'Task Mandate authorization requires an explicit repository-external audit root.', ExitCode.unsafeEnvironment);
    }
    return assertExternalAuditRootPath(value);
}
function assertExternalAuditRootPath(value) {
    if (value.length === 0 ||
        Buffer.byteLength(value) > 4096 ||
        value.includes('\0') ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value) {
        throw mandateInvalid('Task mandate external audit root must be an exact absolute path.');
    }
    return value;
}
function assertMandateId(value) {
    if (!MANDATE_ID.test(value)) {
        throw mandateInvalid('Task mandate ID must be a UUID v4.');
    }
    return value;
}
function assertIntent(value) {
    if (value.trim() !== value ||
        value.length === 0 ||
        value.length > 4096 ||
        containsControlCharacter(value)) {
        throw mandateInvalid('Task mandate intent is invalid.');
    }
    return value;
}
function assertRevocationReason(value) {
    if (value.trim() !== value ||
        value.length === 0 ||
        value.length > 1024 ||
        containsControlCharacter(value)) {
        throw mandateInvalid('Task mandate revocation reason is invalid.');
    }
    return value;
}
function assertSignature(value) {
    if (!SIGNATURE.test(value)) {
        throw workflowError('TASK_MANDATE_SIGNATURE_INVALID', 'Task mandate signature is not canonical armored SSH signature data.', ExitCode.verification);
    }
}
function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw mandateInvalid('Task mandate timestamp is invalid.');
    }
    return date;
}
function exactTimestamp(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value
        ? date.getTime()
        : undefined;
}
function containsControlCharacter(value) {
    return [...value].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 31 || point === 127;
    });
}
function hasExactKeys(value, keys) {
    return (JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...keys].sort()));
}
function isWorkflowFailure(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string');
}
function mandateInvalid(message) {
    return workflowError('TASK_MANDATE_INVALID', message, ExitCode.guard);
}
function unsafeStore() {
    return workflowError('TASK_MANDATE_STORE_UNSAFE', 'Task mandate storage is malformed or unsafe.', ExitCode.unsafeEnvironment);
}
