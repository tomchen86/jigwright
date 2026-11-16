export { deriveAuthorityAuditRepositoryId } from "../../modules/authority/authority-audit-contract.js";
/**
 * Prepares the external audit layout and validates its pinned profile and backend configuration.
 *
 * Invariants:
 * - The audit root remains external to the repository and matches the canonical private layout.
 * - Persisted profile and protected configuration remain bound to the exact repository and policy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { LOCK_NAME, PROFILE_STATE_NAME, PROTECTED_CONFIGURATION_NAME, RETENTION_CHECKPOINT_NAME, RETENTION_CHECKPOINT_NEXT_NAME, MAINTENANCE_JOURNAL_NAME, SCOPE_KEYS, MAX_METADATA_BYTES, deepFreeze, MAX_PATH_BYTES, PROTECTED_CONFIGURATION_KEYS, PROFILE_STATE_KEYS, AUTHORITY_AUDIT_PROFILE_POLICIES, } from "./authority-audit-contracts.js";
import { invalidScope, sha256Digest, pathsOverlap, externalRootRequired, maintenanceInvalid, anchorInvalid, destructionTombstoneInvalid, isPlainRecord, hasExactKeys, assertAbsolutePath, assertDigest, unsafeFilesystem, invalidProfile, isNodeError, profileMismatch, protectedConfigurationInvalid, parseJson, anchorBackendInvalid, } from "./authority-audit-values.js";
import { assertRepositoryRoot, ensurePrivateRoot, ensurePrivateDirectory, recoverPrivateFilePublications, readExactPrivateFile, writeExclusivePrivateFile, fsyncDirectory, assertPrivateDirectory, assertExactDirectoryEntries, } from "./authority-audit-private-files.js";
import { readAnchorPublications, assertAnchorDirectoryLocal, } from "./authority-audit-anchor-records.js";
import { readDestructionTombstones, assertTombstoneDirectoryLocal, } from "./authority-audit-destruction-records.js";
export function authorityAuditLedgerPaths(scope) {
    const checked = assertScope(scope);
    return ledgerPathsForScope(checked);
}
function ledgerPathsForScope(checked) {
    const namespace = checked.repositoryId.slice('sha256:'.length);
    const repositories = path.join(checked.externalAuditRoot, 'repositories');
    const repository = path.join(repositories, namespace);
    const metadata = path.join(repository, 'metadata');
    return Object.freeze({
        externalAuditRoot: checked.externalAuditRoot,
        repositories,
        repository,
        events: path.join(repository, 'events'),
        records: path.join(repository, 'records'),
        locks: path.join(repository, 'locks'),
        appendLock: path.join(repository, 'locks', LOCK_NAME),
        metadata,
        profileState: path.join(metadata, PROFILE_STATE_NAME),
        protectedConfiguration: path.join(metadata, PROTECTED_CONFIGURATION_NAME),
        retentionCheckpoint: path.join(metadata, RETENTION_CHECKPOINT_NAME),
        retentionCheckpointNext: path.join(metadata, RETENTION_CHECKPOINT_NEXT_NAME),
        maintenanceJournal: path.join(metadata, MAINTENANCE_JOURNAL_NAME),
        anchors: path.join(metadata, 'anchors'),
        tombstones: path.join(metadata, 'tombstones'),
    });
}
export function prepareLedger(rawScope) {
    const scope = assertScope(rawScope);
    const paths = ledgerPathsForScope(scope);
    assertRepositoryRoot(scope.repositoryRoot);
    ensurePrivateRoot(paths.externalAuditRoot);
    const realAuditRoot = fs.realpathSync(paths.externalAuditRoot);
    const realRepositoryRoot = fs.realpathSync(scope.repositoryRoot);
    if (pathsOverlap(realAuditRoot, realRepositoryRoot)) {
        throw externalRootRequired();
    }
    ensurePrivateDirectory(paths.repositories);
    ensurePrivateDirectory(paths.repository);
    ensurePrivateDirectory(paths.events);
    ensurePrivateDirectory(paths.records);
    ensurePrivateDirectory(paths.locks);
    ensurePrivateDirectory(paths.metadata);
    ensurePrivateDirectory(paths.anchors);
    ensurePrivateDirectory(paths.tombstones);
    recoverPrivateFilePublications(paths.metadata, (name) => name === PROFILE_STATE_NAME ||
        name === PROTECTED_CONFIGURATION_NAME ||
        name === RETENTION_CHECKPOINT_NEXT_NAME ||
        name === MAINTENANCE_JOURNAL_NAME, maintenanceInvalid);
    recoverPrivateFilePublications(paths.anchors, (name) => /^[0-9a-f]{64}\.json$/.test(name), anchorInvalid);
    recoverPrivateFilePublications(paths.tombstones, (name) => /^[0-9a-f]{64}\.json$/.test(name), destructionTombstoneInvalid);
    const profile = ensureAuthorityAuditProfile(paths, scope);
    assertLayout(paths);
    assertProfileArtifactBindings(paths, scope, profile);
    return Object.freeze({ scope, paths, profile });
}
function assertScope(raw) {
    if (!isPlainRecord(raw) ||
        (!hasExactKeys(raw, SCOPE_KEYS) &&
            !hasExactKeys(raw, [...SCOPE_KEYS, 'profile']))) {
        throw invalidScope();
    }
    const externalAuditRoot = assertAbsolutePath(raw.externalAuditRoot);
    const repositoryRoot = assertAbsolutePath(raw.repositoryRoot);
    const repositoryId = assertDigest(raw.repositoryId, invalidScope);
    const profile = raw.profile === undefined
        ? undefined
        : assertAuditProfile(raw.profile, invalidScope);
    if (pathsOverlap(externalAuditRoot, repositoryRoot)) {
        throw externalRootRequired();
    }
    return Object.freeze({
        externalAuditRoot,
        repositoryRoot,
        repositoryId,
        ...(profile === undefined ? {} : { profile }),
    });
}
function ensureAuthorityAuditProfile(paths, scope) {
    const existingStats = fs.lstatSync(paths.profileState, {
        throwIfNoEntry: false,
    });
    const existing = existingStats === undefined
        ? null
        : parseAuthorityAuditProfileState(readExactPrivateFile(paths.profileState, MAX_METADATA_BYTES, unsafeFilesystem));
    const requested = scope.profile ?? existing?.profile ?? 'development';
    const state = deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-profile.v1',
        repositoryId: scope.repositoryId,
        profile: requested,
        policyVersion: 1,
        policyDigest: authorityAuditPolicyDigest(requested),
    });
    const bytes = `${canonicalJson(state)}\n`;
    if (existing === null) {
        if (!isUninitializedAuditLayout(paths))
            throw invalidProfile();
        try {
            writeExclusivePrivateFile(paths.profileState, bytes, unsafeFilesystem);
            fsyncDirectory(paths.metadata);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
        }
    }
    const stored = existing ??
        parseAuthorityAuditProfileState(readExactPrivateFile(paths.profileState, MAX_METADATA_BYTES, unsafeFilesystem));
    if (stored.repositoryId !== scope.repositoryId)
        throw invalidProfile();
    if (stored.profile !== requested)
        throw profileMismatch();
    if (stored.policyVersion !== 1 ||
        stored.policyDigest !== authorityAuditPolicyDigest(stored.profile)) {
        throw invalidProfile();
    }
    return stored.profile;
}
function isUninitializedAuditLayout(paths) {
    return (fs.readdirSync(paths.events).length === 0 &&
        fs.readdirSync(paths.records).length === 0 &&
        fs.readdirSync(paths.locks).length === 0 &&
        fs.readdirSync(paths.anchors).length === 0 &&
        fs.readdirSync(paths.tombstones).length === 0 &&
        fs
            .readdirSync(paths.metadata)
            .every((entry) => entry === 'anchors' ||
            entry === 'tombstones' ||
            entry === PROTECTED_CONFIGURATION_NAME));
}
function assertProfileArtifactBindings(paths, scope, profile) {
    const repositoryId = scope.repositoryId;
    const anchors = readAnchorPublications(paths);
    const tombstones = readDestructionTombstones(paths);
    const configurationStats = fs.lstatSync(paths.protectedConfiguration, {
        throwIfNoEntry: false,
    });
    if (profile === 'development' &&
        (anchors.length > 0 ||
            tombstones.length > 0 ||
            configurationStats !== undefined)) {
        throw profileMismatch();
    }
    const configuration = configurationStats === undefined ? null : readProtectedConfiguration(paths);
    if (configuration !== null) {
        assertProtectedBackendRoot(configuration.backendRoot, scope);
    }
    if (anchors.some(({ receipt }) => receipt.repositoryId !== repositoryId ||
        receipt.policyDigest !== authorityAuditPolicyDigest('protected')) ||
        tombstones.some(({ repositoryId: observed }) => observed !== repositoryId) ||
        (configuration !== null && configuration.repositoryId !== repositoryId)) {
        throw profileMismatch();
    }
}
export function assertProtectedBackendRoot(raw, scope) {
    const backendRoot = assertProtectedConfigurationPath(raw);
    assertPrivateDirectory(backendRoot);
    const realBackendRoot = fs.realpathSync(backendRoot);
    const realRepositoryRoot = fs.realpathSync(scope.repositoryRoot);
    const realAuditRoot = fs.realpathSync(scope.externalAuditRoot);
    if (realBackendRoot !== backendRoot ||
        pathsOverlap(realBackendRoot, realRepositoryRoot) ||
        pathsOverlap(realBackendRoot, realAuditRoot)) {
        throw protectedConfigurationInvalid();
    }
    return backendRoot;
}
function assertProtectedConfigurationPath(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        Buffer.byteLength(raw) > MAX_PATH_BYTES ||
        raw.includes('\0') ||
        !path.isAbsolute(raw) ||
        path.normalize(raw) !== raw) {
        throw protectedConfigurationInvalid();
    }
    return raw;
}
export function canonicalDestructionPublicKey(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        raw.includes('\0') ||
        Buffer.byteLength(raw) > MAX_METADATA_BYTES) {
        throw protectedConfigurationInvalid();
    }
    try {
        const key = crypto.createPublicKey(raw);
        if (key.asymmetricKeyType !== 'ed25519') {
            throw protectedConfigurationInvalid();
        }
        const canonical = key.export({ type: 'spki', format: 'pem' });
        if (typeof canonical !== 'string') {
            throw protectedConfigurationInvalid();
        }
        return canonical;
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_INVALID') {
            throw error;
        }
        throw protectedConfigurationInvalid();
    }
}
export function canonicalProtectedConfiguration(configuration) {
    return `${canonicalJson(configuration)}\n`;
}
function parseProtectedConfiguration(bytes) {
    const raw = parseJson(bytes, protectedConfigurationInvalid);
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, PROTECTED_CONFIGURATION_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-protected-configuration.v1' ||
        raw.backendId !== 'filesystem-worm.v1') {
        throw protectedConfigurationInvalid();
    }
    const destructionPublicKeyPem = canonicalDestructionPublicKey(raw.destructionPublicKeyPem);
    if (destructionPublicKeyPem !== raw.destructionPublicKeyPem) {
        throw protectedConfigurationInvalid();
    }
    const core = {
        schemaVersion: 1,
        kind: 'authority-audit-protected-configuration.v1',
        repositoryId: assertDigest(raw.repositoryId, protectedConfigurationInvalid),
        backendId: 'filesystem-worm.v1',
        backendRoot: assertProtectedConfigurationPath(raw.backendRoot),
        destructionPublicKeyPem,
        destructionPublicKeyDigest: assertDigest(raw.destructionPublicKeyDigest, protectedConfigurationInvalid),
    };
    const configuration = deepFreeze({
        ...core,
        configurationDigest: assertDigest(raw.configurationDigest, protectedConfigurationInvalid),
    });
    if (configuration.destructionPublicKeyDigest !==
        sha256Digest(configuration.destructionPublicKeyPem) ||
        configuration.configurationDigest !== sha256Digest(canonicalJson(core)) ||
        bytes !== canonicalProtectedConfiguration(configuration)) {
        throw protectedConfigurationInvalid();
    }
    return configuration;
}
export function readProtectedConfiguration(paths) {
    return parseProtectedConfiguration(readExactPrivateFile(paths.protectedConfiguration, MAX_METADATA_BYTES, protectedConfigurationInvalid));
}
export function ensureFilesystemWormBackend(configuration) {
    const backendRoot = configuration.backendRoot;
    assertPrivateDirectory(backendRoot);
    for (const entry of fs.readdirSync(backendRoot)) {
        if (entry !== 'repositories')
            throw anchorBackendInvalid();
    }
    const repositories = path.join(backendRoot, 'repositories');
    ensurePrivateDirectory(repositories);
    for (const namespace of fs.readdirSync(repositories)) {
        if (!/^[0-9a-f]{64}$/.test(namespace))
            throw anchorBackendInvalid();
        assertPrivateDirectory(path.join(repositories, namespace));
    }
    const repository = path.join(repositories, configuration.repositoryId.slice('sha256:'.length));
    ensurePrivateDirectory(repository);
    for (const entry of fs.readdirSync(repository)) {
        if (entry !== 'anchors')
            throw anchorBackendInvalid();
    }
    const anchors = path.join(repository, 'anchors');
    ensurePrivateDirectory(anchors);
    assertExactDirectoryEntries(backendRoot, ['repositories']);
    assertExactDirectoryEntries(repository, ['anchors']);
    return Object.freeze({ repositories, repository, anchors });
}
function parseAuthorityAuditProfileState(bytes) {
    const raw = parseJson(bytes, invalidProfile);
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, PROFILE_STATE_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-profile.v1' ||
        raw.policyVersion !== 1) {
        throw invalidProfile();
    }
    const state = deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-profile.v1',
        repositoryId: assertDigest(raw.repositoryId, invalidProfile),
        profile: assertAuditProfile(raw.profile, invalidProfile),
        policyVersion: 1,
        policyDigest: assertDigest(raw.policyDigest, invalidProfile),
    });
    if (bytes !== `${canonicalJson(state)}\n`)
        throw invalidProfile();
    return state;
}
export function authorityAuditPolicyDigest(profile) {
    return sha256Digest(canonicalJson(AUTHORITY_AUDIT_PROFILE_POLICIES[profile]));
}
export function assertAuditProfile(raw, makeError) {
    if (raw !== 'development' && raw !== 'protected')
        throw makeError();
    return raw;
}
function assertLayout(paths) {
    assertPrivateDirectory(paths.externalAuditRoot);
    assertPrivateDirectory(paths.repositories);
    assertPrivateDirectory(paths.repository);
    assertPrivateDirectory(paths.events);
    assertPrivateDirectory(paths.records);
    assertPrivateDirectory(paths.locks);
    assertPrivateDirectory(paths.metadata);
    assertPrivateDirectory(paths.anchors);
    assertPrivateDirectory(paths.tombstones);
    assertExactDirectoryEntries(paths.externalAuditRoot, ['repositories']);
    assertExactDirectoryEntries(paths.repository, [
        'events',
        'locks',
        'metadata',
        'records',
    ]);
    const metadataEntries = fs.readdirSync(paths.metadata);
    for (const entry of metadataEntries) {
        if (entry !== PROFILE_STATE_NAME &&
            entry !== PROTECTED_CONFIGURATION_NAME &&
            entry !== RETENTION_CHECKPOINT_NAME &&
            entry !== RETENTION_CHECKPOINT_NEXT_NAME &&
            entry !== MAINTENANCE_JOURNAL_NAME &&
            entry !== 'anchors' &&
            entry !== 'tombstones') {
            throw unsafeFilesystem();
        }
    }
    if (!metadataEntries.includes(PROFILE_STATE_NAME)) {
        throw unsafeFilesystem();
    }
    assertAnchorDirectoryLocal(paths.anchors);
    assertTombstoneDirectoryLocal(paths.tombstones);
    for (const namespace of fs.readdirSync(paths.repositories)) {
        if (!/^[0-9a-f]{64}$/.test(namespace)) {
            throw unsafeFilesystem();
        }
        assertPrivateDirectory(path.join(paths.repositories, namespace));
    }
}
