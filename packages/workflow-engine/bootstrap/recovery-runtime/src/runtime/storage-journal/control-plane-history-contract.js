/**
 * Defines and validates supervisor history anchors, transitions, and terminal records.
 *
 * Invariants:
 * - Each record retains exact keys, artifact and authority shapes, and self-digest validation.
 * - Record construction and verification preserve the current canonical identities.
 *
 * Depends on: history value checks and canonical JSON.
 * Failure modes: malformed or tampered history records are treated as valid supervisor evidence.
 */
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertDigest, assertGitOid, assertIso, assertNonEmpty, deepFreeze, hasExactKeys, isPositiveSafeInteger, isRecord, recordInvalid, } from "./control-plane-history-values.js";
export function controlPlaneSupervisorHistoryRecordDigest(payload) {
    return `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(payload))
        .digest('hex')}`;
}
export function verifyControlPlaneSupervisorHistoryRecord(value) {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        throw recordInvalid('Supervisor history record is not an object.');
    }
    switch (value.kind) {
        case 'control-plane-supervisor-history-anchor.v1':
            return verifyAnchor(value);
        case 'control-plane-supervisor-history-transition.v1':
            return verifyTransition(value);
        case 'control-plane-supervisor-history-terminal.v1':
            return verifyTerminal(value);
        default:
            throw recordInvalid('Unknown supervisor history record kind.');
    }
}
function verifyAnchor(value) {
    if (!hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'authority',
        'generation',
        'kind',
        'previousRecordDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'supervisorRecordDigest',
    ]) ||
        value.sequence !== 0 ||
        value.previousRecordDigest !== null ||
        !isPositiveSafeInteger(value.generation)) {
        throw recordInvalid('Supervisor history anchor schema is invalid.');
    }
    assertNonEmpty(value.repositoryId);
    assertDigest(value.supervisorRecordDigest);
    const activeArtifact = verifyArtifactSelection(value.activeArtifact);
    assertGitOid(value.activeTrustCommit);
    const authority = verifyAnchorAuthority(value.authority);
    assertIso(value.recordedAt);
    verifySelfDigest(value);
    return deepFreeze({
        ...structuredClone(value),
        activeArtifact,
        authority,
    });
}
function verifyTransition(value) {
    if (!hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'fromGeneration',
        'fromSupervisorRecordDigest',
        'grantEnvelopeDigest',
        'grantId',
        'kind',
        'phase',
        'previousRecordDigest',
        'promotionBundleDigest',
        'promotionLineageDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'sourceJournalDigest',
        'sourceTransactionState',
        'toGeneration',
        'toSupervisorRecordDigest',
        'txId',
    ]) ||
        !isPositiveSafeInteger(value.sequence) ||
        !isPositiveSafeInteger(value.fromGeneration) ||
        !isPositiveSafeInteger(value.toGeneration) ||
        value.toGeneration !== Number(value.fromGeneration) + 1 ||
        (value.phase !== 'candidate-selected' &&
            value.phase !== 'rollback-restored') ||
        (value.sourceTransactionState !== 'RECOVERY_VERIFIED' &&
            value.sourceTransactionState !== 'ROLLBACK_REQUIRED')) {
        throw recordInvalid('Supervisor history transition schema is invalid.');
    }
    for (const field of [value.repositoryId, value.grantId, value.txId]) {
        assertNonEmpty(field);
    }
    for (const field of [
        value.previousRecordDigest,
        value.fromSupervisorRecordDigest,
        value.toSupervisorRecordDigest,
        value.grantEnvelopeDigest,
        value.promotionBundleDigest,
        value.promotionLineageDigest,
        value.sourceJournalDigest,
    ]) {
        assertDigest(field);
    }
    const activeArtifact = verifyArtifactSelection(value.activeArtifact);
    assertGitOid(value.activeTrustCommit);
    assertIso(value.recordedAt);
    verifySelfDigest(value);
    return deepFreeze({
        ...structuredClone(value),
        activeArtifact,
    });
}
function verifyTerminal(value) {
    if (!hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'generation',
        'grantEnvelopeDigest',
        'grantId',
        'kind',
        'previousRecordDigest',
        'promotionBundleDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'supervisorRecordDigest',
        'terminalState',
        'transactionJournalDigest',
        'txId',
        'updateRecordDigest',
    ]) ||
        !isPositiveSafeInteger(value.sequence) ||
        !isPositiveSafeInteger(value.generation) ||
        (value.terminalState !== 'FINALIZED' &&
            value.terminalState !== 'ROLLED_BACK')) {
        throw recordInvalid('Supervisor history terminal schema is invalid.');
    }
    for (const field of [value.repositoryId, value.grantId, value.txId]) {
        assertNonEmpty(field);
    }
    for (const field of [
        value.previousRecordDigest,
        value.supervisorRecordDigest,
        value.updateRecordDigest,
        value.transactionJournalDigest,
        value.grantEnvelopeDigest,
        value.promotionBundleDigest,
    ]) {
        assertDigest(field);
    }
    const activeArtifact = verifyArtifactSelection(value.activeArtifact);
    assertGitOid(value.activeTrustCommit);
    assertIso(value.recordedAt);
    verifySelfDigest(value);
    return deepFreeze({
        ...structuredClone(value),
        activeArtifact,
    });
}
function verifyArtifactSelection(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['artifactId', 'closureDigest', 'executableDigest'])) {
        throw recordInvalid('Supervisor history artifact selection is invalid.');
    }
    assertDigest(value.artifactId);
    assertDigest(value.executableDigest);
    assertDigest(value.closureDigest);
    return deepFreeze({
        artifactId: value.artifactId,
        executableDigest: value.executableDigest,
        closureDigest: value.closureDigest,
    });
}
function verifyAnchorAuthority(value) {
    if (!isRecord(value)) {
        throw recordInvalid('Supervisor history anchor authority is invalid.');
    }
    if (value.kind !== 'initial-bootstrap-anchor.v1' ||
        !hasExactKeys(value, ['initialBootstrapPublishedDigest', 'kind'])) {
        throw recordInvalid('Initial supervisor history authority is invalid.');
    }
    assertDigest(value.initialBootstrapPublishedDigest);
    return deepFreeze({
        kind: value.kind,
        initialBootstrapPublishedDigest: value.initialBootstrapPublishedDigest,
    });
}
function verifySelfDigest(value) {
    assertDigest(value.recordDigest);
    const { recordDigest, ...payload } = value;
    if (recordDigest !== controlPlaneSupervisorHistoryRecordDigest(payload)) {
        throw recordInvalid('Supervisor history self-digest does not match its canonical bytes.');
    }
}
