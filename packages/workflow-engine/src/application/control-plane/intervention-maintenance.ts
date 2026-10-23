/** Read retained maintenance authority and revoke it through current human authorization. */
import { replacePrivateFileAtomic } from '../../runtime/storage-journal/intervention-persistence-files.ts';
import type { HumanRevocationAuthorizer } from '../../modules/authority/human-revocation-contract.ts';

import type { MaintenanceApprovalSummary } from '../../modules/authority/intervention-bootstrap-contract.ts';

import crypto from 'node:crypto';

import fs from 'node:fs';

import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';

import { deriveAuthorityAuditRepositoryId } from '../../runtime/storage-journal/authority-audit-ledger.ts';

import {
  assertHumanRevocationAuthorization,
  canonicalHumanRevocationAuthorization,
  digestHumanRevocationSubject,
  type HumanRevocationAuthorization,
  type HumanRevocationOptions,
} from '../../modules/authority/human-revocation-contract.ts';

import {
  verifyHarnessMaintenanceGrant,
  type HarnessMaintenanceGrantEnvelope,
  type Sha256Digest,
} from '../../modules/authority/intervention-control.ts';

import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';

import {
  interventionControlPersistencePaths,
  readPersistedIntervention,
} from '../../runtime/storage-journal/intervention-control-persistence.ts';

interface PersistedMaintenanceGrantRecordFields {
  kind: 'persisted-maintenance-grant.v1';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  authorityAudit: {
    externalAuditRoot: string;
    repositoryId: Sha256Digest;
  };
  envelope: HarnessMaintenanceGrantEnvelope;
  summary: MaintenanceApprovalSummary;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  recordDigest: Sha256Digest;
}

export type PersistedMaintenanceGrantRecord =
  | (PersistedMaintenanceGrantRecordFields & {
      state: 'available' | 'expired';
      revocationAuthorization?: never;
    })
  | (PersistedMaintenanceGrantRecordFields & {
      state: 'revoked';
      revocationAuthorization: HumanRevocationAuthorization;
    });

export type MaintenanceGrantRevocationOptions = HumanRevocationOptions & {
  verifyHumanSignature: (
    payload: string,
    signature: string,
    identity: string,
    namespace: string,
  ) => boolean;
};

function maintenanceGrantId(
  parentChangeId: string,
  checkpointId: Sha256Digest,
  issuedAt: string,
  interventionChangeId: string,
): string {
  assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  assertDigest(checkpointId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  exactDate(new Date(issuedAt));
  assertNonEmpty(interventionChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  return `maintenance-${crypto
    .createHash('sha256')
    .update(
      `maintenance-grant.v2\0${parentChangeId}\0${checkpointId}\0${interventionChangeId}\0${issuedAt}`,
    )
    .digest('hex')}`;
}

export function readMaintenanceGrantRecord(
  storageRoot: string,
  grantId: string,
): PersistedMaintenanceGrantRecord {
  const value = readCanonicalPrivateFile(
    maintenanceGrantRecordPath(storageRoot, grantId),
    'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
  );
  const hasRevocationAuthorization =
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'revocationAuthorization');
  if (
    !isRecord(value) ||
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
    !verifyRecordDigest(value)
  ) {
    throw maintenanceRecordCorrupt();
  }
  const record = value as unknown as PersistedMaintenanceGrantRecord;
  assertAuditBinding(record.authorityAudit);
  assertAuditBinding(record.summary.authorityAudit);
  if (
    record.envelope.payload.grantId !== grantId ||
    record.envelope.payload.grantId !==
      maintenanceGrantId(
        record.parentChangeId,
        record.checkpointId,
        record.envelope.payload.issuedAt,
        record.interventionChangeId,
      ) ||
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
        canonicalJson(
          assertMaintenanceRevocationAuthorization(
            record.revocationAuthorization,
            grantId,
            record.revocationReason,
            record.revokedAt,
          ),
        ) !== canonicalJson(record.revocationAuthorization)))
  ) {
    throw maintenanceRecordCorrupt();
  }
  if (record.expiredAt !== null) exactDate(new Date(record.expiredAt));
  exactDate(new Date(record.createdAt));
  exactDate(new Date(record.updatedAt));
  return deepFreeze(structuredClone(record));
}

export function readMaintenanceGrantForParent(
  storageRoot: string,
  parentChangeId: string,
): PersistedMaintenanceGrantRecord {
  assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  const directory = maintenancePaths(storageRoot).grants;
  if (!fs.existsSync(directory)) {
    throw workflowError(
      'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
      'Persisted maintenance record was not found.',
      ExitCode.conflict,
    );
  }
  const matches: PersistedMaintenanceGrantRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'revocation-authorizations') {
      continue;
    }
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw workflowError(
        'INTERVENTION_MAINTENANCE_STORAGE_UNSAFE',
        'Maintenance grant store contains an unexpected entry.',
        ExitCode.unsafeEnvironment,
      );
    }
    const value = readCanonicalPrivateFile(
      path.join(directory, entry.name),
      'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
    );
    if (
      !isRecord(value) ||
      !isRecord(value.envelope) ||
      !isRecord(value.envelope.payload) ||
      typeof value.envelope.payload.grantId !== 'string'
    ) {
      throw maintenanceRecordCorrupt();
    }
    const grantId = value.envelope.payload.grantId;
    if (
      path.basename(maintenanceGrantRecordPath(storageRoot, grantId)) !==
      entry.name
    ) {
      throw maintenanceRecordCorrupt();
    }
    const record = readMaintenanceGrantRecord(storageRoot, grantId);
    if (record.parentChangeId === parentChangeId) matches.push(record);
  }
  if (matches.length === 0) {
    throw workflowError(
      'MAINTENANCE_GRANT_RECORD_NOT_FOUND',
      'Persisted maintenance record was not found.',
      ExitCode.conflict,
    );
  }
  matches.sort((left, right) => {
    const byTime =
      left.createdAt < right.createdAt
        ? -1
        : left.createdAt > right.createdAt
          ? 1
          : 0;
    if (byTime !== 0) return byTime;
    const rank = { expired: 0, revoked: 1, available: 2 } as const;
    const byState = rank[left.state] - rank[right.state];
    if (byState !== 0) return byState;
    return left.envelope.payload.grantId < right.envelope.payload.grantId
      ? -1
      : left.envelope.payload.grantId > right.envelope.payload.grantId
        ? 1
        : 0;
  });
  return matches.at(-1)!;
}

export function revokeMaintenanceGrantForParent(
  authorizeHumanRevocation: HumanRevocationAuthorizer,
  cwd: string,
  storageRoot: string,
  parentChangeId: string,
  options: MaintenanceGrantRevocationOptions,
): PersistedMaintenanceGrantRecord {
  assertNonEmpty(options.reason, 'MAINTENANCE_GRANT_REVOCATION_INVALID');
  const repository = discoverRepository(cwd);
  const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
  const requestedNow = exactDate(options.now ?? new Date());
  if (current.state !== 'revoked') {
    const intervention = readPersistedIntervention(storageRoot, parentChangeId);
    const expiresAt = Date.parse(current.envelope.payload.expiresAt);
    const verificationNow = new Date(
      Math.min(requestedNow.getTime(), expiresAt - 1),
    );
    verifyHarnessMaintenanceGrant(current.envelope, {
      now: verificationNow,
      parent: intervention.parent,
      relationship: intervention.relationship,
      checkpoint: intervention.checkpoint,
      verifyHumanSignature: options.verifyHumanSignature,
    });
  }
  const expectedAuditRepositoryId = deriveAuthorityAuditRepositoryId(
    `git-common:${repository.gitCommonDirectory}`,
  );
  if (current.authorityAudit.repositoryId !== expectedAuditRepositoryId) {
    throw workflowError(
      'HUMAN_REVOCATION_BINDING_INVALID',
      'Maintenance revocation audit binding does not match this Git common directory.',
      ExitCode.guard,
    );
  }
  const policy = loadCurrentMaintainerPolicy(repository.repositoryRoot);
  const authorization = authorizeHumanRevocation(
    repository.repositoryRoot,
    {
      subjectKind: 'harness-maintenance-grant',
      grantId: current.envelope.payload.grantId,
      grantDigest: digestHumanRevocationSubject(
        `${canonicalJson(current.envelope)}\n`,
      ),
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      changeId: current.parentChangeId,
      taskId: null,
      workflowId: current.interventionChangeId,
      audit: structuredClone(current.authorityAudit),
    },
    options,
    path.join(
      storageRoot,
      'maintenance-grants',
      'revocation-authorizations',
      `${current.envelope.payload.grantId}.json`,
    ),
    current.revocationAuthorization ?? null,
  );
  if (current.state === 'revoked') {
    if (
      current.revocationReason !== authorization.payload.reason ||
      canonicalHumanRevocationAuthorization(current.revocationAuthorization) !==
        canonicalHumanRevocationAuthorization(authorization)
    ) {
      throw workflowError(
        'HUMAN_REVOCATION_CONFLICT',
        'Maintenance grant already has a different revocation tombstone.',
        ExitCode.conflict,
      );
    }
    return current;
  }
  const at = authorization.payload.revokedAt;
  const next = withRecordDigest({
    ...withoutRecordDigest(current),
    state: 'revoked' as const,
    updatedAt: at,
    revokedAt: at,
    revocationReason: authorization.payload.reason,
    revocationAuthorization: authorization,
  });
  replacePrivateFileAtomic(
    maintenanceGrantRecordPath(storageRoot, current.envelope.payload.grantId),
    `${canonicalJson(next)}\n`,
  );
  return deepFreeze(structuredClone(next));
}

function maintenancePaths(storageRoot: string) {
  const root = interventionControlPersistencePaths(storageRoot).root;
  return {
    grants: path.join(root, 'maintenance-grants'),
  };
}

function maintenanceGrantRecordPath(storageRoot: string, grantId: string) {
  assertNonEmpty(grantId, 'MAINTENANCE_GRANT_RECORD_INVALID');
  const name = crypto
    .createHash('sha256')
    .update(`maintenance-record\0${grantId}`)
    .digest('hex');
  return path.join(maintenancePaths(storageRoot).grants, `${name}.json`);
}

function withRecordDigest<T extends Record<string, unknown>>(
  value: T,
): T & { recordDigest: Sha256Digest } {
  return { ...value, recordDigest: digest(canonicalJson(value)) };
}

function verifyRecordDigest(value: Record<string, unknown>): boolean {
  const { recordDigest, ...payload } = value;
  return (
    typeof recordDigest === 'string' &&
    digest(canonicalJson(payload)) === recordDigest
  );
}

function withoutRecordDigest<T extends { recordDigest: Sha256Digest }>(
  value: T,
): Omit<T, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...payload } = value;
  return payload;
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      'INTERVENTION_MAINTENANCE_TIME_INVALID',
      'Maintenance record time is invalid.',
      ExitCode.guard,
    );
  }
  return new Date(value.getTime());
}

function loadCurrentMaintainerPolicy(repositoryRoot: string) {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          'HEAD:workflow/maintainer-policy.json',
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The current HEAD does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

function assertMaintenanceRevocationAuthorization(
  value: unknown,
  grantId: string,
  reason: string | null,
  revokedAt: string | null,
): HumanRevocationAuthorization {
  const authorization = assertHumanRevocationAuthorization(value);
  if (
    authorization.payload.subjectKind !== 'harness-maintenance-grant' ||
    authorization.payload.grantId !== grantId ||
    authorization.payload.reason !== reason ||
    authorization.payload.revokedAt !== revokedAt
  ) {
    throw maintenanceRecordCorrupt();
  }
  return authorization;
}

function digest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.guard);
  }
}

function assertNonEmpty(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw workflowError(
      code,
      'Expected a non-empty exact string.',
      ExitCode.guard,
    );
  }
}

function assertAuditBinding(
  value: MaintenanceApprovalSummary['authorityAudit'],
): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['externalAuditRoot', 'repositoryId']) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_AUDIT_BINDING_INVALID',
      'Maintenance grant requires an exact absolute authority-audit root.',
      ExitCode.guard,
    );
  }
  assertDigest(value.repositoryId, 'MAINTENANCE_GRANT_AUDIT_BINDING_INVALID');
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function maintenanceRecordCorrupt(
  message = 'Persisted maintenance grant failed integrity verification.',
) {
  return workflowError(
    'MAINTENANCE_GRANT_RECORD_CORRUPT',
    message,
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

function readCanonicalPrivateFile(filePath: string, notFoundCode: string) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    throw workflowError(
      notFoundCode,
      'Persisted maintenance record was not found.',
      ExitCode.conflict,
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_RECORD_BYTES
  ) {
    throw maintenanceRecordCorrupt();
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw maintenanceRecordCorrupt();
  }
  if (`${canonicalJson(value)}\n` !== raw) throw maintenanceRecordCorrupt();
  return value;
}
