/**
 * Prepare, finalize, and recover one exact provider supersession relation transaction.
 *
 * Invariants:
 * - Predecessor and successor binding checks, durable relation writes, and crash phases stay ordered.
 * - Recovery remains with the prepare and finalize transaction that it completes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { projectProviderInvocationExecution } from "../../modules/provider-orchestration/execution-core.js";
import { WorkflowError, ExitCode } from "../../foundation/errors/errors.js";
import { withPrivateRuntimeLock, privatePathExists, readPrivateCanonicalJson, createPrivateCanonicalJson, assertPrivateInvestigationDirectory, } from "../storage-journal/investigation-private-files.js";
import { assertInvocationId, } from "../session-workspace/paths.js";
import { providerInvocationSupersessionUnsafe, providerInvocationSupersessionTransactionPath, assertProviderInvocationSupersessionTransaction, providerInvocationSupersessionConflict, providerInvocationSupersessionTransactionPointerPath, createProviderInvocationSupersessionTransactionPointer, createProviderInvocationSupersessionEdge, createProviderInvocationSupersessionTransaction, providerInvocationSupersessionPaths, providerInvocationSupersessionReceiptPath, providerInvocationSupersessionEdgePath, providerInvocationSupersessionPredecessorIndexPath, createProviderInvocationSupersessionIndex, providerInvocationSupersessionSuccessorIndexPath, createProviderInvocationSupersessionReceipt, inspectProviderInvocationSupersessionRelations, } from "./provider-invocation-supersession-schema.js";
import { currentEvidenceSnapshot, assertSnapshotStableCurrent, } from "./provider-supersession-evidence.js";
import { isTimestamp, deepFreeze, isRecord, } from "./provider-supersession-values.js";
const MAX_SUPERSESSION_TRANSACTIONS = 4_096;
const TRANSACTION_FILE = /^[0-9a-f]{64}\.json$/;
export class SimulatedProviderInvocationSupersessionCrash extends WorkflowError {
    phase;
    constructor(phase) {
        super({
            code: 'PROVIDER_INVOCATION_SUPERSESSION_SIMULATED_CRASH',
            message: `Simulated provider invocation supersession crash after ${phase}.`,
            exitCode: ExitCode.internal,
        });
        this.phase = phase;
    }
}
export function prepareProviderInvocationSupersession(paths, input) {
    const successor = projectProviderInvocationExecution({
        record: input.successorRecord,
        request: input.successorRequest,
    });
    const predecessors = input.history
        .map((entry) => ({
        ...entry,
        projection: projectProviderInvocationExecution(entry),
    }))
        .filter(({ record, projection }) => record.attempt === input.successorRecord.attempt - 1 &&
        projection.job.jobId === successor.job.jobId);
    if (predecessors.length === 0)
        return null;
    if (predecessors.length !== 1)
        throw providerInvocationSupersessionUnsafe();
    const predecessor = predecessors[0];
    if (predecessor.record.state !== 'failed' ||
        predecessor.projection.attempt.failure === null) {
        // Adjacent Attempt numbers can also be concurrent race/hedge Attempts.
        // Only a terminal failed predecessor establishes replacement semantics.
        return null;
    }
    if (Date.parse(input.successorRecord.createdAt) <
        Date.parse(predecessor.record.updatedAt)) {
        // A later-numbered Attempt may have been reserved as a concurrent hedge.
        // It cannot truthfully replace a failure that had not happened yet.
        return null;
    }
    if (successor.attempt.attemptNumber !==
        predecessor.projection.attempt.attemptNumber + 1 ||
        successor.workflow.workflowId !==
            predecessor.projection.workflow.workflowId ||
        successor.job.epoch !== predecessor.projection.job.epoch ||
        successor.job.contextDigest !== predecessor.projection.job.contextDigest ||
        successor.job.requestDigest !== predecessor.projection.job.requestDigest) {
        throw providerInvocationSupersessionUnsafe();
    }
    const predecessorInvocationId = predecessor.record.invocationId;
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${predecessorInvocationId}.supersession.lock`), () => {
        const transactionPath = providerInvocationSupersessionTransactionPath(paths, predecessorInvocationId);
        if (privatePathExists(paths, transactionPath, providerInvocationSupersessionUnsafe)) {
            const existingTransaction = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, transactionPath, providerInvocationSupersessionUnsafe));
            if (existingTransaction.successorInvocationId !==
                input.successorRecord.invocationId) {
                throw providerInvocationSupersessionConflict();
            }
            createPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPointerPath(paths, input.successorRecord.invocationId), createProviderInvocationSupersessionTransactionPointer({
                schemaVersion: 1,
                kind: 'provider-invocation-supersession-transaction-pointer',
                predecessorInvocationId,
                successorInvocationId: input.successorRecord.invocationId,
                transactionDigest: existingTransaction.transactionDigest,
            }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
            return existingTransaction;
        }
        const existing = inspectRelations(paths, predecessorInvocationId);
        if (existing.supersededBy !== null) {
            if (existing.supersededBy.supersededBy.invocationId !==
                input.successorRecord.invocationId) {
                throw providerInvocationSupersessionConflict();
            }
            return readTransactionForSuccessor(paths, input.successorRecord.invocationId);
        }
        const replacementOf = currentEvidenceSnapshot(paths, predecessor.record, predecessor.request);
        if (replacementOf.terminalStatus !== 'failed') {
            throw providerInvocationSupersessionUnsafe();
        }
        const supersededBy = currentEvidenceSnapshot(paths, input.successorRecord, input.successorRequest);
        if (supersededBy.terminalStatus !== null) {
            throw providerInvocationSupersessionUnsafe();
        }
        const edge = createProviderInvocationSupersessionEdge({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-edge',
            workflowId: predecessor.projection.workflow.workflowId,
            jobId: predecessor.projection.job.jobId,
            epoch: predecessor.projection.job.epoch,
            contextDigest: predecessor.projection.job.contextDigest,
            replacementMode: input.replacementMode,
            previousEdgeDigest: existing.replacementOf?.edgeDigest ?? null,
            replacementOf,
            supersededBy,
            createdAt: input.successorRecord.createdAt,
        });
        const transaction = createProviderInvocationSupersessionTransaction({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-transaction',
            predecessorInvocationId,
            successorInvocationId: input.successorRecord.invocationId,
            edge,
            preparedAt: input.successorRecord.createdAt,
        });
        const pointer = createProviderInvocationSupersessionTransactionPointer({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-transaction-pointer',
            predecessorInvocationId,
            successorInvocationId: input.successorRecord.invocationId,
            transactionDigest: transaction.transactionDigest,
        });
        createPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPath(paths, predecessorInvocationId), transaction, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'transaction-written');
        createPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPointerPath(paths, input.successorRecord.invocationId), pointer, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'transaction-prepared');
        return readTransactionForSuccessor(paths, input.successorRecord.invocationId);
    }, 'PROVIDER_INVOCATION_SUPERSESSION_OPERATION_CONFLICT', providerInvocationSupersessionUnsafe);
}
/**
 * Resume a creation transaction before the ordinary lifecycle scan. A
 * half-published supersession intentionally makes both endpoints fail closed,
 * so retrying creation must use the bounded WAL lookup instead of asking the
 * scanner to treat that state as ordinary history.
 */
export function resumePreparedProviderInvocationSupersession(paths, successorRecord, successorRequest) {
    const successorInvocationId = assertInvocationId(successorRecord.invocationId);
    const pointerPath = providerInvocationSupersessionTransactionPointerPath(paths, successorInvocationId);
    if (privatePathExists(paths, pointerPath, providerInvocationSupersessionUnsafe)) {
        return assertPreparedSuccessorBinding(readTransactionForSuccessor(paths, successorInvocationId), successorRecord, successorRequest);
    }
    const transactionDirectory = providerInvocationSupersessionPaths(paths).transactionsByPredecessor;
    if (!fs.lstatSync(transactionDirectory, { throwIfNoEntry: false })) {
        return null;
    }
    assertPrivateInvestigationDirectory(paths, transactionDirectory, providerInvocationSupersessionUnsafe);
    const entries = fs
        .readdirSync(transactionDirectory, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (entries.length > MAX_SUPERSESSION_TRANSACTIONS) {
        throw providerInvocationSupersessionUnsafe();
    }
    let candidate = null;
    for (const entry of entries) {
        if (!entry.isFile() ||
            entry.isSymbolicLink() ||
            !TRANSACTION_FILE.test(entry.name)) {
            throw providerInvocationSupersessionUnsafe();
        }
        const transaction = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, path.join(transactionDirectory, entry.name), providerInvocationSupersessionUnsafe));
        if (transaction.successorInvocationId !== successorInvocationId)
            continue;
        if (candidate !== null)
            throw providerInvocationSupersessionConflict();
        candidate = transaction;
    }
    if (candidate === null)
        return null;
    const admitted = assertPreparedSuccessorBinding(candidate, successorRecord, successorRequest);
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${admitted.predecessorInvocationId}.supersession.lock`), () => {
        const durable = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPath(paths, admitted.predecessorInvocationId), providerInvocationSupersessionUnsafe));
        if (canonicalJson(durable) !== canonicalJson(admitted)) {
            throw providerInvocationSupersessionUnsafe();
        }
        createPrivateCanonicalJson(paths, pointerPath, createProviderInvocationSupersessionTransactionPointer({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-transaction-pointer',
            predecessorInvocationId: admitted.predecessorInvocationId,
            successorInvocationId,
            transactionDigest: admitted.transactionDigest,
        }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        return readTransactionForSuccessor(paths, successorInvocationId);
    }, 'PROVIDER_INVOCATION_SUPERSESSION_OPERATION_CONFLICT', providerInvocationSupersessionUnsafe);
}
function assertPreparedSuccessorBinding(transaction, successorRecord, successorRequest) {
    const admitted = assertProviderInvocationSupersessionTransaction(transaction);
    const snapshot = admitted.edge.supersededBy;
    if (admitted.successorInvocationId !== successorRecord.invocationId ||
        snapshot.invocationId !== successorRecord.invocationId ||
        snapshot.attempt !== successorRecord.attempt ||
        snapshot.requestDigest !== successorRecord.requestDigest ||
        snapshot.manifestDigest !== successorRecord.manifestDigest ||
        snapshot.subjectDigest !== successorRequest.targetDigest ||
        snapshot.createdAt !== admitted.edge.createdAt ||
        admitted.preparedAt !== admitted.edge.createdAt ||
        snapshot.promptDigest !== null ||
        snapshot.rawOutputDigest !== null ||
        snapshot.semanticOutputDigest !== null ||
        snapshot.terminalStatus !== null ||
        snapshot.terminalAt !== null ||
        snapshot.failureCode !== null ||
        snapshot.invocationRevision !== 0) {
        throw providerInvocationSupersessionUnsafe();
    }
    return admitted;
}
export function finalizeProviderInvocationSupersession(paths, transaction, readCore, input) {
    const admitted = assertProviderInvocationSupersessionTransaction(transaction);
    if (!isTimestamp(input.publishedAt)) {
        throw providerInvocationSupersessionUnsafe();
    }
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${admitted.predecessorInvocationId}.supersession.lock`), () => {
        const durable = readTransactionForSuccessor(paths, admitted.successorInvocationId);
        if (canonicalJson(durable) !== canonicalJson(admitted)) {
            throw providerInvocationSupersessionUnsafe();
        }
        const receiptPath = providerInvocationSupersessionReceiptPath(paths, admitted.transactionDigest);
        if (privatePathExists(paths, receiptPath, providerInvocationSupersessionUnsafe)) {
            const relations = inspectRelations(paths, admitted.successorInvocationId);
            if (relations.replacementOf?.edgeDigest !== admitted.edge.edgeDigest) {
                throw providerInvocationSupersessionUnsafe();
            }
            assertEdgeCurrent(paths, admitted.edge, readCore);
            return deepFreeze({ edge: admitted.edge, replayed: true });
        }
        assertEdgeCurrent(paths, admitted.edge, readCore);
        createPrivateCanonicalJson(paths, providerInvocationSupersessionEdgePath(paths, admitted.edge.edgeDigest), admitted.edge, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'edge-written');
        createPrivateCanonicalJson(paths, providerInvocationSupersessionPredecessorIndexPath(paths, admitted.predecessorInvocationId), createProviderInvocationSupersessionIndex({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-index',
            role: 'superseded-by',
            invocationId: admitted.predecessorInvocationId,
            peerInvocationId: admitted.successorInvocationId,
            edgeDigest: admitted.edge.edgeDigest,
            transactionDigest: admitted.transactionDigest,
        }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'predecessor-indexed');
        createPrivateCanonicalJson(paths, providerInvocationSupersessionSuccessorIndexPath(paths, admitted.successorInvocationId), createProviderInvocationSupersessionIndex({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-index',
            role: 'replacement-of',
            invocationId: admitted.successorInvocationId,
            peerInvocationId: admitted.predecessorInvocationId,
            edgeDigest: admitted.edge.edgeDigest,
            transactionDigest: admitted.transactionDigest,
        }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'successor-indexed');
        const receipt = createProviderInvocationSupersessionReceipt({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-receipt',
            predecessorInvocationId: admitted.predecessorInvocationId,
            successorInvocationId: admitted.successorInvocationId,
            edgeDigest: admitted.edge.edgeDigest,
            transactionDigest: admitted.transactionDigest,
            publishedAt: input.publishedAt,
        });
        createPrivateCanonicalJson(paths, receiptPath, receipt, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        inspectRelations(paths, admitted.predecessorInvocationId);
        inspectRelations(paths, admitted.successorInvocationId);
        return deepFreeze({ edge: admitted.edge, replayed: false });
    }, 'PROVIDER_INVOCATION_SUPERSESSION_OPERATION_CONFLICT', providerInvocationSupersessionUnsafe);
}
export function recoverProviderInvocationSupersessionTransaction(paths, requestedSuccessorInvocationId, readCore, input) {
    const successorInvocationId = assertInvocationId(requestedSuccessorInvocationId);
    return finalizeProviderInvocationSupersession(paths, readTransactionForSuccessor(paths, successorInvocationId), readCore, { publishedAt: input.recoveredAt });
}
export function readProviderInvocationEvidenceRecord(paths, record, request, readCore) {
    const relations = inspectRelations(paths, record.invocationId);
    assertRelationsCurrent(paths, record, request, relations, readCore);
    const fallback = relations.supersededBy?.replacementOf ??
        relations.replacementOf?.supersededBy;
    const invocation = currentEvidenceSnapshot(paths, record, request, fallback);
    return deepFreeze({
        invocation,
        replacementOf: relations.replacementOf === null
            ? null
            : {
                edgeDigest: relations.replacementOf.edgeDigest,
                replacementMode: relations.replacementOf.replacementMode,
                invocation: relations.replacementOf.replacementOf,
            },
        supersededBy: relations.supersededBy === null
            ? null
            : {
                edgeDigest: relations.supersededBy.edgeDigest,
                replacementMode: relations.supersededBy.replacementMode,
                invocation: relations.supersededBy.supersededBy,
            },
    });
}
export function assertProviderInvocationSupersessionEndpointCurrent(paths, record, request, readCore) {
    const relations = inspectRelations(paths, record.invocationId);
    assertRelationsCurrent(paths, record, request, relations, readCore);
}
function assertRelationsCurrent(paths, record, request, relations, readCore) {
    if (relations.supersededBy !== null &&
        relations.supersededBy.previousEdgeDigest !==
            (relations.replacementOf?.edgeDigest ?? null)) {
        throw providerInvocationSupersessionUnsafe();
    }
    if (relations.replacementOf !== null) {
        assertSnapshotStableCurrent(paths, relations.replacementOf.supersededBy, record, request, false);
        assertEdgeCurrent(paths, relations.replacementOf, readCore, record.invocationId);
    }
    if (relations.supersededBy !== null) {
        assertSnapshotStableCurrent(paths, relations.supersededBy.replacementOf, record, request, true);
        assertEdgeCurrent(paths, relations.supersededBy, readCore, record.invocationId);
    }
}
function assertEdgeCurrent(paths, edge, readCore, requiredInvocationId) {
    const readEndpoint = (invocationId) => {
        const exists = privatePathExists(paths, path.join(paths.invocations, invocationId, 'state.json'), providerInvocationSupersessionUnsafe);
        if (!exists) {
            if (requiredInvocationId === undefined ||
                requiredInvocationId === invocationId) {
                throw providerInvocationSupersessionUnsafe();
            }
            return null;
        }
        return readCore(invocationId);
    };
    const predecessor = readEndpoint(edge.replacementOf.invocationId);
    const successor = readEndpoint(edge.supersededBy.invocationId);
    const predecessorProjection = predecessor === null
        ? null
        : projectProviderInvocationExecution(predecessor);
    const successorProjection = successor === null ? null : projectProviderInvocationExecution(successor);
    if (predecessor !== null) {
        assertSnapshotStableCurrent(paths, edge.replacementOf, predecessor.record, predecessor.request, true);
    }
    if (successor !== null) {
        assertSnapshotStableCurrent(paths, edge.supersededBy, successor.record, successor.request, false);
    }
    if ((predecessorProjection !== null &&
        (predecessorProjection.workflow.workflowId !== edge.workflowId ||
            predecessorProjection.job.jobId !== edge.jobId ||
            predecessorProjection.job.epoch !== edge.epoch ||
            predecessorProjection.job.contextDigest !== edge.contextDigest)) ||
        (successorProjection !== null &&
            (successorProjection.workflow.workflowId !== edge.workflowId ||
                successorProjection.job.jobId !== edge.jobId ||
                successorProjection.job.epoch !== edge.epoch ||
                successorProjection.job.contextDigest !== edge.contextDigest)) ||
        (predecessorProjection !== null &&
            successorProjection !== null &&
            predecessorProjection.attempt.attemptNumber + 1 !==
                successorProjection.attempt.attemptNumber)) {
        throw providerInvocationSupersessionUnsafe();
    }
}
function readTransactionForSuccessor(paths, requestedSuccessorInvocationId) {
    const successorInvocationId = assertInvocationId(requestedSuccessorInvocationId);
    const pointerValue = readPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPointerPath(paths, successorInvocationId), providerInvocationSupersessionUnsafe);
    const pointer = inspectRelationsPointer(pointerValue, successorInvocationId);
    const transaction = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPath(paths, pointer.predecessorInvocationId), providerInvocationSupersessionUnsafe));
    if (transaction.transactionDigest !== pointer.transactionDigest ||
        transaction.successorInvocationId !== successorInvocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    return transaction;
}
function inspectRelationsPointer(value, successorInvocationId) {
    if (!isRecord(value) ||
        value.kind !== 'provider-invocation-supersession-transaction-pointer' ||
        value.successorInvocationId !== successorInvocationId ||
        typeof value.predecessorInvocationId !== 'string' ||
        typeof value.transactionDigest !== 'string') {
        throw providerInvocationSupersessionUnsafe();
    }
    return {
        predecessorInvocationId: assertInvocationId(value.predecessorInvocationId),
        transactionDigest: value.transactionDigest,
    };
}
function inspectRelations(paths, invocationId) {
    return inspectProviderInvocationSupersessionRelations(paths, invocationId, {
        exists: (filePath) => privatePathExists(paths, filePath, providerInvocationSupersessionUnsafe),
        read: (filePath) => readPrivateCanonicalJson(paths, filePath, providerInvocationSupersessionUnsafe),
    });
}
function simulateCrash(selected, phase) {
    if (selected === phase) {
        throw new SimulatedProviderInvocationSupersessionCrash(phase);
    }
}
