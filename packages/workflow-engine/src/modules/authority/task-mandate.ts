import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  type AuthorityAuditRecordedEvent,
} from '../../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  isPostApprovalAdmissionFailure,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  isProviderId,
  type ProviderId,
} from '../provider-orchestration/provider-registry.ts';
import { assertChangeId } from '../../runtime/session-workspace/paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';

import { createTaskMandateProviderLifecycle } from './task-mandate-provider-lifecycle.ts';
export type TaskMandateProviderLifecycleBindings = {
  assertTaskMandateBinding: typeof assertTaskMandateBinding;
  assertProviderReservationId: typeof assertProviderReservationId;
  discoverRepository: typeof discoverRepository;
  taskMandateStorePaths: typeof taskMandateStorePaths;
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
  readTaskRecord: typeof readTaskRecord;
  validateTaskMandateEnvelopeForRepository: typeof validateTaskMandateEnvelopeForRepository;
  exactDate: typeof exactDate;
  assertRecordActive: typeof assertRecordActive;
  assertExactTaskMandateBinding: typeof assertExactTaskMandateBinding;
  appendTaskMandateAuthorizationAudit: typeof appendTaskMandateAuthorizationAudit;
  assertProviderInvocationAuditInput: typeof assertProviderInvocationAuditInput;
  findTaskMandateProviderReservation: typeof findTaskMandateProviderReservation;
  appendTaskMandateProviderInvocationAudit: typeof appendTaskMandateProviderInvocationAudit;
  assertProviderReservationOperation: typeof assertProviderReservationOperation;
  taskMandateProviderOperationDigest: typeof taskMandateProviderOperationDigest;
  appendTaskMandateProviderReservationAudit: typeof appendTaskMandateProviderReservationAudit;
  authorizeProviderCall: typeof authorizeProviderCall;
  replacePrivateFileAtomic: typeof replacePrivateFileAtomic;
  taskRecordPath: typeof taskRecordPath;
  canonicalTaskMandateRecord: typeof canonicalTaskMandateRecord;
  unsafeStore: typeof unsafeStore;
};
export type TaskMandateProviderLifecycleTypes = {
  TaskMandateBinding: TaskMandateBinding;
  TaskMandateProviderReservationOperation: TaskMandateProviderReservationOperation;
  TaskMandateOptions: TaskMandateOptions;
  TaskMandateProviderReservationAuthorization: TaskMandateProviderReservationAuthorization;
  TaskMandateProviderInvocationAuditInput: TaskMandateProviderInvocationAuditInput;
  AuthorityAuditRecordedEvent: AuthorityAuditRecordedEvent;
};

function boundTaskMandateProviderLifecycle() {
  return createTaskMandateProviderLifecycle({
    assertTaskMandateBinding,
    assertProviderReservationId,
    discoverRepository,
    taskMandateStorePaths,
    withRepositoryLifecycleOperation,
    readTaskRecord,
    validateTaskMandateEnvelopeForRepository,
    exactDate,
    assertRecordActive,
    assertExactTaskMandateBinding,
    appendTaskMandateAuthorizationAudit,
    assertProviderInvocationAuditInput,
    findTaskMandateProviderReservation,
    appendTaskMandateProviderInvocationAudit,
    assertProviderReservationOperation,
    taskMandateProviderOperationDigest,
    appendTaskMandateProviderReservationAudit,
    authorizeProviderCall,
    replacePrivateFileAtomic,
    taskRecordPath,
    canonicalTaskMandateRecord,
    unsafeStore,
  });
}

import { createTaskMandateRecords } from './task-mandate-records.ts';
export type TaskMandateRecordsBindings = {
  hasExactKeys: typeof hasExactKeys;
  mandateInvalid: typeof mandateInvalid;
  assertChangeId: typeof assertChangeId;
  assertTaskMandateTaskId: typeof assertTaskMandateTaskId;
  assertIntent: typeof assertIntent;
  parseProviderDeclarations: typeof parseProviderDeclarations;
  assertSignature: typeof assertSignature;
  PAYLOAD_KEYS: typeof PAYLOAD_KEYS;
  isWorkflowFailure: typeof isWorkflowFailure;
  TASK_MANDATE_INACTIVITY_DAYS: typeof TASK_MANDATE_INACTIVITY_DAYS;
  MANDATE_ID: typeof MANDATE_ID;
  TASK_ID: typeof TASK_ID;
  assertExternalAuditRootPath: typeof assertExternalAuditRootPath;
  COMMIT_OID: typeof COMMIT_OID;
  exactTimestamp: typeof exactTimestamp;
  isSortedUniqueProviderReservations: typeof isSortedUniqueProviderReservations;
  unsafeStore: typeof unsafeStore;
};
export type TaskMandateRecordsTypes = {
  TaskMandateRequest: TaskMandateRequest;
  TaskMandatePayload: TaskMandatePayload;
  TaskMandateEnvelope: TaskMandateEnvelope;
  TaskMandateRecord: TaskMandateRecord;
  StoredTaskMandateProviderUsage: StoredTaskMandateProviderUsage;
};

function boundTaskMandateRecords() {
  return createTaskMandateRecords({
    hasExactKeys,
    mandateInvalid,
    assertChangeId,
    assertTaskMandateTaskId,
    assertIntent,
    parseProviderDeclarations,
    assertSignature,
    PAYLOAD_KEYS,
    isWorkflowFailure,
    TASK_MANDATE_INACTIVITY_DAYS,
    MANDATE_ID,
    TASK_ID,
    assertExternalAuditRootPath,
    COMMIT_OID,
    exactTimestamp,
    isSortedUniqueProviderReservations,
    unsafeStore,
  });
}

import { createTaskMandatePolicy } from './task-mandate-policy.ts';
export type TaskMandatePolicyBindings = {
  mandateInvalid: typeof mandateInvalid;
  hasExactKeys: typeof hasExactKeys;
  DATA_TYPES: typeof DATA_TYPES;
  TASK_ID: typeof TASK_ID;
  canonicalTaskMandateEnvelope: typeof canonicalTaskMandateEnvelope;
  assertMandateId: typeof assertMandateId;
  assertChangeId: typeof assertChangeId;
  assertExternalAuditRootPath: typeof assertExternalAuditRootPath;
  PROVIDER_RESERVATION_ID: typeof PROVIDER_RESERVATION_ID;
  unsafeStore: typeof unsafeStore;
  exactTimestamp: typeof exactTimestamp;
};
export type TaskMandatePolicyTypes = {
  TaskMandateRecord: TaskMandateRecord;
  TaskMandateProviderReservationOperation: TaskMandateProviderReservationOperation;
  TaskMandateProviderUsage: TaskMandateProviderUsage;
  TaskMandateOperation: TaskMandateOperation;
  TaskMandateProviderDeclaration: TaskMandateProviderDeclaration;
  TaskMandateDataType: TaskMandateDataType;
  TaskMandateBinding: TaskMandateBinding;
  StoredTaskMandateProviderUsage: StoredTaskMandateProviderUsage;
  TaskMandateProviderInvocationAuditInput: TaskMandateProviderInvocationAuditInput;
};

function boundTaskMandatePolicy() {
  return createTaskMandatePolicy({
    mandateInvalid,
    hasExactKeys,
    DATA_TYPES,
    TASK_ID,
    canonicalTaskMandateEnvelope,
    assertMandateId,
    assertChangeId,
    assertExternalAuditRootPath,
    PROVIDER_RESERVATION_ID,
    unsafeStore,
    exactTimestamp,
  });
}

import { createTaskMandateAudit } from './task-mandate-audit.ts';
export type TaskMandateAuditBindings = {
  deriveAuthorityAuditRepositoryId: typeof deriveAuthorityAuditRepositoryId;
  taskMandateBinding: typeof taskMandateBinding;
  recordAuthorityAuditEvent: typeof recordAuthorityAuditEvent;
  unsafeStore: typeof unsafeStore;
};
export type TaskMandateAuditTypes = {
  TaskMandatePayload: TaskMandatePayload;
  AuthorityAuditLedgerScope: AuthorityAuditLedgerScope;
  TaskMandateRecord: TaskMandateRecord;
  AuthorityAuditRecordedEvent: AuthorityAuditRecordedEvent;
  StoredTaskMandateProviderUsage: StoredTaskMandateProviderUsage;
  TaskMandateProviderInvocationAuditInput: TaskMandateProviderInvocationAuditInput;
  Sha256Digest: Sha256Digest;
};

function boundTaskMandateAudit() {
  return createTaskMandateAudit({
    deriveAuthorityAuditRepositoryId,
    taskMandateBinding,
    recordAuthorityAuditEvent,
    unsafeStore,
  });
}

import { createTaskMandateStore } from './task-mandate-store.ts';
export type TaskMandateStoreBindings = {
  runtimePaths: typeof runtimePaths;
  ensurePlainDirectory: typeof ensurePlainDirectory;
  parseCurrentTaskMandateRecord: typeof parseCurrentTaskMandateRecord;
  assertTaskMandateTaskId: typeof assertTaskMandateTaskId;
  assertMandateId: typeof assertMandateId;
  unsafeStore: typeof unsafeStore;
};
export type TaskMandateStoreTypes = {
  TaskMandateRecord: TaskMandateRecord;
};

function boundTaskMandateStore() {
  return createTaskMandateStore({
    runtimePaths,
    ensurePlainDirectory,
    parseCurrentTaskMandateRecord,
    assertTaskMandateTaskId,
    assertMandateId,
    unsafeStore,
  });
}

export const TASK_MANDATE_SIGNATURE_NAMESPACE_V2 =
  'HARNESS_TASK_MANDATE_V2' as const;
export const TASK_MANDATE_INACTIVITY_DAYS = 14;

const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;
const DATA_TYPES = [
  'diff',
  'repository-metadata',
  'source-code',
  'task-intent',
  'test-output',
] as const;
const PAYLOAD_KEYS = [
  'kind',
  'mandateId',
  'changeId',
  'taskId',
  'repositoryId',
  'repositoryOrigin',
  'externalAuditRoot',
  'policyBlob',
  'baseCommit',
  'intent',
  'preparation',
  'authoritativeEffects',
  'controlPlaneMutation',
  'secretScopes',
  'validUntil',
  'auditRequired',
  'issuedAt',
  'signer',
] as const;
export type TaskMandateDataType = (typeof DATA_TYPES)[number];

export type TaskMandateProviderDeclaration = {
  maxInvocations: number;
  maxBudget: number | null;
  dataTypes: TaskMandateDataType[];
  sourceCode: boolean;
  secrets: false;
  retryOnFailure: boolean;
  retryRequiresHuman: boolean;
};

export type TaskMandateRequest = {
  changeId: string;
  taskId: string;
  intent: string;
  providerCalls: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>;
};

export type TaskMandatePayload = {
  kind: 'task-mandate.v2';
  mandateId: string;
  changeId: string;
  taskId: string;
  repositoryId: string;
  repositoryOrigin: string;
  externalAuditRoot: string;
  policyBlob: string;
  baseCommit: string;
  intent: string;
  preparation: {
    repositoryRead: true;
    isolatedRepositoryWrites: true;
    addDeleteRenameFiles: true;
    localCommands: true;
    draftCommits: true;
    candidateAndDesignArtifacts: true;
    providerCalls: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>;
    readOnlyConnectors: true;
  };
  authoritativeEffects: false;
  controlPlaneMutation: false;
  secretScopes: [];
  validUntil: {
    taskClosed: true;
    humanRevokes: true;
    repositoryIdentityChanges: true;
    intentReplaced: true;
    inactivityDays: 14;
  };
  auditRequired: true;
  issuedAt: string;
  signer: string;
};

export type TaskMandateEnvelope = {
  payload: TaskMandatePayload;
  signature: string;
};

export type TaskMandateProviderUsage = {
  invocations: number;
  budget: number;
};

type StoredTaskMandateProviderUsage = TaskMandateProviderUsage & {
  reservations: Array<{
    reservationId: string;
    authorizedAt: string;
    requestDigest: string;
    operationDigest: string;
    executionGrantId?: string;
  }>;
};

export type TaskMandateBinding = {
  schemaVersion: 1;
  mandateTaskId: string;
  mandateId: string;
  mandateDigest: string;
  changeId: string;
  externalAuditRoot: string;
};

type TaskMandateRecord = {
  schemaVersion: 2;
  state: 'active' | 'revoked';
  mandateId: string;
  changeId: string;
  externalAuditRoot: string;
  taskId: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, StoredTaskMandateProviderUsage>>;
  revokedAt: string | null;
  revocationReason: string | null;
  envelope: TaskMandateEnvelope;
};

export type TaskMandateInspection = {
  mandateId: string;
  changeId: string;
  externalAuditRoot: string;
  taskId: string;
  state: 'active' | 'expired' | 'revoked';
  intent: string;
  baseCommit: string;
  signer: string;
  issuedAt: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, TaskMandateProviderUsage>>;
  inactivityDays: 14;
  revokedAt?: string;
  revocationReason?: string;
};

export type TaskMandateOperation =
  | {
      kind:
        | 'repository-read'
        | 'isolated-repository-write'
        | 'add-delete-rename'
        | 'local-command'
        | 'draft-commit'
        | 'candidate-or-design-artifact'
        | 'read-only-connector';
    }
  | {
      kind:
        | 'authoritative-ref-update'
        | 'push'
        | 'deploy'
        | 'secret-scope-expansion'
        | 'irreversible-external-effect'
        | 'live-workflow-state-mutation'
        | 'control-plane-mutation';
    }
  | {
      kind: 'provider-call';
      providerId: ProviderId;
      dataTypes: TaskMandateDataType[];
      sourceCode: boolean;
      secrets: boolean;
      retry: boolean;
      budget: number | null;
    };

export type TaskMandateOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export type TaskMandateOperationOptions = TaskMandateOptions & {
  changeId: string;
};

export type TaskMandateProviderReservationOperation = Omit<
  Extract<TaskMandateOperation, { kind: 'provider-call' }>,
  'kind'
> & {
  requestDigest: string;
  /**
   * A signed execution-budget grant the caller has already validated and
   * consumed for this exact replacement Attempt. The human signature it
   * carries is the consent that lets this one reservation proceed past an
   * exhausted declared budget; the ledger records the grant so the excess is
   * attributed, never silent.
   */
  executionGrant?: { grantId: string };
};

export type TaskMandateProviderReservationAuthorization = {
  authorized: true;
  binding: TaskMandateBinding;
  reservationId: string;
  providerUsage: TaskMandateProviderUsage;
  replay: boolean;
  audit: AuthorityAuditRecordedEvent;
};

export type TaskMandateProviderInvocationAuditInput = {
  providerId: ProviderId;
  invocationId: string;
  requestDigest: string;
  occurredAt: string;
};

export type AuthorizeTaskMandateOptions = TaskMandateOptions & {
  mandateId?: string;
  externalAuditRoot?: string;
};

export type RevokeTaskMandateOptions = TaskMandateOptions & {
  reason: string;
};

export function parseTaskMandateRequest(value: unknown): TaskMandateRequest {
  return boundTaskMandateRecords().parseTaskMandateRequest(value);
}

export function authorizeTaskMandate(
  cwd: string,
  requested: TaskMandateRequest,
  options: AuthorizeTaskMandateOptions = {},
): {
  mandateId: string;
  recordPath: string;
  envelope: TaskMandateEnvelope;
  audit: AuthorityAuditRecordedEvent;
} {
  const request = parseTaskMandateRequest(requested);
  const context = loadTrustContext(cwd);
  const externalAuditRoot = assertExternalAuditRoot(options.externalAuditRoot);
  scanAuthorityAuditLedger({
    externalAuditRoot,
    repositoryRoot: context.repository.repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(
      context.policy.repository.id,
    ),
  });
  const now = exactDate(options.now ?? new Date());
  const mandateId = assertMandateId(options.mandateId ?? crypto.randomUUID());
  const paths = taskMandateStorePaths(context.repository.gitCommonDirectory);
  const existingActive = taskRecordPath(paths.active, request.taskId);
  const existingTerminal = taskRecordPath(paths.terminal, request.taskId);
  if (fs.existsSync(existingActive)) {
    throw workflowError(
      'TASK_MANDATE_EXISTS',
      `Task ${request.taskId} already has an active mandate.`,
      ExitCode.conflict,
    );
  }
  if (fs.existsSync(existingTerminal)) {
    const terminal = parseCurrentTaskMandateRecord(
      readPrivateFile(existingTerminal),
    );
    validateTaskMandateEnvelopeForRepository(
      context.repository.repositoryRoot,
      terminal.envelope,
      options.signer,
    );
  }
  const signer =
    options.signer ??
    createInteractiveSshSigner(
      context.repository.repositoryRoot,
      context.policy,
    );

  signer.assertHumanPresent();
  const identity = signer.identity();
  if (
    !context.policy.trustedSigners.some(({ identity: id }) => id === identity)
  ) {
    throw workflowError(
      'TASK_MANDATE_SIGNER_UNTRUSTED',
      'Task mandate signer is not trusted by the exact base policy.',
      ExitCode.verification,
    );
  }
  const payload: TaskMandatePayload = {
    kind: 'task-mandate.v2',
    mandateId,
    changeId: request.changeId,
    taskId: request.taskId,
    repositoryId: context.policy.repository.id,
    repositoryOrigin: context.policy.repository.origin,
    externalAuditRoot,
    policyBlob: context.policyBlob,
    baseCommit: context.repository.head,
    intent: request.intent,
    preparation: {
      repositoryRead: true,
      isolatedRepositoryWrites: true,
      addDeleteRenameFiles: true,
      localCommands: true,
      draftCommits: true,
      candidateAndDesignArtifacts: true,
      providerCalls: cloneProviderDeclarations(request.providerCalls),
      readOnlyConnectors: true,
    },
    authoritativeEffects: false,
    controlPlaneMutation: false,
    secretScopes: [],
    validUntil: {
      taskClosed: true,
      humanRevokes: true,
      repositoryIdentityChanges: true,
      intentReplaced: true,
      inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    },
    auditRequired: true,
    issuedAt: now.toISOString(),
    signer: identity,
  };
  validateTaskMandatePayload(payload);
  let signature: string;
  try {
    signature = signer.sign(
      canonicalTaskMandatePayload(payload),
      TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
    );
    assertSignature(signature);
    signer.verify(
      canonicalTaskMandatePayload(payload),
      signature,
      identity,
      TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
    );
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature could not be created or verified.',
      ExitCode.verification,
    );
  }
  const envelope = { payload, signature };
  const record: TaskMandateRecord = {
    schemaVersion: 2,
    state: 'active',
    mandateId,
    changeId: request.changeId,
    externalAuditRoot,
    taskId: request.taskId,
    lastActivityAt: now.toISOString(),
    providerUsage: Object.fromEntries(
      Object.keys(request.providerCalls).map((providerId) => [
        providerId,
        { invocations: 0, budget: 0, reservations: [] },
      ]),
    ),
    revokedAt: null,
    revocationReason: null,
    envelope,
  };
  const recordPath = withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      ensureStore(paths);
      assertOwned();
      const active = taskRecordPath(paths.active, request.taskId);
      const terminal = taskRecordPath(paths.terminal, request.taskId);
      if (fs.existsSync(active)) {
        throw workflowError(
          'TASK_MANDATE_EXISTS',
          `Task ${request.taskId} already has an active mandate.`,
          ExitCode.conflict,
        );
      }
      if (fs.existsSync(terminal)) {
        const previous = parseCurrentTaskMandateRecord(
          readPrivateFile(terminal),
        );
        const history = taskHistoryPath(
          paths.history,
          request.taskId,
          previous.mandateId,
        );
        if (fs.existsSync(history)) throw unsafeStore();
        fs.renameSync(terminal, history);
        fsyncDirectory(paths.terminal);
        fsyncDirectory(paths.history);
      }
      createPrivateFileAtomic(active, canonicalTaskMandateRecord(record));
      assertOwned();
      return active;
    },
  );
  const audit = appendTaskMandateAuthorizationAudit(
    context.repository.repositoryRoot,
    record,
    exactDate(options.now ?? new Date()),
  );
  return { mandateId, recordPath, envelope, audit };
}

export function inspectTaskMandate(
  cwd: string,
  requestedTaskId: string,
  options: TaskMandateOptions = {},
): TaskMandateInspection {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  const record = readTaskRecord(paths, taskId);
  validateTaskMandateEnvelopeForRepository(
    repository.repositoryRoot,
    record.envelope,
    options.signer,
  );
  return inspectRecord(record, exactDate(options.now ?? new Date()));
}

export function inspectActiveTaskMandateBinding(
  cwd: string,
  requestedTaskId: string,
  options: TaskMandateOptions = {},
): TaskMandateBinding {
  return withActiveTaskMandateBinding(
    cwd,
    requestedTaskId,
    options,
    (binding) => binding,
  );
}

export function withActiveTaskMandateBinding<T>(
  cwd: string,
  requestedTaskId: string,
  options: TaskMandateOptions,
  operation: (binding: TaskMandateBinding, assertOwned: () => void) => T,
): T {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    const auditNow = exactDate(options.now ?? new Date());
    assertRecordActive(record, auditNow);
    appendTaskMandateAuthorizationAudit(
      repository.repositoryRoot,
      record,
      auditNow,
    );
    assertOwned();
    return operation(taskMandateBinding(record), assertOwned);
  });
}

export function authorizeTaskMandateOperation(
  cwd: string,
  requestedTaskId: string,
  operation: Exclude<TaskMandateOperation, { kind: 'provider-call' }>,
  options: TaskMandateOperationOptions,
): {
  authorized: true;
  mandateId: string;
  taskId: string;
  binding: TaskMandateBinding;
} {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const changeId = assertChangeId(options.changeId);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    const now = exactDate(options.now ?? new Date());
    const refusalBinding = taskMandateRefusalBinding(
      repository.repositoryRoot,
      record,
      'task-mandate.operation',
      {
        changeId,
        operationKind: operation.kind,
      },
    );
    return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
      assertRecordActive(record, now);
      assertTaskMandateChange(record, changeId);
      appendTaskMandateAuthorizationAudit(
        repository.repositoryRoot,
        record,
        now,
      );
      assertOwned();
      if (!isPreparationOperation(operation.kind)) {
        throw workflowError(
          'TASK_MANDATE_EFFECT_NOT_AUTHORIZED',
          `Task mandate does not authorize ${operation.kind}.`,
          ExitCode.guard,
        );
      }
      record.lastActivityAt = now.toISOString();
      replacePrivateFileAtomic(
        taskRecordPath(paths.active, taskId),
        canonicalTaskMandateRecord(record),
      );
      assertOwned();
      return {
        authorized: true as const,
        mandateId: record.mandateId,
        taskId,
        binding: taskMandateBinding(record),
      };
    });
  });
}

export function authorizeTaskMandateProviderReservation(
  cwd: string,
  binding: TaskMandateBinding,
  requestedReservationId: string,
  operation: TaskMandateProviderReservationOperation,
  options: TaskMandateOptions = {},
): TaskMandateProviderReservationAuthorization {
  return boundTaskMandateProviderLifecycle().authorizeTaskMandateProviderReservation(
    cwd,
    binding,
    requestedReservationId,
    operation,
    options,
  );
}

export function authorizeTaskMandateProviderReservationUnderLifecycleLock(
  cwd: string,
  binding: TaskMandateBinding,
  requestedReservationId: string,
  operation: TaskMandateProviderReservationOperation,
  assertOwned: () => void,
  options: TaskMandateOptions = {},
): TaskMandateProviderReservationAuthorization {
  return boundTaskMandateProviderLifecycle().authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd,
    binding,
    requestedReservationId,
    operation,
    assertOwned,
    options,
  );
}

export function assertActiveTaskMandateBindingUnderLifecycleLock(
  cwd: string,
  binding: TaskMandateBinding,
  assertOwned: () => void,
  options: TaskMandateOptions = {},
): TaskMandateBinding {
  return boundTaskMandateProviderLifecycle().assertActiveTaskMandateBindingUnderLifecycleLock(
    cwd,
    binding,
    assertOwned,
    options,
  );
}

export function recordTaskMandateProviderInvocation(
  cwd: string,
  binding: TaskMandateBinding,
  input: TaskMandateProviderInvocationAuditInput,
  options: TaskMandateOptions = {},
): AuthorityAuditRecordedEvent {
  return boundTaskMandateProviderLifecycle().recordTaskMandateProviderInvocation(
    cwd,
    binding,
    input,
    options,
  );
}

export function recordTaskMandateProviderInvocationUnderLifecycleLock(
  cwd: string,
  binding: TaskMandateBinding,
  input: TaskMandateProviderInvocationAuditInput,
  assertOwned: () => void,
  options: TaskMandateOptions = {},
): AuthorityAuditRecordedEvent {
  return boundTaskMandateProviderLifecycle().recordTaskMandateProviderInvocationUnderLifecycleLock(
    cwd,
    binding,
    input,
    assertOwned,
    options,
  );
}

export function revokeTaskMandate(
  cwd: string,
  requestedTaskId: string,
  options: RevokeTaskMandateOptions,
): TaskMandateInspection {
  const taskId = assertTaskMandateTaskId(requestedTaskId);
  const reason = assertRevocationReason(options.reason);
  const repository = discoverRepository(cwd);
  const paths = taskMandateStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureStore(paths);
    const terminalPath = taskRecordPath(paths.terminal, taskId);
    if (fs.existsSync(terminalPath)) {
      const terminal = parseCurrentTaskMandateRecord(
        readPrivateFile(terminalPath),
      );
      validateTaskMandateEnvelopeForRepository(
        repository.repositoryRoot,
        terminal.envelope,
        options.signer,
      );
      if (terminal.schemaVersion === 2) {
        appendTaskMandateAuthorizationAudit(
          repository.repositoryRoot,
          terminal,
          exactDate(options.now ?? new Date()),
        );
        appendTaskMandateRevocationAudit(
          repository.repositoryRoot,
          terminal,
          exactDate(options.now ?? new Date()),
        );
      }
      return inspectRecord(terminal, exactDate(options.now ?? new Date()));
    }
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    const now = exactDate(options.now ?? new Date());
    const refusalBinding = taskMandateRefusalBinding(
      repository.repositoryRoot,
      record,
      'task-mandate.revoke',
      { reasonDigest: authorityRefusalDigest(reason) },
    );
    return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
      appendTaskMandateAuthorizationAudit(
        repository.repositoryRoot,
        record,
        now,
      );
      const signer = options.signer ?? currentSigner(repository.repositoryRoot);
      signer.assertHumanPresent();
      const currentPolicy = loadPolicyAt(
        repository.repositoryRoot,
        repository.head,
      ).policy;
      if (
        !currentPolicy.trustedSigners.some(
          ({ identity }) => identity === signer.identity(),
        )
      ) {
        throw workflowError(
          'TASK_MANDATE_SIGNER_UNTRUSTED',
          'Task mandate revocation requires a currently trusted signer.',
          ExitCode.verification,
        );
      }
      record.state = 'revoked';
      record.revokedAt = now.toISOString();
      record.revocationReason = reason;
      assertOwned();
      const activePath = taskRecordPath(paths.active, taskId);
      fs.renameSync(activePath, terminalPath);
      replacePrivateFileAtomic(
        terminalPath,
        canonicalTaskMandateRecord(record),
      );
      assertOwned();
      appendTaskMandateRevocationAudit(repository.repositoryRoot, record, now);
      assertOwned();
      return inspectRecord(record, now);
    });
  });
}

export function canonicalTaskMandatePayload(
  payload: TaskMandatePayload,
): string {
  return boundTaskMandateRecords().canonicalTaskMandatePayload(payload);
}

export function canonicalTaskMandateEnvelope(
  envelope: TaskMandateEnvelope,
): string {
  return boundTaskMandateRecords().canonicalTaskMandateEnvelope(envelope);
}

export function parseTaskMandateEnvelope(raw: string): TaskMandateEnvelope {
  return boundTaskMandateRecords().parseTaskMandateEnvelope(raw);
}

function validateTaskMandatePayload(payload: TaskMandatePayload): void {
  return boundTaskMandateRecords().validateTaskMandatePayload(payload);
}

function validateTaskMandateEnvelopeForRepository(
  repositoryRoot: string,
  envelope: TaskMandateEnvelope,
  providedSigner?: MaintainerSignerProvider,
): void {
  const payload = envelope.payload;
  const base = loadPolicyAt(repositoryRoot, payload.baseCommit);
  const currentHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const current = loadPolicyAt(repositoryRoot, currentHead);
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  if (
    base.policyBlob !== payload.policyBlob ||
    base.policy.repository.id !== payload.repositoryId ||
    base.policy.repository.origin !== payload.repositoryOrigin ||
    current.policy.repository.id !== payload.repositoryId ||
    current.policy.repository.origin !== payload.repositoryOrigin ||
    origin !== payload.repositoryOrigin ||
    !base.policy.trustedSigners.some(
      ({ identity }) => identity === payload.signer,
    )
  ) {
    throw workflowError(
      'TASK_MANDATE_REPOSITORY_MISMATCH',
      'Task mandate no longer matches this repository identity or trust base.',
      ExitCode.staleState,
    );
  }
  scanAuthorityAuditLedger(taskMandateAuditScope(repositoryRoot, payload));
  const signer =
    providedSigner ?? createInteractiveSshSigner(repositoryRoot, base.policy);
  try {
    signer.verify(
      canonicalTaskMandatePayload(payload),
      envelope.signature,
      payload.signer,
      TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature is invalid for its dedicated domain.',
      ExitCode.verification,
    );
  }
}

function authorizeProviderCall(
  record: TaskMandateRecord,
  operation: TaskMandateProviderReservationOperation,
  reservationId: string,
  authorizedAt: string,
  operationDigest: string,
): TaskMandateProviderUsage {
  return boundTaskMandatePolicy().authorizeProviderCall(
    record,
    operation,
    reservationId,
    authorizedAt,
    operationDigest,
  );
}

function isPreparationOperation(kind: TaskMandateOperation['kind']): boolean {
  return boundTaskMandatePolicy().isPreparationOperation(kind);
}

function parseProviderDeclarations(
  value: Record<string, unknown>,
): Partial<Record<ProviderId, TaskMandateProviderDeclaration>> {
  return boundTaskMandatePolicy().parseProviderDeclarations(value);
}

function cloneProviderDeclarations(
  declarations: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>,
): Partial<Record<ProviderId, TaskMandateProviderDeclaration>> {
  return boundTaskMandatePolicy().cloneProviderDeclarations(declarations);
}

function inspectRecord(
  record: TaskMandateRecord,
  now: Date,
): TaskMandateInspection {
  assertRecordClock(record, now);
  const state =
    record.state === 'revoked'
      ? 'revoked'
      : isInactive(record, now)
        ? 'expired'
        : 'active';
  return {
    mandateId: record.mandateId,
    changeId: record.changeId,
    externalAuditRoot: record.externalAuditRoot,
    taskId: record.taskId,
    state,
    intent: record.envelope.payload.intent,
    baseCommit: record.envelope.payload.baseCommit,
    signer: record.envelope.payload.signer,
    issuedAt: record.envelope.payload.issuedAt,
    lastActivityAt: record.lastActivityAt,
    providerUsage: Object.fromEntries(
      Object.entries(record.providerUsage).map(([providerId, usage]) => [
        providerId,
        { invocations: usage.invocations, budget: usage.budget },
      ]),
    ),
    inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    ...(record.revocationReason
      ? { revocationReason: record.revocationReason }
      : {}),
  };
}

function assertRecordActive(record: TaskMandateRecord, now: Date): void {
  assertRecordClock(record, now);
  if (record.state === 'revoked') {
    throw workflowError(
      'TASK_MANDATE_REVOKED',
      'Task mandate has been revoked.',
      ExitCode.staleState,
    );
  }
  if (isInactive(record, now)) {
    throw workflowError(
      'TASK_MANDATE_EXPIRED',
      'Task mandate expired after fourteen days without activity.',
      ExitCode.staleState,
    );
  }
}

function assertRecordClock(record: TaskMandateRecord, now: Date): void {
  const lastActivity = exactTimestamp(record.lastActivityAt);
  if (lastActivity === undefined || lastActivity > now.getTime() + 30_000) {
    throw unsafeStore();
  }
}

function isInactive(record: TaskMandateRecord, now: Date): boolean {
  const lastActivity = exactTimestamp(record.lastActivityAt);
  if (lastActivity === undefined) throw unsafeStore();
  return (
    now.getTime() - lastActivity >=
    TASK_MANDATE_INACTIVITY_DAYS * 24 * 60 * 60_000
  );
}

function taskMandateStorePaths(gitCommonDirectory: string) {
  return boundTaskMandateStore().taskMandateStorePaths(gitCommonDirectory);
}

function ensureStore(paths: ReturnType<typeof taskMandateStorePaths>): void {
  return boundTaskMandateStore().ensureStore(paths);
}

function readTaskRecord(
  paths: ReturnType<typeof taskMandateStorePaths>,
  taskId: string,
): TaskMandateRecord {
  return boundTaskMandateStore().readTaskRecord(paths, taskId);
}

function canonicalTaskMandateRecord(record: TaskMandateRecord): string {
  return boundTaskMandateRecords().canonicalTaskMandateRecord(record);
}

function parseCurrentTaskMandateRecord(raw: string): TaskMandateRecord {
  return boundTaskMandateRecords().parseCurrentTaskMandateRecord(raw);
}

function taskMandateAuditScope(
  repositoryRoot: string,
  payload: TaskMandatePayload,
): AuthorityAuditLedgerScope {
  return boundTaskMandateAudit().taskMandateAuditScope(repositoryRoot, payload);
}

function taskMandateRefusalBinding(
  repositoryRoot: string,
  record: TaskMandateRecord,
  operation: string,
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  return boundTaskMandateAudit().taskMandateRefusalBinding(
    repositoryRoot,
    record,
    operation,
    refusalIdentity,
  );
}

function appendTaskMandateAuthorizationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  now?: Date,
): AuthorityAuditRecordedEvent {
  return boundTaskMandateAudit().appendTaskMandateAuthorizationAudit(
    repositoryRoot,
    record,
    now,
  );
}

function appendTaskMandateRevocationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  now?: Date,
): AuthorityAuditRecordedEvent {
  return boundTaskMandateAudit().appendTaskMandateRevocationAudit(
    repositoryRoot,
    record,
    now,
  );
}

function appendTaskMandateProviderReservationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  providerId: ProviderId,
  reservation: StoredTaskMandateProviderUsage['reservations'][number],
): AuthorityAuditRecordedEvent {
  return boundTaskMandateAudit().appendTaskMandateProviderReservationAudit(
    repositoryRoot,
    record,
    providerId,
    reservation,
  );
}

function appendTaskMandateProviderInvocationAudit(
  repositoryRoot: string,
  record: TaskMandateRecord,
  input: TaskMandateProviderInvocationAuditInput,
): AuthorityAuditRecordedEvent {
  return boundTaskMandateAudit().appendTaskMandateProviderInvocationAudit(
    repositoryRoot,
    record,
    input,
  );
}

function loadTrustContext(cwd: string) {
  const repository = discoverRepository(cwd);
  const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== loaded.policy.repository.origin) {
    throw workflowError(
      'TASK_MANDATE_REPOSITORY_MISMATCH',
      'Repository origin differs from its trusted task mandate policy.',
      ExitCode.guard,
    );
  }
  return { repository, ...loaded };
}

function loadPolicyAt(repositoryRoot: string, commit: string) {
  try {
    const content = runGit(repositoryRoot, [
      'show',
      `${commit}:workflow/maintainer-policy.json`,
    ]);
    return {
      policy: parseMaintainerPolicy(JSON.parse(content)),
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${commit}:workflow/maintainer-policy.json`,
      ]).trim(),
    };
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_POLICY_INVALID',
      'Task mandate trust-base policy is unavailable or invalid.',
      ExitCode.guard,
    );
  }
}

function currentSigner(repositoryRoot: string): MaintainerSignerProvider {
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  return createInteractiveSshSigner(
    repositoryRoot,
    loadPolicyAt(repositoryRoot, head).policy,
  );
}

function taskRecordPath(directory: string, taskId: string): string {
  return boundTaskMandateStore().taskRecordPath(directory, taskId);
}

function taskHistoryPath(
  directory: string,
  taskId: string,
  mandateId: string,
): string {
  return boundTaskMandateStore().taskHistoryPath(directory, taskId, mandateId);
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  return boundTaskMandateStore().createPrivateFileAtomic(filePath, content);
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  return boundTaskMandateStore().replacePrivateFileAtomic(filePath, content);
}

function readPrivateFile(filePath: string): string {
  return boundTaskMandateStore().readPrivateFile(filePath);
}

function fsyncDirectory(directory: string): void {
  return boundTaskMandateStore().fsyncDirectory(directory);
}

function assertTaskMandateTaskId(value: string): string {
  return boundTaskMandatePolicy().assertTaskMandateTaskId(value);
}

function taskMandateBinding(record: TaskMandateRecord): TaskMandateBinding {
  return boundTaskMandatePolicy().taskMandateBinding(record);
}

function assertTaskMandateBinding(value: unknown): TaskMandateBinding {
  return boundTaskMandatePolicy().assertTaskMandateBinding(value);
}

function assertTaskMandateChange(
  record: TaskMandateRecord,
  changeId: string,
): void {
  return boundTaskMandatePolicy().assertTaskMandateChange(record, changeId);
}

function assertExactTaskMandateBinding(
  record: TaskMandateRecord,
  binding: TaskMandateBinding,
): void {
  return boundTaskMandatePolicy().assertExactTaskMandateBinding(
    record,
    binding,
  );
}

function assertProviderReservationId(value: string): string {
  return boundTaskMandatePolicy().assertProviderReservationId(value);
}

function assertProviderReservationOperation(
  value: unknown,
): TaskMandateProviderReservationOperation {
  return boundTaskMandatePolicy().assertProviderReservationOperation(value);
}

function taskMandateProviderOperationDigest(
  operation: TaskMandateProviderReservationOperation,
): string {
  return boundTaskMandatePolicy().taskMandateProviderOperationDigest(operation);
}

function findTaskMandateProviderReservation(
  record: TaskMandateRecord,
  reservationId: string,
): {
  providerId: ProviderId;
  usage: StoredTaskMandateProviderUsage;
  reservation: StoredTaskMandateProviderUsage['reservations'][number];
} | null {
  return boundTaskMandatePolicy().findTaskMandateProviderReservation(
    record,
    reservationId,
  );
}

function assertProviderInvocationAuditInput(
  value: unknown,
): TaskMandateProviderInvocationAuditInput {
  return boundTaskMandatePolicy().assertProviderInvocationAuditInput(value);
}

function isSortedUniqueProviderReservations(
  value: unknown,
): value is StoredTaskMandateProviderUsage['reservations'] {
  return boundTaskMandatePolicy().isSortedUniqueProviderReservations(value);
}

function assertExternalAuditRoot(value: string | undefined): string {
  if (value === undefined) {
    throw workflowError(
      'TASK_MANDATE_AUDIT_ROOT_REQUIRED',
      'Task Mandate authorization requires an explicit repository-external audit root.',
      ExitCode.unsafeEnvironment,
    );
  }
  return assertExternalAuditRootPath(value);
}

function assertExternalAuditRootPath(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw mandateInvalid(
      'Task mandate external audit root must be an exact absolute path.',
    );
  }
  return value;
}

function assertMandateId(value: string): string {
  if (!MANDATE_ID.test(value)) {
    throw mandateInvalid('Task mandate ID must be a UUID v4.');
  }
  return value;
}

function assertIntent(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 4096 ||
    containsControlCharacter(value)
  ) {
    throw mandateInvalid('Task mandate intent is invalid.');
  }
  return value;
}

function assertRevocationReason(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 1024 ||
    containsControlCharacter(value)
  ) {
    throw mandateInvalid('Task mandate revocation reason is invalid.');
  }
  return value;
}

function assertSignature(value: string): void {
  if (!SIGNATURE.test(value)) {
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature is not canonical armored SSH signature data.',
      ExitCode.verification,
    );
  }
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw mandateInvalid('Task mandate timestamp is invalid.');
  }
  return date;
}

function exactTimestamp(value: string): number | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date.getTime()
    : undefined;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function isWorkflowFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

function mandateInvalid(message: string) {
  return workflowError('TASK_MANDATE_INVALID', message, ExitCode.guard);
}

function unsafeStore() {
  return workflowError(
    'TASK_MANDATE_STORE_UNSAFE',
    'Task mandate storage is malformed or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}
