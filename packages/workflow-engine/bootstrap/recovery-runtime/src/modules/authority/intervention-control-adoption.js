import { assertNonEmpty, assertDigest, assertIsoTimestamp, freezeDeep, canonicalDigest, assertSortedUnique, assertSafePath, verifyHumanSignatureSafely, HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE, assertMonotonicTimestamp, } from "./intervention-control-values.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
export function checkpointPayload(input) {
    return {
        kind: 'harness-wip-checkpoint.v1',
        parentChangeId: input.parentChangeId,
        baseOid: input.baseOid,
        worktreeFingerprint: input.worktreeFingerprint,
        trackedTreeDigest: input.trackedTreeDigest,
        untrackedBundleDigest: input.untrackedBundleDigest,
        sessionStateDigest: input.sessionStateDigest,
        pendingIntentDigest: input.pendingIntentDigest,
        engineDigest: input.engineDigest,
        policyDigest: input.policyDigest,
        createdAt: input.createdAt,
    };
}
export function validateCheckpointInput(input) {
    assertNonEmpty(input.parentChangeId, 'INTERVENTION_CHECKPOINT_INVALID', 'Parent change id');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseOid)) {
        throw workflowError('INTERVENTION_CHECKPOINT_INVALID', 'Checkpoint baseOid must be a full Git object id.', ExitCode.usage);
    }
    for (const digest of [
        input.worktreeFingerprint,
        input.trackedTreeDigest,
        input.untrackedBundleDigest,
        input.sessionStateDigest,
        input.pendingIntentDigest,
        input.engineDigest,
        input.policyDigest,
    ]) {
        assertDigest(digest, 'INTERVENTION_CHECKPOINT_INVALID');
    }
    assertIsoTimestamp(input.createdAt, 'INTERVENTION_CHECKPOINT_INVALID');
}
export function createWipCheckpoint(input) {
    validateCheckpointInput(input);
    const payload = checkpointPayload(input);
    return freezeDeep({
        ...payload,
        checkpointId: canonicalDigest(payload),
    });
}
export function verifyWipCheckpoint(checkpoint) {
    validateCheckpointInput(checkpoint);
    if (checkpoint.kind !== 'harness-wip-checkpoint.v1') {
        throw workflowError('INTERVENTION_CHECKPOINT_INVALID', 'Unknown WIP checkpoint schema.', ExitCode.usage);
    }
    assertDigest(checkpoint.checkpointId, 'INTERVENTION_CHECKPOINT_INVALID');
    const expected = canonicalDigest(checkpointPayload(checkpoint));
    if (checkpoint.checkpointId !== expected) {
        throw workflowError('INTERVENTION_CHECKPOINT_DIGEST_MISMATCH', 'WIP checkpoint content no longer matches its immutable digest.', ExitCode.verification, { details: { expected, actual: checkpoint.checkpointId } });
    }
    return freezeDeep({ ...checkpoint });
}
export function beginHarnessIntervention(parent, interventionChangeId, checkpointValue) {
    const checkpoint = verifyWipCheckpoint(checkpointValue);
    assertNonEmpty(interventionChangeId, 'INTERVENTION_CHANGE_ID_INVALID', 'Intervention change id');
    if (parent.status !== 'active') {
        throw workflowError('INTERVENTION_PARENT_NOT_ACTIVE', 'An intervention can only block an active parent change.', ExitCode.conflict);
    }
    if (parent.blocker?.kind === 'harness-intervention') {
        throw workflowError('INTERVENTION_ALREADY_ACTIVE', 'The parent already has an active harness intervention.', ExitCode.conflict);
    }
    if (parent.blocker !== null) {
        throw workflowError('INTERVENTION_PARENT_BLOCKED', 'The parent has another blocker that must be resolved first.', ExitCode.conflict);
    }
    assertDigest(parent.engineBinding, 'INTERVENTION_PARENT_INVALID');
    assertNonEmpty(parent.sessionSchema, 'INTERVENTION_PARENT_INVALID', 'Session schema');
    if (checkpoint.parentChangeId !== parent.changeId ||
        checkpoint.engineDigest !== parent.engineBinding) {
        throw workflowError('INTERVENTION_CHECKPOINT_PARENT_MISMATCH', 'Checkpoint is not bound to the exact parent and engine state.', ExitCode.verification);
    }
    if (interventionChangeId === parent.changeId) {
        throw workflowError('INTERVENTION_SELF_REFERENCE_FORBIDDEN', 'The intervention change must be distinct from its parent.', ExitCode.usage);
    }
    const blocker = {
        kind: 'harness-intervention',
        checkpointId: checkpoint.checkpointId,
        blockedBy: interventionChangeId,
    };
    return freezeDeep({
        parent: { ...parent, blocker },
        relationship: {
            kind: 'harness-intervention.v1',
            parentChangeId: parent.changeId,
            interventionChangeId,
            checkpointId: checkpoint.checkpointId,
            unblocks: parent.changeId,
            state: 'active',
        },
    });
}
export function engineArtifactPayload(input) {
    return {
        kind: 'engine-artifact.v1',
        sourceChangeId: input.sourceChangeId,
        sourceDigest: input.sourceDigest,
        executableDigest: input.executableDigest,
        protocolVersion: input.protocolVersion,
        canReadSessionSchemas: input.canReadSessionSchemas,
        writesSessionSchema: input.writesSessionSchema,
        policySchemaVersion: input.policySchemaVersion,
        smokeReportDigest: input.smokeReportDigest,
        ...(input.workflowBindingDigest === undefined
            ? {}
            : { workflowBindingDigest: input.workflowBindingDigest }),
    };
}
export function createEngineArtifact(input) {
    assertNonEmpty(input.sourceChangeId, 'ENGINE_ARTIFACT_INVALID', 'Source change id');
    assertDigest(input.sourceDigest, 'ENGINE_ARTIFACT_INVALID');
    assertDigest(input.executableDigest, 'ENGINE_ARTIFACT_INVALID');
    assertDigest(input.smokeReportDigest, 'ENGINE_ARTIFACT_INVALID');
    if (input.workflowBindingDigest !== undefined) {
        assertDigest(input.workflowBindingDigest, 'ENGINE_ARTIFACT_INVALID');
    }
    if (!Number.isSafeInteger(input.protocolVersion) ||
        input.protocolVersion < 1) {
        throw workflowError('ENGINE_ARTIFACT_INVALID', 'Invalid engine protocol version.', ExitCode.usage);
    }
    if (!Number.isSafeInteger(input.policySchemaVersion) ||
        input.policySchemaVersion < 1) {
        throw workflowError('ENGINE_ARTIFACT_INVALID', 'Invalid policy schema version.', ExitCode.usage);
    }
    assertNonEmpty(input.writesSessionSchema, 'ENGINE_ARTIFACT_INVALID', 'Written session schema');
    for (const schema of input.canReadSessionSchemas) {
        assertNonEmpty(schema, 'ENGINE_ARTIFACT_INVALID', 'Readable session schema');
    }
    assertSortedUnique(input.canReadSessionSchemas, 'ENGINE_ARTIFACT_INVALID');
    if (!input.canReadSessionSchemas.includes(input.writesSessionSchema)) {
        throw workflowError('ENGINE_ARTIFACT_INVALID', 'Engine must be able to read the session schema that it writes.', ExitCode.usage);
    }
    const payload = engineArtifactPayload(input);
    return freezeDeep({ ...payload, artifactId: canonicalDigest(payload) });
}
export const MAINTENANCE_OPERATIONS = [
    'adopt-engine-into-parent',
    'build-engine-artifact',
    'create-isolated-workspace',
    'modify-engine',
    'run-engine-tests',
];
export const MAINTENANCE_WAIVERS = [
    'active-change-exclusivity',
    'clean-worktree-required',
    'engine-path-protection',
    'parent-terminalization-required',
    'selected-workflow-check',
];
export function canonicalHarnessMaintenanceGrantPayload(payload) {
    return `${canonicalJson(payload)}\n`;
}
export function validateMaintenancePayload(payload) {
    if (payload.kind !== 'harness-maintenance-grant.v1') {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Unknown maintenance grant schema.', ExitCode.usage);
    }
    for (const [value, label] of [
        [payload.grantId, 'Grant id'],
        [payload.parentChangeId, 'Parent change id'],
        [payload.interventionChangeId, 'Intervention change id'],
        [payload.sessionSchema, 'Session schema'],
        [payload.humanSigner, 'Human signer'],
        [payload.reason, 'Reason'],
    ]) {
        assertNonEmpty(value, 'MAINTENANCE_GRANT_INVALID', label);
    }
    assertDigest(payload.engineFromDigest, 'MAINTENANCE_GRANT_INVALID');
    if (payload.parentChangeId === payload.interventionChangeId) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Parent and intervention must differ.', ExitCode.usage);
    }
    if (!Array.isArray(payload.scope.paths) || payload.scope.paths.length === 0) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Maintenance scope needs exact path globs.', ExitCode.usage);
    }
    for (const path of payload.scope.paths) {
        assertSafePath(path, true, 'MAINTENANCE_GRANT_INVALID');
    }
    assertSortedUnique(payload.scope.paths, 'MAINTENANCE_GRANT_INVALID');
    if (!Array.isArray(payload.scope.operations) ||
        payload.scope.operations.length === 0) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Maintenance scope needs operations.', ExitCode.usage);
    }
    assertSortedUnique(payload.scope.operations, 'MAINTENANCE_GRANT_INVALID');
    if (payload.scope.operations.some((operation) => !MAINTENANCE_OPERATIONS.includes(operation))) {
        throw workflowError('MAINTENANCE_GRANT_OPERATION_UNKNOWN', 'Unknown maintenance operation.', ExitCode.guard);
    }
    if (!payload.scope.operations.includes('adopt-engine-into-parent')) {
        throw workflowError('MAINTENANCE_GRANT_ADOPTION_NOT_AUTHORIZED', 'Maintenance grant does not authorize local engine adoption.', ExitCode.guard);
    }
    assertSortedUnique(payload.waivers, 'MAINTENANCE_GRANT_INVALID');
    if (payload.waivers.some((waiver) => !MAINTENANCE_WAIVERS.includes(waiver))) {
        throw workflowError('MAINTENANCE_GRANT_NONWAIVABLE_INVARIANT', 'Maintenance grant attempts to waive a recovery invariant.', ExitCode.guard);
    }
    if (payload.maxLocalAdoptions !== 1) {
        throw workflowError('MAINTENANCE_GRANT_V1_ADOPTION_LIMIT_INVALID', 'V1 maintenance grants authorize exactly one local adoption.', ExitCode.guard);
    }
    assertIsoTimestamp(payload.issuedAt, 'MAINTENANCE_GRANT_INVALID');
    assertIsoTimestamp(payload.expiresAt, 'MAINTENANCE_GRANT_INVALID');
    if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
        throw workflowError('MAINTENANCE_GRANT_INVALID', 'Maintenance grant expiry must follow issue time.', ExitCode.usage);
    }
}
export function verifyHarnessMaintenanceGrant(envelope, context) {
    validateMaintenancePayload(envelope.payload);
    assertNonEmpty(envelope.signature, 'MAINTENANCE_GRANT_SIGNATURE_INVALID', 'Signature');
    const checkpoint = verifyWipCheckpoint(context.checkpoint);
    const blocker = context.parent.blocker;
    if (context.parent.status !== 'active' ||
        blocker?.kind !== 'harness-intervention' ||
        blocker.checkpointId !== checkpoint.checkpointId ||
        blocker.blockedBy !== context.relationship.interventionChangeId ||
        context.relationship.state !== 'active' ||
        context.relationship.parentChangeId !== context.parent.changeId ||
        context.relationship.checkpointId !== checkpoint.checkpointId) {
        throw workflowError('MAINTENANCE_GRANT_INTERVENTION_MISMATCH', 'Maintenance grant requires the exact active intervention relationship.', ExitCode.verification);
    }
    const payload = envelope.payload;
    if (payload.parentChangeId !== context.parent.changeId ||
        payload.interventionChangeId !==
            context.relationship.interventionChangeId ||
        payload.engineFromDigest !== context.parent.engineBinding ||
        payload.engineFromDigest !== checkpoint.engineDigest ||
        payload.sessionSchema !== context.parent.sessionSchema) {
        throw workflowError('MAINTENANCE_GRANT_BINDING_MISMATCH', 'Maintenance grant does not match the parent checkpoint and engine binding.', ExitCode.verification);
    }
    if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
        throw workflowError('MAINTENANCE_GRANT_EXPIRED', 'Maintenance grant has expired.', ExitCode.staleState);
    }
    const signatureValid = verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalHarnessMaintenanceGrantPayload(payload), envelope.signature, payload.humanSigner, HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE);
    if (!signatureValid) {
        throw workflowError('MAINTENANCE_GRANT_SIGNATURE_INVALID', 'Human maintenance grant signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: { ...payload },
        signature: envelope.signature,
        verifiedAt: context.now.toISOString(),
        verification: 'human-signature-verified',
    });
}
export function adoptionJournalPayload(journal) {
    return { ...journal };
}
export function buildAdoptionJournal(journal) {
    return freezeDeep({
        ...journal,
        journalDigest: canonicalDigest(adoptionJournalPayload(journal)),
    });
}
export function verifyAdoptionJournal(journal) {
    assertDigest(journal.journalDigest, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
    if ((journal.workflowBindingDigest === undefined) !==
        (journal.workflowStatus === undefined) ||
        (journal.workflowBindingDigest !== undefined &&
            journal.workflowStatus !== 'repair-active')) {
        throw workflowError('ENGINE_ADOPTION_JOURNAL_CORRUPT', 'Engine adoption workflow binding is incomplete.', ExitCode.verification);
    }
    if (journal.workflowBindingDigest !== undefined) {
        assertDigest(journal.workflowBindingDigest, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
    }
    const { journalDigest, ...payload } = journal;
    if (canonicalDigest(adoptionJournalPayload(payload)) !== journalDigest ||
        journal.history.length === 0 ||
        journal.history.at(-1)?.state !== journal.state) {
        throw workflowError('ENGINE_ADOPTION_JOURNAL_CORRUPT', 'Engine adoption journal failed integrity verification.', ExitCode.verification);
    }
    for (let index = 1; index < journal.history.length; index += 1) {
        assertMonotonicTimestamp(journal.history[index - 1].at, journal.history[index].at, 'ENGINE_ADOPTION_JOURNAL_CORRUPT');
    }
}
export function prepareEngineAdoption(input) {
    assertNonEmpty(input.txId, 'ENGINE_ADOPTION_INVALID', 'Adoption transaction id');
    const checkpoint = verifyWipCheckpoint(input.checkpoint);
    const rebuiltArtifact = createEngineArtifact(input.artifact);
    if (rebuiltArtifact.artifactId !== input.artifact.artifactId) {
        throw workflowError('ENGINE_ARTIFACT_DIGEST_MISMATCH', 'Engine artifact digest mismatch.', ExitCode.verification);
    }
    if (input.parent.status !== 'active' ||
        input.parent.blocker?.kind !== 'harness-intervention' ||
        input.parent.blocker.checkpointId !== checkpoint.checkpointId ||
        input.parent.blocker.blockedBy !==
            input.relationship.interventionChangeId ||
        input.relationship.state !== 'active' ||
        input.relationship.checkpointId !== checkpoint.checkpointId ||
        input.artifact.sourceChangeId !== input.relationship.interventionChangeId) {
        throw workflowError('ENGINE_ADOPTION_INTERVENTION_MISMATCH', 'Adoption is not bound to the exact active intervention.', ExitCode.verification);
    }
    if (input.maintenanceGrant.verification !== 'human-signature-verified' ||
        input.maintenanceGrant.payload.grantId.length === 0 ||
        input.maintenanceGrant.payload.parentChangeId !== input.parent.changeId ||
        input.maintenanceGrant.payload.interventionChangeId !==
            input.relationship.interventionChangeId ||
        input.maintenanceGrant.payload.engineFromDigest !==
            input.parent.engineBinding) {
        throw workflowError('ENGINE_ADOPTION_GRANT_MISMATCH', 'Verified maintenance grant does not authorize this adoption.', ExitCode.guard);
    }
    if (input.now.getTime() >= Date.parse(input.maintenanceGrant.payload.expiresAt)) {
        throw workflowError('ENGINE_ADOPTION_GRANT_EXPIRED', 'Maintenance grant expired before adoption.', ExitCode.staleState);
    }
    if (!Number.isSafeInteger(input.priorLocalAdoptions) ||
        input.priorLocalAdoptions < 0 ||
        input.priorLocalAdoptions >=
            input.maintenanceGrant.payload.maxLocalAdoptions) {
        throw workflowError('ENGINE_ADOPTION_LIMIT_EXHAUSTED', 'Maintenance grant local adoption limit is exhausted.', ExitCode.conflict);
    }
    if (input.artifact.writesSessionSchema !== input.parent.sessionSchema ||
        input.maintenanceGrant.payload.sessionSchema !==
            input.parent.sessionSchema ||
        !input.artifact.canReadSessionSchemas.includes(input.parent.sessionSchema)) {
        throw workflowError('ENGINE_ADOPTION_SCHEMA_CHANGE_FORBIDDEN', 'V1 local adoption cannot modify the durable session schema.', ExitCode.guard);
    }
    const at = input.now.toISOString();
    if ((input.workflowBindingDigest === undefined) !==
        (input.workflowStatus === undefined) ||
        (input.workflowBindingDigest !== undefined &&
            input.workflowStatus !== 'repair-active')) {
        throw workflowError('ENGINE_ADOPTION_WORKFLOW_BINDING_INVALID', 'Workflow binding digest and status must be supplied together.', ExitCode.verification);
    }
    if (input.workflowBindingDigest !== undefined) {
        assertDigest(input.workflowBindingDigest, 'ENGINE_ADOPTION_WORKFLOW_BINDING_INVALID');
    }
    return buildAdoptionJournal({
        kind: 'engine-adoption-journal.v1',
        txId: input.txId,
        grantId: input.maintenanceGrant.payload.grantId,
        parentChangeId: input.parent.changeId,
        interventionChangeId: input.relationship.interventionChangeId,
        checkpointId: checkpoint.checkpointId,
        fromEngineDigest: input.parent.engineBinding,
        toEngineDigest: input.artifact.executableDigest,
        artifactId: input.artifact.artifactId,
        sessionSchema: input.parent.sessionSchema,
        ...(input.workflowBindingDigest === undefined
            ? {}
            : {
                workflowBindingDigest: input.workflowBindingDigest,
                workflowStatus: input.workflowStatus,
            }),
        state: 'PREPARED',
        history: [{ state: 'PREPARED', at }],
    });
}
export const ADOPTION_TRANSITIONS = {
    PREPARED: { 'parent-checkpointed': 'PARENT_CHECKPOINTED' },
    PARENT_CHECKPOINTED: { 'engine-binding-updated': 'ENGINE_BINDING_UPDATED' },
    ENGINE_BINDING_UPDATED: { 'new-engine-started': 'NEW_ENGINE_STARTED' },
    NEW_ENGINE_STARTED: {
        'health-check-passed': 'HEALTHY',
        'health-check-failed': 'ROLLBACK_REQUIRED',
    },
    ROLLBACK_REQUIRED: {
        'engine-binding-rolled-back': 'ENGINE_BINDING_ROLLED_BACK',
    },
    HEALTHY: { commit: 'COMMITTED' },
    COMMITTED: {},
    ENGINE_BINDING_ROLLED_BACK: {},
};
export function advanceEngineAdoption(journal, event) {
    verifyAdoptionJournal(journal);
    const nextState = ADOPTION_TRANSITIONS[journal.state][event.kind];
    if (nextState === undefined) {
        throw workflowError('ENGINE_ADOPTION_TRANSITION_INVALID', `Cannot apply ${event.kind} while adoption is ${journal.state}.`, ExitCode.conflict);
    }
    assertMonotonicTimestamp(journal.history.at(-1).at, event.at, 'ENGINE_ADOPTION_TRANSITION_INVALID');
    const { journalDigest: _journalDigest, ...payload } = journal;
    return buildAdoptionJournal({
        ...payload,
        state: nextState,
        history: [...journal.history, { state: nextState, at: event.at }],
    });
}
export function decideEngineAdoptionRecovery(journal) {
    verifyAdoptionJournal(journal);
    switch (journal.state) {
        case 'PREPARED':
            return {
                action: 'checkpoint-parent',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
        case 'PARENT_CHECKPOINTED':
            return {
                action: 'update-engine-binding',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
        case 'ENGINE_BINDING_UPDATED':
            return {
                action: 'start-new-engine',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: false,
            };
        case 'NEW_ENGINE_STARTED':
            return {
                action: 'run-health-check',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: false,
            };
        case 'ROLLBACK_REQUIRED':
            return {
                action: 'rollback-engine-binding',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
        case 'HEALTHY':
            return {
                action: 'finalize-commit',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: false,
            };
        case 'COMMITTED':
            return {
                action: 'none',
                authoritativeEngineDigest: journal.toEngineDigest,
                blockerCleared: true,
            };
        case 'ENGINE_BINDING_ROLLED_BACK':
            return {
                action: 'none',
                authoritativeEngineDigest: journal.fromEngineDigest,
                blockerCleared: false,
            };
    }
}
export function finalizeEngineAdoption(parent, relationship, journal) {
    verifyAdoptionJournal(journal);
    if (parent.status !== 'active' ||
        parent.blocker?.kind !== 'harness-intervention' ||
        parent.changeId !== journal.parentChangeId ||
        parent.blocker.checkpointId !== journal.checkpointId ||
        parent.blocker.blockedBy !== journal.interventionChangeId ||
        relationship.parentChangeId !== journal.parentChangeId ||
        relationship.interventionChangeId !== journal.interventionChangeId ||
        relationship.state !== 'active') {
        throw workflowError('ENGINE_ADOPTION_FINALIZE_MISMATCH', 'Parent or intervention relationship changed during adoption.', ExitCode.staleState);
    }
    if (journal.state === 'COMMITTED') {
        return freezeDeep({
            parent: {
                ...parent,
                engineBinding: journal.toEngineDigest,
                blocker: null,
            },
            relationship: { ...relationship, state: 'adopted' },
        });
    }
    if (journal.state === 'ENGINE_BINDING_ROLLED_BACK') {
        return freezeDeep({
            parent: { ...parent, engineBinding: journal.fromEngineDigest },
            relationship: { ...relationship },
        });
    }
    throw workflowError('ENGINE_ADOPTION_NOT_TERMINAL', 'Adoption can only finalize after commit or durable rollback.', ExitCode.conflict);
}
