/** Canonical finalize cancellation records, digests and phase preparation. */
import crypto from 'node:crypto';
import {
  type FinalizeTransaction,
  parseFinalizeTransaction,
} from './finalize-transaction.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export const MAX_FINALIZE_CANCELLATION_REASON_BYTES = 1024;

export type FinalizeCancellationPhase =
  'requested' | 'projection-restored' | 'completed';

export type FinalizeCancellation = Readonly<{
  schemaVersion: 1;
  kind: 'projected-finalize-cancellation.v1';
  recordDigest: string;
  phase: FinalizeCancellationPhase;
  sessionId: string;
  transactionId: string;
  transaction: FinalizeTransaction;
  reason: string;
  requestedAt: string;
  cancelledAt: string | null;
}>;

export function createFinalizeCancellation(
  transaction: FinalizeTransaction,
  reason: string,
  requestedAt: string,
): FinalizeCancellation {
  if (
    transaction.phase !== 'checks-running' &&
    transaction.phase !== 'checked'
  ) {
    throw invalidCancellation(
      'Only an ambiguous checks-running or authorized checked transaction can be cancelled.',
    );
  }
  return sealCancellation({
    schemaVersion: 1,
    kind: 'projected-finalize-cancellation.v1',
    phase: 'requested',
    sessionId: transaction.sessionId,
    transactionId: transaction.transactionId,
    transaction,
    reason,
    requestedAt,
    cancelledAt: null,
  });
}

export function parseFinalizeCancellation(
  value: unknown,
): FinalizeCancellation {
  if (!isRecord(value)) throw malformed();
  const keys = [
    'cancelledAt',
    'kind',
    'phase',
    'reason',
    'recordDigest',
    'requestedAt',
    'schemaVersion',
    'sessionId',
    'transaction',
    'transactionId',
  ].sort();
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'projected-finalize-cancellation.v1' ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest) ||
    !['requested', 'projection-restored', 'completed'].includes(
      String(value.phase),
    ) ||
    typeof value.sessionId !== 'string' ||
    typeof value.transactionId !== 'string' ||
    !DIGEST.test(value.transactionId) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    Buffer.byteLength(value.reason) > MAX_FINALIZE_CANCELLATION_REASON_BYTES ||
    /\p{Cc}/u.test(value.reason) ||
    typeof value.requestedAt !== 'string' ||
    Number.isNaN(Date.parse(value.requestedAt)) ||
    (value.cancelledAt !== null && typeof value.cancelledAt !== 'string')
  ) {
    throw malformed();
  }
  const transaction = parseFinalizeTransaction(value.transaction);
  if (
    !['checks-running', 'checked'].includes(transaction.phase) ||
    transaction.sessionId !== value.sessionId ||
    transaction.transactionId !== value.transactionId ||
    (value.phase === 'completed'
      ? value.cancelledAt === null ||
        Number.isNaN(Date.parse(value.cancelledAt))
      : value.cancelledAt !== null)
  ) {
    throw malformed();
  }
  const cancellation: FinalizeCancellation = {
    schemaVersion: 1,
    kind: 'projected-finalize-cancellation.v1',
    recordDigest: value.recordDigest,
    phase: value.phase as FinalizeCancellationPhase,
    sessionId: value.sessionId,
    transactionId: value.transactionId,
    transaction,
    reason: value.reason,
    requestedAt: value.requestedAt,
    cancelledAt: value.cancelledAt as string | null,
  };
  if (
    digestCancellation(recordWithoutDigest(cancellation)) !==
    cancellation.recordDigest
  ) {
    throw malformed();
  }
  return cancellation;
}

export function sealCancellation(
  value: Omit<FinalizeCancellation, 'recordDigest'> | FinalizeCancellation,
): FinalizeCancellation {
  const record = recordWithoutDigest(value);
  return parseFinalizeCancellation({
    ...record,
    recordDigest: digestCancellation(record),
  });
}

function recordWithoutDigest(
  value: Omit<FinalizeCancellation, 'recordDigest'> | FinalizeCancellation,
): Omit<FinalizeCancellation, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...record } =
    value as FinalizeCancellation;
  return record;
}

function digestCancellation(
  value: Omit<FinalizeCancellation, 'recordDigest'>,
): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function assertSameCancellationRequest(
  observed: FinalizeCancellation,
  requested: FinalizeCancellation,
): FinalizeCancellation {
  if (
    observed.phase !== 'requested' ||
    observed.cancelledAt !== null ||
    observed.sessionId !== requested.sessionId ||
    observed.transactionId !== requested.transactionId ||
    observed.reason !== requested.reason ||
    JSON.stringify(observed.transaction) !==
      JSON.stringify(requested.transaction)
  ) {
    throw invalidCancellation(
      'A different finalize cancellation preparation already exists.',
    );
  }
  return observed;
}

export function assertSameCancellation(
  observed: FinalizeCancellation,
  expected: FinalizeCancellation,
): FinalizeCancellation {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw invalidCancellation(
      'A different finalize cancellation already owns this transaction.',
    );
  }
  return observed;
}

export function assertTransactionId(value: string): string {
  if (!DIGEST.test(value)) {
    throw invalidCancellation('Finalize transaction ID is invalid.');
  }
  return value;
}

function malformed(): never {
  throw invalidCancellation('Finalize cancellation is malformed.');
}

export function invalidCancellation(message: string) {
  return workflowError(
    'FINALIZE_CANCELLATION_INVALID',
    message,
    ExitCode.staleState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function prepareFinalizeProjectionRestored(
  current: FinalizeCancellation,
): FinalizeCancellation {
  if (current.phase !== 'requested') {
    throw invalidCancellation(
      'Finalize cancellation projection is not awaiting restoration.',
    );
  }
  return {
    ...current,
    phase: 'projection-restored',
  };
}

export function prepareFinalizeCancellationCompletion(
  current: FinalizeCancellation,
  cancelledAt: string,
): FinalizeCancellation {
  if (current.phase !== 'projection-restored') {
    throw invalidCancellation(
      'Finalize cancellation projection has not been restored.',
    );
  }
  return {
    ...current,
    phase: 'completed',
    cancelledAt,
  };
}
