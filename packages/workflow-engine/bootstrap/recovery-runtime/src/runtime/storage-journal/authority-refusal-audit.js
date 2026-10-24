/** Persist trusted refusals using the first durable occurrence on retry. */
import { createAuthorityRefusalIdentity, createAuthorityRefusalEventInput, } from "../../modules/authority/authority-refusal-audit.js";
import { scanAuthorityAuditLedger } from "./authority-audit-ledger.js";
import { recordAuthorityAuditEvent } from "./authority-audit-service.js";
export const recordAuthorityRefusal = (binding, error, options = {}) => {
    const refusal = createAuthorityRefusalIdentity(binding, error);
    const durableOccurrence = scanAuthorityAuditLedger(binding.scope).records.find(({ record }) => record.idempotencyKey === refusal.idempotencyKey)?.record.occurredAt;
    const occurredAt = durableOccurrence ?? exactDate(options.now ?? new Date()).toISOString();
    // Preserve the caller's ledger clock; an explicit service clock wins.
    const entry = recordAuthorityAuditEvent(binding.scope, createAuthorityRefusalEventInput(binding, error, refusal, occurredAt), options.serviceHooks?.now !== undefined || options.now === undefined
        ? options.serviceHooks
        : { ...options.serviceHooks, now: () => exactDate(options.now) });
    options.onRecord?.(entry);
    return entry;
};
function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new TypeError('Authority refusal audit time is invalid.');
    }
    return date;
}
