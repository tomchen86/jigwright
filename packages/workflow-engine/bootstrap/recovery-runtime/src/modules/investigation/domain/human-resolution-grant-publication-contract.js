/**
 * Defines and validates exact grant-publication observations and quarantine receipts.
 *
 * Invariants:
 * - File names, digests, audit identities, and phase shapes retain their current exact checks.
 * - Recovery receipts bind every observed artifact and its intended quarantine destination.
 */
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { GIT_OBJECT_ID, hasExactKeys, isDigest, isRecord, isTimestamp, sha256, } from "./investigation-store-values.js";
import { isBoundedResolutionText } from "./human-resolution-values.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
export const HUMAN_RESOLUTION_GRANT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
export const HUMAN_RESOLUTION_GRANT_TEMPORARY = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export function assertHumanResolutionGrantPublicationQuarantineReceipt(value, grantId) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'recoveryId',
            'action',
            'phase',
            'grantId',
            'publicationStateDigest',
            'auditTag',
            'publicationStoreState',
            'artifacts',
            'reason',
            'recordedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'human-resolution-grant-publication-recovery' ||
        !isDigest(value.recoveryId) ||
        value.action !== 'quarantined' ||
        !['prepared', 'quarantined'].includes(String(value.phase)) ||
        value.grantId !== grantId ||
        !isDigest(value.publicationStateDigest) ||
        !isBoundedResolutionText(value.reason, 1024) ||
        !isTimestamp(value.recordedAt)) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    const recoveryId = value.recoveryId;
    const publicationStateDigest = value.publicationStateDigest;
    if (recoveryId !==
        sha256(canonicalJson({
            schema: 'human-resolution-grant-publication-quarantine.v1',
            grantId,
            publicationStateDigest,
        }))) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    const publicationStoreState = assertHumanResolutionGrantPublicationStoreState(value.publicationStoreState, grantId);
    const auditTag = assertHumanResolutionGrantPublicationAuditTag(value.auditTag, grantId);
    if (sha256(canonicalJson({
        schemaVersion: 1,
        kind: 'human-resolution-grant-publication-state',
        ...publicationStoreState,
        auditTag,
    })) !== publicationStateDigest) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    if (!Array.isArray(value.artifacts) ||
        value.artifacts.length === 0 ||
        value.artifacts.length !== publicationStoreState.temporaries.length) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    const artifacts = value.artifacts.map((artifact, index) => assertHumanResolutionGrantPublicationQuarantineArtifact(artifact, grantId, recoveryId, index, publicationStoreState.temporaries[index]));
    if (artifacts.some((artifact, index) => index > 0 &&
        artifact.temporaryName <= artifacts[index - 1].temporaryName)) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    return value;
}
function assertHumanResolutionGrantPublicationAuditTag(value, grantId) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['status', 'tagRef', 'refObjectOid', 'objectType']) ||
        !['absent', 'present'].includes(String(value.status)) ||
        (value.tagRef !== null && typeof value.tagRef !== 'string') ||
        (value.refObjectOid !== null &&
            (typeof value.refObjectOid !== 'string' ||
                !GIT_OBJECT_ID.test(value.refObjectOid))) ||
        (value.objectType !== null && typeof value.objectType !== 'string') ||
        (value.status === 'absent' &&
            (value.tagRef !== null ||
                value.refObjectOid !== null ||
                value.objectType !== null)) ||
        (value.status === 'present' &&
            (value.tagRef === null ||
                value.refObjectOid === null ||
                value.objectType !== 'tag' ||
                !value.tagRef.endsWith(`/resolution-${grantId}`)))) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    return value;
}
function assertHumanResolutionGrantPublicationQuarantineArtifact(value, grantId, recoveryId, index, temporary) {
    if (!temporary ||
        !isRecord(value) ||
        !hasExactKeys(value, [
            'temporaryName',
            'rawSha256',
            'unsafeObservationDigest',
            'byteLength',
            'quarantineArtifact',
        ]) ||
        typeof value.temporaryName !== 'string' ||
        HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(value.temporaryName)?.[1] !==
            grantId ||
        value.temporaryName !== temporary.temporaryName ||
        value.rawSha256 !== temporary.rawSha256 ||
        value.unsafeObservationDigest !== temporary.unsafeObservationDigest ||
        value.byteLength !== temporary.byteLength ||
        value.quarantineArtifact !==
            `${recoveryId}.${index + 1}.grant-publication.artifact`) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    return value;
}
function assertHumanResolutionGrantPublicationStoreState(value, grantId) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'grantId',
            'temporaries',
            'durable',
            'sameGrantJournalDigest',
            'sameGrantActiveJournalDigest',
            'sameGrantReceiptDigest',
        ]) ||
        value.grantId !== grantId ||
        !Array.isArray(value.temporaries) ||
        !isRecord(value.durable) ||
        !hasExactKeys(value.durable, [
            'availableDigest',
            'reservedDigest',
            'terminalDigest',
        ]) ||
        ![
            value.durable.availableDigest,
            value.durable.reservedDigest,
            value.durable.terminalDigest,
            value.sameGrantJournalDigest,
            value.sameGrantActiveJournalDigest,
            value.sameGrantReceiptDigest,
        ].every((candidate) => candidate === null || isDigest(candidate))) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    const temporaries = value.temporaries.map((temporary) => assertHumanResolutionGrantPublicationTemporary(temporary, grantId));
    if (temporaries.length === 0 ||
        temporaries.some((temporary, index) => index > 0 &&
            temporary.temporaryName <= temporaries[index - 1].temporaryName)) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    return value;
}
function assertHumanResolutionGrantPublicationTemporary(value, grantId) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'temporaryName',
            'rawSha256',
            'unsafeObservationDigest',
            'byteLength',
            'parsedEnvelopeGrantId',
        ]) ||
        typeof value.temporaryName !== 'string' ||
        HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(value.temporaryName)?.[1] !==
            grantId ||
        !isDigest(value.rawSha256) ||
        !isDigest(value.unsafeObservationDigest) ||
        !Number.isSafeInteger(value.byteLength) ||
        value.byteLength < 0 ||
        (value.parsedEnvelopeGrantId !== null &&
            (typeof value.parsedEnvelopeGrantId !== 'string' ||
                HUMAN_RESOLUTION_GRANT_FILE.exec(`${value.parsedEnvelopeGrantId}.json`)?.[1] !== value.parsedEnvelopeGrantId))) {
        throw humanResolutionGrantPublicationRecoveryStale();
    }
    return value;
}
export function humanResolutionGrantPublicationRecoveryStale() {
    return workflowError('HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE', 'Interrupted human resolution grant publication no longer matches the inspected bytes.', ExitCode.staleState);
}
