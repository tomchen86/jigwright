import type { HumanRevocationAuthorizer } from '../../modules/authority/human-revocation-contract.ts';
import type { MaintenanceApprovalSummary } from '../../modules/authority/intervention-bootstrap-contract.ts';
export type { MaintenanceApprovalSummary } from '../../modules/authority/intervention-bootstrap-contract.ts';
/**
 * Persists, inspects, revokes, and expires intervention maintenance grants.
 *
 * Invariants:
 * - A maintenance grant must match the approval summary presented to its
 *   signer.
 */
import { createInterventionArtifactProduction } from './intervention-artifact-production.ts';
import { createInterventionMaintenancePublication } from './intervention-maintenance-publication.ts';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  createEngineArtifact,
  verifyHarnessMaintenanceGrant,
  type EngineArtifact,
  type HarnessMaintenanceGrantEnvelope,
  type HarnessMaintenanceOperation,
  type HarnessMaintenanceWaiver,
  type Sha256Digest,
} from '../../modules/authority/intervention-control.ts';
import {
  interventionEngineArtifactRecordPath as storedArtifactRecordPath,
  readStoredInterventionEngineArtifact,
} from '../../runtime/storage-journal/intervention-engine-artifact-store.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  activeBootstrapMaintenanceWorkflowBindingDigest,
  interventionControlPersistencePaths,
  preparePersistedEngineAdoption,
  recordBootstrapSidecarArtifactReady,
  readPersistedBootstrapSidecarWorkflow,
  readPersistedIntervention,
} from '../../runtime/storage-journal/intervention-control-persistence.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const ENGINE_PROBE_TIMEOUT_MS = 10_000;

// Only paths this repository actually has. A scope naming a package that does
// not exist reads as authority over something and grants nothing — the kind of
// clause that looks like protection until someone relies on it.
export const MAINTENANCE_SCOPE_PATHS = Object.freeze([
  'packages/workflow-engine/**',
] as const);

export const MAINTENANCE_SCOPE_OPERATIONS = Object.freeze([
  'adopt-engine-into-parent',
  'build-engine-artifact',
  'create-isolated-workspace',
  'modify-engine',
  'run-engine-tests',
] as const satisfies readonly HarnessMaintenanceOperation[]);

// Every waiver the grant type admits. Issuing three of the five meant an
// intervention could be stopped by a rule the design says a maintenance grant
// may waive, with nothing in the signed record explaining why that rule was
// treated differently from its siblings.
export const MAINTENANCE_SCOPE_WAIVERS = Object.freeze([
  'active-change-exclusivity',
  'clean-worktree-required',
  'engine-path-protection',
  'parent-terminalization-required',
  'selected-workflow-check',
] as const satisfies readonly HarnessMaintenanceWaiver[]);

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

export interface PersistedInterventionEngineArtifact {
  kind: 'persisted-intervention-engine-artifact.v2';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  artifact: EngineArtifact;
  executablePath: string;
  workflowBindingDigest: Sha256Digest;
  workflowStatus: 'repair-active';
  createdAt: string;
  recordDigest: Sha256Digest;
}

export function maintenanceGrantId(
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

export function maintenanceApprovalSummary(input: {
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  engineFromDigest: Sha256Digest;
  sessionSchema: string;
  reason: string;
  childWorkspace: {
    path: string;
    changeRef: string;
  };
  authorityAudit: {
    externalAuditRoot: string;
    repositoryId: Sha256Digest;
  };
}): MaintenanceApprovalSummary {
  const humanReadable = [
    'Harness maintenance intervention',
    `Parent change: ${input.parentChangeId}`,
    `Intervention change: ${input.interventionChangeId}`,
    `Checkpoint: ${input.checkpointId}`,
    `Current engine: ${input.engineFromDigest}`,
    `Session schema: ${input.sessionSchema}`,
    `Reason: ${input.reason}`,
    `Reserved child workspace: ${input.childWorkspace.path}`,
    `Reserved child change ref: ${input.childWorkspace.changeRef}`,
    `Exact scope paths: ${MAINTENANCE_SCOPE_PATHS.join(', ')}`,
    `Allowed operations: ${MAINTENANCE_SCOPE_OPERATIONS.join(', ')}`,
    `Explicit waivers: ${MAINTENANCE_SCOPE_WAIVERS.join(', ')}`,
    `External authority audit root: ${input.authorityAudit.externalAuditRoot}`,
    `Authority audit repository: ${input.authorityAudit.repositoryId}`,
    'Local adoption limit: 1',
    'Repository-default/global engine promotion: forbidden',
  ].join('\n');
  return deepFreeze({
    kind: 'maintenance-approval-summary.v1' as const,
    ...input,
    scope: {
      paths: [...MAINTENANCE_SCOPE_PATHS],
      operations: [...MAINTENANCE_SCOPE_OPERATIONS],
    },
    waivers: [...MAINTENANCE_SCOPE_WAIVERS],
    authorityAudit: structuredClone(input.authorityAudit),
    maxLocalAdoptions: 1 as const,
    humanReadable,
  });
}

export function persistMaintenanceGrantRecord(
  storageRoot: string,
  input: {
    envelope: HarnessMaintenanceGrantEnvelope;
    summary: MaintenanceApprovalSummary;
    now: Date;
  },
): PersistedMaintenanceGrantRecord {
  const payload = input.envelope.payload;
  assertAuditBinding(input.summary.authorityAudit);
  const issuedGrantId = maintenanceGrantId(
    input.summary.parentChangeId,
    input.summary.checkpointId,
    payload.issuedAt,
    payload.interventionChangeId,
  );
  const at = exactDate(input.now).toISOString();
  if (
    payload.grantId !== issuedGrantId ||
    payload.parentChangeId !== input.summary.parentChangeId ||
    payload.interventionChangeId !== input.summary.interventionChangeId ||
    payload.engineFromDigest !== input.summary.engineFromDigest ||
    payload.sessionSchema !== input.summary.sessionSchema ||
    payload.reason !== input.summary.reason ||
    canonicalJson(payload.scope) !== canonicalJson(input.summary.scope) ||
    canonicalJson(payload.waivers) !== canonicalJson(input.summary.waivers) ||
    payload.maxLocalAdoptions !== input.summary.maxLocalAdoptions
  ) {
    throw maintenanceRecordCorrupt(
      'Maintenance grant does not match the presented approval summary.',
    );
  }
  const paths = maintenancePaths(storageRoot);
  ensurePrivateDirectory(paths.grants);
  const record = withRecordDigest({
    kind: 'persisted-maintenance-grant.v1' as const,
    state: 'available' as const,
    parentChangeId: input.summary.parentChangeId,
    interventionChangeId: input.summary.interventionChangeId,
    checkpointId: input.summary.checkpointId,
    authorityAudit: structuredClone(input.summary.authorityAudit),
    envelope: structuredClone(input.envelope),
    summary: structuredClone(input.summary),
    createdAt: at,
    updatedAt: at,
    expiredAt: null,
    revokedAt: null,
    revocationReason: null,
  });
  const target = maintenanceGrantRecordPath(storageRoot, payload.grantId);
  if (fs.existsSync(target)) {
    const existing = readMaintenanceGrantRecord(storageRoot, payload.grantId);
    if (canonicalJson(existing) !== canonicalJson(record)) {
      throw workflowError(
        'MAINTENANCE_GRANT_RECORD_CONFLICT',
        'Maintenance grant id is already bound to different bytes.',
        ExitCode.conflict,
      );
    }
    return existing;
  }
  createPrivateFileExclusive(target, `${canonicalJson(record)}\n`);
  return deepFreeze(structuredClone(record));
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
      (record.expiredAt !== null ||
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
  if (current.state !== 'available' && current.state !== 'revoked') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Only active harness-maintenance authority can be revoked.',
      ExitCode.guard,
    );
  }
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

export function terminalizeExpiredMaintenanceGrantForParent(
  storageRoot: string,
  parentChangeId: string,
  now: Date,
): PersistedMaintenanceGrantRecord {
  const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
  if (current.state !== 'available') return current;
  const observedAt = exactDate(now).getTime();
  const expiresAt = Date.parse(current.envelope.payload.expiresAt);
  if (!Number.isFinite(expiresAt)) throw maintenanceRecordCorrupt();
  if (observedAt < expiresAt) return current;
  const terminalAt = new Date(expiresAt).toISOString();
  const next = withRecordDigest({
    ...withoutRecordDigest(current),
    state: 'expired' as const,
    updatedAt: terminalAt,
    expiredAt: terminalAt,
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
    artifacts: path.join(root, 'intervention-engine-artifacts'),
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

function interventionArtifactRecordPath(
  storageRoot: string,
  artifactId: string,
) {
  assertDigest(artifactId, 'INTERVENTION_ENGINE_ARTIFACT_INVALID');
  return path.join(
    maintenancePaths(storageRoot).artifacts,
    `${artifactId.slice('sha256:'.length)}.json`,
  );
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

function artifactRecordCorrupt() {
  return workflowError(
    'INTERVENTION_ENGINE_ARTIFACT_RECORD_CORRUPT',
    'Persisted intervention engine artifact failed integrity verification.',
    ExitCode.verification,
  );
}

function artifactPublicationCorrupt() {
  return workflowError(
    'INTERVENTION_ENGINE_ARTIFACT_PUBLICATION_CORRUPT',
    'Prepared intervention engine artifact publication is foreign, incomplete, or inconsistent.',
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

export type InterventionArtifactProductionBindings = {
  readPersistedIntervention: typeof readPersistedIntervention;
  readPersistedBootstrapSidecarWorkflow: typeof readPersistedBootstrapSidecarWorkflow;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  discoverRepository: typeof discoverRepository;
  digest: typeof digest;
  canonicalJson: typeof canonicalJson;
  createEngineArtifact: typeof createEngineArtifact;
  activeBootstrapMaintenanceWorkflowBindingDigest: typeof activeBootstrapMaintenanceWorkflowBindingDigest;
  withRecordDigest: typeof withRecordDigest;
  exactDate: typeof exactDate;
  maintenancePaths: typeof maintenancePaths;
  ensurePrivateDirectory: typeof ensurePrivateDirectory;
  storedArtifactRecordPath: typeof storedArtifactRecordPath;
  reconcilePrivateFileExclusivePublication: typeof reconcilePrivateFileExclusivePublication;
  fs: typeof fs;
  recordBootstrapSidecarArtifactReady: typeof recordBootstrapSidecarArtifactReady;
  createPrivateFileExclusive: typeof createPrivateFileExclusive;
  deepFreeze: typeof deepFreeze;
  readStoredInterventionEngineArtifact: typeof readStoredInterventionEngineArtifact;
  artifactRecordCorrupt: typeof artifactRecordCorrupt;
  preparePersistedEngineAdoption: typeof preparePersistedEngineAdoption;
  runGit: typeof runGit;
  path: typeof path;
  MAX_EXECUTABLE_BYTES: typeof MAX_EXECUTABLE_BYTES;
  MAX_SOURCE_SNAPSHOT_BYTES: typeof MAX_SOURCE_SNAPSHOT_BYTES;
  spawnSync: typeof spawnSync;
  ENGINE_PROBE_TIMEOUT_MS: typeof ENGINE_PROBE_TIMEOUT_MS;
  isRecord: typeof isRecord;
};
export type InterventionArtifactProductionBindingsTypes = {
  PersistedInterventionEngineArtifact: PersistedInterventionEngineArtifact;
  EngineArtifact: EngineArtifact;
  Sha256Digest: Sha256Digest;
  HarnessMaintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
  preparePersistedEngineAdoption: typeof preparePersistedEngineAdoption;
};

const {
  buildAndPersistInterventionEngineArtifact,
  persistInterventionEngineArtifact,
  readInterventionEngineArtifact,
  preparePersistedEngineAdoptionFromArtifactRecord,
  sameArtifactExecutableIdentity,
} = createInterventionArtifactProduction(() => ({
  readPersistedIntervention,
  readPersistedBootstrapSidecarWorkflow,
  workflowError,
  ExitCode,
  discoverRepository,
  digest,
  canonicalJson,
  createEngineArtifact,
  activeBootstrapMaintenanceWorkflowBindingDigest,
  withRecordDigest,
  exactDate,
  maintenancePaths,
  ensurePrivateDirectory,
  storedArtifactRecordPath,
  reconcilePrivateFileExclusivePublication,
  fs,
  recordBootstrapSidecarArtifactReady,
  createPrivateFileExclusive,
  deepFreeze,
  readStoredInterventionEngineArtifact,
  artifactRecordCorrupt,
  preparePersistedEngineAdoption,
  runGit,
  path,
  MAX_EXECUTABLE_BYTES,
  MAX_SOURCE_SNAPSHOT_BYTES,
  spawnSync,
  ENGINE_PROBE_TIMEOUT_MS,
  isRecord,
}));
export {
  buildAndPersistInterventionEngineArtifact,
  persistInterventionEngineArtifact,
  readInterventionEngineArtifact,
  preparePersistedEngineAdoptionFromArtifactRecord,
};

export type InterventionMaintenancePublicationBindings = {
  fs: typeof fs;
  PRIVATE_DIRECTORY_MODE: typeof PRIVATE_DIRECTORY_MODE;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  path: typeof path;
  PRIVATE_FILE_MODE: typeof PRIVATE_FILE_MODE;
  artifactPublicationCorrupt: typeof artifactPublicationCorrupt;
  sameArtifactExecutableIdentity: typeof sameArtifactExecutableIdentity;
  isRecord: typeof isRecord;
  canonicalJson: typeof canonicalJson;
  verifyRecordDigest: typeof verifyRecordDigest;
  crypto: typeof crypto;
  MAX_RECORD_BYTES: typeof MAX_RECORD_BYTES;
  maintenanceRecordCorrupt: typeof maintenanceRecordCorrupt;
};
export type InterventionMaintenancePublicationBindingsTypes = {};

const {
  ensurePrivateDirectory,
  createPrivateFileExclusive,
  reconcilePrivateFileExclusivePublication,
  replacePrivateFileAtomic,
  readCanonicalPrivateFile,
} = createInterventionMaintenancePublication(() => ({
  fs,
  PRIVATE_DIRECTORY_MODE,
  workflowError,
  ExitCode,
  path,
  PRIVATE_FILE_MODE,
  artifactPublicationCorrupt,
  sameArtifactExecutableIdentity,
  isRecord,
  canonicalJson,
  verifyRecordDigest,
  crypto,
  MAX_RECORD_BYTES,
  maintenanceRecordCorrupt,
}));
