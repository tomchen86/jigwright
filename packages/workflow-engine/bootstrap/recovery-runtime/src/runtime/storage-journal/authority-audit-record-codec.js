/**
 * Validates canonical authority event records and derives their immutable chain identities.
 *
 * Invariants:
 * - Event fields, predecessor digests, sequence values, and idempotency inputs retain exact meaning.
 * - Stored record bytes remain canonical and bounded before entering the ledger chain.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { APPEND_INPUT_KEYS, RECORD_KEYS, } from "./authority-audit-contracts.js";
import { isPlainRecord, hasExactKeys, invalidRecord, includes, isCanonicalTimestamp, assertDigest, assertNullableDigest, invalidLedger, } from "./authority-audit-values.js";
export function assertAppendInput(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, APPEND_INPUT_KEYS)) {
        throw invalidRecord();
    }
    if (!includes(AUTHORITY_AUDIT_EVENT_TYPES, raw.eventType) ||
        !includes(AUTHORITY_AUDIT_RESULTS, raw.result) ||
        !isCanonicalTimestamp(raw.occurredAt)) {
        throw invalidRecord();
    }
    return Object.freeze({
        eventType: raw.eventType,
        occurredAt: raw.occurredAt,
        idempotencyKey: assertDigest(raw.idempotencyKey, invalidRecord),
        grantDigest: assertNullableDigest(raw.grantDigest, invalidRecord),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest, invalidRecord),
        prestateDigest: assertNullableDigest(raw.prestateDigest, invalidRecord),
        poststateDigest: assertNullableDigest(raw.poststateDigest, invalidRecord),
        result: raw.result,
        resultDigest: assertDigest(raw.resultDigest, invalidRecord),
    });
}
function assertStoredRecord(raw) {
    if (!isPlainRecord(raw) || !hasExactKeys(raw, RECORD_KEYS)) {
        throw invalidLedger();
    }
    if (raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-record.v1' ||
        !Number.isSafeInteger(raw.sequence) ||
        typeof raw.sequence !== 'number' ||
        raw.sequence < 1 ||
        !includes(AUTHORITY_AUDIT_EVENT_TYPES, raw.eventType) ||
        !includes(AUTHORITY_AUDIT_RESULTS, raw.result) ||
        !isCanonicalTimestamp(raw.occurredAt)) {
        throw invalidLedger();
    }
    return freezeRecord({
        schemaVersion: 1,
        kind: 'authority-audit-record.v1',
        repositoryId: assertDigest(raw.repositoryId, invalidLedger),
        sequence: raw.sequence,
        occurredAt: raw.occurredAt,
        eventType: raw.eventType,
        idempotencyKey: assertDigest(raw.idempotencyKey, invalidLedger),
        previousRecordDigest: assertNullableDigest(raw.previousRecordDigest, invalidLedger),
        grantDigest: assertNullableDigest(raw.grantDigest, invalidLedger),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest, invalidLedger),
        prestateDigest: assertNullableDigest(raw.prestateDigest, invalidLedger),
        poststateDigest: assertNullableDigest(raw.poststateDigest, invalidLedger),
        result: raw.result,
        resultDigest: assertDigest(raw.resultDigest, invalidLedger),
    });
}
export function parseCanonicalRecord(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw invalidLedger();
    }
    const record = assertStoredRecord(parsed);
    if (content !== canonicalRecordContent(record)) {
        throw invalidLedger();
    }
    return record;
}
export function recordMatchesInput(record, input) {
    return APPEND_INPUT_KEYS.every((key) => record[key] === input[key]);
}
export function canonicalRecordContent(record) {
    return `${canonicalJson(record)}\n`;
}
export function recordFileName(sequence, digest) {
    const encodedSequence = sequence.toString().padStart(16, '0');
    if (encodedSequence.length !== 16 || !/^[0-9a-f]{64}$/.test(digest)) {
        throw invalidLedger();
    }
    return `${encodedSequence}-${digest}.json`;
}
export function freezeRecord(record) {
    return Object.freeze(record);
}
export function freezeEntry(entry) {
    return Object.freeze(entry);
}
import { AUTHORITY_AUDIT_EVENT_TYPES, AUTHORITY_AUDIT_RESULTS, } from "../../modules/authority/authority-audit-contract.js";
