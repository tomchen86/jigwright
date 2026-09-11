/**
 * Normalizes promotion material, recovery bundles and lineage while
 * classifying protected changes.
 *
 * Invariants:
 * - Material identities are computed from verified, normalized promotion
 *   material.
 * - Promotion lineage requires consecutive generations: candidateGeneration
 *   is previousGeneration + 1 and rollbackGeneration is previousGeneration
 *   + 2.
 */
import { hasExactObjectKeys, freezeDeep, assertDigest, canonicalDigest, sameJson, assertSafePath, assertSortedUnique, assertNonEmpty, } from "./intervention-control-values.js";
import path from 'node:path';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { createEngineArtifact, } from "./intervention-control-adoption.js";
import { verifyProtectedManifest, REQUIRED_PROTECTED_CAPABILITIES, } from "./intervention-control-protected-manifest.js";
import { compareCanonicalStrings } from "../../foundation/canonical-json/canonical-json.js";
import crypto from 'node:crypto';
export function normalizeControlPlaneTaskMandateBinding(value) {
    if (!hasExactObjectKeys(value, [
        'changeId',
        'externalAuditRoot',
        'mandateDigest',
        'mandateId',
        'parentTaskId',
        'schemaVersion',
    ])) {
        throw invalidControlPlaneTaskMandateBinding();
    }
    const raw = value;
    if (raw.schemaVersion !== 1 ||
        typeof raw.parentTaskId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.parentTaskId) ||
        typeof raw.mandateId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.mandateId) ||
        typeof raw.mandateDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(raw.mandateDigest) ||
        typeof raw.changeId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.changeId) ||
        typeof raw.externalAuditRoot !== 'string' ||
        !path.isAbsolute(raw.externalAuditRoot) ||
        path.normalize(raw.externalAuditRoot) !== raw.externalAuditRoot ||
        raw.externalAuditRoot === path.parse(raw.externalAuditRoot).root) {
        throw invalidControlPlaneTaskMandateBinding();
    }
    return freezeDeep({
        schemaVersion: 1,
        parentTaskId: raw.parentTaskId,
        mandateId: raw.mandateId,
        mandateDigest: raw.mandateDigest,
        changeId: raw.changeId,
        externalAuditRoot: raw.externalAuditRoot,
    });
}
export function invalidControlPlaneTaskMandateBinding() {
    return workflowError('CONTROL_PLANE_TASK_MANDATE_BINDING_INVALID', 'Control-Plane Grant requires an exact parent Task Mandate binding and absolute external audit root.', ExitCode.guard);
}
// ---------------------------------------------------------------------------
// Control-plane promotion material v1 and material-bound grant/review v2
// ---------------------------------------------------------------------------
export const MAX_CONTROL_PLANE_PROMOTION_BYTES = 64 * 1024 * 1024;
export const MAX_CONTROL_PLANE_PROMOTION_FILE_BYTES = 16 * 1024 * 1024;
export function createControlPlanePromotionLineage(input) {
    const keys = [
        'candidateGeneration',
        'candidateTrustCommit',
        'historyAnchorDigest',
        'previousActiveTrustCommit',
        'previousGeneration',
        'previousSupervisorRecordDigest',
        'previousTerminalRecordDigest',
        'rollbackGeneration',
    ];
    const hasKind = Object.prototype.hasOwnProperty.call(input, 'kind');
    if (!hasExactObjectKeys(input, hasKind ? [...keys, 'kind'] : keys) ||
        (hasKind && input.kind !== 'control-plane-promotion-lineage.v1')) {
        throw promotionLineageError('Unknown promotion lineage schema.');
    }
    for (const digest of [
        input.historyAnchorDigest,
        input.previousTerminalRecordDigest,
        input.previousSupervisorRecordDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_PROMOTION_LINEAGE_INVALID');
    }
    if (!Number.isSafeInteger(input.previousGeneration) ||
        input.previousGeneration < 1 ||
        input.candidateGeneration !== input.previousGeneration + 1 ||
        input.rollbackGeneration !== input.previousGeneration + 2 ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.previousActiveTrustCommit) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.candidateTrustCommit)) {
        throw promotionLineageError('Promotion lineage generations or trust commits are invalid.');
    }
    const payload = {
        kind: 'control-plane-promotion-lineage.v1',
        historyAnchorDigest: input.historyAnchorDigest,
        previousTerminalRecordDigest: input.previousTerminalRecordDigest,
        previousSupervisorRecordDigest: input.previousSupervisorRecordDigest,
        previousGeneration: input.previousGeneration,
        candidateGeneration: input.candidateGeneration,
        rollbackGeneration: input.rollbackGeneration,
        previousActiveTrustCommit: input.previousActiveTrustCommit,
        candidateTrustCommit: input.candidateTrustCommit,
    };
    return freezeDeep({ ...payload, lineageDigest: canonicalDigest(payload) });
}
export function verifyControlPlanePromotionLineage(value) {
    if (!hasExactObjectKeys(value, [
        'candidateGeneration',
        'candidateTrustCommit',
        'historyAnchorDigest',
        'kind',
        'lineageDigest',
        'previousActiveTrustCommit',
        'previousGeneration',
        'previousSupervisorRecordDigest',
        'previousTerminalRecordDigest',
        'rollbackGeneration',
    ])) {
        throw promotionLineageError('Unknown promotion lineage schema.');
    }
    const lineage = value;
    assertDigest(lineage.lineageDigest, 'CONTROL_PLANE_PROMOTION_LINEAGE_INVALID');
    const rebuilt = createControlPlanePromotionLineage({
        kind: lineage.kind,
        historyAnchorDigest: lineage.historyAnchorDigest,
        previousTerminalRecordDigest: lineage.previousTerminalRecordDigest,
        previousSupervisorRecordDigest: lineage.previousSupervisorRecordDigest,
        previousGeneration: lineage.previousGeneration,
        candidateGeneration: lineage.candidateGeneration,
        rollbackGeneration: lineage.rollbackGeneration,
        previousActiveTrustCommit: lineage.previousActiveTrustCommit,
        candidateTrustCommit: lineage.candidateTrustCommit,
    });
    if (!sameJson(rebuilt, lineage)) {
        throw promotionLineageError('Promotion lineage digest or bytes mismatch.');
    }
    return rebuilt;
}
export function controlPlanePromotionLineageDigest(lineage) {
    return verifyControlPlanePromotionLineage(lineage).lineageDigest;
}
export function promotionLineageError(message) {
    return workflowError('CONTROL_PLANE_PROMOTION_LINEAGE_INVALID', message, ExitCode.guard);
}
export function promotionMaterialError(message) {
    return workflowError('CONTROL_PLANE_PROMOTION_MATERIAL_INVALID', message, ExitCode.guard);
}
export function recoveryMaterialError(message) {
    return workflowError('CONTROL_PLANE_RECOVERY_MATERIAL_INVALID', message, ExitCode.guard);
}
export function normalizedExactChangesV2(value, code = 'CONTROL_PLANE_EXACT_DIFF_INVALID') {
    if (!Array.isArray(value) || value.length === 0) {
        throw workflowError(code, 'Mode-aware candidate exact diff is empty.', ExitCode.usage);
    }
    const normalized = value
        .map((change) => {
        if (!hasExactObjectKeys(change, [
            'afterDigest',
            'afterMode',
            'beforeDigest',
            'beforeMode',
            'path',
        ])) {
            throw workflowError(code, 'Mode-aware exact diff has an unknown schema.', ExitCode.usage);
        }
        assertSafePath(change.path, false, code);
        const beforePresent = change.beforeDigest !== null;
        const afterPresent = change.afterDigest !== null;
        if (beforePresent) {
            assertDigest(change.beforeDigest, code);
        }
        if (afterPresent) {
            assertDigest(change.afterDigest, code);
        }
        if (beforePresent !== (change.beforeMode !== null) ||
            afterPresent !== (change.afterMode !== null) ||
            (change.beforeMode !== null &&
                change.beforeMode !== '100644' &&
                change.beforeMode !== '100755') ||
            (change.afterMode !== null &&
                change.afterMode !== '100644' &&
                change.afterMode !== '100755') ||
            (!beforePresent && !afterPresent) ||
            (change.beforeDigest === change.afterDigest &&
                change.beforeMode === change.afterMode)) {
            throw workflowError(code, 'Mode-aware exact diff has an invalid file state or a no-op.', ExitCode.usage);
        }
        return {
            path: change.path,
            beforeDigest: change.beforeDigest,
            afterDigest: change.afterDigest,
            beforeMode: change.beforeMode,
            afterMode: change.afterMode,
        };
    })
        .sort((left, right) => compareCanonicalStrings(left.path, right.path));
    assertSortedUnique(normalized.map((change) => change.path), code);
    return normalized;
}
export function controlPlaneCandidateDigestV2(changes) {
    return canonicalDigest({
        kind: 'control-plane-candidate.v2',
        changes: normalizedExactChangesV2(changes),
    });
}
export function classifyProtectedCandidateImpactV2(input) {
    verifyProtectedManifest(input.beforeManifest);
    verifyProtectedManifest(input.afterManifest);
    const changes = normalizedExactChangesV2(input.changes);
    const changedPaths = new Set(changes.map((change) => change.path));
    const manifestChanged = changedPaths.has(input.beforeManifest.manifestPath) ||
        input.beforeManifest.manifestDigest !== input.afterManifest.manifestDigest;
    const capabilities = new Set();
    for (const capability of REQUIRED_PROTECTED_CAPABILITIES) {
        const before = input.beforeManifest.entries.find((entry) => entry.capability === capability);
        const after = input.afterManifest.entries.find((entry) => entry.capability === capability);
        const protectedPaths = new Set([
            ...before.entrypoints,
            ...before.dependencies,
            ...after.entrypoints,
            ...after.dependencies,
        ]);
        if (before.closureDigest !== after.closureDigest ||
            [...changedPaths].some((changedPath) => protectedPaths.has(changedPath))) {
            capabilities.add(capability);
        }
    }
    const affectedCapabilities = [...capabilities].sort(compareCanonicalStrings);
    return freezeDeep(manifestChanged || affectedCapabilities.length > 0
        ? {
            class: 'C',
            kind: 'control-plane',
            affectedCapabilities,
            manifestChanged,
        }
        : {
            class: 'A',
            kind: 'ordinary',
            affectedCapabilities: [],
            manifestChanged: false,
        });
}
export function decodeCanonicalPromotionBase64(value, code) {
    if (typeof value !== 'string' ||
        value.length >
            Math.ceil((MAX_CONTROL_PLANE_PROMOTION_FILE_BYTES * 4) / 3) + 4) {
        throw workflowError(code, 'Promotion material contains invalid or oversized base64.', ExitCode.guard);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length > MAX_CONTROL_PLANE_PROMOTION_FILE_BYTES ||
        decoded.toString('base64') !== value) {
        throw workflowError(code, 'Promotion material base64 must be canonical and bounded.', ExitCode.guard);
    }
    return decoded;
}
export function rawPromotionDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
export function normalizeControlPlanePromotionFiles(value, code) {
    if (!Array.isArray(value) || value.length === 0) {
        throw workflowError(code, 'Promotion file inventory is empty.', ExitCode.guard);
    }
    let totalBytes = 0;
    const files = value
        .map((entry) => {
        if (!hasExactObjectKeys(entry, [
            'contentBase64',
            'contentDigest',
            'mode',
            'path',
        ])) {
            throw workflowError(code, 'Promotion file inventory has an unknown schema.', ExitCode.guard);
        }
        const file = entry;
        assertSafePath(file.path, false, code);
        if (file.mode !== '100644' && file.mode !== '100755') {
            throw workflowError(code, 'Promotion file mode is not supported.', ExitCode.guard);
        }
        assertDigest(file.contentDigest, code);
        const content = decodeCanonicalPromotionBase64(file.contentBase64, code);
        totalBytes += content.length;
        if (totalBytes > MAX_CONTROL_PLANE_PROMOTION_BYTES ||
            rawPromotionDigest(content) !== file.contentDigest) {
            throw workflowError(code, 'Promotion file content does not match its digest or size bound.', ExitCode.guard);
        }
        return {
            path: file.path,
            mode: file.mode,
            contentBase64: file.contentBase64,
            contentDigest: file.contentDigest,
        };
    })
        .sort((left, right) => compareCanonicalStrings(left.path, right.path));
    assertSortedUnique(files.map((file) => file.path), code);
    return files;
}
export function normalizePromotionEngineArtifact(value, code) {
    const artifactKeys = [
        'artifactId',
        'canReadSessionSchemas',
        'executableDigest',
        'kind',
        'policySchemaVersion',
        'protocolVersion',
        'smokeReportDigest',
        'sourceChangeId',
        'sourceDigest',
        'writesSessionSchema',
    ];
    if (!hasExactObjectKeys(value, value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'workflowBindingDigest' in value
        ? [...artifactKeys, 'workflowBindingDigest']
        : artifactKeys)) {
        throw workflowError(code, 'Promotion EngineArtifact has an unknown schema.', ExitCode.guard);
    }
    const artifact = value;
    if (artifact.kind !== 'engine-artifact.v1') {
        throw workflowError(code, 'Promotion EngineArtifact kind is not supported.', ExitCode.guard);
    }
    const rebuilt = createEngineArtifact(artifact);
    if (rebuilt.artifactId !== artifact.artifactId) {
        throw workflowError(code, 'Promotion EngineArtifact digest mismatch.', ExitCode.verification);
    }
    return rebuilt;
}
export function assertPromotionFilesMatchChanges(files, changes, side, code) {
    const expected = changes
        .filter((change) => side === 'before'
        ? change.beforeDigest !== null
        : change.afterDigest !== null)
        .map((change) => ({
        path: change.path,
        mode: side === 'before' ? change.beforeMode : change.afterMode,
        contentDigest: side === 'before' ? change.beforeDigest : change.afterDigest,
    }));
    const observed = files.map((file) => ({
        path: file.path,
        mode: file.mode,
        contentDigest: file.contentDigest,
    }));
    if (!sameJson(observed, expected)) {
        throw workflowError(code, `Promotion ${side} file inventory does not match the exact diff and modes.`, ExitCode.verification);
    }
}
export function normalizeAffectedCapabilitiesV2(value, code) {
    if (!Array.isArray(value) ||
        value.some((capability) => !REQUIRED_PROTECTED_CAPABILITIES.includes(capability))) {
        throw workflowError(code, 'Promotion material contains an unknown protected capability.', ExitCode.guard);
    }
    assertSortedUnique(value, code);
    return [...value];
}
export function createControlPlaneRecoveryBundleMaterial(input) {
    if (!hasExactObjectKeys(input, [
        'previousClosureDigest',
        'previousFiles',
        'repositoryId',
        'restartArtifact',
        'restartExecutableBase64',
        'restartExecutableProvenanceDigest',
        'rollbackTestReportBase64',
        'rollbackTestReportDigest',
    ])) {
        throw recoveryMaterialError('Unknown recovery material input schema.');
    }
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID', 'Repository id');
    assertDigest(input.previousClosureDigest, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    const restartArtifact = normalizePromotionEngineArtifact(input.restartArtifact, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    assertDigest(input.restartExecutableProvenanceDigest, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    const previousFiles = normalizeControlPlanePromotionFiles(input.previousFiles, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    const restartExecutable = decodeCanonicalPromotionBase64(input.restartExecutableBase64, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    if (rawPromotionDigest(restartExecutable) !== restartArtifact.executableDigest) {
        throw recoveryMaterialError('Recovery executable does not match the restart EngineArtifact.');
    }
    const rollbackTestReport = decodeCanonicalPromotionBase64(input.rollbackTestReportBase64, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    assertDigest(input.rollbackTestReportDigest, 'CONTROL_PLANE_RECOVERY_MATERIAL_INVALID');
    if (rawPromotionDigest(rollbackTestReport) !== input.rollbackTestReportDigest) {
        throw recoveryMaterialError('Rollback-test evidence digest mismatch.');
    }
    const payload = {
        kind: 'control-plane-recovery-bundle.v2',
        repositoryId: input.repositoryId,
        previousClosureDigest: input.previousClosureDigest,
        restartArtifact,
        restartExecutableBase64: input.restartExecutableBase64,
        restartExecutableProvenanceDigest: input.restartExecutableProvenanceDigest,
        previousFiles,
        rollbackTestReportBase64: input.rollbackTestReportBase64,
        rollbackTestReportDigest: input.rollbackTestReportDigest,
    };
    return freezeDeep({ ...payload, bundleDigest: canonicalDigest(payload) });
}
export function verifyControlPlaneRecoveryBundleMaterial(value) {
    if (!hasExactObjectKeys(value, [
        'bundleDigest',
        'kind',
        'previousClosureDigest',
        'previousFiles',
        'repositoryId',
        'restartArtifact',
        'restartExecutableBase64',
        'restartExecutableProvenanceDigest',
        'rollbackTestReportBase64',
        'rollbackTestReportDigest',
    ])) {
        throw recoveryMaterialError('Unknown recovery material schema.');
    }
    const material = value;
    if (material.kind !== 'control-plane-recovery-bundle.v2') {
        throw recoveryMaterialError('Unknown recovery material kind.');
    }
    const rebuilt = createControlPlaneRecoveryBundleMaterial({
        repositoryId: material.repositoryId,
        previousClosureDigest: material.previousClosureDigest,
        restartArtifact: material.restartArtifact,
        restartExecutableBase64: material.restartExecutableBase64,
        restartExecutableProvenanceDigest: material.restartExecutableProvenanceDigest,
        previousFiles: material.previousFiles,
        rollbackTestReportBase64: material.rollbackTestReportBase64,
        rollbackTestReportDigest: material.rollbackTestReportDigest,
    });
    if (!sameJson(rebuilt, material)) {
        throw recoveryMaterialError('Recovery material digest or bytes mismatch.');
    }
    return rebuilt;
}
export function createControlPlanePromotionMaterial(input) {
    const keys = [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateArtifact',
        'candidateDigest',
        'candidateExecutableBase64',
        'candidateExecutableProvenanceDigest',
        'candidateFiles',
        'exactChanges',
        'frozenCandidateBundleDigest',
        'mandateBinding',
        'recoveryBundle',
        'repositoryId',
    ];
    const hasKind = Object.prototype.hasOwnProperty.call(input, 'kind');
    if (!hasExactObjectKeys(input, hasKind ? [...keys, 'kind'] : keys) ||
        (hasKind && input.kind !== 'control-plane-promotion-material.v1')) {
        throw promotionMaterialError('Unknown promotion material schema.');
    }
    const mandateBinding = normalizeControlPlaneTaskMandateBinding(input.mandateBinding);
    assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID', 'Repository id');
    assertNonEmpty(input.behaviorChangeSummary, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID', 'Behavior change summary');
    for (const digest of [
        input.frozenCandidateBundleDigest,
        input.candidateDigest,
        input.beforeClosureDigest,
        input.afterClosureDigest,
        input.candidateExecutableProvenanceDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    }
    const exactChanges = normalizedExactChangesV2(input.exactChanges, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    if (input.candidateDigest !== controlPlaneCandidateDigestV2(exactChanges)) {
        throw promotionMaterialError('Promotion candidate digest does not match the mode-aware exact diff.');
    }
    const affectedCapabilities = normalizeAffectedCapabilitiesV2(input.affectedCapabilities, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    const candidateArtifact = normalizePromotionEngineArtifact(input.candidateArtifact, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    if (candidateArtifact.sourceChangeId !== mandateBinding.changeId) {
        throw promotionMaterialError('Candidate EngineArtifact is not bound to the Task Mandate change.');
    }
    const candidateExecutable = decodeCanonicalPromotionBase64(input.candidateExecutableBase64, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    const candidateFiles = normalizeControlPlanePromotionFiles(input.candidateFiles, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    const recoveryBundle = verifyControlPlaneRecoveryBundleMaterial(input.recoveryBundle);
    if (recoveryBundle.repositoryId !== input.repositoryId ||
        recoveryBundle.previousClosureDigest !== input.beforeClosureDigest) {
        throw promotionMaterialError('Recovery material is not bound to the repository and old closure.');
    }
    assertPromotionFilesMatchChanges(candidateFiles, exactChanges, 'after', 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    assertPromotionFilesMatchChanges(recoveryBundle.previousFiles, exactChanges, 'before', 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID');
    if (rawPromotionDigest(candidateExecutable) !==
        candidateArtifact.executableDigest) {
        throw promotionMaterialError('Candidate executable does not match the candidate EngineArtifact.');
    }
    return freezeDeep({
        kind: 'control-plane-promotion-material.v1',
        mandateBinding,
        repositoryId: input.repositoryId,
        frozenCandidateBundleDigest: input.frozenCandidateBundleDigest,
        candidateDigest: input.candidateDigest,
        beforeClosureDigest: input.beforeClosureDigest,
        afterClosureDigest: input.afterClosureDigest,
        affectedCapabilities,
        behaviorChangeSummary: input.behaviorChangeSummary,
        exactChanges,
        candidateArtifact,
        candidateExecutableBase64: input.candidateExecutableBase64,
        candidateExecutableProvenanceDigest: input.candidateExecutableProvenanceDigest,
        candidateFiles,
        recoveryBundle,
    });
}
export function verifyControlPlanePromotionMaterial(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'behaviorChangeSummary',
        'candidateArtifact',
        'candidateDigest',
        'candidateExecutableBase64',
        'candidateExecutableProvenanceDigest',
        'candidateFiles',
        'exactChanges',
        'frozenCandidateBundleDigest',
        'kind',
        'mandateBinding',
        'recoveryBundle',
        'repositoryId',
    ])) {
        throw promotionMaterialError('Unknown promotion material schema.');
    }
    const rebuilt = createControlPlanePromotionMaterial(value);
    if (!sameJson(rebuilt, value)) {
        throw promotionMaterialError('Promotion material is not canonical.');
    }
    return rebuilt;
}
/**
 * This digest deliberately excludes every review or grant signature. A reviewer
 * signs this complete executable/artifact/recovery material; the later grant
 * can then bind both this digest and the final bundle (which includes review
 * bytes) without a signature cycle.
 */
export function controlPlanePromotionMaterialDigest(material) {
    return canonicalDigest(verifyControlPlanePromotionMaterial(material));
}
