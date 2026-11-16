/** Canonical records and deterministic durable-state interpretation. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  UUID_V4,
  DIGEST,
  IDEMPOTENCY_KEY,
  type Sha256Digest,
  type ExternalEffectGrantEnvelope,
  type ExternalEffectObservation,
  type ExternalEffectReconciliationRequest,
  type ExternalEffectReconciliation,
  type AvailableRecord,
  type PendingRecord,
  type IdempotencyRecord,
  type TransactionRecord,
  type TerminalState,
  type TerminalRecord,
  type StoreState,
  isTimestamp,
  hasExactKeys,
  sha256,
  unsafeStore,
  reconciliationInvalid,
} from './external-effect-grant.ts';
import {
  parseRequest,
  parseEnvelope,
  canonicalExternalEffectGrantEnvelope,
} from './external-effect-grant-envelope.ts';

export function createAvailableRecord(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
): AvailableRecord {
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-available' as const,
    grantDigest,
    envelope,
  };
  return { ...value, recordDigest: sha256(canonicalJson(value)) };
}

export function createPendingRecord(
  envelope: ExternalEffectGrantEnvelope,
  grantDigest: Sha256Digest,
): PendingRecord {
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-pending' as const,
    grantDigest,
    envelope,
  };
  return { ...value, recordDigest: sha256(canonicalJson(value)) };
}

export function parsePending(raw: string): PendingRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-pending' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const record = createPendingRecord(
    envelope,
    value.grantDigest as Sha256Digest,
  );
  if (
    record.recordDigest !== value.recordDigest ||
    record.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope)) ||
    canonicalPending(record) !== raw
  ) {
    throw unsafeStore();
  }
  return record;
}

export function assertPendingMatchesRequest(
  pending: PendingRecord,
  request: ReturnType<typeof parseRequest>,
  grantId: string,
  ttlSeconds: number,
  baseCommit: string,
): void {
  const payload = pending.envelope.payload;
  const expectedBinding = {
    schemaVersion: 1 as const,
    mandateTaskId: payload.taskId,
    mandateId: payload.mandateId,
    mandateDigest: payload.mandateDigest,
    changeId: payload.changeId,
    externalAuditRoot: payload.externalAuditRoot,
  };
  if (
    payload.grantId !== grantId ||
    payload.baseCommit !== baseCommit ||
    canonicalJson(expectedBinding) !== canonicalJson(request.mandateBinding) ||
    payload.effectKind !== request.effectKind ||
    canonicalJson(payload.target) !== canonicalJson(request.target) ||
    payload.artifactDigest !== request.artifactDigest ||
    payload.prestateDigest !== request.prestateDigest ||
    canonicalJson(payload.rollbackPlan) !==
      canonicalJson(request.rollbackPlan) ||
    payload.idempotencyKey !== request.idempotencyKey ||
    Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) !==
      ttlSeconds * 1000
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_EXISTS',
      'Pending external effect grant differs from the exact recovery request.',
      ExitCode.conflict,
    );
  }
}

export function createTransactionRecord(
  available: AvailableRecord,
  grantId: string,
  now: Date,
  transactionEntropy: string,
): TransactionRecord {
  return replaceTransactionDigest({
    schemaVersion: 1,
    kind: 'external-effect-transaction',
    grantDigest: available.grantDigest,
    envelope: available.envelope,
    transactionId: grantId,
    transactionToken: `${grantId}.${transactionEntropy}`,
    phase: 'reserved',
    reservedAt: now.toISOString(),
    dispatchIssuedAt: null,
    effectObservedAt: null,
    observation: null,
    recordDigest: 'sha256:'.padEnd(71, '0') as Sha256Digest,
  });
}

export function replaceTransactionDigest(
  transaction: TransactionRecord,
): TransactionRecord {
  const { recordDigest: _recordDigest, ...value } = transaction;
  return { ...value, recordDigest: sha256(canonicalJson(value)) };
}

export function createObservation(
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
  if (
    !isRecord(requested) ||
    !hasExactKeys(requested, [
      'externalReceiptId',
      'artifactDigest',
      'prestateDigest',
      'poststateDigest',
      'observedAt',
    ]) ||
    typeof requested.externalReceiptId !== 'string' ||
    requested.externalReceiptId.length < 1 ||
    requested.externalReceiptId.length > 512 ||
    !DIGEST.test(String(requested.artifactDigest)) ||
    !DIGEST.test(String(requested.prestateDigest)) ||
    !DIGEST.test(String(requested.poststateDigest)) ||
    typeof requested.observedAt !== 'string' ||
    !isTimestamp(requested.observedAt) ||
    requested.artifactDigest !== transaction.envelope.payload.artifactDigest ||
    requested.prestateDigest !== transaction.envelope.payload.prestateDigest
  ) {
    throw workflowError(
      'EXTERNAL_EFFECT_RECEIPT_INVALID',
      'External effect receipt does not match the signed grant.',
      ExitCode.verification,
    );
  }
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-observation' as const,
    grantId: transaction.envelope.payload.grantId,
    transactionId: transaction.transactionId,
    idempotencyKey: transaction.envelope.payload.idempotencyKey,
    externalReceiptId: requested.externalReceiptId,
    artifactDigest: requested.artifactDigest as Sha256Digest,
    prestateDigest: requested.prestateDigest as Sha256Digest,
    poststateDigest: requested.poststateDigest as Sha256Digest,
    observedAt: requested.observedAt,
  };
  return { ...value, receiptDigest: sha256(canonicalJson(value)) };
}

export function parseAvailable(raw: string): AvailableRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-available' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const record = createAvailableRecord(
    envelope,
    value.grantDigest as Sha256Digest,
  );
  if (
    record.recordDigest !== value.recordDigest ||
    value.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope)) ||
    canonicalAvailable(record) !== raw
  ) {
    throw unsafeStore();
  }
  return record;
}

export function parseTransaction(raw: string): TransactionRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'transactionId',
      'transactionToken',
      'phase',
      'reservedAt',
      'dispatchIssuedAt',
      'effectObservedAt',
      'observation',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-transaction' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.transactionId !== 'string' ||
    !UUID_V4.test(value.transactionId) ||
    typeof value.transactionToken !== 'string' ||
    !new RegExp(
      `^${value.transactionId.replaceAll('-', '\\-')}\\.[0-9a-f]{64}$`,
    ).test(value.transactionToken) ||
    (value.phase !== 'reserved' &&
      value.phase !== 'dispatch-issued' &&
      value.phase !== 'effect-observed') ||
    typeof value.reservedAt !== 'string' ||
    !isTimestamp(value.reservedAt) ||
    (value.dispatchIssuedAt !== null &&
      (typeof value.dispatchIssuedAt !== 'string' ||
        !isTimestamp(value.dispatchIssuedAt))) ||
    (value.effectObservedAt !== null &&
      (typeof value.effectObservedAt !== 'string' ||
        !isTimestamp(value.effectObservedAt))) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const observation =
    value.observation === null
      ? null
      : parseObservation(value.observation, envelope, value.transactionId);
  const transaction: TransactionRecord = {
    schemaVersion: 1,
    kind: 'external-effect-transaction',
    grantDigest: value.grantDigest as Sha256Digest,
    envelope,
    transactionId: value.transactionId,
    transactionToken: value.transactionToken,
    phase: value.phase,
    reservedAt: value.reservedAt,
    dispatchIssuedAt: value.dispatchIssuedAt,
    effectObservedAt: value.effectObservedAt,
    observation,
    recordDigest: value.recordDigest as Sha256Digest,
  };
  if (
    replaceTransactionDigest(transaction).recordDigest !==
      transaction.recordDigest ||
    transaction.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope)) ||
    (transaction.phase === 'reserved' &&
      (transaction.dispatchIssuedAt !== null ||
        transaction.effectObservedAt !== null ||
        transaction.observation !== null)) ||
    (transaction.phase === 'dispatch-issued' &&
      (transaction.dispatchIssuedAt === null ||
        transaction.effectObservedAt !== null ||
        transaction.observation !== null)) ||
    (transaction.phase === 'effect-observed' &&
      (transaction.dispatchIssuedAt === null ||
        transaction.effectObservedAt === null ||
        transaction.observation === null)) ||
    canonicalTransaction(transaction) !== raw
  ) {
    throw unsafeStore();
  }
  return transaction;
}

export function parseObservation(
  value: unknown,
  envelope: ExternalEffectGrantEnvelope,
  transactionId: string,
): ExternalEffectObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantId',
      'transactionId',
      'idempotencyKey',
      'externalReceiptId',
      'artifactDigest',
      'prestateDigest',
      'poststateDigest',
      'observedAt',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-observation' ||
    value.grantId !== envelope.payload.grantId ||
    value.transactionId !== transactionId ||
    value.idempotencyKey !== envelope.payload.idempotencyKey ||
    typeof value.externalReceiptId !== 'string' ||
    value.externalReceiptId.length < 1 ||
    value.externalReceiptId.length > 512 ||
    value.artifactDigest !== envelope.payload.artifactDigest ||
    value.prestateDigest !== envelope.payload.prestateDigest ||
    typeof value.poststateDigest !== 'string' ||
    !DIGEST.test(value.poststateDigest) ||
    typeof value.observedAt !== 'string' ||
    !isTimestamp(value.observedAt) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw unsafeStore();
  }
  const { receiptDigest: _receiptDigest, ...withoutDigest } = value;
  if (sha256(canonicalJson(withoutDigest)) !== value.receiptDigest) {
    throw unsafeStore();
  }
  return value as ExternalEffectObservation;
}

export function parseTerminal(raw: string): TerminalRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantDigest',
      'envelope',
      'transactionId',
      'state',
      'observation',
      'terminalAt',
      'reason',
      'previousRecordDigest',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-terminal' ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    (value.transactionId !== null &&
      (typeof value.transactionId !== 'string' ||
        !UUID_V4.test(value.transactionId))) ||
    ![
      'consumed',
      'revoked',
      'expired',
      'failed',
      'manual-reconciliation',
    ].includes(String(value.state)) ||
    typeof value.terminalAt !== 'string' ||
    !isTimestamp(value.terminalAt) ||
    (value.reason !== null && typeof value.reason !== 'string') ||
    typeof value.previousRecordDigest !== 'string' ||
    !DIGEST.test(value.previousRecordDigest) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw unsafeStore();
  }
  const envelope = parseEnvelope(value.envelope);
  const observation =
    value.observation === null
      ? null
      : parseObservation(
          value.observation,
          envelope,
          String(value.transactionId),
        );
  const terminal = {
    schemaVersion: 1 as const,
    kind: 'external-effect-terminal' as const,
    grantDigest: value.grantDigest as Sha256Digest,
    envelope,
    transactionId: value.transactionId as string | null,
    state: value.state as TerminalState,
    observation,
    terminalAt: value.terminalAt,
    reason: value.reason as string | null,
    previousRecordDigest: value.previousRecordDigest as Sha256Digest,
  };
  if (
    sha256(canonicalJson(terminal)) !== value.receiptDigest ||
    terminal.grantDigest !==
      sha256(canonicalExternalEffectGrantEnvelope(envelope))
  ) {
    throw unsafeStore();
  }
  const record = {
    ...terminal,
    receiptDigest: value.receiptDigest as Sha256Digest,
  };
  if (canonicalTerminal(record) !== raw) throw unsafeStore();
  return record;
}

export function parseReconciliationRequest(
  value: unknown,
  terminal: TerminalRecord,
  now: Date,
): ExternalEffectReconciliationRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'outcome',
      'evidenceDigest',
      'externalReceiptId',
      'poststateDigest',
      'observedAt',
      'reason',
    ]) ||
    (value.outcome !== 'succeeded' &&
      value.outcome !== 'rolled-back' &&
      value.outcome !== 'failed') ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    (value.externalReceiptId !== null &&
      (typeof value.externalReceiptId !== 'string' ||
        value.externalReceiptId.length < 1 ||
        value.externalReceiptId.length > 512 ||
        value.externalReceiptId.trim() !== value.externalReceiptId ||
        /[\0\r\n]/.test(value.externalReceiptId))) ||
    (value.poststateDigest !== null &&
      (typeof value.poststateDigest !== 'string' ||
        !DIGEST.test(value.poststateDigest))) ||
    typeof value.observedAt !== 'string' ||
    !isTimestamp(value.observedAt) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length < 1 ||
    value.reason.length > 1024 ||
    /[\0\r]/.test(value.reason)
  ) {
    throw reconciliationInvalid();
  }
  const observedAt = Date.parse(value.observedAt);
  if (
    observedAt < Date.parse(terminal.terminalAt) ||
    observedAt > now.getTime() + 30_000 ||
    (value.outcome === 'succeeded' &&
      (value.poststateDigest === null || value.externalReceiptId === null)) ||
    (value.outcome === 'rolled-back' &&
      (value.poststateDigest !== terminal.envelope.payload.prestateDigest ||
        value.externalReceiptId === null))
  ) {
    throw reconciliationInvalid();
  }
  return {
    outcome: value.outcome,
    evidenceDigest: value.evidenceDigest as Sha256Digest,
    externalReceiptId: value.externalReceiptId,
    poststateDigest: value.poststateDigest as Sha256Digest | null,
    observedAt: value.observedAt,
    reason: value.reason,
  };
}

export function createReconciliationRecord(
  terminal: TerminalRecord,
  request: ExternalEffectReconciliationRequest,
  resolver: string,
  resolvedAt: Date,
): ExternalEffectReconciliation {
  if (
    terminal.state !== 'manual-reconciliation' ||
    terminal.transactionId === null ||
    resolver.length < 1 ||
    resolver.length > 128 ||
    resolver.trim() !== resolver
  ) {
    throw reconciliationInvalid();
  }
  const value = {
    schemaVersion: 1 as const,
    kind: 'external-effect-reconciliation.v1' as const,
    grantId: terminal.envelope.payload.grantId,
    grantDigest: terminal.grantDigest,
    transactionId: terminal.transactionId,
    manualReconciliationReceiptDigest: terminal.receiptDigest,
    ...request,
    resolver,
    resolvedAt: resolvedAt.toISOString(),
  };
  return Object.freeze({
    ...value,
    receiptDigest: sha256(canonicalJson(value)),
  });
}

export function parseReconciliation(
  raw: string,
  terminal: TerminalRecord,
): ExternalEffectReconciliation {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'grantId',
      'grantDigest',
      'transactionId',
      'manualReconciliationReceiptDigest',
      'outcome',
      'evidenceDigest',
      'externalReceiptId',
      'poststateDigest',
      'observedAt',
      'reason',
      'resolver',
      'resolvedAt',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-reconciliation.v1' ||
    value.grantId !== terminal.envelope.payload.grantId ||
    value.grantDigest !== terminal.grantDigest ||
    value.transactionId !== terminal.transactionId ||
    value.manualReconciliationReceiptDigest !== terminal.receiptDigest ||
    typeof value.resolver !== 'string' ||
    typeof value.resolvedAt !== 'string' ||
    !isTimestamp(value.resolvedAt) ||
    Date.parse(value.resolvedAt) < Date.parse(terminal.terminalAt) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw unsafeStore();
  }
  try {
    const request = parseReconciliationRequest(
      {
        outcome: value.outcome,
        evidenceDigest: value.evidenceDigest,
        externalReceiptId: value.externalReceiptId,
        poststateDigest: value.poststateDigest,
        observedAt: value.observedAt,
        reason: value.reason,
      },
      terminal,
      new Date(value.resolvedAt),
    );
    const record = createReconciliationRecord(
      terminal,
      request,
      value.resolver,
      new Date(value.resolvedAt),
    );
    if (
      record.receiptDigest !== value.receiptDigest ||
      canonicalReconciliation(record) !== raw
    ) {
      throw unsafeStore();
    }
    return record;
  } catch {
    throw unsafeStore();
  }
}

export function parseIdempotencyRecord(raw: string): IdempotencyRecord {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'idempotencyKey',
      'grantId',
      'grantDigest',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'external-effect-idempotency' ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.grantId !== 'string' ||
    !UUID_V4.test(value.grantId) ||
    typeof value.grantDigest !== 'string' ||
    !DIGEST.test(value.grantDigest) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest)
  ) {
    throw unsafeStore();
  }
  const { recordDigest: _recordDigest, ...withoutDigest } = value;
  if (
    sha256(canonicalJson(withoutDigest)) !== value.recordDigest ||
    `${canonicalJson(value)}\n` !== raw
  ) {
    throw unsafeStore();
  }
  return value as IdempotencyRecord;
}

export function canonicalAvailable(record: AvailableRecord): string {
  return `${canonicalJson(record)}\n`;
}

export function canonicalPending(record: PendingRecord): string {
  return `${canonicalJson(record)}\n`;
}

export function canonicalTransaction(record: TransactionRecord): string {
  return `${canonicalJson(record)}\n`;
}

export function canonicalTerminal(record: TerminalRecord): string {
  return `${canonicalJson(record)}\n`;
}

export function canonicalReconciliation(
  record: ExternalEffectReconciliation,
): string {
  return `${canonicalJson(record)}\n`;
}

export function parseJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > 64 * 1024) throw unsafeStore();
  try {
    return JSON.parse(raw);
  } catch {
    throw unsafeStore();
  }
}

export function resolveStoreState(
  grantId: string,
  available: string | null,
  transaction: string | null,
  terminal: string | null,
  resolved: string | null,
): StoreState {
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
