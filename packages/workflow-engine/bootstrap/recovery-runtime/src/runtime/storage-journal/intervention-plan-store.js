/** Read retained checkpoint-bound intervention and child workspace metadata. */
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { verifyWipCheckpoint, } from "../../modules/authority/intervention-control.js";
import { isRecord, hasExactKeys, verifyRecordDigest, corruptPersistenceRecord, exactIso, assertAbsoluteWorkspacePath, isPathInside, assertSafeChangeRef, canonicalDigest, assertDigest, } from "./intervention-persistence-values.js";
import { interventionRecordPath, interventionControlPersistencePaths, } from "./intervention-persistence-paths.js";
import { readCanonicalRecord, readPrivateFile, } from "./intervention-persistence-files.js";
export function readPersistedIntervention(storageRoot, parentChangeId) {
    const value = readCanonicalRecord(interventionRecordPath(storageRoot, parentChangeId), 'INTERVENTION_PERSISTENCE_NOT_FOUND');
    if (!isRecord(value) ||
        value.kind !== 'persisted-harness-intervention.v1' ||
        !hasExactKeys(value, [
            'checkpoint',
            'childWorkspace',
            'createdAt',
            'kind',
            'parent',
            'recordDigest',
            'relationship',
        ]) ||
        !verifyRecordDigest(value)) {
        throw corruptPersistenceRecord();
    }
    const record = value;
    try {
        const checkpoint = verifyWipCheckpoint(record.checkpoint);
        verifyStoredCheckpoint(storageRoot, checkpoint);
        verifyChildWorktreeMetadata(record.childWorkspace);
        if (record.parent.changeId !== parentChangeId ||
            record.parent.status !== 'active' ||
            record.parent.blocker?.kind !== 'harness-intervention' ||
            record.parent.blocker.checkpointId !== checkpoint.checkpointId ||
            record.parent.blocker.blockedBy !==
                record.relationship.interventionChangeId ||
            record.relationship.parentChangeId !== parentChangeId ||
            record.relationship.checkpointId !== checkpoint.checkpointId ||
            record.relationship.state !== 'active' ||
            record.childWorkspace.parentChangeId !== parentChangeId ||
            record.childWorkspace.interventionChangeId !==
                record.relationship.interventionChangeId ||
            record.childWorkspace.checkpointId !== checkpoint.checkpointId ||
            record.childWorkspace.baseOid !== checkpoint.baseOid) {
            throw corruptPersistenceRecord();
        }
        exactIso(record.createdAt, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT') {
            throw error;
        }
        throw corruptPersistenceRecord();
    }
    return record;
}
function verifyChildWorktreeMetadata(metadata) {
    const { metadataDigest, ...payload } = metadata;
    const expectedWorkspaceId = canonicalDigest(childWorktreeIdentity(metadata));
    if (metadata.kind !== 'intervention-child-worktree.v1' ||
        metadata.state !== 'planned' ||
        metadata.effectsPerformed !== false ||
        canonicalDigest(payload) !== metadataDigest ||
        metadata.workspaceId !== expectedWorkspaceId ||
        metadata.parentWorkspacePath === metadata.childWorkspacePath ||
        isPathInside(metadata.parentWorkspacePath, metadata.childWorkspacePath) ||
        isPathInside(metadata.childWorkspacePath, metadata.parentWorkspacePath)) {
        throw corruptPersistenceRecord();
    }
    assertDigest(metadata.workspaceId, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    assertDigest(metadata.checkpointId, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    exactIso(metadata.createdAt, 'INTERVENTION_PERSISTENCE_RECORD_CORRUPT');
    assertAbsoluteWorkspacePath(metadata.parentWorkspacePath);
    assertAbsoluteWorkspacePath(metadata.childWorkspacePath);
    assertSafeChangeRef(metadata.changeRef);
}
function childWorktreeIdentity(input) {
    return {
        kind: 'intervention-child-worktree-identity.v1',
        parentChangeId: input.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        checkpointId: input.checkpointId,
        parentWorkspacePath: input.parentWorkspacePath,
        childWorkspacePath: input.childWorkspacePath,
        changeRef: input.changeRef,
    };
}
function verifyStoredCheckpoint(storageRoot, checkpoint) {
    const paths = interventionControlPersistencePaths(storageRoot);
    const target = path.join(paths.checkpoints, `${checkpoint.checkpointId.slice('sha256:'.length)}.json`);
    const expected = `${canonicalJson(checkpoint)}\n`;
    let observed;
    try {
        observed = readPrivateFile(target, 'INTERVENTION_CHECKPOINT_STORE_MISSING');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_CHECKPOINT_STORE_MISSING') {
            throw workflowError('INTERVENTION_CHECKPOINT_STORE_MISSING', 'Persisted intervention checkpoint object is missing.', ExitCode.verification);
        }
        throw error;
    }
    if (observed !== expected) {
        throw workflowError('INTERVENTION_CHECKPOINT_STORE_CORRUPT', 'Persisted intervention checkpoint object has changed.', ExitCode.verification);
    }
}
