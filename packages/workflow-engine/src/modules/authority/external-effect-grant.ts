import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deriveAuthorityAuditRepositoryId } from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  appendExternalEffectAuthorityAudit,
  type ExternalEffectAuthorityAuditOptions,
} from '../../runtime/storage-journal/external-effect-audit.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import {
  inspectActiveTaskMandateBinding,
  withActiveTaskMandateBinding,
  type TaskMandateBinding,
} from './task-mandate.ts';

import { createExternalEffectGrantTransaction } from './external-effect-grant-transaction.ts';
export type ExternalEffectGrantTransactionBindings = {
  assertUuid: typeof assertUuid;
  discoverRepository: typeof discoverRepository;
  externalEffectStorePaths: typeof externalEffectStorePaths;
  exactDate: typeof exactDate;
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
  readStoreState: typeof readStoreState;
  validateEnvelopeForRepository: typeof validateEnvelopeForRepository;
  inspectionFromState: typeof inspectionFromState;
  expired: typeof expired;
  createTransactionRecord: typeof createTransactionRecord;
  emitAudit: typeof emitAudit;
  auditInput: typeof auditInput;
  createPrivateFileAtomic: typeof createPrivateFileAtomic;
  grantPath: typeof grantPath;
  canonicalTransaction: typeof canonicalTransaction;
  unlinkIfExact: typeof unlinkIfExact;
  canonicalAvailable: typeof canonicalAvailable;
  storedExternalEffectRefusalBinding: typeof storedExternalEffectRefusalBinding;
  refusalAuditOptions: typeof refusalAuditOptions;
  stateConflict: typeof stateConflict;
  assertTransactionId: typeof assertTransactionId;
  createObservation: typeof createObservation;
  assertObservationClock: typeof assertObservationClock;
  replaceTransactionDigest: typeof replaceTransactionDigest;
  replacePrivateFileAtomic: typeof replacePrivateFileAtomic;
  assertReason: typeof assertReason;
  PUBLISH_TRANSACTION_ENV: typeof PUBLISH_TRANSACTION_ENV;
  publishTransactionRequired: typeof publishTransactionRequired;
  publishTransactionInvalid: typeof publishTransactionInvalid;
  assertUuidForPublish: typeof assertUuidForPublish;
  runGit: typeof runGit;
  sha256: typeof sha256;
  canonicalTerminal: typeof canonicalTerminal;
};
export type ExternalEffectGrantTransactionTypes = {
  ExternalEffectTransitionOptions: ExternalEffectTransitionOptions;
  ExternalEffectGrantInspection: ExternalEffectGrantInspection;
  ExternalEffectObservation: ExternalEffectObservation;
  MaintainerSignerProvider: MaintainerSignerProvider;
  StoreState: StoreState;
  TerminalState: TerminalState;
  TerminalRecord: TerminalRecord;
  ExternalEffectAuditEventType: ExternalEffectAuditEventType;
};

function boundExternalEffectGrantTransaction() {
  return createExternalEffectGrantTransaction({
    assertUuid,
    discoverRepository,
    externalEffectStorePaths,
    exactDate,
    withRepositoryLifecycleOperation,
    readStoreState,
    validateEnvelopeForRepository,
    inspectionFromState,
    expired,
    createTransactionRecord,
    emitAudit,
    auditInput,
    createPrivateFileAtomic,
    grantPath,
    canonicalTransaction,
    unlinkIfExact,
    canonicalAvailable,
    storedExternalEffectRefusalBinding,
    refusalAuditOptions,
    stateConflict,
    assertTransactionId,
    createObservation,
    assertObservationClock,
    replaceTransactionDigest,
    replacePrivateFileAtomic,
    assertReason,
    PUBLISH_TRANSACTION_ENV,
    publishTransactionRequired,
    publishTransactionInvalid,
    assertUuidForPublish,
    runGit,
    sha256,
    canonicalTerminal,
  });
}

import { createExternalEffectGrantReconciliation } from './external-effect-grant-reconciliation.ts';
export type ExternalEffectGrantReconciliationBindings = {
  assertUuid: typeof assertUuid;
  discoverRepository: typeof discoverRepository;
  externalEffectStorePaths: typeof externalEffectStorePaths;
  exactDate: typeof exactDate;
  readStoreState: typeof readStoreState;
  validateEnvelopeForRepository: typeof validateEnvelopeForRepository;
  storedExternalEffectRefusalBinding: typeof storedExternalEffectRefusalBinding;
  refusalAuditOptions: typeof refusalAuditOptions;
  parseReconciliationRequest: typeof parseReconciliationRequest;
  loadTrustForPayload: typeof loadTrustForPayload;
  createInteractiveSshSigner: typeof createInteractiveSshSigner;
  assertTrustedSigner: typeof assertTrustedSigner;
  redactTransactionToken: typeof redactTransactionToken;
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
  inspectionFromState: typeof inspectionFromState;
  createReconciliationRecord: typeof createReconciliationRecord;
  emitAudit: typeof emitAudit;
  auditInput: typeof auditInput;
  createPrivateFileAtomic: typeof createPrivateFileAtomic;
  reconciliationPath: typeof reconciliationPath;
  canonicalReconciliation: typeof canonicalReconciliation;
  assertReason: typeof assertReason;
  terminalize: typeof terminalize;
};
export type ExternalEffectGrantReconciliationTypes = {
  ExternalEffectReconciliationRequest: ExternalEffectReconciliationRequest;
  ExternalEffectTransitionOptions: ExternalEffectTransitionOptions;
  ExternalEffectGrantPublicInspection: ExternalEffectGrantPublicInspection;
  ExternalEffectRevokeOptions: ExternalEffectRevokeOptions;
  ExternalEffectGrantInspection: ExternalEffectGrantInspection;
  StoreState: StoreState;
  TerminalRecord: TerminalRecord;
  ExternalEffectReconciliation: ExternalEffectReconciliation;
};

function boundExternalEffectGrantReconciliation() {
  return createExternalEffectGrantReconciliation({
    assertUuid,
    discoverRepository,
    externalEffectStorePaths,
    exactDate,
    readStoreState,
    validateEnvelopeForRepository,
    storedExternalEffectRefusalBinding,
    refusalAuditOptions,
    parseReconciliationRequest,
    loadTrustForPayload,
    createInteractiveSshSigner,
    assertTrustedSigner,
    redactTransactionToken,
    withRepositoryLifecycleOperation,
    inspectionFromState,
    createReconciliationRecord,
    emitAudit,
    auditInput,
    createPrivateFileAtomic,
    reconciliationPath,
    canonicalReconciliation,
    assertReason,
    terminalize,
  });
}

import { createExternalEffectGrantEnvelope } from './external-effect-grant-envelope.ts';
export type ExternalEffectGrantEnvelopeBindings = {
  hasExactKeys: typeof hasExactKeys;
  TASK_ID: typeof TASK_ID;
  UUID_V4: typeof UUID_V4;
  RAW_DIGEST: typeof RAW_DIGEST;
  EFFECT_KINDS: typeof EFFECT_KINDS;
  DIGEST: typeof DIGEST;
  IDEMPOTENCY_KEY: typeof IDEMPOTENCY_KEY;
  invalidGrant: typeof invalidGrant;
  PAYLOAD_KEYS: typeof PAYLOAD_KEYS;
  COMMIT_OID: typeof COMMIT_OID;
  isTimestamp: typeof isTimestamp;
  EXTERNAL_EFFECT_MAX_TTL_SECONDS: typeof EXTERNAL_EFFECT_MAX_TTL_SECONDS;
  assertSignature: typeof assertSignature;
  SIMPLE_NAME: typeof SIMPLE_NAME;
  REF_NAME: typeof REF_NAME;
};
export type ExternalEffectGrantEnvelopeTypes = {
  ExternalEffectGrantRequest: ExternalEffectGrantRequest;
  ExternalEffectKind: ExternalEffectKind;
  Sha256Digest: Sha256Digest;
  ExternalEffectGrantPayload: ExternalEffectGrantPayload;
  ExternalEffectGrantEnvelope: ExternalEffectGrantEnvelope;
  ExternalEffectTarget: ExternalEffectTarget;
  ExternalEffectRollbackPlan: ExternalEffectRollbackPlan;
};

function boundExternalEffectGrantEnvelope() {
  return createExternalEffectGrantEnvelope({
    hasExactKeys,
    TASK_ID,
    UUID_V4,
    RAW_DIGEST,
    EFFECT_KINDS,
    DIGEST,
    IDEMPOTENCY_KEY,
    invalidGrant,
    PAYLOAD_KEYS,
    COMMIT_OID,
    isTimestamp,
    EXTERNAL_EFFECT_MAX_TTL_SECONDS,
    assertSignature,
    SIMPLE_NAME,
    REF_NAME,
  });
}

import { createExternalEffectGrantRecords } from './external-effect-grant-records.ts';
export type ExternalEffectGrantRecordsBindings = {
  sha256: typeof sha256;
  hasExactKeys: typeof hasExactKeys;
  DIGEST: typeof DIGEST;
  unsafeStore: typeof unsafeStore;
  parseEnvelope: typeof parseEnvelope;
  canonicalExternalEffectGrantEnvelope: typeof canonicalExternalEffectGrantEnvelope;
  parseRequest: typeof parseRequest;
  isTimestamp: typeof isTimestamp;
  UUID_V4: typeof UUID_V4;
  reconciliationInvalid: typeof reconciliationInvalid;
  IDEMPOTENCY_KEY: typeof IDEMPOTENCY_KEY;
};
export type ExternalEffectGrantRecordsTypes = {
  ExternalEffectGrantEnvelope: ExternalEffectGrantEnvelope;
  Sha256Digest: Sha256Digest;
  AvailableRecord: AvailableRecord;
  PendingRecord: PendingRecord;
  TransactionRecord: TransactionRecord;
  ExternalEffectObservation: ExternalEffectObservation;
  TerminalRecord: TerminalRecord;
  TerminalState: TerminalState;
  ExternalEffectReconciliationRequest: ExternalEffectReconciliationRequest;
  ExternalEffectReconciliation: ExternalEffectReconciliation;
  IdempotencyRecord: IdempotencyRecord;
};

function boundExternalEffectGrantRecords() {
  return createExternalEffectGrantRecords({
    sha256,
    hasExactKeys,
    DIGEST,
    unsafeStore,
    parseEnvelope,
    canonicalExternalEffectGrantEnvelope,
    parseRequest,
    isTimestamp,
    UUID_V4,
    reconciliationInvalid,
    IDEMPOTENCY_KEY,
  });
}

import { createExternalEffectGrantStore } from './external-effect-grant-store.ts';
export type ExternalEffectGrantStoreBindings = {
  externalEffectStorePaths: typeof externalEffectStorePaths;
  ensurePlainDirectory: typeof ensurePlainDirectory;
  unsafeStore: typeof unsafeStore;
  parseIdempotencyRecord: typeof parseIdempotencyRecord;
  sha256: typeof sha256;
  assertUuid: typeof assertUuid;
};
export type ExternalEffectGrantStoreTypes = {
  Sha256Digest: Sha256Digest;
  IdempotencyRecord: IdempotencyRecord;
};

function boundExternalEffectGrantStore() {
  return createExternalEffectGrantStore({
    externalEffectStorePaths,
    ensurePlainDirectory,
    unsafeStore,
    parseIdempotencyRecord,
    sha256,
    assertUuid,
  });
}

import { createExternalEffectGrantAudit } from './external-effect-grant-audit.ts';
export type ExternalEffectGrantAuditBindings = {
  sha256: typeof sha256;
  appendExternalEffectAuthorityAudit: typeof appendExternalEffectAuthorityAudit;
};
export type ExternalEffectGrantAuditTypes = {
  ExternalEffectGrantEnvelope: ExternalEffectGrantEnvelope;
  Sha256Digest: Sha256Digest;
  ExternalEffectAuditEventType: ExternalEffectAuditEventType;
  ExternalEffectAuditEvent: ExternalEffectAuditEvent;
  ExternalEffectTransitionOptions: ExternalEffectTransitionOptions;
};

function boundExternalEffectGrantAudit() {
  return createExternalEffectGrantAudit({
    sha256,
    appendExternalEffectAuthorityAudit,
  });
}

export const EXTERNAL_EFFECT_SIGNATURE_NAMESPACE =
  'HARNESS_EXTERNAL_EFFECT_GRANT_V1' as const;
export const EXTERNAL_EFFECT_MAX_TTL_SECONDS = 5 * 60;
export const PUBLISH_TRANSACTION_ENV =
  'HARNESS_PUBLISH_TRANSACTION_TOKEN' as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF_NAME = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/;
const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;

const EFFECT_KINDS = [
  'publish-git-ref',
  'force-push-git-ref',
  'deploy-production',
  'delete-remote-resource',
  'send-external-message',
  'database-write',
  'provider-budget-expansion',
  'secret-scope-expansion',
] as const;

/**
 * Effect kinds with an in-process production executor. The broader schema is
 * retained so durable historical grants remain inspectable, but issuance must
 * never imply executable support that the engine does not actually possess.
 */
export const PRODUCTION_EXTERNAL_EFFECT_EXECUTOR_KINDS = [
  'publish-git-ref',
] as const satisfies readonly (typeof EFFECT_KINDS)[number][];

const _AUDIT_EVENT_TYPES = [
  'grant-issued',
  'grant-reserved',
  'dispatch-issued',
  'effect-observed',
  'grant-consumed',
  'grant-revoked',
  'grant-expired',
  'grant-failed',
  'manual-reconciliation',
  'reconciliation-resolved',
] as const;

export type Sha256Digest = `sha256:${string}`;
export type ExternalEffectKind = (typeof EFFECT_KINDS)[number];
export type ExternalEffectAuditEventType = (typeof _AUDIT_EVENT_TYPES)[number];

export type ExternalEffectGitRefTarget = {
  kind: 'git-ref';
  remoteName: string;
  remoteUrl: string;
  refName: string;
  sourceOid: string;
  expectedRemoteOid: string | null;
};

export type ExternalEffectResourceTarget = {
  kind: 'external-resource';
  service: string;
  resource: string;
};

export type ExternalEffectTarget =
  ExternalEffectGitRefTarget | ExternalEffectResourceTarget;

export type ExternalEffectRollbackPlan = {
  kind: 'restore-git-ref' | 'operator-procedure';
  planDigest: Sha256Digest;
};

export type ExternalEffectGrantRequest = {
  mandateBinding: TaskMandateBinding;
  effectKind: ExternalEffectKind;
  target: ExternalEffectTarget;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  rollbackPlan: ExternalEffectRollbackPlan | null;
  ttlSeconds?: number;
  idempotencyKey: string;
};

export type ExternalEffectGrantPayload = {
  kind: 'external-effect-grant.v1';
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  externalAuditRoot: string;
  changeId: string;
  mandateId: string;
  taskId: string;
  mandateDigest: string;
  effectKind: ExternalEffectKind;
  target: ExternalEffectTarget;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  rollbackPlan: ExternalEffectRollbackPlan | null;
  issuedAt: string;
  expiresAt: string;
  uses: 1;
  idempotencyKey: string;
  signer: string;
};

export type ExternalEffectGrantEnvelope = {
  payload: ExternalEffectGrantPayload;
  signature: string;
};

export type ExternalEffectObservation = {
  schemaVersion: 1;
  kind: 'external-effect-observation';
  grantId: string;
  transactionId: string;
  idempotencyKey: string;
  externalReceiptId: string;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest;
  observedAt: string;
  receiptDigest: Sha256Digest;
};

export type ExternalEffectReconciliationOutcome =
  'succeeded' | 'rolled-back' | 'failed';

export type ExternalEffectReconciliationRequest = {
  outcome: ExternalEffectReconciliationOutcome;
  evidenceDigest: Sha256Digest;
  externalReceiptId: string | null;
  poststateDigest: Sha256Digest | null;
  observedAt: string;
  reason: string;
};

export type ExternalEffectReconciliation = Readonly<{
  schemaVersion: 1;
  kind: 'external-effect-reconciliation.v1';
  grantId: string;
  grantDigest: Sha256Digest;
  transactionId: string;
  manualReconciliationReceiptDigest: Sha256Digest;
  outcome: ExternalEffectReconciliationOutcome;
  evidenceDigest: Sha256Digest;
  externalReceiptId: string | null;
  poststateDigest: Sha256Digest | null;
  observedAt: string;
  reason: string;
  resolver: string;
  resolvedAt: string;
  receiptDigest: Sha256Digest;
}>;

export type ExternalEffectAuditEvent = Readonly<{
  schemaVersion: 1;
  eventId: Sha256Digest;
  eventType: ExternalEffectAuditEventType;
  occurredAt: string;
  repositoryId: string;
  externalAuditRoot: string;
  changeId: string;
  taskId: string;
  mandateId: string;
  mandateDigest: string;
  effectKind: ExternalEffectKind;
  targetDigest: Sha256Digest;
  effectIdempotencyDigest: Sha256Digest;
  grantId: string;
  grantDigest: Sha256Digest;
  transactionId: string | null;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest | null;
  evidenceDigest: Sha256Digest | null;
  resolver: string | null;
  result:
    | 'authorized'
    | 'reserved'
    | 'issued'
    | 'observed'
    | 'consumed'
    | 'revoked'
    | 'expired'
    | 'failed'
    | 'manual-reconciliation'
    | 'reconciled-succeeded'
    | 'reconciled-rolled-back'
    | 'reconciled-failed';
  reason: string | null;
}>;

export type ExternalEffectGrantInspection = {
  grantId: string;
  grantDigest: Sha256Digest;
  state:
    | 'available'
    | 'reserved'
    | 'dispatch-issued'
    | 'effect-observed'
    | 'consumed'
    | 'revoked'
    | 'expired'
    | 'failed'
    | 'manual-reconciliation'
    | 'reconciled-succeeded'
    | 'reconciled-rolled-back'
    | 'reconciled-failed';
  payload: ExternalEffectGrantPayload;
  transactionId: string | null;
  transactionToken: string | null;
  observation: ExternalEffectObservation | null;
  reconciliation: ExternalEffectReconciliation | null;
  terminalAt: string | null;
  terminalReason: string | null;
};

export type ExternalEffectGrantPublicInspection = Omit<
  ExternalEffectGrantInspection,
  'transactionToken'
> & {
  transactionToken: null;
};

export type ExternalEffectIssueOptions = {
  now?: Date;
  grantId: string;
  signer?: MaintainerSignerProvider;
  onAuditRecord?: ExternalEffectAuthorityAuditOptions['onRecord'];
  testAuditServiceHooks?: ExternalEffectAuthorityAuditOptions['serviceHooks'];
};

export type ExternalEffectTransitionOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  onAuditRecord?: ExternalEffectAuthorityAuditOptions['onRecord'];
  testAuditServiceHooks?: ExternalEffectAuthorityAuditOptions['serviceHooks'];
};

export type ExternalEffectRevokeOptions = ExternalEffectTransitionOptions & {
  reason: string;
};

type AvailableRecord = {
  schemaVersion: 1;
  kind: 'external-effect-available';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  recordDigest: Sha256Digest;
};

type PendingRecord = {
  schemaVersion: 1;
  kind: 'external-effect-pending';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  recordDigest: Sha256Digest;
};

type IdempotencyRecord = {
  schemaVersion: 1;
  kind: 'external-effect-idempotency';
  idempotencyKey: string;
  grantId: string;
  grantDigest: Sha256Digest;
  recordDigest: Sha256Digest;
};

type TransactionRecord = {
  schemaVersion: 1;
  kind: 'external-effect-transaction';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  transactionId: string;
  transactionToken: string;
  phase: 'reserved' | 'dispatch-issued' | 'effect-observed';
  reservedAt: string;
  dispatchIssuedAt: string | null;
  effectObservedAt: string | null;
  observation: ExternalEffectObservation | null;
  recordDigest: Sha256Digest;
};

type TerminalState =
  'consumed' | 'revoked' | 'expired' | 'failed' | 'manual-reconciliation';

type TerminalRecord = {
  schemaVersion: 1;
  kind: 'external-effect-terminal';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  transactionId: string | null;
  state: TerminalState;
  observation: ExternalEffectObservation | null;
  terminalAt: string;
  reason: string | null;
  previousRecordDigest: Sha256Digest;
  receiptDigest: Sha256Digest;
};

type StoreState =
  | { kind: 'available'; record: AvailableRecord }
  | { kind: 'transaction'; record: TransactionRecord }
  | {
      kind: 'terminal';
      record: TerminalRecord;
      reconciliation: ExternalEffectReconciliation | null;
    };

const PAYLOAD_KEYS = [
  'kind',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'baseCommit',
  'policyBlob',
  'externalAuditRoot',
  'changeId',
  'mandateId',
  'taskId',
  'mandateDigest',
  'effectKind',
  'target',
  'artifactDigest',
  'prestateDigest',
  'rollbackPlan',
  'issuedAt',
  'expiresAt',
  'uses',
  'idempotencyKey',
  'signer',
] as const;

export function externalEffectStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'external-effect-grants');
  return {
    runtime,
    root,
    pending: path.join(root, 'pending'),
    available: path.join(root, 'available'),
    transactions: path.join(root, 'transactions'),
    terminal: path.join(root, 'terminal'),
    idempotency: path.join(root, 'idempotency'),
  };
}

export function canonicalExternalEffectGrantPayload(
  payload: ExternalEffectGrantPayload,
): string {
  return `${canonicalJson(parsePayload(payload))}\n`;
}

export function canonicalExternalEffectGrantEnvelope(
  envelope: ExternalEffectGrantEnvelope,
): string {
  return `${canonicalJson(parseEnvelope(envelope))}\n`;
}

export function parseExternalEffectGrantEnvelope(
  raw: string,
): ExternalEffectGrantEnvelope {
  if (Buffer.byteLength(raw) > 16 * 1024) throw invalidGrant();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidGrant();
  }
  const envelope = parseEnvelope(value);
  if (canonicalExternalEffectGrantEnvelope(envelope) !== raw) {
    throw invalidGrant();
  }
  return envelope;
}

export function issueExternalEffectGrant(
  cwd: string,
  request: ExternalEffectGrantRequest,
  options: ExternalEffectIssueOptions,
): {
  grantId: string;
  grantDigest: Sha256Digest;
  recordPath: string;
  envelope: ExternalEffectGrantEnvelope;
} {
  const parsed = parseRequest(request);
  const now = exactDate(options.now ?? new Date());
  const ttlSeconds = parsed.ttlSeconds ?? EXTERNAL_EFFECT_MAX_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > EXTERNAL_EFFECT_MAX_TTL_SECONDS
  ) {
    throw invalidGrant();
  }
  const grantId = assertUuid(options.grantId);
  const trust = loadTrustContext(cwd);
  const activeMandateBinding = inspectActiveTaskMandateBinding(
    trust.repository.repositoryRoot,
    parsed.mandateBinding.mandateTaskId,
    { now, signer: options.signer },
  );
  const refusalBinding = externalEffectRefusalBinding(
    trust.repository.repositoryRoot,
    trust.policy.repository.id,
    activeMandateBinding,
    grantId,
    parsed,
  );
  const refusalOptions = {
    now,
    serviceHooks: options.testAuditServiceHooks,
  };
  withAuthorityRefusalAudit(refusalBinding, refusalOptions, () => {
    if (
      canonicalJson(activeMandateBinding) !==
      canonicalJson(parsed.mandateBinding)
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_MANDATE_MISMATCH',
        'External effect grant does not match the exact active Task Mandate.',
        ExitCode.staleState,
      );
    }
    assertProductionExternalEffectExecutor(parsed.effectKind);
  });
  const paths = externalEffectStorePaths(trust.repository.gitCommonDirectory);
  const pendingPath = grantPath(paths.pending, grantId);
  const recoveredPendingRaw = readOptionalPrivateFile(pendingPath);
  const { envelope, grantDigest } = withAuthorityRefusalAudit(
    refusalBinding,
    refusalOptions,
    () => {
      if (recoveredPendingRaw !== null) {
        const pending = parsePending(recoveredPendingRaw);
        validateEnvelopeForRepository(
          trust.repository.repositoryRoot,
          pending.envelope,
          options.signer,
        );
        assertPendingMatchesRequest(
          pending,
          parsed,
          grantId,
          ttlSeconds,
          trust.repository.head,
        );
        if (expired(pending.envelope.payload, now)) {
          throw workflowError(
            'EXTERNAL_EFFECT_GRANT_STALE',
            'Pending external effect grant expired before audit recovery.',
            ExitCode.staleState,
          );
        }
        return {
          envelope: pending.envelope,
          grantDigest: pending.grantDigest,
        };
      }
      const signer =
        options.signer ??
        createInteractiveSshSigner(
          trust.repository.repositoryRoot,
          trust.policy,
        );
      signer.assertHumanPresent();
      const identity = signer.identity();
      assertTrustedSigner(trust.policy, identity);
      const payload: ExternalEffectGrantPayload = parsePayload({
        kind: 'external-effect-grant.v1',
        grantId,
        repositoryId: trust.policy.repository.id,
        repositoryOrigin: trust.policy.repository.origin,
        baseCommit: trust.repository.head,
        policyBlob: trust.policyBlob,
        externalAuditRoot: assertExternalAuditRoot(
          activeMandateBinding.externalAuditRoot,
          trust.repository.repositoryRoot,
        ),
        changeId: activeMandateBinding.changeId,
        mandateId: activeMandateBinding.mandateId,
        taskId: activeMandateBinding.mandateTaskId,
        mandateDigest: activeMandateBinding.mandateDigest,
        effectKind: parsed.effectKind,
        target: parsed.target,
        artifactDigest: parsed.artifactDigest,
        prestateDigest: parsed.prestateDigest,
        rollbackPlan: parsed.rollbackPlan,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        uses: 1,
        idempotencyKey: parsed.idempotencyKey,
        signer: identity,
      });
      let signature: string;
      try {
        signature = signer.sign(
          canonicalExternalEffectGrantPayload(payload),
          EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
        );
        assertSignature(signature);
        signer.verify(
          canonicalExternalEffectGrantPayload(payload),
          signature,
          identity,
          EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
        );
      } catch (error) {
        if (isWorkflowFailure(error)) throw error;
        throw workflowError(
          'EXTERNAL_EFFECT_SIGNATURE_INVALID',
          'External effect grant signature could not be created or verified.',
          ExitCode.verification,
        );
      }
      const issuedEnvelope = parseEnvelope({ payload, signature });
      return {
        envelope: issuedEnvelope,
        grantDigest: sha256(
          canonicalExternalEffectGrantEnvelope(issuedEnvelope),
        ),
      };
    },
  );
  const record = createAvailableRecord(envelope, grantDigest);
  const recordPath = grantPath(paths.available, grantId);

  return withAuthorityRefusalAudit(refusalBinding, refusalOptions, () =>
    withActiveTaskMandateBinding(
      trust.repository.repositoryRoot,
      activeMandateBinding.mandateTaskId,
      { now, signer: options.signer },
      (binding, assertOwned) => {
        if (canonicalJson(binding) !== canonicalJson(parsed.mandateBinding)) {
          throw workflowError(
            'EXTERNAL_EFFECT_MANDATE_MISMATCH',
            'External effect grant does not match the exact active Task Mandate.',
            ExitCode.staleState,
          );
        }
        const current = discoverRepository(trust.repository.repositoryRoot);
        if (current.head !== trust.repository.head) {
          throw workflowError(
            'EXTERNAL_EFFECT_GRANT_STALE',
            'Repository HEAD moved before external effect grant publication.',
            ExitCode.staleState,
          );
        }
        ensureStore(paths);
        const observedPendingRaw = readOptionalPrivateFile(pendingPath);
        if (observedPendingRaw === null) {
          assertGrantAbsent(paths, grantId);
          createPrivateFileAtomic(
            pendingPath,
            canonicalPending(createPendingRecord(envelope, grantDigest)),
          );
        } else if (
          canonicalPending(parsePending(observedPendingRaw)) !==
          canonicalPending(createPendingRecord(envelope, grantDigest))
        ) {
          throw unsafeStore();
        }
        assertIdempotencyAvailable(
          paths,
          envelope.payload.idempotencyKey,
          grantId,
          grantDigest,
        );
        assertOwned();
        emitAudit(
          trust.repository.repositoryRoot,
          options,
          auditInput(
            envelope,
            grantDigest,
            'grant-issued',
            new Date(envelope.payload.issuedAt),
            {
              result: 'authorized',
            },
          ),
        );
        assertOwned();
        createIdempotencyIndex(
          paths,
          envelope.payload.idempotencyKey,
          grantId,
          grantDigest,
        );
        const existingAvailable = readOptionalPrivateFile(recordPath);
        if (existingAvailable === null) {
          createPrivateFileAtomic(recordPath, canonicalAvailable(record));
        } else if (
          canonicalAvailable(parseAvailable(existingAvailable)) !==
          canonicalAvailable(record)
        ) {
          throw unsafeStore();
        }
        unlinkIfExact(
          pendingPath,
          canonicalPending(createPendingRecord(envelope, grantDigest)),
        );
        assertOwned();
        return { grantId, grantDigest, recordPath, envelope };
      },
    ),
  );
}

function externalEffectRefusalBinding(
  repositoryRoot: string,
  repositoryIdentity: string,
  mandateBinding: TaskMandateBinding,
  grantId: string,
  request: ExternalEffectGrantRequest,
): AuthorityRefusalAuditBinding {
  const bindingDigest = authorityRefusalDigest(mandateBinding);
  return {
    scope: {
      externalAuditRoot: mandateBinding.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(repositoryIdentity),
    },
    family: 'external-effect',
    operation: 'external-effect.issue',
    subjectId: grantId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: mandateBinding.mandateTaskId,
    changeId: mandateBinding.changeId,
    workflowId: mandateBinding.mandateId,
    grantDigest: bindingDigest,
    bindingDigest,
    refusalIdentity: {
      grantId,
      effectKind: request.effectKind,
      artifactDigest: request.artifactDigest,
      prestateDigest: request.prestateDigest,
      idempotencyKey: request.idempotencyKey,
    },
  };
}

/**
 * Construct refusal authority only from an already repository-validated,
 * domain-signed grant. The caller-supplied request never selects the audit
 * root, repository identity, task correlation, or grant digest.
 */
function storedExternalEffectRefusalBinding(
  repositoryRoot: string,
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
  operation: string,
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const mandateBinding: TaskMandateBinding = {
    schemaVersion: 1,
    mandateTaskId: envelope.payload.taskId,
    mandateId: envelope.payload.mandateId,
    mandateDigest: envelope.payload.mandateDigest,
    changeId: envelope.payload.changeId,
    externalAuditRoot: envelope.payload.externalAuditRoot,
  };
  const bindingDigest = authorityRefusalDigest(mandateBinding);
  return {
    scope: {
      externalAuditRoot: envelope.payload.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(
        envelope.payload.repositoryId,
      ),
    },
    family: 'external-effect',
    operation,
    subjectId: envelope.payload.grantId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: envelope.payload.taskId,
    changeId: envelope.payload.changeId,
    workflowId: envelope.payload.mandateId,
    grantDigest,
    bindingDigest,
    refusalIdentity,
  };
}

function refusalAuditOptions(
  now: Date,
  options: Pick<ExternalEffectTransitionOptions, 'testAuditServiceHooks'>,
) {
  return { now, serviceHooks: options.testAuditServiceHooks };
}

function assertProductionExternalEffectExecutor(
  effectKind: ExternalEffectKind,
): void {
  if (
    !(PRODUCTION_EXTERNAL_EFFECT_EXECUTOR_KINDS as readonly string[]).includes(
      effectKind,
    )
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_EXECUTOR_UNAVAILABLE',
      `External effect kind ${effectKind} has no production executor; no grant was issued.`,
      ExitCode.guard,
    );
  }
}

export function inspectExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  options: { now?: Date; signer?: MaintainerSignerProvider } = {},
): ExternalEffectGrantPublicInspection {
  return redactTransactionToken(
    inspectExternalEffectGrantForExecutor(cwd, requestedGrantId, options),
  );
}

/** Engine-internal inspection used only by the production effect executor. */
export function inspectExternalEffectGrantForExecutor(
  cwd: string,
  requestedGrantId: string,
  options: { now?: Date; signer?: MaintainerSignerProvider } = {},
): ExternalEffectGrantInspection {
  const grantId = assertUuid(requestedGrantId);
  const repository = discoverRepository(cwd);
  const paths = externalEffectStorePaths(repository.gitCommonDirectory);
  const state = readStoreState(paths, grantId);
  validateEnvelopeForRepository(
    repository.repositoryRoot,
    state.record.envelope,
    options.signer,
  );
  return inspectionFromState(state, exactDate(options.now ?? new Date()));
}

export function reserveExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().reserveExternalEffectGrant(
    cwd,
    requestedGrantId,
    options,
  );
}

export function markExternalEffectDispatchIssued(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().markExternalEffectDispatchIssued(
    cwd,
    requestedGrantId,
    requestedTransactionId,
    options,
  );
}

export function recordExternalEffectObservation(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  requestedObservation: Omit<
    ExternalEffectObservation,
    | 'schemaVersion'
    | 'kind'
    | 'grantId'
    | 'transactionId'
    | 'idempotencyKey'
    | 'receiptDigest'
  >,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().recordExternalEffectObservation(
    cwd,
    requestedGrantId,
    requestedTransactionId,
    requestedObservation,
    options,
  );
}

export function consumeExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().consumeExternalEffectGrant(
    cwd,
    requestedGrantId,
    requestedTransactionId,
    options,
  );
}

export function terminalizeExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  requestedTransactionId: string,
  state: 'failed' | 'manual-reconciliation',
  reason: string,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().terminalizeExternalEffectGrant(
    cwd,
    requestedGrantId,
    requestedTransactionId,
    state,
    reason,
    options,
  );
}

export function reconcileExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  requestedReconciliation: ExternalEffectReconciliationRequest,
  options: ExternalEffectTransitionOptions,
): ExternalEffectGrantPublicInspection {
  return boundExternalEffectGrantReconciliation().reconcileExternalEffectGrant(
    cwd,
    requestedGrantId,
    requestedReconciliation,
    options,
  );
}

export function revokeExternalEffectGrant(
  cwd: string,
  requestedGrantId: string,
  options: ExternalEffectRevokeOptions,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantReconciliation().revokeExternalEffectGrant(
    cwd,
    requestedGrantId,
    options,
  );
}

export function assertActivePublishTransaction(
  cwd: string,
  hookArgs: string[],
  environment: NodeJS.ProcessEnv = process.env,
  signer?: MaintainerSignerProvider,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().assertActivePublishTransaction(
    cwd,
    hookArgs,
    environment,
    signer,
  );
}

function terminalize(
  repositoryRoot: string,
  paths: ReturnType<typeof externalEffectStorePaths>,
  state: StoreState,
  terminalState: TerminalState,
  now: Date,
  reason: string | null,
  auditOptions: ExternalEffectTransitionOptions,
  assertOwned: () => void,
): ExternalEffectGrantInspection {
  return boundExternalEffectGrantTransaction().terminalize(
    repositoryRoot,
    paths,
    state,
    terminalState,
    now,
    reason,
    auditOptions,
    assertOwned,
  );
}

function inspectionFromState(
  state: StoreState,
  now: Date,
): ExternalEffectGrantInspection {
  if (state.kind === 'available') {
    return {
      grantId: state.record.envelope.payload.grantId,
      grantDigest: state.record.grantDigest,
      state: expired(state.record.envelope.payload, now)
        ? 'expired'
        : 'available',
      payload: state.record.envelope.payload,
      transactionId: null,
      transactionToken: null,
      observation: null,
      reconciliation: null,
      terminalAt: null,
      terminalReason: null,
    };
  }
  if (state.kind === 'transaction') {
    return {
      grantId: state.record.envelope.payload.grantId,
      grantDigest: state.record.grantDigest,
      state: state.record.phase,
      payload: state.record.envelope.payload,
      transactionId: state.record.transactionId,
      transactionToken: state.record.transactionToken,
      observation: state.record.observation,
      reconciliation: null,
      terminalAt: null,
      terminalReason: null,
    };
  }
  return {
    grantId: state.record.envelope.payload.grantId,
    grantDigest: state.record.grantDigest,
    state: state.reconciliation
      ? (`reconciled-${state.reconciliation.outcome}` as const)
      : state.record.state,
    payload: state.record.envelope.payload,
    transactionId: state.record.transactionId,
    transactionToken: null,
    observation: state.record.observation,
    reconciliation: state.reconciliation,
    terminalAt: state.record.terminalAt,
    terminalReason: state.record.reason,
  };
}

function redactTransactionToken(
  inspection: ExternalEffectGrantInspection,
): ExternalEffectGrantPublicInspection {
  return { ...inspection, transactionToken: null };
}

function readStoreState(
  paths: ReturnType<typeof externalEffectStorePaths>,
  grantId: string,
): StoreState {
  assertStore(paths);
  const availablePath = grantPath(paths.available, grantId);
  const transactionPath = grantPath(paths.transactions, grantId);
  const terminalPath = grantPath(paths.terminal, grantId);
  const resolvedPath = reconciliationPath(paths, grantId);
  const available = readOptionalPrivateFile(availablePath);
  const transaction = readOptionalPrivateFile(transactionPath);
  const terminal = readOptionalPrivateFile(terminalPath);
  const resolved = readOptionalPrivateFile(resolvedPath);
  if (!available && !transaction && !terminal) {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_NOT_FOUND',
      `External effect grant ${grantId} was not found.`,
      ExitCode.guard,
    );
  }
  let availableRecord: AvailableRecord | null;
  let transactionRecord: TransactionRecord | null;
  let terminalRecord: TerminalRecord | null;
  let reconciliation: ExternalEffectReconciliation | null;
  try {
    availableRecord = available ? parseAvailable(available) : null;
    transactionRecord = transaction ? parseTransaction(transaction) : null;
    terminalRecord = terminal ? parseTerminal(terminal) : null;
    reconciliation =
      resolved && terminalRecord
        ? parseReconciliation(resolved, terminalRecord)
        : null;
  } catch {
    throw unsafeStore();
  }
  const records = [availableRecord, transactionRecord, terminalRecord].filter(
    (value): value is AvailableRecord | TransactionRecord | TerminalRecord =>
      value !== null,
  );
  const grantDigests = new Set(records.map(({ grantDigest }) => grantDigest));
  if (
    grantDigests.size !== 1 ||
    records.some(({ envelope }) => envelope.payload.grantId !== grantId)
  ) {
    throw unsafeStore();
  }
  if (
    (resolved !== null && terminalRecord === null) ||
    (reconciliation !== null &&
      terminalRecord?.state !== 'manual-reconciliation')
  ) {
    throw unsafeStore();
  }
  if (terminalRecord)
    return { kind: 'terminal', record: terminalRecord, reconciliation };
  if (transactionRecord)
    return { kind: 'transaction', record: transactionRecord };
  return { kind: 'available', record: availableRecord! };
}

function createAvailableRecord(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
): AvailableRecord {
  return boundExternalEffectGrantRecords().createAvailableRecord(
    envelope,
    grantDigest,
  );
}

function createPendingRecord(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
): PendingRecord {
  return boundExternalEffectGrantRecords().createPendingRecord(
    envelope,
    grantDigest,
  );
}

function parsePending(raw: string): PendingRecord {
  return boundExternalEffectGrantRecords().parsePending(raw);
}

function assertPendingMatchesRequest(
  pending: PendingRecord,
  request: ReturnType<typeof parseRequest>,
  grantId: string,
  ttlSeconds: number,
  baseCommit: string,
): void {
  return boundExternalEffectGrantRecords().assertPendingMatchesRequest(
    pending,
    request,
    grantId,
    ttlSeconds,
    baseCommit,
  );
}

function createTransactionRecord(
  available: AvailableRecord,
  grantId: string,
  now: Date,
): TransactionRecord {
  return boundExternalEffectGrantRecords().createTransactionRecord(
    available,
    grantId,
    now,
  );
}

function replaceTransactionDigest(
  transaction: TransactionRecord,
): TransactionRecord {
  return boundExternalEffectGrantRecords().replaceTransactionDigest(
    transaction,
  );
}

function createObservation(
  transaction: TransactionRecord,
  requested: Omit<
    ExternalEffectObservation,
    | 'schemaVersion'
    | 'kind'
    | 'grantId'
    | 'transactionId'
    | 'idempotencyKey'
    | 'receiptDigest'
  >,
): ExternalEffectObservation {
  return boundExternalEffectGrantRecords().createObservation(
    transaction,
    requested,
  );
}

function parseRequest(request: ExternalEffectGrantRequest) {
  return boundExternalEffectGrantEnvelope().parseRequest(request);
}

function parsePayload(value: unknown): ExternalEffectGrantPayload {
  return boundExternalEffectGrantEnvelope().parsePayload(value);
}

function parseEnvelope(value: unknown): ExternalEffectGrantEnvelope {
  return boundExternalEffectGrantEnvelope().parseEnvelope(value);
}

function parseAvailable(raw: string): AvailableRecord {
  return boundExternalEffectGrantRecords().parseAvailable(raw);
}

function parseTransaction(raw: string): TransactionRecord {
  return boundExternalEffectGrantRecords().parseTransaction(raw);
}

function parseTerminal(raw: string): TerminalRecord {
  return boundExternalEffectGrantRecords().parseTerminal(raw);
}

function parseReconciliationRequest(
  value: unknown,
  terminal: TerminalRecord,
  now: Date,
): ExternalEffectReconciliationRequest {
  return boundExternalEffectGrantRecords().parseReconciliationRequest(
    value,
    terminal,
    now,
  );
}

function createReconciliationRecord(
  terminal: TerminalRecord,
  request: ExternalEffectReconciliationRequest,
  resolver: string,
  resolvedAt: Date,
): ExternalEffectReconciliation {
  return boundExternalEffectGrantRecords().createReconciliationRecord(
    terminal,
    request,
    resolver,
    resolvedAt,
  );
}

function parseReconciliation(
  raw: string,
  terminal: TerminalRecord,
): ExternalEffectReconciliation {
  return boundExternalEffectGrantRecords().parseReconciliation(raw, terminal);
}

function validateEnvelopeForRepository(
  repositoryRoot: string,
  envelope: ExternalEffectGrantEnvelope,
  providedSigner?: MaintainerSignerProvider,
): void {
  const trust = loadTrustForPayload(repositoryRoot, envelope.payload);
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  assertExternalAuditRoot(envelope.payload.externalAuditRoot, repositoryRoot);
  if (
    trust.policy.repository.id !== envelope.payload.repositoryId ||
    trust.policy.repository.origin !== envelope.payload.repositoryOrigin ||
    trust.policyBlob !== envelope.payload.policyBlob ||
    origin !== envelope.payload.repositoryOrigin ||
    !trust.policy.trustedSigners.some(
      ({ identity }) => identity === envelope.payload.signer,
    )
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
      'External effect grant no longer matches the repository trust base.',
      ExitCode.staleState,
    );
  }
  const signer =
    providedSigner ?? createInteractiveSshSigner(repositoryRoot, trust.policy);
  try {
    signer.verify(
      canonicalExternalEffectGrantPayload(envelope.payload),
      envelope.signature,
      envelope.payload.signer,
      EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
    );
  } catch {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNATURE_INVALID',
      'External effect grant signature is invalid for its dedicated domain.',
      ExitCode.verification,
    );
  }
}

function loadTrustContext(cwd: string) {
  const repository = discoverRepository(cwd);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
  if (origin !== loaded.policy.repository.origin) {
    throw workflowError(
      'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
      'Repository origin differs from its trusted external effect policy.',
      ExitCode.guard,
    );
  }
  return { repository, ...loaded };
}

function loadTrustForPayload(
  repositoryRoot: string,
  payload: ExternalEffectGrantPayload,
) {
  return loadPolicyAt(repositoryRoot, payload.baseCommit);
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
      'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
      'External effect trust base could not be loaded.',
      ExitCode.verification,
    );
  }
}

function auditInput(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
  eventType: ExternalEffectAuditEventType,
  now: Date,
  overrides: Partial<
    Pick<
      ExternalEffectAuditEvent,
      | 'transactionId'
      | 'poststateDigest'
      | 'evidenceDigest'
      | 'resolver'
      | 'result'
      | 'reason'
    >
  >,
): Omit<ExternalEffectAuditEvent, 'eventId'> {
  return boundExternalEffectGrantAudit().auditInput(
    envelope,
    grantDigest,
    eventType,
    now,
    overrides,
  );
}

function emitAudit(
  repositoryRoot: string,
  options: Pick<
    ExternalEffectTransitionOptions,
    'onAuditRecord' | 'testAuditServiceHooks'
  >,
  input: Omit<ExternalEffectAuditEvent, 'eventId'>,
): void {
  return boundExternalEffectGrantAudit().emitAudit(
    repositoryRoot,
    options,
    input,
  );
}

function ensureStore(paths: ReturnType<typeof externalEffectStorePaths>): void {
  return boundExternalEffectGrantStore().ensureStore(paths);
}

function assertStore(paths: ReturnType<typeof externalEffectStorePaths>): void {
  return boundExternalEffectGrantStore().assertStore(paths);
}

function assertIdempotencyAvailable(
  paths: ReturnType<typeof externalEffectStorePaths>,
  idempotencyKey: string,
  grantId: string,
  grantDigest: Sha256Digest,
): void {
  return boundExternalEffectGrantStore().assertIdempotencyAvailable(
    paths,
    idempotencyKey,
    grantId,
    grantDigest,
  );
}

function createIdempotencyIndex(
  paths: ReturnType<typeof externalEffectStorePaths>,
  idempotencyKey: string,
  grantId: string,
  grantDigest: Sha256Digest,
): void {
  return boundExternalEffectGrantStore().createIdempotencyIndex(
    paths,
    idempotencyKey,
    grantId,
    grantDigest,
  );
}

function parseIdempotencyRecord(raw: string): IdempotencyRecord {
  return boundExternalEffectGrantRecords().parseIdempotencyRecord(raw);
}

function assertExternalAuditRoot(
  value: string,
  repositoryRoot: string,
): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.length > 4096
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
      'External effect audit root must be an exact absolute private directory.',
      ExitCode.guard,
    );
  }
  const relative = path.relative(path.resolve(repositoryRoot), value);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
      'External effect audit root must remain outside the repository.',
      ExitCode.guard,
    );
  }
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(value) !== value
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
      'External effect audit root is missing, linked, or not private.',
      ExitCode.guard,
    );
  }
  return value;
}

function assertGrantAbsent(
  paths: ReturnType<typeof externalEffectStorePaths>,
  grantId: string,
): void {
  return boundExternalEffectGrantStore().assertGrantAbsent(paths, grantId);
}

function grantPath(directory: string, grantId: string): string {
  return boundExternalEffectGrantStore().grantPath(directory, grantId);
}

function reconciliationPath(
  paths: ReturnType<typeof externalEffectStorePaths>,
  grantId: string,
): string {
  return boundExternalEffectGrantStore().reconciliationPath(paths, grantId);
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  return boundExternalEffectGrantStore().createPrivateFileAtomic(
    filePath,
    content,
  );
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  return boundExternalEffectGrantStore().replacePrivateFileAtomic(
    filePath,
    content,
  );
}

function readOptionalPrivateFile(filePath: string): string | null {
  return boundExternalEffectGrantStore().readOptionalPrivateFile(filePath);
}

function unlinkIfExact(filePath: string, expected: string): void {
  return boundExternalEffectGrantStore().unlinkIfExact(filePath, expected);
}

function canonicalAvailable(record: AvailableRecord): string {
  return boundExternalEffectGrantRecords().canonicalAvailable(record);
}

function canonicalPending(record: PendingRecord): string {
  return boundExternalEffectGrantRecords().canonicalPending(record);
}

function canonicalTransaction(record: TransactionRecord): string {
  return boundExternalEffectGrantRecords().canonicalTransaction(record);
}

function canonicalTerminal(record: TerminalRecord): string {
  return boundExternalEffectGrantRecords().canonicalTerminal(record);
}

function canonicalReconciliation(record: ExternalEffectReconciliation): string {
  return boundExternalEffectGrantRecords().canonicalReconciliation(record);
}

function assertTrustedSigner(
  policy: ReturnType<typeof parseMaintainerPolicy>,
  identity: string,
): void {
  if (
    !policy.trustedSigners.some(({ identity: value }) => value === identity)
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNER_UNTRUSTED',
      'External effect signer is not trusted by the exact base policy.',
      ExitCode.verification,
    );
  }
}

function assertTransactionId(
  transaction: TransactionRecord,
  transactionId: string,
): void {
  if (transaction.transactionId !== transactionId) throw stateConflict();
}

function assertObservationClock(
  observation: ExternalEffectObservation,
  transaction: TransactionRecord,
  now: Date,
): void {
  const observed = Date.parse(observation.observedAt);
  if (
    observed < Date.parse(transaction.reservedAt) ||
    observed > now.getTime() + 30_000
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECEIPT_INVALID',
      'External effect receipt time is outside the transaction window.',
      ExitCode.verification,
    );
  }
}

function expired(payload: ExternalEffectGrantPayload, now: Date): boolean {
  return now.getTime() >= Date.parse(payload.expiresAt);
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidGrant();
  }
  return new Date(value.getTime());
}

function isTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertUuid(value: string): string {
  if (!UUID_V4.test(value)) throw invalidGrant();
  return value;
}

function assertUuidForPublish(value: string): string {
  try {
    return assertUuid(value);
  } catch {
    throw publishTransactionInvalid();
  }
}

function assertSignature(value: string): void {
  if (!SIGNATURE.test(value) || Buffer.byteLength(value) > 16 * 1024) {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNATURE_INVALID',
      'External effect grant signature is malformed.',
      ExitCode.verification,
    );
  }
}

function assertReason(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 1024 ||
    /[\0\r]/.test(normalized)
  ) {
    throw invalidGrant();
  }
  return normalized;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function sha256(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function invalidGrant() {
  return workflowError(
    'EXTERNAL_EFFECT_GRANT_INVALID',
    'External effect grant is malformed or exceeds its authority bounds.',
    ExitCode.guard,
  );
}

function unsafeStore() {
  return workflowError(
    'EXTERNAL_EFFECT_STORE_UNSAFE',
    'External effect grant store is missing, noncanonical, or unsafe.',
    ExitCode.verification,
  );
}

function stateConflict() {
  return workflowError(
    'EXTERNAL_EFFECT_STATE_CONFLICT',
    'External effect grant is not in the exact required transaction phase.',
    ExitCode.conflict,
  );
}

function reconciliationInvalid() {
  return workflowError(
    'EXTERNAL_EFFECT_RECONCILIATION_INVALID',
    'External effect reconciliation evidence is malformed or does not prove the selected outcome.',
    ExitCode.verification,
  );
}

function publishTransactionRequired() {
  return workflowError(
    'PUBLISH_TRANSACTION_REQUIRED',
    'Direct push is denied without an exact active publish transaction token.',
    ExitCode.guard,
  );
}

function publishTransactionInvalid() {
  return workflowError(
    'PUBLISH_TRANSACTION_INVALID',
    'Publish transaction token does not match the active exact remote effect.',
    ExitCode.guard,
  );
}

function isWorkflowFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  );
}
