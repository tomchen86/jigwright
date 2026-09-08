/**
 * Persists engine adoption transactions, authority renewal, and recovery observations.
 *
 * Invariants:
 * - Adoption authority and history bind the exact parent, artifact, sidecar workflow, and transaction.
 * - Grant verification, record reads, CAS, and publication retain their locked operation order.
 * - Renewal and recovery preserve prior observations and exact current journal state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { readStoredInterventionEngineArtifact } from "./intervention-engine-artifact-store.js";
import { verifyHarnessMaintenanceGrant, prepareEngineAdoption, advanceEngineAdoption, decideEngineAdoptionRecovery, } from "../../modules/authority/intervention-control.js";
import { requireHumanVerifier, persistenceNow, canonicalDigest, withRecordDigest, serializeRecord, assertDigest, adoptionRecordCorrupt, isRecord, hasExactKeys, verifyRecordDigest, validateObservations, exactIso, identityFileName, } from "./intervention-persistence-values.js";
import { withInterventionParentOperation, withPersistenceOperation, } from "./intervention-persistence-locks.js";
import { ensurePersistenceDirectories, engineAdoptionRecordPath, interventionControlPersistencePaths, } from "./intervention-persistence-paths.js";
import { readPersistedIntervention } from "./intervention-plan-store.js";
import { readPersistedBootstrapSidecarWorkflow, recordBootstrapSidecarArtifactReady, } from "./intervention-sidecar-store.js";
import { createPrivateFileExclusive, replacePrivateFileAtomic, readCanonicalRecord, } from "./intervention-persistence-files.js";
import { activeBootstrapMaintenanceWorkflowBindingDigest } from "./intervention-sidecar-records.js";
export function preparePersistedEngineAdoption(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    const now = persistenceNow(dependencies);
    return withInterventionParentOperation(storageRoot, input.parentChangeId, () => {
        ensurePersistenceDirectories(storageRoot);
        const target = engineAdoptionRecordPath(storageRoot, input.txId);
        if (fs.existsSync(target)) {
            throw workflowError('INTERVENTION_ADOPTION_TRANSACTION_EXISTS', 'Engine adoption transaction already exists.', ExitCode.conflict);
        }
        const adoptionHistory = inspectAdoptionHistory(storageRoot, input.parentChangeId, input.maintenanceGrantEnvelope.payload.grantId);
        if (adoptionHistory.inFlightTxIds.length > 0) {
            throw workflowError('INTERVENTION_ADOPTION_ALREADY_ACTIVE', 'Another engine adoption transaction for this parent still requires recovery.', ExitCode.conflict, { details: { txIds: adoptionHistory.inFlightTxIds } });
        }
        const durablePriorAdoptions = adoptionHistory.successfulCount;
        if (input.priorLocalAdoptions !== durablePriorAdoptions) {
            throw workflowError('INTERVENTION_ADOPTION_COUNT_MISMATCH', 'Requested prior adoption count differs from durable history.', ExitCode.staleState);
        }
        const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
        const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(storageRoot, input.parentChangeId);
        const activeBindingDigest = sidecarWorkflow.workflowBinding.workflowBindingDigest;
        if (sidecarWorkflow.workflowBinding.status !== 'repair-active') {
            throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_NOT_ACTIVE', 'Engine adoption requires the active bootstrap-maintenance Workflow.', ExitCode.conflict);
        }
        if (input.artifact.workflowBindingDigest !== undefined &&
            input.artifact.workflowBindingDigest !== activeBindingDigest) {
            throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_MISMATCH', 'Engine adoption artifact is not bound to the exact active bootstrap-maintenance Workflow.', ExitCode.verification);
        }
        let storedArtifact;
        try {
            storedArtifact = readStoredInterventionEngineArtifact(storageRoot, input.artifact.artifactId);
        }
        catch (error) {
            if (error instanceof Error &&
                'code' in error &&
                error.code === 'INTERVENTION_ENGINE_ARTIFACT_NOT_FOUND') {
                storedArtifact = null;
            }
            else {
                throw error;
            }
        }
        if (storedArtifact !== null &&
            (storedArtifact.kind !== 'persisted-intervention-engine-artifact.v2' ||
                storedArtifact.parentChangeId !== input.parentChangeId ||
                storedArtifact.workflowBindingDigest !== activeBindingDigest ||
                canonicalJson(storedArtifact.artifact) !==
                    canonicalJson(input.artifact))) {
            throw workflowError('INTERVENTION_ADOPTION_ARTIFACT_RECORD_MISMATCH', 'Persisted artifact record does not match the exact adoption input and Workflow binding.', ExitCode.verification);
        }
        if (input.artifactAuthority !== undefined &&
            (storedArtifact === null ||
                input.artifactAuthority.recordDigest !==
                    storedArtifact.recordDigest ||
                input.artifactAuthority.createdAt !== storedArtifact.createdAt ||
                input.artifactAuthority.workflowBindingDigest !==
                    storedArtifact.workflowBindingDigest)) {
            throw workflowError('INTERVENTION_ADOPTION_ARTIFACT_AUTHORITY_STALE', 'Persisted artifact authority changed before the parent-scoped adoption reservation.', ExitCode.staleState);
        }
        const artifactAuthority = storedArtifact === null
            ? undefined
            : {
                recordDigest: storedArtifact.recordDigest,
                createdAt: storedArtifact.createdAt,
                workflowBindingDigest: storedArtifact.workflowBindingDigest,
            };
        if (artifactAuthority !== undefined &&
            artifactAuthority.workflowBindingDigest !== activeBindingDigest) {
            throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_MISMATCH', 'Persisted artifact authority is not bound to the exact active bootstrap-maintenance Workflow.', ExitCode.verification);
        }
        const maintenanceGrant = verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature,
        });
        const journal = prepareEngineAdoption({
            txId: input.txId,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            artifact: input.artifact,
            maintenanceGrant,
            priorLocalAdoptions: durablePriorAdoptions,
            now,
            workflowBindingDigest: activeBindingDigest,
            workflowStatus: 'repair-active',
        });
        recordBootstrapSidecarArtifactReady(storageRoot, {
            parentChangeId: input.parentChangeId,
            artifact: input.artifact,
            evidenceDigest: artifactAuthority?.recordDigest ??
                canonicalDigest({
                    kind: 'engine-adoption-workflow-artifact.v1',
                    artifactId: input.artifact.artifactId,
                    sourceDigest: input.artifact.sourceDigest,
                    executableDigest: input.artifact.executableDigest,
                    workflowBindingDigest: activeBindingDigest,
                }),
            readyAt: artifactAuthority?.createdAt ?? now.toISOString(),
        });
        const record = withRecordDigest({
            kind: 'persisted-engine-adoption.v2',
            journal,
            ...(artifactAuthority === undefined
                ? {}
                : { artifactRecordDigest: artifactAuthority.recordDigest }),
            maintenanceGrantEnvelope: input.maintenanceGrantEnvelope,
            grantEnvelopeDigest: canonicalDigest(input.maintenanceGrantEnvelope),
            observations: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            effectsPerformed: false,
        });
        createPrivateFileExclusive(target, serializeRecord(record));
        return record;
    });
}
export function advancePersistedEngineAdoption(storageRoot, input) {
    assertDigest(input.evidenceDigest, 'INTERVENTION_ADOPTION_EVIDENCE_INVALID');
    return withPersistenceOperation(storageRoot, `adoption:${input.txId}`, () => {
        const current = readPersistedEngineAdoption(storageRoot, input.txId);
        assertPersistedAdoptionWorkflowBinding(storageRoot, current);
        if (current.journal.journalDigest !== input.expectedJournalDigest) {
            throw workflowError('INTERVENTION_ADOPTION_CAS_MISMATCH', 'Engine adoption journal changed since it was read.', ExitCode.staleState);
        }
        const fromState = current.journal.state;
        const journal = advanceEngineAdoption(current.journal, input.event);
        const observation = {
            sequence: current.observations.length + 1,
            eventKind: input.event.kind,
            fromState,
            toState: journal.state,
            evidenceDigest: input.evidenceDigest,
            recordedAt: input.event.at,
        };
        const next = withRecordDigest({
            kind: current.kind,
            journal,
            ...(current.artifactRecordDigest === undefined
                ? {}
                : { artifactRecordDigest: current.artifactRecordDigest }),
            maintenanceGrantEnvelope: current.maintenanceGrantEnvelope,
            grantEnvelopeDigest: current.grantEnvelopeDigest,
            observations: [...current.observations, observation],
            createdAt: current.createdAt,
            updatedAt: input.event.at,
            effectsPerformed: false,
        });
        replacePrivateFileAtomic(engineAdoptionRecordPath(storageRoot, input.txId), serializeRecord(next));
        return next;
    });
}
export function renewPersistedEngineAdoptionAuthority(storageRoot, input, dependencies) {
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    const now = persistenceNow(dependencies);
    return withPersistenceOperation(storageRoot, `adoption:${input.txId}`, () => {
        const current = readPersistedEngineAdoption(storageRoot, input.txId);
        assertPersistedAdoptionWorkflowBinding(storageRoot, current);
        if (current.journal.journalDigest !== input.expectedJournalDigest) {
            throw workflowError('INTERVENTION_ADOPTION_CAS_MISMATCH', 'Engine adoption journal changed before maintenance authority renewal.', ExitCode.staleState);
        }
        if (!['PREPARED', 'PARENT_CHECKPOINTED'].includes(current.journal.state)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_TOO_LATE', 'Maintenance authority can only be renewed before the engine binding switches.', ExitCode.conflict);
        }
        const previousPayload = current.maintenanceGrantEnvelope.payload;
        if (previousPayload.grantId !== current.journal.grantId) {
            throw adoptionRecordCorrupt();
        }
        if (now.getTime() < Date.parse(previousPayload.expiresAt)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_NOT_REQUIRED', 'The persisted maintenance authority has not expired.', ExitCode.conflict);
        }
        const intervention = readPersistedIntervention(storageRoot, current.journal.parentChangeId);
        const renewedGrant = verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature,
        });
        const renewedPayload = renewedGrant.payload;
        if (renewedPayload.grantId === previousPayload.grantId) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_GRANT_REUSED', 'Expired maintenance authority must be replaced by a newly issued grant.', ExitCode.conflict);
        }
        if (Date.parse(renewedPayload.issuedAt) <
            Date.parse(previousPayload.expiresAt)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_ISSUANCE_INVALID', 'Renewed maintenance authority must be issued after the previous authority expires.', ExitCode.verification);
        }
        if (canonicalDigest(maintenanceRenewalAuthority(previousPayload)) !==
            canonicalDigest(maintenanceRenewalAuthority(renewedPayload))) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_SCOPE_MISMATCH', 'Renewed maintenance authority differs from the exact persisted adoption authority.', ExitCode.verification);
        }
        const at = now.toISOString();
        if (Date.parse(at) < Date.parse(current.journal.history.at(-1).at)) {
            throw workflowError('INTERVENTION_ADOPTION_REAUTHORIZATION_CLOCK_INVALID', 'Maintenance authority renewal cannot move the adoption journal clock backward.', ExitCode.staleState);
        }
        const { journalDigest: _journalDigest, ...journalPayload } = current.journal;
        const nextJournalPayload = {
            ...journalPayload,
            grantId: renewedPayload.grantId,
            history: [
                ...current.journal.history,
                { state: current.journal.state, at },
            ],
        };
        const journal = {
            ...nextJournalPayload,
            journalDigest: canonicalDigest(nextJournalPayload),
        };
        const renewedEnvelopeDigest = canonicalDigest(input.maintenanceGrantEnvelope);
        const observation = {
            sequence: current.observations.length + 1,
            eventKind: 'maintenance-grant-renewed',
            fromState: current.journal.state,
            toState: current.journal.state,
            evidenceDigest: canonicalDigest({
                kind: 'engine-adoption-authority-renewal.v1',
                previousGrantEnvelopeDigest: current.grantEnvelopeDigest,
                renewedGrantEnvelopeDigest: renewedEnvelopeDigest,
                previousJournalDigest: current.journal.journalDigest,
                renewedJournalDigest: journal.journalDigest,
            }),
            recordedAt: at,
        };
        const next = withRecordDigest({
            kind: current.kind,
            journal,
            ...(current.artifactRecordDigest === undefined
                ? {}
                : { artifactRecordDigest: current.artifactRecordDigest }),
            maintenanceGrantEnvelope: input.maintenanceGrantEnvelope,
            grantEnvelopeDigest: renewedEnvelopeDigest,
            observations: [...current.observations, observation],
            createdAt: current.createdAt,
            updatedAt: at,
            effectsPerformed: false,
        });
        replacePrivateFileAtomic(engineAdoptionRecordPath(storageRoot, input.txId), serializeRecord(next));
        return next;
    });
}
export function recoverPersistedEngineAdoption(storageRoot, txId) {
    const record = readPersistedEngineAdoption(storageRoot, txId);
    assertPersistedAdoptionWorkflowBinding(storageRoot, record);
    return { record, decision: decideEngineAdoptionRecovery(record.journal) };
}
export function rollbackPersistedEngineAdoption(storageRoot, input) {
    const current = readPersistedEngineAdoption(storageRoot, input.txId);
    assertPersistedAdoptionWorkflowBinding(storageRoot, current);
    if (current.journal.state !== 'ROLLBACK_REQUIRED') {
        throw workflowError('INTERVENTION_ADOPTION_ROLLBACK_NOT_REQUIRED', 'Engine adoption is not waiting for a durable binding rollback.', ExitCode.conflict);
    }
    return advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: input.expectedJournalDigest,
        event: { kind: 'engine-binding-rolled-back', at: input.at },
        evidenceDigest: input.evidenceDigest,
    });
}
export function readPersistedEngineAdoption(storageRoot, txId) {
    const value = readCanonicalRecord(engineAdoptionRecordPath(storageRoot, txId), 'INTERVENTION_ADOPTION_NOT_FOUND');
    if (!isRecord(value) ||
        value.kind !== 'persisted-engine-adoption.v2' ||
        !hasExactKeys(value, [
            'createdAt',
            'effectsPerformed',
            'grantEnvelopeDigest',
            'journal',
            'kind',
            'maintenanceGrantEnvelope',
            'observations',
            'recordDigest',
            'updatedAt',
        ].concat(Object.prototype.hasOwnProperty.call(value, 'artifactRecordDigest')
            ? ['artifactRecordDigest']
            : [])) ||
        !verifyRecordDigest(value)) {
        throw adoptionRecordCorrupt();
    }
    const record = value;
    try {
        if (!isRecord(record.journal) ||
            !Object.prototype.hasOwnProperty.call(record.journal, 'workflowBindingDigest') ||
            !Object.prototype.hasOwnProperty.call(record.journal, 'workflowStatus') ||
            record.journal.workflowBindingDigest === undefined ||
            record.journal.workflowStatus !== 'repair-active' ||
            record.journal.txId !== txId ||
            record.effectsPerformed !== false ||
            (record.artifactRecordDigest !== undefined &&
                !/^sha256:[0-9a-f]{64}$/.test(record.artifactRecordDigest)) ||
            canonicalDigest(record.maintenanceGrantEnvelope) !==
                record.grantEnvelopeDigest) {
            throw adoptionRecordCorrupt();
        }
        decideEngineAdoptionRecovery(record.journal);
        validateObservations(record.observations, record.journal.history.length - 1, record.journal.state);
        exactIso(record.createdAt, 'INTERVENTION_ADOPTION_RECORD_CORRUPT');
        exactIso(record.updatedAt, 'INTERVENTION_ADOPTION_RECORD_CORRUPT');
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'INTERVENTION_ADOPTION_RECORD_CORRUPT') {
            throw error;
        }
        throw adoptionRecordCorrupt();
    }
    return record;
}
function assertPersistedAdoptionWorkflowBinding(storageRoot, record) {
    if (record.journal.workflowBindingDigest === undefined ||
        record.journal.workflowStatus !== 'repair-active') {
        throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_REQUIRED', 'Historical adoption metadata cannot cross a bootstrap Workflow authority boundary.', ExitCode.verification);
    }
    const sidecar = readPersistedBootstrapSidecarWorkflow(storageRoot, record.journal.parentChangeId);
    const activeBindingDigest = activeBootstrapMaintenanceWorkflowBindingDigest(sidecar.workflowBinding);
    if (record.journal.workflowBindingDigest !== activeBindingDigest ||
        ![
            sidecar.identity.interventionChangeId,
            sidecar.workflowBinding.changeId,
        ].every((changeId) => changeId === record.journal.interventionChangeId) ||
        (record.journal.state === 'COMMITTED'
            ? !['repair-active', 'adopted'].includes(sidecar.workflowBinding.status)
            : sidecar.workflowBinding.status !== 'repair-active')) {
        throw workflowError('INTERVENTION_ADOPTION_WORKFLOW_BINDING_MISMATCH', 'Persisted adoption no longer matches the exact bootstrap-maintenance Workflow binding and status.', ExitCode.verification);
    }
    return sidecar;
}
function inspectAdoptionHistory(storageRoot, parentChangeId, grantId) {
    const paths = interventionControlPersistencePaths(storageRoot);
    if (!fs.existsSync(paths.adoptions)) {
        return { successfulCount: 0, inFlightTxIds: [] };
    }
    let successfulCount = 0;
    const inFlightTxIds = [];
    for (const name of fs.readdirSync(paths.adoptions).sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) {
            throw workflowError('INTERVENTION_ADOPTION_STORE_UNSAFE', 'Adoption store contains an unexpected entry.', ExitCode.unsafeEnvironment);
        }
        const value = readCanonicalRecord(path.join(paths.adoptions, name), 'INTERVENTION_ADOPTION_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.journal) ||
            typeof value.journal.txId !== 'string' ||
            !isRecord(value.maintenanceGrantEnvelope) ||
            !isRecord(value.maintenanceGrantEnvelope.payload)) {
            throw adoptionRecordCorrupt();
        }
        if (name !== `${identityFileName('adoption', value.journal.txId)}.json`) {
            throw adoptionRecordCorrupt();
        }
        const record = readPersistedEngineAdoption(storageRoot, value.journal.txId);
        if (record.journal.parentChangeId === parentChangeId &&
            !['COMMITTED', 'ENGINE_BINDING_ROLLED_BACK'].includes(record.journal.state)) {
            inFlightTxIds.push(record.journal.txId);
        }
        if (record.maintenanceGrantEnvelope.payload.grantId === grantId &&
            record.journal.state === 'COMMITTED') {
            successfulCount += 1;
        }
    }
    return { successfulCount, inFlightTxIds };
}
export function inFlightPersistedEngineAdoptionTxIds(storageRoot, parentChangeId) {
    return inspectAdoptionHistory(storageRoot, parentChangeId, '').inFlightTxIds;
}
function maintenanceRenewalAuthority(payload) {
    return {
        kind: payload.kind,
        parentChangeId: payload.parentChangeId,
        interventionChangeId: payload.interventionChangeId,
        scope: payload.scope,
        waivers: payload.waivers,
        engineFromDigest: payload.engineFromDigest,
        sessionSchema: payload.sessionSchema,
        maxLocalAdoptions: payload.maxLocalAdoptions,
        reason: payload.reason,
    };
}
