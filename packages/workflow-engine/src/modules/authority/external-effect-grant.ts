/** External-effect authority contracts, exact validation and state decisions. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { type TaskMandateBinding } from './task-mandate-contract.ts';
import { type TaskMandateOperations } from './task-mandate.ts';
import { type MaintainerSignerProvider } from './maintainer-signer-port.ts';
import { type parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  type AuthorityAuditServiceHooks,
  type AuthorityAuditRecordedEvent,
} from './authority-audit-contract.ts';
export const EXTERNAL_EFFECT_SIGNATURE_NAMESPACE =
  'HARNESS_EXTERNAL_EFFECT_GRANT_V1' as const;

export const EXTERNAL_EFFECT_MAX_TTL_SECONDS = 5 * 60;

export const PUBLISH_TRANSACTION_ENV =
  'HARNESS_PUBLISH_TRANSACTION_TOKEN' as const;

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const RAW_DIGEST = /^[0-9a-f]{64}$/;

export const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const REF_NAME =
  /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/;

export const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;

export const EFFECT_KINDS = [
  'publish-git-ref',
  'force-push-git-ref',
  'deploy-production',
  'delete-remote-resource',
  'send-external-message',
  'database-write',
  'provider-budget-expansion',
  'secret-scope-expansion',
] as const;

export const PRODUCTION_EXTERNAL_EFFECT_EXECUTOR_KINDS = [
  'publish-git-ref',
] as const satisfies readonly (typeof EFFECT_KINDS)[number][];

export const _AUDIT_EVENT_TYPES = [
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

export type AvailableRecord = {
  schemaVersion: 1;
  kind: 'external-effect-available';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  recordDigest: Sha256Digest;
};

export type PendingRecord = {
  schemaVersion: 1;
  kind: 'external-effect-pending';
  grantDigest: Sha256Digest;
  envelope: ExternalEffectGrantEnvelope;
  recordDigest: Sha256Digest;
};

export type IdempotencyRecord = {
  schemaVersion: 1;
  kind: 'external-effect-idempotency';
  idempotencyKey: string;
  grantId: string;
  grantDigest: Sha256Digest;
  recordDigest: Sha256Digest;
};

export type TransactionRecord = {
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

export type TerminalState =
  'consumed' | 'revoked' | 'expired' | 'failed' | 'manual-reconciliation';

export type TerminalRecord = {
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

export type StoreState =
  | { kind: 'available'; record: AvailableRecord }
  | { kind: 'transaction'; record: TransactionRecord }
  | {
      kind: 'terminal';
      record: TerminalRecord;
      reconciliation: ExternalEffectReconciliation | null;
    };

export const PAYLOAD_KEYS = [
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

export type ExternalEffectTaskMandateOperations = Pick<
  TaskMandateOperations,
  'inspectActiveTaskMandateBinding' | 'withActiveTaskMandateBinding'
>;

export function assertProductionExternalEffectExecutor(
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

export function inspectionFromState(
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

export function redactTransactionToken(
  inspection: ExternalEffectGrantInspection,
): ExternalEffectGrantPublicInspection {
  return { ...inspection, transactionToken: null };
}

export function assertTrustedSigner(
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

export function assertTransactionId(
  transaction: TransactionRecord,
  transactionId: string,
): void {
  if (transaction.transactionId !== transactionId) throw stateConflict();
}

export function assertObservationClock(
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

export function expired(
  payload: ExternalEffectGrantPayload,
  now: Date,
): boolean {
  return now.getTime() >= Date.parse(payload.expiresAt);
}

export function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidGrant();
  }
  return new Date(value.getTime());
}

export function isTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function assertUuid(value: string): string {
  if (!UUID_V4.test(value)) throw invalidGrant();
  return value;
}

export function assertUuidForPublish(value: string): string {
  try {
    return assertUuid(value);
  } catch {
    throw publishTransactionInvalid();
  }
}

export function assertSignature(value: string): void {
  if (!SIGNATURE.test(value) || Buffer.byteLength(value) > 16 * 1024) {
    throw workflowError(
      'EXTERNAL_EFFECT_SIGNATURE_INVALID',
      'External effect grant signature is malformed.',
      ExitCode.verification,
    );
  }
}

export function assertReason(value: string): string {
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

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

export function sha256(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function invalidGrant() {
  return workflowError(
    'EXTERNAL_EFFECT_GRANT_INVALID',
    'External effect grant is malformed or exceeds its authority bounds.',
    ExitCode.guard,
  );
}

export function unsafeStore() {
  return workflowError(
    'EXTERNAL_EFFECT_STORE_UNSAFE',
    'External effect grant store is missing, noncanonical, or unsafe.',
    ExitCode.verification,
  );
}

export function stateConflict() {
  return workflowError(
    'EXTERNAL_EFFECT_STATE_CONFLICT',
    'External effect grant is not in the exact required transaction phase.',
    ExitCode.conflict,
  );
}

export function reconciliationInvalid() {
  return workflowError(
    'EXTERNAL_EFFECT_RECONCILIATION_INVALID',
    'External effect reconciliation evidence is malformed or does not prove the selected outcome.',
    ExitCode.verification,
  );
}

export function publishTransactionRequired() {
  return workflowError(
    'PUBLISH_TRANSACTION_REQUIRED',
    'Direct push is denied without an exact active publish transaction token.',
    ExitCode.guard,
  );
}

export function publishTransactionInvalid() {
  return workflowError(
    'PUBLISH_TRANSACTION_INVALID',
    'Publish transaction token does not match the active exact remote effect.',
    ExitCode.guard,
  );
}

export function isWorkflowFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  );
}

export function assertManualReconciliationState(
  state: StoreState,
): asserts state is Extract<StoreState, { kind: 'terminal' }> & {
  record: TerminalRecord & {
    state: 'manual-reconciliation';
    transactionId: string;
  };
} {
  if (
    state.kind !== 'terminal' ||
    state.record.state !== 'manual-reconciliation' ||
    state.record.transactionId === null
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECONCILIATION_NOT_REQUIRED',
      'Only a durable manual-reconciliation terminal may be resolved.',
      ExitCode.guard,
    );
  }
}

export function assertReconciliationReplay(
  existing: ExternalEffectReconciliation,
  request: ExternalEffectReconciliationRequest,
  resolver: string,
): void {
  const observed = {
    outcome: existing.outcome,
    evidenceDigest: existing.evidenceDigest,
    externalReceiptId: existing.externalReceiptId,
    poststateDigest: existing.poststateDigest,
    observedAt: existing.observedAt,
    reason: existing.reason,
  };
  if (
    canonicalJson(observed) !== canonicalJson(request) ||
    existing.resolver !== resolver
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECONCILIATION_CONFLICT',
      'External effect reconciliation is already bound to different human evidence.',
      ExitCode.conflict,
    );
  }
}

export type ExternalEffectAuthorityAuditOptions = {
  serviceHooks?: AuthorityAuditServiceHooks;
  onRecord?: (
    event: ExternalEffectAuditEvent,
    entry: AuthorityAuditRecordedEvent,
  ) => void;
};

export function assertExternalAuditRootPath(
  value: string,
  repositoryRoot: string,
): void {
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
}
