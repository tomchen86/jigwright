/**
 * Reads and validates workflow sessions and publishes their atomic JSON records.
 *
 * Invariants:
 * - Stored sessions retain exact identity, planning assurance, check evidence, and isolation fields.
 * - Reads preserve file metadata and canonical validation; writes keep rename and fsync order.
 */
import {
  type PlanningAssuranceBinding,
  isPlanningAssuranceBinding,
} from '../../modules/assurance/planning-assurance-binding.ts';
import { defaultSessionRuntimeLayoutPort } from '@jigwright/core/session-runtime-layout-port';
import fs from 'node:fs';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  fsyncDirectory,
  isRecord,
  isStringRecord,
  isStringArray,
  isDigest,
  isCanonicalStringSet,
  isSha256Digest,
  isCommitHash,
} from './session-store-values.ts';
import { normalizePolicyPath } from './paths.ts';

const TASK_REVISION_LEASE_ID =
  /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TaskSessionResourceLease = Readonly<{
  kind: 'destructive-database' | 'exclusive';
  digest: `sha256:${string}`;
}>;

export type TaskSessionIsolationBinding = Readonly<{
  schemaVersion: 1;
  routingRole: 'single' | 'primary' | 'concurrent';
  routingWorksetDigest: `sha256:${string}`;
  concurrencyEnabled: boolean;
  worktreeDigest: `sha256:${string}`;
  resources: readonly TaskSessionResourceLease[];
}>;

export type WorkflowSession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'revising' | 'aborted' | 'committed';
  changeId: string;
  taskId: string;
  /** Durable top-level task mandate authorization for production sessions. */
  mandateBinding?: {
    schemaVersion: 1;
    mandateTaskId: string;
    mandateId: string;
    mandateDigest: string;
    changeId: string;
    externalAuditRoot: string;
  } | null;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: {
    head: string;
    tree: string;
  };
  artifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  /** Durable worktree, workset, and exclusive-resource lease identities. */
  isolation: TaskSessionIsolationBinding;
  requiredCheckDigests: Record<string, string>;
  /** Engine identity against which the current durable check evidence ran. */
  checkEvidenceEngineDigest?: `sha256:${string}`;
  planningAssurance: PlanningAssuranceBinding | null;
  /** Current same-session planning-authority lease while execution is paused. */
  revisionLeaseId?: string;
  /** Immutable post-implementation semantic reconciliation authority. */
  implementationReconciliationReportId?: string;
  /** Exact engine-owned Git projection authorized by that reconciliation. */
  implementationReconciliationPaths?: string[];
  /** Authenticated reviewer-requested documentation paths for this session. */
  documentationRemediation?: {
    reviewRecordDigests: string[];
    paths: string[];
  };
  createdAt: string;
  latestCheckReportId?: string;
  completionReportId?: string;
  finishReportId?: string;
  commitReportId?: string;
  commitHash?: string;
  committedAt?: string;
  abortedAt?: string;
  abortReason?: string;
};

export function runtimePaths(
  gitCommonDirectory: string,
  runtimeDirectory: string,
) {
  return defaultSessionRuntimeLayoutPort.resolve({
    gitCommonDirectory,
    runtimeDirectory,
  });
}

export function readSessionFile(sessionPath: string): WorkflowSession {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'SESSION_UNREADABLE',
      `Unable to read session: ${path.basename(sessionPath, '.json')}`,
      ExitCode.staleState,
      {
        details: {
          sessionPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }

  if (!isWorkflowSession(value)) {
    throw workflowError(
      'INVALID_SESSION',
      `Session file is malformed: ${sessionPath}`,
      ExitCode.staleState,
    );
  }

  const expectedSessionId = path.basename(sessionPath, '.json');
  if (value.sessionId !== expectedSessionId) {
    throw workflowError(
      'SESSION_ID_MISMATCH',
      `Session content does not match filename ${expectedSessionId}.`,
      ExitCode.staleState,
    );
  }

  return value;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function createSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `session-${timestamp}-${crypto.randomUUID()}`;
}

export function isWorkflowSession(value: unknown): value is WorkflowSession {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }
  const allowedFields = new Set([
    'schemaVersion',
    'sessionId',
    'state',
    'changeId',
    'taskId',
    'mandateBinding',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'artifacts',
    'allowedPaths',
    'requiredChecks',
    'isolation',
    'requiredCheckDigests',
    'checkEvidenceEngineDigest',
    'planningAssurance',
    'revisionLeaseId',
    'implementationReconciliationReportId',
    'implementationReconciliationPaths',
    'documentationRemediation',
    'createdAt',
    'latestCheckReportId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
    'commitHash',
    'committedAt',
    'abortedAt',
    'abortReason',
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    return false;
  }
  if (
    typeof value.sessionId !== 'string' ||
    !['active', 'revising', 'aborted', 'committed'].includes(
      String(value.state),
    ) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isRecord(value.baseline) ||
    typeof value.baseline.head !== 'string' ||
    typeof value.baseline.tree !== 'string' ||
    !isStringRecord(value.artifacts) ||
    !isStringArray(value.allowedPaths) ||
    !isStringArray(value.requiredChecks)
  ) {
    return false;
  }
  if (
    value.mandateBinding !== undefined &&
    value.mandateBinding !== null &&
    !isTaskMandateBinding(value.mandateBinding, value.changeId)
  ) {
    return false;
  }
  if (
    !Object.hasOwn(value, 'isolation') ||
    !isTaskSessionIsolationBinding(value.isolation)
  ) {
    return false;
  }
  for (const field of [
    'implementationReconciliationReportId',
    'latestCheckReportId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
  ]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isDigest(fieldValue)) {
      return false;
    }
  }
  if (
    !Object.hasOwn(value, 'requiredCheckDigests') ||
    !isStringRecord(value.requiredCheckDigests)
  ) {
    return false;
  }
  if (
    value.implementationReconciliationPaths !== undefined &&
    (!isStringArray(value.implementationReconciliationPaths) ||
      value.implementationReconciliationPaths.length === 0 ||
      new Set(value.implementationReconciliationPaths).size !==
        value.implementationReconciliationPaths.length ||
      JSON.stringify(value.implementationReconciliationPaths) !==
        JSON.stringify([...value.implementationReconciliationPaths].sort()) ||
      value.implementationReconciliationPaths.some(
        (candidatePath) =>
          !candidatePath.startsWith('workflow/semantic-ledger/') ||
          candidatePath.includes('..'),
      ))
  ) {
    return false;
  }
  if (
    value.implementationReconciliationPaths !== undefined &&
    value.implementationReconciliationReportId === undefined
  ) {
    return false;
  }
  if (
    value.documentationRemediation !== undefined &&
    (!isRecord(value.documentationRemediation) ||
      Object.keys(value.documentationRemediation).sort().join('\0') !==
        ['paths', 'reviewRecordDigests'].join('\0') ||
      !isStringArray(value.documentationRemediation.reviewRecordDigests) ||
      value.documentationRemediation.reviewRecordDigests.length === 0 ||
      value.documentationRemediation.reviewRecordDigests.some(
        (candidate) => !isDigest(candidate),
      ) ||
      !isCanonicalStringSet(
        value.documentationRemediation.reviewRecordDigests,
      ) ||
      !isStringArray(value.documentationRemediation.paths) ||
      value.documentationRemediation.paths.length === 0 ||
      !isCanonicalStringSet(value.documentationRemediation.paths) ||
      value.documentationRemediation.paths.some(
        (candidate) =>
          !isCanonicalDocumentationRemediationPath(candidate) ||
          (!candidate.startsWith('docs/') &&
            !/(?:^|\/)README\.md$/.test(candidate)),
      ))
  ) {
    return false;
  }
  if (
    value.checkEvidenceEngineDigest !== undefined &&
    !isSha256Digest(value.checkEvidenceEngineDigest)
  ) {
    return false;
  }
  if (
    !Object.hasOwn(value, 'planningAssurance') ||
    (value.planningAssurance !== null &&
      !isPlanningAssuranceBinding(value.planningAssurance))
  ) {
    return false;
  }
  if (
    value.revisionLeaseId !== undefined &&
    (typeof value.revisionLeaseId !== 'string' ||
      !TASK_REVISION_LEASE_ID.test(value.revisionLeaseId))
  ) {
    return false;
  }
  if (
    (value.state === 'revising') !==
    (typeof value.revisionLeaseId === 'string')
  ) {
    // An aborted session may retain its terminal lease pointer for audit.
    if (value.state !== 'aborted' || value.revisionLeaseId === undefined) {
      return false;
    }
  }
  if (
    (value.commitHash !== undefined && !isCommitHash(value.commitHash)) ||
    (value.commitReportId === undefined) !== (value.commitHash === undefined)
  ) {
    return false;
  }
  if (
    value.state === 'active' &&
    value.commitReportId !== undefined &&
    (value.finishReportId === undefined || value.committedAt !== undefined)
  ) {
    return false;
  }
  if (
    value.state === 'revising' &&
    (value.latestCheckReportId !== undefined ||
      value.completionReportId !== undefined ||
      value.finishReportId !== undefined ||
      value.commitReportId !== undefined ||
      value.commitHash !== undefined ||
      value.committedAt !== undefined)
  ) {
    return false;
  }
  if (
    value.state === 'aborted' &&
    (typeof value.abortedAt !== 'string' ||
      Number.isNaN(Date.parse(value.abortedAt)) ||
      typeof value.abortReason !== 'string' ||
      !value.abortReason)
  ) {
    return false;
  }
  if (
    value.state === 'committed' &&
    (!isDigest(value.latestCheckReportId) ||
      !isDigest(value.completionReportId) ||
      !isDigest(value.finishReportId) ||
      !isDigest(value.commitReportId) ||
      !isCommitHash(value.commitHash) ||
      typeof value.committedAt !== 'string' ||
      Number.isNaN(Date.parse(value.committedAt)))
  ) {
    return false;
  }
  return true;
}

function isTaskSessionIsolationBinding(
  value: unknown,
): value is TaskSessionIsolationBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'concurrencyEnabled',
        'resources',
        'routingRole',
        'routingWorksetDigest',
        'schemaVersion',
        'worktreeDigest',
      ]
        .sort()
        .join('\0') ||
    value.schemaVersion !== 1 ||
    !['single', 'primary', 'concurrent'].includes(String(value.routingRole)) ||
    typeof value.concurrencyEnabled !== 'boolean' ||
    !isSha256Digest(value.routingWorksetDigest) ||
    !isSha256Digest(value.worktreeDigest) ||
    !Array.isArray(value.resources)
  ) {
    return false;
  }
  const resources = value.resources;
  if (
    resources.some(
      (resource) =>
        !isRecord(resource) ||
        Object.keys(resource).sort().join('\0') !== 'digest\0kind' ||
        !['destructive-database', 'exclusive'].includes(
          String(resource.kind),
        ) ||
        !isSha256Digest(resource.digest),
    )
  ) {
    return false;
  }
  const identities = resources.map(
    (resource) => `${String(resource.kind)}:${String(resource.digest)}`,
  );
  return (
    new Set(identities).size === identities.length &&
    JSON.stringify(identities) === JSON.stringify([...identities].sort())
  );
}

function isCanonicalDocumentationRemediationPath(candidate: string): boolean {
  try {
    return (
      normalizePolicyPath(candidate) === candidate && !candidate.endsWith('/**')
    );
  } catch {
    return false;
  }
}

function isTaskMandateBinding(value: unknown, changeId: string): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.join('\0') !==
    [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'mandateTaskId',
      'schemaVersion',
    ]
      .sort()
      .join('\0')
  ) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    value.changeId === changeId &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    typeof value.mandateTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    isDigest(value.mandateDigest)
  );
}
