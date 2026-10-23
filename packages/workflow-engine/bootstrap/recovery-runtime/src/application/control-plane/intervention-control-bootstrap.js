export { capturePersistedWipIntervention, discoverBootstrapUntrackedAllowlist, persistTrustedBootstrapSessionSnapshot, readPersistedWipBundle, restorePersistedWipBundle, };
/**
 * Executes persisted engine adoption steps through intervention bootstrap
 * ports.
 *
 * Invariants:
 * - The executable and artifact must match the exact persisted adoption
 *   record.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterventionBootstrapAbandonment } from "./intervention-bootstrap-abandonment.js";
import { createInterventionBootstrapChildWorktree } from "./intervention-bootstrap-child-worktree.js";
import { createInterventionBootstrapEngine } from "./intervention-bootstrap-engine.js";
import { createInterventionBootstrapStorage } from "./intervention-bootstrap-storage.js";
import { createInterventionBootstrapWorkspace } from "./intervention-bootstrap-workspace.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError, } from "../../foundation/errors/errors.js";
import { createWipCheckpoint, verifyHarnessMaintenanceGrant, } from "../../modules/authority/intervention-control.js";
import { ensurePlainDirectory } from "../../runtime/repository-transaction/filesystem-safety.js";
import { advancePersistedEngineAdoption, inFlightPersistedEngineAdoptionTxIds, interventionControlPersistencePaths, interventionRecordPath, persistInterventionPlan, readPersistedIntervention, recordBootstrapSidecarAbandoned, recordBootstrapSidecarAdopted, recordBootstrapSidecarWorkspaceMaterialized, recoverPersistedEngineAdoption, rollbackPersistedEngineAdoption, withInterventionParentOperation, } from "../../runtime/storage-journal/intervention-control-persistence.js";
import { readStoredInterventionEngineArtifact } from "../../runtime/storage-journal/intervention-engine-artifact-store.js";
const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const ENGINE_COMMAND_TIMEOUT_MS = 10_000;
const PRIVATE_EXECUTABLE_MODE = 0o500;
export function executePersistedAdoptionStep(storageRoot, input, dependencies) {
    const verifier = requireHumanVerifier(dependencies);
    const now = bootstrapNow(dependencies);
    exactIso(input.at, 'BOOTSTRAP_ADOPTION_TIMESTAMP_INVALID');
    const recovered = recoverPersistedEngineAdoption(storageRoot, input.txId);
    const current = recovered.record;
    if (current.artifactRecordDigest !== undefined) {
        const storedArtifact = readStoredInterventionEngineArtifact(storageRoot, current.journal.artifactId);
        if (storedArtifact.kind !== 'persisted-intervention-engine-artifact.v2' ||
            storedArtifact.recordDigest !== current.artifactRecordDigest ||
            (input.artifactRecordDigest !== undefined &&
                input.artifactRecordDigest !== storedArtifact.recordDigest) ||
            canonicalJson(storedArtifact.artifact) !==
                canonicalJson(input.artifact) ||
            storedArtifact.executablePath !== input.executablePath) {
            throw workflowError('BOOTSTRAP_ENGINE_ARTIFACT_RECORD_MISMATCH', 'Bootstrap execution requires the exact persisted artifact record bound by the adoption.', ExitCode.verification);
        }
    }
    if (current.journal.journalDigest !== input.expectedJournalDigest) {
        throw workflowError('BOOTSTRAP_ADOPTION_CAS_MISMATCH', 'Adoption journal changed before bootstrap execution.', ExitCode.staleState);
    }
    const intervention = readPersistedIntervention(storageRoot, current.journal.parentChangeId);
    if ([
        'start-new-engine',
        'run-health-check',
        'finalize-commit',
        'rollback-engine-binding',
        'none',
    ].includes(recovered.decision.action)) {
        verifyPersistedMaintenanceGrantForRecovery(current.maintenanceGrantEnvelope, intervention, current.journal, verifier);
    }
    else {
        verifyHarnessMaintenanceGrant(current.maintenanceGrantEnvelope, {
            now,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: verifier,
        });
    }
    assertEngineArtifactIntegrity(input.artifact);
    if (input.artifact.artifactId !== current.journal.artifactId ||
        input.artifact.executableDigest !== current.journal.toEngineDigest ||
        input.artifact.writesSessionSchema !== current.journal.sessionSchema ||
        input.artifact.sourceChangeId !== current.journal.interventionChangeId ||
        (input.artifact.workflowBindingDigest !== undefined &&
            input.artifact.workflowBindingDigest !==
                current.journal.workflowBindingDigest)) {
        throw workflowError('BOOTSTRAP_ENGINE_ARTIFACT_MISMATCH', 'Engine artifact differs from the persisted adoption journal.', ExitCode.verification);
    }
    const bindingPath = assertPersistenceOwnedPath(storageRoot, input.bindingPath, 'BOOTSTRAP_BINDING_OUTSIDE_STATE');
    const binding = readLocalEngineBinding(bindingPath);
    if (binding.parentChangeId !== current.journal.parentChangeId ||
        binding.parentWorkspacePath !==
            intervention.childWorkspace.parentWorkspacePath ||
        binding.parentBranch !==
            `refs/heads/work/${current.journal.parentChangeId}` ||
        binding.interventionChangeId !== current.journal.interventionChangeId ||
        binding.txId !== current.journal.txId ||
        binding.checkpointId !== current.journal.checkpointId ||
        binding.sessionSchema !== current.journal.sessionSchema ||
        binding.activeArtifact.artifactId !== current.journal.artifactId ||
        binding.activeArtifact.executableDigest !==
            current.journal.toEngineDigest ||
        binding.activeArtifact.executablePath !==
            localEngineArtifactPath(storageRoot, current.journal.artifactId) ||
        (binding.interventionState === 'adopted' &&
            !['HEALTHY', 'COMMITTED'].includes(current.journal.state)) ||
        (current.journal.state === 'COMMITTED' &&
            binding.interventionState !== 'adopted')) {
        throw workflowError('BOOTSTRAP_BINDING_MISMATCH', 'Local engine binding does not belong to this adoption transaction.', ExitCode.verification);
    }
    const materializedExecutable = materializeLocalEngineExecutable(storageRoot, intervention, input.artifact, input.executablePath);
    const beforeJournalDigest = current.journal.journalDigest;
    let next;
    let evidence;
    let effectsPerformed = false;
    switch (recovered.decision.action) {
        case 'checkpoint-parent': {
            const bundle = readPersistedWipBundle(storageRoot, current.journal.checkpointId);
            assertCheckpointMatchesBundle(intervention, bundle);
            const restore = restorePersistedWipBundle(storageRoot, {
                parentChangeId: current.journal.parentChangeId,
                repositoryRoot: intervention.childWorkspace.parentWorkspacePath,
                sessionSnapshotPath: bundle.session.snapshotPath,
                maintenanceGrantEnvelope: current.maintenanceGrantEnvelope,
            }, dependencies);
            evidence = {
                action: 'checkpoint-parent',
                bundleDigest: bundle.bundleDigest,
                restoreReceiptDigest: restore.receiptDigest,
            };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'parent-checkpointed', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'update-engine-binding': {
            const updated = ensureBindingEngine(bindingPath, binding, current.journal.fromEngineDigest, current.journal.toEngineDigest, input.at);
            effectsPerformed = updated.recordDigest !== binding.recordDigest;
            dependencies.testHooks?.afterBindingUpdatedBeforeJournal?.();
            evidence = {
                action: 'update-engine-binding',
                beforeBindingDigest: binding.recordDigest,
                afterBindingDigest: updated.recordDigest,
            };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'engine-binding-updated', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'start-new-engine': {
            assertBindingEngine(binding, current.journal.toEngineDigest);
            const probe = runEngineExecutable(materializedExecutable, input.artifact.executableDigest, '--bootstrap-probe');
            if (probe.kind !== 'engine-bootstrap-probe.v1' ||
                probe.started !== true ||
                probe.sessionSchema !== current.journal.sessionSchema) {
                throw workflowError('BOOTSTRAP_ENGINE_START_FAILED', 'New engine bootstrap probe did not report a compatible start.', ExitCode.verification);
            }
            effectsPerformed = true;
            evidence = { action: 'start-new-engine', probe };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'new-engine-started', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'run-health-check': {
            assertBindingEngine(binding, current.journal.toEngineDigest);
            const health = runEngineExecutable(materializedExecutable, input.artifact.executableDigest, '--health-check');
            if (health.kind !== 'engine-health.v1' ||
                typeof health.healthy !== 'boolean' ||
                health.sessionSchema !== current.journal.sessionSchema) {
                throw workflowError('BOOTSTRAP_ENGINE_HEALTH_INVALID', 'Engine health check returned an invalid contract.', ExitCode.verification);
            }
            effectsPerformed = true;
            evidence = { action: 'run-health-check', health };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: {
                    kind: health.healthy ? 'health-check-passed' : 'health-check-failed',
                    at: input.at,
                },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'finalize-commit': {
            assertBindingEngine(binding, current.journal.toEngineDigest);
            const finalized = ensureBindingAdoptionFinalized(bindingPath, binding, current.journal.checkpointId, current.journal.interventionChangeId, input.at);
            effectsPerformed = finalized.recordDigest !== binding.recordDigest;
            evidence = {
                action: 'finalize-commit',
                beforeBindingDigest: binding.recordDigest,
                afterBindingDigest: finalized.recordDigest,
                blockerCleared: finalized.blocker === null,
            };
            next = advancePersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                event: { kind: 'commit', at: input.at },
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'rollback-engine-binding': {
            const rolledBack = ensureBindingEngine(bindingPath, binding, current.journal.toEngineDigest, current.journal.fromEngineDigest, input.at);
            effectsPerformed = rolledBack.recordDigest !== binding.recordDigest;
            evidence = {
                action: 'rollback-engine-binding',
                beforeBindingDigest: binding.recordDigest,
                afterBindingDigest: rolledBack.recordDigest,
            };
            next = rollbackPersistedEngineAdoption(storageRoot, {
                txId: input.txId,
                expectedJournalDigest: beforeJournalDigest,
                at: input.at,
                evidenceDigest: canonicalDigest(evidence),
            });
            break;
        }
        case 'none': {
            assertBindingEngine(binding, recovered.decision.authoritativeEngineDigest);
            evidence = { action: 'none', journalDigest: beforeJournalDigest };
            next = current;
            break;
        }
    }
    const evidenceDigest = canonicalDigest(evidence);
    const recordedAt = recovered.decision.action === 'none'
        ? (current.journal.history.at(-1)?.at ?? input.at)
        : input.at;
    const receiptPayload = {
        kind: 'bootstrap-adoption-step-receipt.v1',
        txId: input.txId,
        action: recovered.decision.action,
        beforeJournalDigest,
        afterJournalDigest: next.journal.journalDigest,
        evidenceDigest,
        recordedAt,
        effectsPerformed,
    };
    const receipt = {
        ...receiptPayload,
        receiptDigest: canonicalDigest(receiptPayload),
    };
    persistBootstrapReceipt(storageRoot, `adoption-${input.txId}-${beforeJournalDigest}-${recovered.decision.action}`, receipt);
    if (next.journal.state === 'COMMITTED' &&
        recovered.decision.action !== 'none') {
        dependencies.testHooks?.afterAdoptionReceiptPersistedBeforeSidecar?.();
    }
    if (next.journal.state === 'COMMITTED') {
        recordBootstrapSidecarAdopted(storageRoot, {
            parentChangeId: next.journal.parentChangeId,
            txId: next.journal.txId,
            artifact: input.artifact,
            journalDigest: next.journal.journalDigest,
            adoptedAt: next.journal.history.at(-1).at,
        });
    }
    return { record: next, receipt };
}
function decodeCanonicalBase64(value) {
    if (typeof value !== 'string' ||
        value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw corruptWipBundle();
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) {
        throw corruptWipBundle();
    }
    return decoded;
}
function rawDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function canonicalDigest(value) {
    return rawDigest(Buffer.from(canonicalJson(value)));
}
function verifyPersistedMaintenanceGrantForRecovery(envelope, intervention, journal, verifier) {
    const payload = envelope.payload;
    if (payload.grantId !== journal.grantId ||
        payload.parentChangeId !== journal.parentChangeId ||
        payload.interventionChangeId !== journal.interventionChangeId ||
        payload.engineFromDigest !== journal.fromEngineDigest ||
        payload.sessionSchema !== journal.sessionSchema ||
        journal.checkpointId !== intervention.checkpoint.checkpointId) {
        throw workflowError('BOOTSTRAP_RECOVERY_GRANT_INVALID', 'Persisted recovery grant no longer matches the adoption journal.', ExitCode.verification);
    }
    try {
        const issuedAt = new Date(payload.issuedAt);
        if (!Number.isFinite(issuedAt.getTime())) {
            throw new Error('invalid issuedAt');
        }
        // An already-prepared transaction must remain safely recoverable after
        // expiry. Revalidate every grant binding and the human signature at its
        // original issue time, while deliberately omitting only the live TTL gate.
        verifyHarnessMaintenanceGrant(envelope, {
            now: issuedAt,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: verifier,
        });
    }
    catch {
        throw workflowError('BOOTSTRAP_RECOVERY_GRANT_INVALID', 'Persisted recovery grant failed binding or signature verification.', ExitCode.verification);
    }
}
function requireHumanVerifier(dependencies) {
    if (dependencies.verifyHumanSignature === undefined) {
        throw workflowError('BOOTSTRAP_HUMAN_VERIFIER_REQUIRED', 'Bootstrap effect requires a trusted human grant verifier.', ExitCode.guard);
    }
    return dependencies.verifyHumanSignature;
}
function bootstrapNow(dependencies) {
    return exactDate(dependencies.now?.() ?? new Date(), 'BOOTSTRAP_CLOCK_INVALID');
}
function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError(code, 'Bootstrap clock is invalid.', ExitCode.unsafeEnvironment);
    }
    return new Date(value.getTime());
}
function exactIso(value, code) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw workflowError(code, 'Bootstrap timestamp is invalid.', ExitCode.verification);
    }
}
function assertDigest(value, code) {
    if (!isDigest(value)) {
        throw workflowError(code, 'Expected a canonical sha256 digest.', ExitCode.usage);
    }
}
function isDigest(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function assertGitOid(value, code) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
        throw workflowError(code, 'Expected a full Git object id.', ExitCode.verification);
    }
}
function assertNonEmpty(value, code) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0) {
        throw workflowError(code, 'Expected a non-empty trimmed string.', ExitCode.usage);
    }
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function corruptWipBundle() {
    return workflowError('BOOTSTRAP_WIP_BUNDLE_CORRUPT', 'Persisted WIP bundle failed integrity verification.', ExitCode.verification);
}
function corruptBinding() {
    return workflowError('BOOTSTRAP_BINDING_CORRUPT', 'Local engine binding failed integrity verification.', ExitCode.verification);
}
const { discoverBootstrapUntrackedAllowlist, persistTrustedBootstrapSessionSnapshot, capturePersistedWipIntervention, readPersistedWipBundle, restorePersistedWipBundle, assertCheckpointMatchesBundle, } = createInterventionBootstrapWorkspace(() => ({
    canonicalRepositoryRoot,
    canonicalJson,
    MAX_SESSION_BYTES,
    workflowError,
    ExitCode,
    rawDigest,
    path,
    interventionControlPersistencePaths,
    createPrivateFileExclusive,
    isNodeError,
    readPrivateBytes,
    exactDate,
    gitText,
    assertGitOid,
    assertDigest,
    assertNonEmpty,
    gitBuffer,
    MAX_PATCH_BYTES,
    canonicalPlainFile,
    assertPersistenceOwnedPath,
    fs,
    canonicalDigest,
    createWipCheckpoint,
    persistInterventionPlan,
    canonicalPlannedWorkspacePath,
    readCanonicalPrivateJson,
    wipBundlePath,
    MAX_BUNDLE_BYTES,
    isRecord,
    hasExactKeys,
    corruptWipBundle,
    decodeCanonicalBase64,
    assertSafeRelativePath,
    exactIso,
    requireHumanVerifier,
    bootstrapNow,
    readPersistedIntervention,
    verifyHarnessMaintenanceGrant,
    bootstrapReceiptPath,
    readBootstrapReceipt,
    readOptionalPlainFile,
    writePrivateFileAtomic,
    persistBootstrapReceipt,
    safeRepositoryPath,
    gitBufferNoThrow,
    ensureSafeParentDirectories,
    MAX_UNTRACKED_FILE_BYTES,
    MAX_UNTRACKED_TOTAL_BYTES,
    bootstrapBundleDirectory,
    ensurePrivateDirectory,
    isPathInside,
}));
const { assertPersistedInterventionAbandonable, abandonPersistedIntervention } = createInterventionBootstrapAbandonment(() => ({
    readPersistedIntervention,
    withInterventionParentOperation,
    assertDigest,
    assertNonEmpty,
    exactIso,
    assertPersistenceOwnedPath,
    canonicalDigest,
    createPrivateFileExclusive,
    canonicalJson,
    workflowError,
    ExitCode,
    fs,
    fsyncDirectory,
    path,
    interventionRecordPath,
    recordBootstrapSidecarAbandoned,
    inFlightPersistedEngineAdoptionTxIds,
    isHarnessInterventionBlocker,
    recoverPersistedEngineAdoption,
    readLocalEngineBinding,
    crypto,
    interventionControlPersistencePaths,
    readCanonicalPrivateJson,
    MAX_BUNDLE_BYTES,
    isRecord,
    hasExactKeys,
    isDigest,
}));
export { abandonPersistedIntervention, assertPersistedInterventionAbandonable };
const { localEngineArtifactPath, bindingStateRoot, bootstrapBundleDirectory, wipBundlePath, bootstrapReceiptPath, persistBootstrapReceipt, readBootstrapReceipt, canonicalRepositoryRoot, canonicalPlannedWorkspacePath, canonicalPlainFile, canonicalAbsolutePath, assertPersistenceOwnedPath, assertSafeRelativePath, safeRepositoryPath, ensureSafeParentDirectories, isPathInside, gitBuffer, gitBufferNoThrow, gitText, gitRefExists, createPrivateFileExclusive, createPrivateExecutableExclusive, assertPrivateLocalEngineExecutable, writePrivateFileAtomic, replacePrivateFileAtomic, ensurePrivateDirectory, readCanonicalPrivateJson, readPrivateBytes, readOptionalPlainFile, fsyncDirectory, } = createInterventionBootstrapStorage(() => ({
    assertDigest,
    path,
    interventionControlPersistencePaths,
    crypto,
    canonicalJson,
    fs,
    workflowError,
    ExitCode,
    isRecord,
    isDigest,
    canonicalDigest,
    spawnSync,
    MAX_BUNDLE_BYTES,
    PRIVATE_EXECUTABLE_MODE,
    MAX_UNTRACKED_FILE_BYTES,
    rawDigest,
    readLocalEngineBinding,
    ensurePlainDirectory,
}));
export { localEngineArtifactPath };
const { materializeInterventionChildWorktree } = createInterventionBootstrapChildWorktree(() => ({
    requireHumanVerifier,
    bootstrapNow,
    readPersistedIntervention,
    verifyHarnessMaintenanceGrant,
    canonicalRepositoryRoot,
    workflowError,
    ExitCode,
    readPersistedWipBundle,
    bootstrapReceiptPath,
    fs,
    readBootstrapReceipt,
    recordBootstrapSidecarWorkspaceMaterialized,
    gitRefExists,
    gitBuffer,
    gitBufferNoThrow,
    canonicalDigest,
    persistBootstrapReceipt,
    gitText,
    path,
    isPathInside,
}));
export { materializeInterventionChildWorktree };
const { initializeLocalEngineBinding, readLocalEngineBinding, rebindLocalEngineAfterRolledBackAdoption, assertEngineArtifactIntegrity, materializeLocalEngineExecutable, runEngineExecutable, ensureBindingEngine, ensureBindingAdoptionFinalized, assertBindingEngine, isHarnessInterventionBlocker, } = createInterventionBootstrapEngine(() => ({
    assertNonEmpty,
    assertDigest,
    canonicalRepositoryRoot,
    gitText,
    localEngineArtifactPath,
    workflowError,
    ExitCode,
    exactDate,
    canonicalDigest,
    createPrivateFileExclusive,
    assertPersistenceOwnedPath,
    canonicalJson,
    readCanonicalPrivateJson,
    canonicalAbsolutePath,
    isRecord,
    hasExactKeys,
    corruptBinding,
    isDigest,
    bindingStateRoot,
    exactIso,
    replacePrivateFileAtomic,
    fs,
    assertPrivateLocalEngineExecutable,
    canonicalPlainFile,
    MAX_UNTRACKED_FILE_BYTES,
    isPathInside,
    rawDigest,
    createPrivateExecutableExclusive,
    path,
    spawnSync,
    ENGINE_COMMAND_TIMEOUT_MS,
}));
export { initializeLocalEngineBinding, readLocalEngineBinding, rebindLocalEngineAfterRolledBackAdoption, };
