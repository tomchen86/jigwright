/**
 * Persists checkpoint-bound intervention plans and reserves their exact child workspaces.
 *
 * Invariants:
 * - Child metadata retains exact parent checkpoint, base, path, and change-reference bindings.
 * - Workspace overlap and prior-plan replay checks precede publication under the operation lock.
 * - Content-addressed checkpoints retain the same bytes before the owning plan is recorded.
 *
 * Depends on: intervention policy, sidecar storage, workspace checks, and private persistence.
 * Failure modes: overlapping child workspaces, changed checkpoint bytes, or a plan bound to another parent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { createWipCheckpoint, beginHarnessIntervention, verifyWipCheckpoint, } from "../../modules/authority/intervention-control.js";
import { exactDate, withRecordDigest, serializeRecord, isRecord, hasExactKeys, verifyRecordDigest, corruptPersistenceRecord, exactIso, assertAbsoluteWorkspacePath, isPathInside, assertSafeChangeRef, canonicalDigest, assertDigest, identityFileName, } from "./intervention-persistence-values.js";
import { withPersistenceOperation } from "./intervention-persistence-locks.js";
import { ensurePersistenceDirectories, interventionRecordPath, interventionControlPersistencePaths, } from "./intervention-persistence-paths.js";
import { ensureBootstrapSidecarSession } from "./intervention-sidecar-store.js";
import { createPrivateFileExclusive, readCanonicalRecord, readPrivateFile, } from "./intervention-persistence-files.js";
export function persistInterventionPlan(storageRoot, input) {
    const now = exactDate(input.now, 'INTERVENTION_PERSISTENCE_CLOCK_INVALID');
    const checkpoint = createWipCheckpoint(input.checkpoint);
    const projection = beginHarnessIntervention(input.parent, input.interventionChangeId, checkpoint);
    const childWorkspace = createChildWorktreeMetadata({
        parentChangeId: projection.parent.changeId,
        interventionChangeId: projection.relationship.interventionChangeId,
        checkpoint,
        ...input.childWorkspace,
        createdAt: now.toISOString(),
    });
    const candidate = withRecordDigest({
        kind: 'persisted-harness-intervention.v1',
        parent: projection.parent,
        relationship: projection.relationship,
        checkpoint,
        childWorkspace,
        createdAt: now.toISOString(),
    });
    return withPersistenceOperation(storageRoot, 'intervention-reservation', () => {
        ensurePersistenceDirectories(storageRoot);
        const target = interventionRecordPath(storageRoot, input.parent.changeId);
        if (fs.existsSync(target)) {
            const existing = readPersistedIntervention(storageRoot, input.parent.changeId);
            if (sameInterventionPlan(existing, candidate)) {
                ensureBootstrapSidecarSession(storageRoot, existing);
                return existing;
            }
            throw workflowError('INTERVENTION_PERSISTENCE_ACTIVE_CONFLICT', 'The parent already has a different persisted intervention.', ExitCode.conflict);
        }
        assertUniqueChildWorkspaceReservation(storageRoot, candidate);
        writeContentAddressedCheckpoint(storageRoot, checkpoint);
        createPrivateFileExclusive(target, serializeRecord(candidate));
        input.testAfterInterventionPersistedBeforeSidecar?.();
        ensureBootstrapSidecarSession(storageRoot, candidate);
        return candidate;
    });
}
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
function createChildWorktreeMetadata(input) {
    const parentWorkspacePath = assertAbsoluteWorkspacePath(input.parentWorkspacePath);
    const childWorkspacePath = assertAbsoluteWorkspacePath(input.childWorkspacePath);
    if (parentWorkspacePath === childWorkspacePath ||
        isPathInside(parentWorkspacePath, childWorkspacePath) ||
        isPathInside(childWorkspacePath, parentWorkspacePath)) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_NOT_ISOLATED', 'Parent and intervention workspace paths must be disjoint.', ExitCode.guard);
    }
    assertExistingPlainWorkspace(parentWorkspacePath);
    if (fs.lstatSync(childWorkspacePath, { throwIfNoEntry: false })) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_PATH_OCCUPIED', 'Planned intervention workspace path already exists.', ExitCode.conflict);
    }
    assertSafeChangeRef(input.changeRef);
    const identity = childWorktreeIdentity({
        parentChangeId: input.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        checkpointId: input.checkpoint.checkpointId,
        parentWorkspacePath,
        childWorkspacePath,
        changeRef: input.changeRef,
    });
    const payload = {
        kind: 'intervention-child-worktree.v1',
        workspaceId: canonicalDigest(identity),
        parentChangeId: input.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        checkpointId: input.checkpoint.checkpointId,
        baseOid: input.checkpoint.baseOid,
        parentWorkspacePath,
        childWorkspacePath,
        changeRef: input.changeRef,
        state: 'planned',
        createdAt: input.createdAt,
        effectsPerformed: false,
    };
    return { ...payload, metadataDigest: canonicalDigest(payload) };
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
function writeContentAddressedCheckpoint(storageRoot, checkpoint) {
    const paths = interventionControlPersistencePaths(storageRoot);
    const target = path.join(paths.checkpoints, `${checkpoint.checkpointId.slice('sha256:'.length)}.json`);
    const content = `${canonicalJson(checkpoint)}\n`;
    if (fs.existsSync(target)) {
        if (readPrivateFile(target, 'INTERVENTION_CHECKPOINT_STORE_CORRUPT') !==
            content) {
            throw workflowError('INTERVENTION_CHECKPOINT_STORE_COLLISION', 'Content-addressed checkpoint path contains different bytes.', ExitCode.verification);
        }
        return;
    }
    createPrivateFileExclusive(target, content);
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
function sameInterventionPlan(left, right) {
    return (left.checkpoint.checkpointId === right.checkpoint.checkpointId &&
        left.relationship.interventionChangeId ===
            right.relationship.interventionChangeId &&
        left.childWorkspace.parentWorkspacePath ===
            right.childWorkspace.parentWorkspacePath &&
        left.childWorkspace.childWorkspacePath ===
            right.childWorkspace.childWorkspacePath &&
        left.childWorkspace.changeRef === right.childWorkspace.changeRef);
}
function assertUniqueChildWorkspaceReservation(storageRoot, candidate) {
    const paths = interventionControlPersistencePaths(storageRoot);
    for (const name of fs.readdirSync(paths.interventions).sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) {
            throw corruptPersistenceRecord();
        }
        const value = readCanonicalRecord(path.join(paths.interventions, name), 'INTERVENTION_PERSISTENCE_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.parent) ||
            typeof value.parent.changeId !== 'string' ||
            name !== `${identityFileName('intervention', value.parent.changeId)}.json`) {
            throw corruptPersistenceRecord();
        }
        const existing = readPersistedIntervention(storageRoot, value.parent.changeId);
        if (existing.childWorkspace.workspaceId ===
            candidate.childWorkspace.workspaceId ||
            existing.childWorkspace.childWorkspacePath ===
                candidate.childWorkspace.childWorkspacePath ||
            existing.childWorkspace.changeRef === candidate.childWorkspace.changeRef) {
            throw workflowError('INTERVENTION_CHILD_WORKSPACE_RESERVATION_CONFLICT', 'Child workspace path or change ref is already reserved.', ExitCode.conflict);
        }
    }
}
function assertExistingPlainWorkspace(workspacePath) {
    const stats = fs.lstatSync(workspacePath, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(workspacePath) !== workspacePath) {
        throw workflowError('INTERVENTION_PARENT_WORKSPACE_UNSAFE', 'Parent workspace must be an existing plain directory.', ExitCode.unsafeEnvironment);
    }
}
