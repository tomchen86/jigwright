/** Read sidecar metadata and append authorized abandonment without altering historical evidence. */
import fs from 'node:fs';
import { parseBootstrapSidecarWorkflow, sidecarProjectionConflict, appendBootstrapSidecarEvent, transitionBootstrapMaintenanceWorkflow, createBootstrapMaintenanceWorkflow, sidecarMatchesIntervention, } from "./intervention-sidecar-records.js";
import { readCanonicalRecord, createPrivateFileExclusive, replacePrivateFileAtomic, } from "./intervention-persistence-files.js";
import { persistedBootstrapSidecarSessionPath } from "./intervention-persistence-paths.js";
import { assertDigest, exactIso, canonicalDigest, withRecordDigest, serializeRecord, } from "./intervention-persistence-values.js";
import { withPersistenceOperation } from "./intervention-persistence-locks.js";
export function readPersistedBootstrapSidecarWorkflow(storageRoot, parentChangeId) {
    return parseBootstrapSidecarWorkflow(readCanonicalRecord(persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId), 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND'), parentChangeId);
}
export function recordBootstrapSidecarAbandoned(storageRoot, input) {
    assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(input.abandonedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (!fs.existsSync(persistedBootstrapSidecarSessionPath(storageRoot, input.parentChangeId))) {
        createMissingBootstrapSidecar(storageRoot, input.intervention);
    }
    return updateBootstrapSidecarSession(storageRoot, input.parentChangeId, (current) => {
        if (!sidecarMatchesIntervention(current, input.intervention)) {
            throw sidecarProjectionConflict('Sidecar identity differs from the intervention being abandoned.');
        }
        if (current.state === 'abandoned')
            return current;
        return appendBootstrapSidecarEvent(current, {
            state: 'abandoned',
            workflowBinding: transitionBootstrapMaintenanceWorkflow(current.workflowBinding, 'abandoned'),
            parentUnblock: {
                kind: 'sidecar-unblocks-parent.v1',
                parentChangeId: current.identity.parentChangeId,
                state: 'unblocked',
                resolution: 'abandonment',
                resolvedByTxId: null,
                resolvedAt: input.abandonedAt,
            },
        }, {
            eventKind: 'intervention-abandoned',
            evidenceDigest: input.evidenceDigest,
            recordedAt: input.abandonedAt,
        });
    });
}
function createMissingBootstrapSidecar(storageRoot, intervention) {
    const target = persistedBootstrapSidecarSessionPath(storageRoot, intervention.parent.changeId);
    const identity = {
        parentChangeId: intervention.parent.changeId,
        interventionChangeId: intervention.relationship.interventionChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
    };
    const createdAt = intervention.createdAt;
    const workflowBinding = createBootstrapMaintenanceWorkflow(intervention, 'repair-active');
    const payload = {
        kind: 'bootstrap-sidecar-session.v2',
        sidecarSessionId: canonicalDigest({
            kind: 'bootstrap-sidecar-session-identity.v2',
            ...identity,
            workflowId: workflowBinding.workflowId,
        }),
        identity,
        workflowBinding,
        state: 'repair-active',
        parentUnblock: {
            kind: 'sidecar-unblocks-parent.v1',
            parentChangeId: intervention.parent.changeId,
            state: 'blocking',
            resolution: null,
            resolvedByTxId: null,
            resolvedAt: null,
        },
        workspace: {
            childWorkspacePath: intervention.childWorkspace.childWorkspacePath,
            changeRef: intervention.childWorkspace.changeRef,
            state: 'planned',
            receiptDigest: null,
            materializedAt: null,
        },
        artifacts: [],
        adoption: null,
        promotion: null,
        history: [
            {
                sequence: 1,
                eventKind: 'sidecar-created',
                evidenceDigest: intervention.recordDigest,
                recordedAt: createdAt,
            },
        ],
        createdAt,
        updatedAt: createdAt,
    };
    const record = withRecordDigest(payload);
    createPrivateFileExclusive(target, serializeRecord(record));
    return record;
}
function updateBootstrapSidecarSession(storageRoot, parentChangeId, update) {
    return withPersistenceOperation(storageRoot, `sidecar-session:${parentChangeId}`, () => {
        const current = readPersistedBootstrapSidecarWorkflow(storageRoot, parentChangeId);
        const next = update(current);
        if (next.recordDigest === current.recordDigest)
            return current;
        parseBootstrapSidecarWorkflow(next, parentChangeId);
        replacePrivateFileAtomic(persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId), serializeRecord(next));
        return next;
    });
}
