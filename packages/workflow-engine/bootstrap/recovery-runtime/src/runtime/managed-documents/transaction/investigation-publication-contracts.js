/**
 * Validates publication envelopes and binds manifest authority to one investigation lifecycle.
 *
 * Invariants:
 * - Snapshots, refs, and failure observations retain exact fields and lifecycle identity.
 * - Namespace and failure-emission digests retain their canonical input bytes.
 *
 * Depends on: investigation manifest validation and publication value primitives.
 * Failure modes: foreign lifecycle authority, invalid recovery records, or changed failure evidence.
 */
import { digest, isCanonicalPublicationRelativePath, hasExactKeys, DIGEST, publicationFailureSourceInvalid, deepFreeze, isBoundedPublicationPath, publicationFailure, prefixedDigest, } from "./investigation-publication-values.js";
import { parseInvestigationV3Blocker, } from "../../../modules/investigation/manifest/investigation-manifest.js";
import { isRecord } from "../../../foundation/canonical-json/contract-values.js";
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
export function investigationManifestPublicationNamespace(identity) {
    return `investigation-v3-publication/${digest({
        schema: 'investigation-manifest-publication-namespace.v1',
        repositoryId: identity.repositoryId,
        changeId: identity.changeId,
        investigationId: identity.investigationId,
    })}`;
}
export function investigationManifestPublicationSourceMatchesLifecycle(source, lifecycle) {
    const namespace = investigationManifestPublicationNamespace(lifecycle);
    const marker = `${namespace}/`;
    const namespaceRoot = (candidate) => {
        if (!isCanonicalPublicationRelativePath(candidate)) {
            return null;
        }
        const offset = candidate.indexOf(marker);
        if (offset < 0 || (offset > 0 && candidate[offset - 1] !== '/')) {
            return null;
        }
        return candidate.slice(0, offset + namespace.length);
    };
    if (source.operation === 'read-ref') {
        return namespaceRoot(source.currentRefPath) !== null;
    }
    const privateRoots = [
        namespaceRoot(source.paths.currentRefPath),
        namespaceRoot(source.paths.journalPath),
    ];
    if (privateRoots[0] === null ||
        privateRoots.some((root) => root !== privateRoots[0])) {
        return false;
    }
    const manifestNamespaceRoot = namespaceRoot(source.paths.manifestPath);
    return (manifestNamespaceRoot === privateRoots[0] ||
        (isCanonicalPublicationRelativePath(source.paths.manifestPath) &&
            source.paths.manifestPath ===
                `openspec/changes/${lifecycle.changeId}/investigation.json`));
}
export function assertInvestigationManifestPublicationFailure(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'lifecycle',
            'blocker',
            'source',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'investigation-manifest-publication-failure' ||
        !isRecord(value.lifecycle) ||
        !hasExactKeys(value.lifecycle, [
            'repositoryId',
            'changeId',
            'investigationId',
            'sessionRevision',
            'sessionSnapshotDigest',
        ]) ||
        !isRecord(value.source) ||
        !hasExactKeys(value.source, [
            'schemaVersion',
            'observation',
            'failureIdentity',
            'emittedPublicationStateDigest',
            'emittedGitStateDigest',
            'recoveryPolicy',
            'emissionDigest',
        ]) ||
        value.source.schemaVersion !== 1 ||
        typeof value.source.failureIdentity !== 'string' ||
        !DIGEST.test(value.source.failureIdentity) ||
        typeof value.source.emittedPublicationStateDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.source.emittedPublicationStateDigest) ||
        typeof value.source.emittedGitStateDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.source.emittedGitStateDigest) ||
        (value.source.recoveryPolicy !== 'central-grant' &&
            value.source.recoveryPolicy !== 'idempotent-post-ref') ||
        typeof value.source.emissionDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.source.emissionDigest)) {
        throw publicationFailureSourceInvalid('Investigation v3 publication failure is malformed.');
    }
    const lifecycle = assertPublicationFailureLifecycle(value.lifecycle);
    const blocker = parseInvestigationV3Blocker(value.blocker);
    const observation = assertPublicationObservationSource(value.source.observation);
    if (!investigationManifestPublicationSourceMatchesLifecycle(observation, lifecycle)) {
        throw publicationFailureSourceInvalid('Investigation v3 publication source is outside its lifecycle namespace.');
    }
    const sourceWithoutEmission = {
        schemaVersion: 1,
        observation,
        failureIdentity: value.source.failureIdentity,
        emittedPublicationStateDigest: value.source
            .emittedPublicationStateDigest,
        emittedGitStateDigest: value.source
            .emittedGitStateDigest,
        recoveryPolicy: value.source.recoveryPolicy,
    };
    const parsed = deepFreeze({
        schemaVersion: 1,
        kind: 'investigation-manifest-publication-failure',
        lifecycle,
        blocker,
        source: {
            ...sourceWithoutEmission,
            emissionDigest: value.source.emissionDigest,
        },
    });
    if (parsed.source.failureIdentity !== parsed.blocker.failureIdentity ||
        investigationManifestPublicationFailureEmissionDigest({
            schemaVersion: parsed.schemaVersion,
            kind: parsed.kind,
            lifecycle: parsed.lifecycle,
            blocker: parsed.blocker,
            source: sourceWithoutEmission,
        }) !== parsed.source.emissionDigest) {
        throw publicationFailureSourceInvalid('Investigation v3 publication blocker and source do not match.');
    }
    return parsed;
}
function assertPublicationFailureLifecycle(value) {
    if (typeof value.repositoryId !== 'string' ||
        value.repositoryId.length === 0 ||
        value.repositoryId.trim() !== value.repositoryId ||
        Buffer.byteLength(value.repositoryId) > 256 ||
        /[\0\r\n]/.test(value.repositoryId) ||
        typeof value.changeId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
        typeof value.investigationId !== 'string' ||
        !/^investigation-[a-zA-Z0-9-]+$/.test(value.investigationId) ||
        typeof value.sessionRevision !== 'number' ||
        !Number.isSafeInteger(value.sessionRevision) ||
        value.sessionRevision < 0 ||
        typeof value.sessionSnapshotDigest !== 'string' ||
        !DIGEST.test(value.sessionSnapshotDigest)) {
        throw publicationFailureSourceInvalid('Investigation v3 publication lifecycle is malformed.');
    }
    return deepFreeze({
        repositoryId: value.repositoryId,
        changeId: value.changeId,
        investigationId: value.investigationId,
        sessionRevision: value.sessionRevision,
        sessionSnapshotDigest: value.sessionSnapshotDigest,
    });
}
function assertPublicationObservationSource(value) {
    if (!isRecord(value) || typeof value.operation !== 'string') {
        throw publicationFailureSourceInvalid('Investigation v3 publication observer input is malformed.');
    }
    if (value.operation === 'read-ref') {
        if (!hasExactKeys(value, ['operation', 'currentRefPath']) ||
            !isBoundedPublicationPath(value.currentRefPath)) {
            throw publicationFailureSourceInvalid('Investigation v3 current-ref source is malformed.');
        }
        return deepFreeze({
            operation: 'read-ref',
            currentRefPath: value.currentRefPath,
        });
    }
    if (!['publish', 'inspect', 'resume'].includes(value.operation)) {
        throw publicationFailureSourceInvalid('Investigation v3 publication operation is unknown.');
    }
    if (!hasExactKeys(value, ['operation', 'paths']) || !isRecord(value.paths)) {
        throw publicationFailureSourceInvalid('Investigation v3 publication paths are malformed.');
    }
    if (!hasExactKeys(value.paths, [
        'manifestPath',
        'currentRefPath',
        'journalPath',
    ]) ||
        !isBoundedPublicationPath(value.paths.manifestPath) ||
        !isBoundedPublicationPath(value.paths.currentRefPath) ||
        !isBoundedPublicationPath(value.paths.journalPath)) {
        throw publicationFailureSourceInvalid('Investigation v3 publication paths are malformed.');
    }
    return deepFreeze({
        operation: value.operation,
        paths: {
            manifestPath: value.paths.manifestPath,
            currentRefPath: value.paths.currentRefPath,
            journalPath: value.paths.journalPath,
        },
    });
}
export function assertPublicationSourceLifecycleBinding(source, lifecycle) {
    if (!investigationManifestPublicationSourceMatchesLifecycle(source, lifecycle)) {
        throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Publication paths are outside the lifecycle-owned namespace.');
    }
}
export function currentRefFor(manifestPath, manifest) {
    return {
        schemaVersion: 1,
        kind: 'investigation-manifest-current',
        repositoryId: manifest.repositoryId,
        changeId: manifest.changeId,
        investigationId: manifest.investigationId,
        manifestDigest: manifest.manifestDigest,
        investigationTargetDigest: manifest.investigationApproval.investigationTargetDigest,
        manifestPath,
    };
}
export function authorityExpected(snapshot) {
    return {
        repositoryId: snapshot.repositoryId,
        changeId: snapshot.changeId,
        investigationId: snapshot.investigationId,
        sessionRevision: snapshot.sessionRevision,
        sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
    };
}
export function assertSnapshot(actual, expected) {
    assertSnapshotIdentity(actual, expected);
    if (actual.currentRefDigest !== expected.currentRefDigest) {
        throw publicationFailure('REVIEW_TARGET_STALE', 'Lifecycle snapshot current-ref digest changed before publication.');
    }
}
export function assertSnapshotIdentity(actual, expected) {
    const identity = (snapshot) => ({
        repositoryId: snapshot.repositoryId,
        changeId: snapshot.changeId,
        investigationId: snapshot.investigationId,
        sessionRevision: snapshot.sessionRevision,
        sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
    });
    if (canonicalJson(identity(actual)) !== canonicalJson(identity(expected))) {
        throw publicationFailure('REVIEW_TARGET_STALE', 'Lifecycle authority snapshot changed before publication.');
    }
}
export function lifecycleIdentity(snapshot) {
    return {
        repositoryId: snapshot.repositoryId,
        changeId: snapshot.changeId,
        investigationId: snapshot.investigationId,
        sessionRevision: snapshot.sessionRevision,
        sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
    };
}
export function assertLifecycleIdentity(actual, expected) {
    if (canonicalJson(lifecycleIdentity(actual)) !== canonicalJson(expected)) {
        throw publicationFailure('REVIEW_TARGET_STALE', 'Publication journal lifecycle identity changed before recovery.');
    }
}
export function isSameTrackedInvestigationLifecycle(current, next) {
    return (current.repositoryId === next.repositoryId &&
        current.changeId === next.changeId &&
        current.investigationId === next.investigationId &&
        current.manifestPath ===
            `openspec/changes/${current.changeId}/investigation.json` &&
        next.manifestPath === current.manifestPath);
}
export function parseCurrentManifestRef(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Investigation current ref is malformed.');
    }
    const record = value;
    const expectedKeys = [
        'schemaVersion',
        'kind',
        'repositoryId',
        'changeId',
        'investigationId',
        'manifestDigest',
        'investigationTargetDigest',
        'manifestPath',
    ];
    if (Object.keys(record).length !== expectedKeys.length ||
        !Object.keys(record).every((key) => expectedKeys.includes(key)) ||
        record.schemaVersion !== 1 ||
        record.kind !== 'investigation-manifest-current' ||
        typeof record.repositoryId !== 'string' ||
        typeof record.changeId !== 'string' ||
        typeof record.investigationId !== 'string' ||
        typeof record.manifestDigest !== 'string' ||
        !DIGEST.test(record.manifestDigest) ||
        typeof record.investigationTargetDigest !== 'string' ||
        !DIGEST.test(record.investigationTargetDigest) ||
        !isCanonicalPublicationRelativePath(record.manifestPath)) {
        throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Investigation current ref is malformed.');
    }
    return record;
}
export function assertPublicationSnapshot(value) {
    if (typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length !== 6) {
        throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Publication journal lifecycle snapshot is malformed.');
    }
    const snapshot = value;
    if (typeof snapshot.repositoryId !== 'string' ||
        typeof snapshot.changeId !== 'string' ||
        typeof snapshot.investigationId !== 'string' ||
        typeof snapshot.sessionRevision !== 'number' ||
        !Number.isSafeInteger(snapshot.sessionRevision) ||
        snapshot.sessionRevision < 0 ||
        typeof snapshot.sessionSnapshotDigest !== 'string' ||
        !DIGEST.test(snapshot.sessionSnapshotDigest) ||
        typeof snapshot.currentRefDigest !== 'string' ||
        !DIGEST.test(snapshot.currentRefDigest)) {
        throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Publication journal lifecycle snapshot is malformed.');
    }
}
export function publishedResult(journal) {
    return {
        outcome: 'published',
        manifestDigest: journal.manifestDigest,
        investigationTargetDigest: journal.investigationTargetDigest,
        transactionId: journal.transactionId,
    };
}
export function investigationManifestPublicationFailureEmissionDigest(failure) {
    return prefixedDigest(canonicalJson({
        schema: 'investigation-v3-publication-failure-emission.v1',
        lifecycle: failure.lifecycle,
        blocker: failure.blocker,
        source: failure.source,
    }));
}
