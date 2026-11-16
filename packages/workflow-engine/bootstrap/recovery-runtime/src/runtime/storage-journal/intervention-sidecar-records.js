/**
 * Validates and projects current bootstrap sidecar workflow identities and event history.
 *
 * Invariants:
 * - Workflow revisions and binding digests retain exact session, parent, checkpoint, and artifact facts.
 * - Current sidecar records preserve adoption, promotion, and parent-unblock relationships.
 * - Event projection preserves original ordering and canonical record digests.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { assertDigest, exactIso, withRecordDigest, canonicalDigest, isRecord, hasExactKeys, verifyRecordDigest, assertAbsoluteWorkspacePath, assertSafeChangeRef, } from "./intervention-persistence-values.js";
export function appendBootstrapSidecarEvent(current, patch, event) {
    assertDigest(event.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(event.recordedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    const { recordDigest: _recordDigest, ...payload } = current;
    const updatedAt = Date.parse(event.recordedAt) > Date.parse(current.updatedAt)
        ? event.recordedAt
        : current.updatedAt;
    const next = withRecordDigest({
        ...payload,
        ...patch,
        history: [
            ...current.history,
            {
                sequence: current.history.length + 1,
                ...event,
            },
        ],
        updatedAt,
    });
    return next;
}
export function sidecarMatchesIntervention(sidecar, intervention) {
    const expectedIdentity = {
        parentChangeId: intervention.parent.changeId,
        interventionChangeId: intervention.relationship.interventionChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
    };
    return (sidecar.sidecarSessionId ===
        canonicalDigest({
            kind: 'bootstrap-sidecar-session-identity.v2',
            ...expectedIdentity,
            workflowId: sidecar.workflowBinding.workflowId,
        }) &&
        canonicalJson(sidecar.identity) === canonicalJson(expectedIdentity) &&
        sidecar.workspace.childWorkspacePath ===
            intervention.childWorkspace.childWorkspacePath &&
        sidecar.workspace.changeRef === intervention.childWorkspace.changeRef &&
        canonicalJson(sidecar.workflowBinding) ===
            canonicalJson(createBootstrapMaintenanceWorkflow(intervention, sidecar.workflowBinding.status)));
}
function bootstrapMaintenanceWorkflowId(input) {
    return canonicalDigest({
        kind: 'bootstrap-maintenance-workflow-identity.v1',
        changeId: input.changeId,
        parentChangeId: input.parentChangeId,
        checkpointId: input.checkpointId,
        workspaceId: input.workspaceId,
    });
}
function bootstrapMaintenanceWorkflowPayload(binding) {
    return { ...binding };
}
export function createBootstrapMaintenanceWorkflow(intervention, status) {
    const payload = {
        kind: 'bootstrap-maintenance-workflow.v1',
        workflowType: 'bootstrap-maintenance',
        workflowId: bootstrapMaintenanceWorkflowId({
            changeId: intervention.relationship.interventionChangeId,
            parentChangeId: intervention.parent.changeId,
            checkpointId: intervention.checkpoint.checkpointId,
            workspaceId: intervention.childWorkspace.workspaceId,
        }),
        changeId: intervention.relationship.interventionChangeId,
        parentChangeId: intervention.parent.changeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
        repositoryRoot: intervention.childWorkspace.childWorkspacePath,
        changeRef: intervention.childWorkspace.changeRef,
        baselineOid: intervention.childWorkspace.baseOid,
        status,
    };
    return {
        ...payload,
        workflowBindingDigest: canonicalDigest(bootstrapMaintenanceWorkflowPayload(payload)),
    };
}
export function transitionBootstrapMaintenanceWorkflow(current, status) {
    const { workflowBindingDigest: _workflowBindingDigest, ...payload } = current;
    const next = { ...payload, status };
    return {
        ...next,
        workflowBindingDigest: canonicalDigest(bootstrapMaintenanceWorkflowPayload(next)),
    };
}
export function activeBootstrapMaintenanceWorkflowBindingDigest(current) {
    return transitionBootstrapMaintenanceWorkflow(current, 'repair-active')
        .workflowBindingDigest;
}
export function parseBootstrapSidecarWorkflow(value, expectedParentChangeId) {
    try {
        if (!isRecord(value) ||
            value.kind !== 'bootstrap-sidecar-session.v2' ||
            !hasExactKeys(value, [
                'adoption',
                'artifacts',
                'createdAt',
                'history',
                'identity',
                'kind',
                'parentUnblock',
                'promotion',
                'recordDigest',
                'sidecarSessionId',
                'state',
                'updatedAt',
                'workflowBinding',
                'workspace',
            ]) ||
            !verifyRecordDigest(value)) {
            throw new Error('invalid sidecar workflow record');
        }
        const record = value;
        validateBootstrapSidecarWorkflow(record, expectedParentChangeId);
        return record;
    }
    catch {
        throw workflowError('INTERVENTION_SIDECAR_SESSION_CORRUPT', 'Bootstrap sidecar Workflow metadata is corrupt or inconsistent.', ExitCode.verification);
    }
}
function validateBootstrapSidecarWorkflow(record, expectedParentChangeId) {
    const binding = record.workflowBinding;
    if (!isRecord(binding) ||
        !hasExactKeys(binding, [
            'baselineOid',
            'changeId',
            'changeRef',
            'checkpointId',
            'kind',
            'parentChangeId',
            'repositoryRoot',
            'status',
            'workflowBindingDigest',
            'workflowId',
            'workflowType',
            'workspaceId',
        ]) ||
        binding.kind !== 'bootstrap-maintenance-workflow.v1' ||
        binding.workflowType !== 'bootstrap-maintenance' ||
        !['repair-active', 'adopted', 'abandoned'].includes(binding.status) ||
        binding.status !== record.state) {
        throw new Error('invalid bootstrap workflow binding');
    }
    assertSidecarIdentityText(binding.changeId);
    assertSidecarIdentityText(binding.parentChangeId);
    assertDigest(binding.workflowId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(binding.checkpointId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(binding.workspaceId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(binding.workflowBindingDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertAbsoluteWorkspacePath(binding.repositoryRoot);
    assertSafeChangeRef(binding.changeRef);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.baselineOid)) {
        throw new Error('invalid bootstrap workflow baseline');
    }
    const { workflowBindingDigest, ...bindingPayload } = binding;
    if (canonicalDigest(bootstrapMaintenanceWorkflowPayload(bindingPayload)) !==
        workflowBindingDigest ||
        binding.workflowId !==
            bootstrapMaintenanceWorkflowId({
                changeId: binding.changeId,
                parentChangeId: binding.parentChangeId,
                checkpointId: binding.checkpointId,
                workspaceId: binding.workspaceId,
            }) ||
        binding.changeId !== record.identity.interventionChangeId ||
        binding.parentChangeId !== record.identity.parentChangeId ||
        binding.checkpointId !== record.identity.checkpointId ||
        binding.workspaceId !== record.identity.workspaceId ||
        binding.repositoryRoot !== record.workspace.childWorkspacePath ||
        binding.changeRef !== record.workspace.changeRef ||
        (expectedParentChangeId !== undefined &&
            binding.parentChangeId !== expectedParentChangeId) ||
        record.sidecarSessionId !==
            canonicalDigest({
                kind: 'bootstrap-sidecar-session-identity.v2',
                ...record.identity,
                workflowId: binding.workflowId,
            })) {
        throw new Error('bootstrap workflow identity mismatch');
    }
    validateCurrentBootstrapSidecarSession(record, expectedParentChangeId);
}
function validateCurrentBootstrapSidecarSession(record, expectedParentChangeId) {
    if (!isRecord(record.identity) ||
        !hasExactKeys(record.identity, [
            'checkpointId',
            'interventionChangeId',
            'parentChangeId',
            'workspaceId',
        ]) ||
        !isRecord(record.parentUnblock) ||
        !hasExactKeys(record.parentUnblock, [
            'kind',
            'parentChangeId',
            'resolution',
            'resolvedAt',
            'resolvedByTxId',
            'state',
        ]) ||
        !isRecord(record.workspace) ||
        !hasExactKeys(record.workspace, [
            'changeRef',
            'childWorkspacePath',
            'materializedAt',
            'receiptDigest',
            'state',
        ])) {
        throw new Error('invalid sidecar workflow structure');
    }
    assertSidecarIdentityText(record.identity.parentChangeId);
    assertSidecarIdentityText(record.identity.interventionChangeId);
    assertDigest(record.identity.checkpointId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.identity.workspaceId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.sidecarSessionId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if ((expectedParentChangeId !== undefined &&
        record.identity.parentChangeId !== expectedParentChangeId) ||
        record.sidecarSessionId !==
            canonicalDigest({
                kind: 'bootstrap-sidecar-session-identity.v2',
                ...record.identity,
                workflowId: record.workflowBinding.workflowId,
            })) {
        throw new Error('sidecar workflow identity mismatch');
    }
    assertAbsoluteWorkspacePath(record.workspace.childWorkspacePath);
    assertSafeChangeRef(record.workspace.changeRef);
    if (record.parentUnblock.kind !== 'sidecar-unblocks-parent.v1' ||
        record.parentUnblock.parentChangeId !== record.identity.parentChangeId ||
        !['repair-active', 'adopted', 'abandoned'].includes(record.state)) {
        throw new Error('sidecar workflow relationship mismatch');
    }
    if (record.workspace.state === 'planned') {
        if (record.workspace.receiptDigest !== null ||
            record.workspace.materializedAt !== null) {
            throw new Error('planned sidecar has materialization evidence');
        }
    }
    else if (record.workspace.state === 'materialized') {
        if (record.workspace.receiptDigest === null ||
            record.workspace.materializedAt === null) {
            throw new Error('materialized sidecar lacks evidence');
        }
        assertDigest(record.workspace.receiptDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        exactIso(record.workspace.materializedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    }
    else {
        throw new Error('invalid workspace state');
    }
    if (!Array.isArray(record.artifacts)) {
        throw new Error('invalid sidecar artifacts');
    }
    const activeBindingDigest = activeBootstrapMaintenanceWorkflowBindingDigest(record.workflowBinding);
    const artifactIds = new Set();
    for (const artifact of record.artifacts) {
        if (!isRecord(artifact) ||
            !hasExactKeys(artifact, [
                'artifactId',
                'evidenceDigest',
                'executableDigest',
                'readyAt',
                'sourceDigest',
                'workflowBindingDigest',
                'workflowStatus',
            ]) ||
            artifact.workflowStatus !== 'repair-active' ||
            artifact.workflowBindingDigest !== activeBindingDigest) {
            throw new Error('artifact workflow binding mismatch');
        }
        assertDigest(artifact.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        assertDigest(artifact.sourceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        assertDigest(artifact.executableDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        assertDigest(artifact.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        exactIso(artifact.readyAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        if (artifactIds.has(artifact.artifactId)) {
            throw new Error('duplicate sidecar artifact');
        }
        artifactIds.add(artifact.artifactId);
    }
    validateCurrentBootstrapSidecarAdoption(record, artifactIds, activeBindingDigest);
    validateCurrentBootstrapSidecarPromotion(record, artifactIds);
    validateCurrentBootstrapSidecarRelation(record);
    validateCurrentBootstrapSidecarHistory(record);
}
function validateCurrentBootstrapSidecarAdoption(record, artifactIds, activeBindingDigest) {
    if (record.adoption === null)
        return;
    if (!isRecord(record.adoption) ||
        !hasExactKeys(record.adoption, [
            'adoptedAt',
            'artifactId',
            'journalDigest',
            'txId',
            'workflowBindingDigest',
            'workflowStatus',
        ]) ||
        record.adoption.workflowStatus !== 'repair-active' ||
        record.adoption.workflowBindingDigest !== activeBindingDigest) {
        throw new Error('invalid sidecar adoption');
    }
    assertSidecarIdentityText(record.adoption.txId);
    assertDigest(record.adoption.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.adoption.journalDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(record.adoption.adoptedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (!artifactIds.has(record.adoption.artifactId)) {
        throw new Error('adoption artifact is not ready');
    }
}
function validateCurrentBootstrapSidecarPromotion(record, artifactIds) {
    if (record.promotion === null)
        return;
    if (!isRecord(record.promotion) ||
        !hasExactKeys(record.promotion, [
            'artifactId',
            'closureDigest',
            'evidenceDigest',
            'grantId',
            'promotedAt',
            'txId',
        ])) {
        throw new Error('invalid sidecar promotion');
    }
    assertSidecarIdentityText(record.promotion.grantId);
    assertSidecarIdentityText(record.promotion.txId);
    assertDigest(record.promotion.artifactId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.promotion.closureDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    assertDigest(record.promotion.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(record.promotion.promotedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (!artifactIds.has(record.promotion.artifactId)) {
        throw new Error('promotion artifact is not ready');
    }
}
function validateCurrentBootstrapSidecarRelation(record) {
    const relation = record.parentUnblock;
    if (relation.state === 'blocking') {
        if (relation.resolution !== null ||
            relation.resolvedByTxId !== null ||
            relation.resolvedAt !== null ||
            record.adoption !== null ||
            record.state !== 'repair-active') {
            throw new Error('invalid blocking relation');
        }
        return;
    }
    if (relation.state !== 'unblocked' || relation.resolvedAt === null) {
        throw new Error('invalid resolved relation');
    }
    exactIso(relation.resolvedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    if (relation.resolution === 'local-adoption') {
        if (record.adoption === null ||
            relation.resolvedByTxId !== record.adoption.txId ||
            relation.resolvedAt !== record.adoption.adoptedAt ||
            record.state !== 'adopted') {
            throw new Error('invalid adoption relation');
        }
        return;
    }
    if (relation.resolution !== 'abandonment' ||
        relation.resolvedByTxId !== null ||
        record.state !== 'abandoned') {
        throw new Error('invalid abandonment relation');
    }
}
function validateCurrentBootstrapSidecarHistory(record) {
    if (!Array.isArray(record.history) || record.history.length === 0) {
        throw new Error('missing sidecar history');
    }
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const [index, entry] of record.history.entries()) {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, [
                'eventKind',
                'evidenceDigest',
                'recordedAt',
                'sequence',
            ]) ||
            entry.sequence !== index + 1 ||
            ![
                'sidecar-created',
                'workspace-materialized',
                'artifact-ready',
                'adopted-by-parent',
                'repository-default-promoted',
                'intervention-abandoned',
            ].includes(entry.eventKind)) {
            throw new Error('invalid sidecar history entry');
        }
        assertDigest(entry.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        exactIso(entry.recordedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
        latestAt = Math.max(latestAt, Date.parse(entry.recordedAt));
    }
    if (record.history[0].eventKind !== 'sidecar-created' ||
        record.history[0].recordedAt !== record.createdAt ||
        new Date(latestAt).toISOString() !== record.updatedAt ||
        record.history.filter((entry) => entry.eventKind === 'sidecar-created')
            .length !== 1 ||
        record.history.filter((entry) => entry.eventKind === 'workspace-materialized').length !== (record.workspace.state === 'materialized' ? 1 : 0) ||
        record.history.filter((entry) => entry.eventKind === 'artifact-ready')
            .length !== record.artifacts.length ||
        record.history.filter((entry) => entry.eventKind === 'adopted-by-parent')
            .length !== (record.adoption === null ? 0 : 1) ||
        record.history.filter((entry) => entry.eventKind === 'repository-default-promoted').length !== (record.promotion === null ? 0 : 1) ||
        record.history.filter((entry) => entry.eventKind === 'intervention-abandoned').length !== (record.state === 'abandoned' ? 1 : 0)) {
        throw new Error('sidecar history does not match workflow state');
    }
    exactIso(record.createdAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
    exactIso(record.updatedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
}
export function assertSidecarIdentityText(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value) {
        throw workflowError('INTERVENTION_SIDECAR_SESSION_INVALID', 'Sidecar identity must be a non-empty trimmed string.', ExitCode.usage);
    }
}
export function sidecarProjectionConflict(message) {
    return workflowError('INTERVENTION_SIDECAR_SESSION_CONFLICT', message, ExitCode.conflict);
}
