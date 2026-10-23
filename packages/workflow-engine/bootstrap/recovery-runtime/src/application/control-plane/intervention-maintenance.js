/** Read retained maintenance authority and revoke it through current human authorization. */
import { replacePrivateFileAtomic } from "../../runtime/storage-journal/intervention-persistence-files.js";
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { discoverRepository, runGit, } from "../../runtime/repository-transaction/git.js";
import { deriveAuthorityAuditRepositoryId } from "../../runtime/storage-journal/authority-audit-ledger.js";
import { assertHumanRevocationAuthorization, canonicalHumanRevocationAuthorization, digestHumanRevocationSubject, } from "../../modules/authority/human-revocation-contract.js";
import { verifyHarnessMaintenanceGrant, } from "../../modules/authority/intervention-control.js";
import { parseMaintainerPolicy } from "../../modules/authority/maintainer-policy.js";
import { interventionControlPersistencePaths, readPersistedIntervention, } from "../../runtime/storage-journal/intervention-control-persistence.js";
function maintenanceGrantId(parentChangeId, checkpointId, issuedAt, interventionChangeId) {
    assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    assertDigest(checkpointId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    exactDate(new Date(issuedAt));
    assertNonEmpty(interventionChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    return `maintenance-${crypto
        .createHash('sha256')
        .update(`maintenance-grant.v2\0${parentChangeId}\0${checkpointId}\0${interventionChangeId}\0${issuedAt}`)
        .digest('hex')}`;
}
export function readMaintenanceGrantRecord(storageRoot, grantId) {
    const value = readCanonicalPrivateFile(maintenanceGrantRecordPath(storageRoot, grantId), 'MAINTENANCE_GRANT_RECORD_NOT_FOUND');
    const hasRevocationAuthorization = isRecord(value) &&
        Object.prototype.hasOwnProperty.call(value, 'revocationAuthorization');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'checkpointId',
            'authorityAudit',
            'createdAt',
            'envelope',
            'expiredAt',
            'interventionChangeId',
            'kind',
            'parentChangeId',
            'recordDigest',
            'revocationReason',
            ...(hasRevocationAuthorization ? ['revocationAuthorization'] : []),
            'revokedAt',
            'state',
            'summary',
            'updatedAt',
        ]) ||
        value.kind !== 'persisted-maintenance-grant.v1' ||
        !['available', 'expired', 'revoked'].includes(String(value.state)) ||
        !verifyRecordDigest(value)) {
        throw maintenanceRecordCorrupt();
    }
    const record = value;
    assertAuditBinding(record.authorityAudit);
    assertAuditBinding(record.summary.authorityAudit);
    if (record.envelope.payload.grantId !== grantId ||
        record.envelope.payload.grantId !==
            maintenanceGrantId(record.parentChangeId, record.checkpointId, record.envelope.payload.issuedAt, record.interventionChangeId) ||
        record.envelope.payload.parentChangeId !== record.parentChangeId ||
        record.envelope.payload.interventionChangeId !==
            record.interventionChangeId ||
        record.summary.checkpointId !== record.checkpointId ||
        record.summary.parentChangeId !== record.parentChangeId ||
        record.summary.interventionChangeId !== record.interventionChangeId ||
        canonicalJson(record.authorityAudit) !==
            canonicalJson(record.summary.authorityAudit) ||
        hasRevocationAuthorization !== (record.state === 'revoked') ||
        (record.state === 'available' &&
            (record.expiredAt !== null ||
                record.revokedAt !== null ||
                record.revocationReason !== null)) ||
        (record.state === 'expired' &&
            (record.expiredAt !== record.envelope.payload.expiresAt ||
                record.revokedAt !== null ||
                record.revocationReason !== null)) ||
        (record.state === 'revoked' &&
            ((record.expiredAt !== null &&
                record.expiredAt !== record.envelope.payload.expiresAt) ||
                record.revokedAt === null ||
                record.revocationReason === null)) ||
        (hasRevocationAuthorization &&
            (record.state !== 'revoked' ||
                canonicalJson(assertMaintenanceRevocationAuthorization(record.revocationAuthorization, grantId, record.revocationReason, record.revokedAt)) !== canonicalJson(record.revocationAuthorization)))) {
        throw maintenanceRecordCorrupt();
    }
    if (record.expiredAt !== null)
        exactDate(new Date(record.expiredAt));
    exactDate(new Date(record.createdAt));
    exactDate(new Date(record.updatedAt));
    return deepFreeze(structuredClone(record));
}
export function readMaintenanceGrantForParent(storageRoot, parentChangeId) {
    assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    const directory = maintenancePaths(storageRoot).grants;
    if (!fs.existsSync(directory)) {
        throw workflowError('MAINTENANCE_GRANT_RECORD_NOT_FOUND', 'Persisted maintenance record was not found.', ExitCode.conflict);
    }
    const matches = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === 'revocation-authorizations') {
            continue;
        }
        if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
            throw workflowError('INTERVENTION_MAINTENANCE_STORAGE_UNSAFE', 'Maintenance grant store contains an unexpected entry.', ExitCode.unsafeEnvironment);
        }
        const value = readCanonicalPrivateFile(path.join(directory, entry.name), 'MAINTENANCE_GRANT_RECORD_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.envelope) ||
            !isRecord(value.envelope.payload) ||
            typeof value.envelope.payload.grantId !== 'string') {
            throw maintenanceRecordCorrupt();
        }
        const grantId = value.envelope.payload.grantId;
        if (path.basename(maintenanceGrantRecordPath(storageRoot, grantId)) !==
            entry.name) {
            throw maintenanceRecordCorrupt();
        }
        const record = readMaintenanceGrantRecord(storageRoot, grantId);
        if (record.parentChangeId === parentChangeId)
            matches.push(record);
    }
    if (matches.length === 0) {
        throw workflowError('MAINTENANCE_GRANT_RECORD_NOT_FOUND', 'Persisted maintenance record was not found.', ExitCode.conflict);
    }
    matches.sort((left, right) => {
        const byTime = left.createdAt < right.createdAt
            ? -1
            : left.createdAt > right.createdAt
                ? 1
                : 0;
        if (byTime !== 0)
            return byTime;
        const rank = { expired: 0, revoked: 1, available: 2 };
        const byState = rank[left.state] - rank[right.state];
        if (byState !== 0)
            return byState;
        return left.envelope.payload.grantId < right.envelope.payload.grantId
            ? -1
            : left.envelope.payload.grantId > right.envelope.payload.grantId
                ? 1
                : 0;
    });
    return matches.at(-1);
}
export function revokeMaintenanceGrantForParent(authorizeHumanRevocation, cwd, storageRoot, parentChangeId, options) {
    assertNonEmpty(options.reason, 'MAINTENANCE_GRANT_REVOCATION_INVALID');
    const repository = discoverRepository(cwd);
    const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
    const requestedNow = exactDate(options.now ?? new Date());
    if (current.state !== 'revoked') {
        const intervention = readPersistedIntervention(storageRoot, parentChangeId);
        const expiresAt = Date.parse(current.envelope.payload.expiresAt);
        const verificationNow = new Date(Math.min(requestedNow.getTime(), expiresAt - 1));
        verifyHarnessMaintenanceGrant(current.envelope, {
            now: verificationNow,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: options.verifyHumanSignature,
        });
    }
    const expectedAuditRepositoryId = deriveAuthorityAuditRepositoryId(`git-common:${repository.gitCommonDirectory}`);
    if (current.authorityAudit.repositoryId !== expectedAuditRepositoryId) {
        throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Maintenance revocation audit binding does not match this Git common directory.', ExitCode.guard);
    }
    const policy = loadCurrentMaintainerPolicy(repository.repositoryRoot);
    const authorization = authorizeHumanRevocation(repository.repositoryRoot, {
        subjectKind: 'harness-maintenance-grant',
        grantId: current.envelope.payload.grantId,
        grantDigest: digestHumanRevocationSubject(`${canonicalJson(current.envelope)}\n`),
        repositoryId: policy.repository.id,
        repositoryOrigin: policy.repository.origin,
        changeId: current.parentChangeId,
        taskId: null,
        workflowId: current.interventionChangeId,
        audit: structuredClone(current.authorityAudit),
    }, options, path.join(storageRoot, 'maintenance-grants', 'revocation-authorizations', `${current.envelope.payload.grantId}.json`), current.revocationAuthorization ?? null);
    if (current.state === 'revoked') {
        if (current.revocationReason !== authorization.payload.reason ||
            canonicalHumanRevocationAuthorization(current.revocationAuthorization) !==
                canonicalHumanRevocationAuthorization(authorization)) {
            throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Maintenance grant already has a different revocation tombstone.', ExitCode.conflict);
        }
        return current;
    }
    const at = authorization.payload.revokedAt;
    const next = withRecordDigest({
        ...withoutRecordDigest(current),
        state: 'revoked',
        updatedAt: at,
        revokedAt: at,
        revocationReason: authorization.payload.reason,
        revocationAuthorization: authorization,
    });
    replacePrivateFileAtomic(maintenanceGrantRecordPath(storageRoot, current.envelope.payload.grantId), `${canonicalJson(next)}\n`);
    return deepFreeze(structuredClone(next));
}
function maintenancePaths(storageRoot) {
    const root = interventionControlPersistencePaths(storageRoot).root;
    return {
        grants: path.join(root, 'maintenance-grants'),
    };
}
function maintenanceGrantRecordPath(storageRoot, grantId) {
    assertNonEmpty(grantId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    const name = crypto
        .createHash('sha256')
        .update(`maintenance-record\0${grantId}`)
        .digest('hex');
    return path.join(maintenancePaths(storageRoot).grants, `${name}.json`);
}
function withRecordDigest(value) {
    return { ...value, recordDigest: digest(canonicalJson(value)) };
}
function verifyRecordDigest(value) {
    const { recordDigest, ...payload } = value;
    return (typeof recordDigest === 'string' &&
        digest(canonicalJson(payload)) === recordDigest);
}
function withoutRecordDigest(value) {
    const { recordDigest: _recordDigest, ...payload } = value;
    return payload;
}
function exactDate(value) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError('INTERVENTION_MAINTENANCE_TIME_INVALID', 'Maintenance record time is invalid.', ExitCode.guard);
    }
    return new Date(value.getTime());
}
function loadCurrentMaintainerPolicy(repositoryRoot) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            'HEAD:workflow/maintainer-policy.json',
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error)
            throw error;
        throw workflowError('MAINTAINER_POLICY_INVALID', 'The current HEAD does not contain a valid maintainer policy.', ExitCode.guard);
    }
}
function assertMaintenanceRevocationAuthorization(value, grantId, reason, revokedAt) {
    const authorization = assertHumanRevocationAuthorization(value);
    if (authorization.payload.subjectKind !== 'harness-maintenance-grant' ||
        authorization.payload.grantId !== grantId ||
        authorization.payload.reason !== reason ||
        authorization.payload.revokedAt !== revokedAt) {
        throw maintenanceRecordCorrupt();
    }
    return authorization;
}
function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function assertDigest(value, code) {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.guard);
    }
}
function assertNonEmpty(value, code) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value) {
        throw workflowError(code, 'Expected a non-empty exact string.', ExitCode.guard);
    }
}
function assertAuditBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['externalAuditRoot', 'repositoryId']) ||
        typeof value.externalAuditRoot !== 'string' ||
        !path.isAbsolute(value.externalAuditRoot) ||
        path.normalize(value.externalAuditRoot) !== value.externalAuditRoot) {
        throw workflowError('MAINTENANCE_GRANT_AUDIT_BINDING_INVALID', 'Maintenance grant requires an exact absolute authority-audit root.', ExitCode.guard);
    }
    assertDigest(value.repositoryId, 'MAINTENANCE_GRANT_AUDIT_BINDING_INVALID');
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function maintenanceRecordCorrupt(message = 'Persisted maintenance grant failed integrity verification.') {
    return workflowError('MAINTENANCE_GRANT_RECORD_CORRUPT', message, ExitCode.verification);
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
function readCanonicalPrivateFile(filePath, notFoundCode) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        throw workflowError(notFoundCode, 'Persisted maintenance record was not found.', ExitCode.conflict);
    }
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
        stats.size < 1 ||
        stats.size > MAX_RECORD_BYTES) {
        throw maintenanceRecordCorrupt();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw maintenanceRecordCorrupt();
    }
    if (`${canonicalJson(value)}\n` !== raw)
        throw maintenanceRecordCorrupt();
    return value;
}
