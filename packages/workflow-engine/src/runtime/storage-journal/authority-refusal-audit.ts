/** Persist trusted refusals using the first durable occurrence on retry. */
import {
  createAuthorityRefusalIdentity,
  createAuthorityRefusalEventInput,
} from '../../modules/authority/authority-refusal-audit.ts';
import type { RecordAuthorityRefusal } from '../../modules/authority/authority-audit-contract.ts';
import { scanAuthorityAuditLedger } from './authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from './authority-audit-service.ts';

export const recordAuthorityRefusal: RecordAuthorityRefusal = (
  binding,
  error,
  options = {},
) => {
  const refusal = createAuthorityRefusalIdentity(binding, error);
  const durableOccurrence = scanAuthorityAuditLedger(
    binding.scope,
  ).records.find(
    ({ record }) => record.idempotencyKey === refusal.idempotencyKey,
  )?.record.occurredAt;
  const occurredAt =
    durableOccurrence ?? exactDate(options.now ?? new Date()).toISOString();
  // Preserve the caller's ledger clock; an explicit service clock wins.
  const entry = recordAuthorityAuditEvent(
    binding.scope,
    createAuthorityRefusalEventInput(binding, error, refusal, occurredAt),
    options.serviceHooks?.now !== undefined || options.now === undefined
      ? options.serviceHooks
      : { ...options.serviceHooks, now: () => exactDate(options.now!) },
  );
  options.onRecord?.(entry);
  return entry;
};

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('Authority refusal audit time is invalid.');
  }
  return date;
}
