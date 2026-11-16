/**
 * Validates resolution journal plans and their immutable identities and phase order.
 *
 * Invariants:
 * - Planned refs and reservations bind their exact before and after digests.
 * - Journal identity excludes only the same mutable phase data as before.
 */
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { assertInvestigationId } from "../../../foundation/repository-path/repository-path.js";
import { assertHumanResolutionTarget, investigationCurrentRefDigest, } from "./human-resolution-contract.js";
import { assertHumanResolutionGrantId } from "./human-resolution-values.js";
import { deepFreeze, hasExactKeys, isDigest, isRecord, isTimestamp, sha256, } from "./investigation-store-values.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
export function createHumanResolutionJournal(input) {
    const semantic = {
        schemaVersion: 2,
        kind: 'human-resolution-journal',
        phase: input.phase,
        grantId: input.grantId,
        grantDigest: input.grantDigest,
        target: input.target,
        beforeStateDigest: input.beforeStateDigest,
        afterStateDigest: input.afterStateDigest,
        beforeResolutionRef: input.beforeResolutionRef,
        resolutionRefMode: input.resolutionRefMode,
        plannedResolutionNodeId: input.plannedResolutionNodeId,
        plannedCurrentWorkflowRef: input.plannedCurrentWorkflowRef,
        plannedStartReservation: input.plannedStartReservation,
        plannedEvidenceRefs: input.plannedEvidenceRefs,
        evidenceArchiveDigest: input.evidenceArchiveDigest,
        receiptDigest: input.receiptDigest,
        createdAt: input.createdAt,
    };
    const candidate = {
        ...semantic,
        journalId: sha256(canonicalJson({
            schema: 'human-resolution-journal.v2',
            journal: humanResolutionJournalIdentity(semantic),
        })),
    };
    return assertHumanResolutionJournal(candidate);
}
export function humanResolutionJournalPhaseIndex(phase) {
    return [
        'prepared',
        'evidence-refs-published',
        'start-reservation-published',
        'current-ref-published',
        'state-published',
        'receipt-written',
        'completed',
        'grant-consumed',
    ].indexOf(phase);
}
export function isTerminalHumanResolutionJournalPhase(phase) {
    return phase === 'completed' || phase === 'grant-consumed';
}
export function assertHumanResolutionJournal(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'journalId',
            'phase',
            'grantId',
            'grantDigest',
            'target',
            'beforeStateDigest',
            'afterStateDigest',
            'beforeResolutionRef',
            'resolutionRefMode',
            'plannedResolutionNodeId',
            'plannedCurrentWorkflowRef',
            'plannedStartReservation',
            'plannedEvidenceRefs',
            'evidenceArchiveDigest',
            'receiptDigest',
            'createdAt',
        ]) ||
        value.schemaVersion !== 2 ||
        value.kind !== 'human-resolution-journal' ||
        !isDigest(value.journalId) ||
        ![
            'prepared',
            'evidence-refs-published',
            'start-reservation-published',
            'current-ref-published',
            'state-published',
            'receipt-written',
            'completed',
            'grant-consumed',
        ].includes(String(value.phase)) ||
        typeof value.grantId !== 'string' ||
        !isDigest(value.grantDigest) ||
        !isDigest(value.beforeStateDigest) ||
        !isDigest(value.afterStateDigest) ||
        (value.beforeResolutionRef !== null &&
            !isDigest(value.beforeResolutionRef)) ||
        !['preserve', 'quarantine-whole'].includes(String(value.resolutionRefMode)) ||
        !isDigest(value.plannedResolutionNodeId) ||
        !isRecord(value.plannedCurrentWorkflowRef) ||
        !hasExactKeys(value.plannedCurrentWorkflowRef, [
            'expectedInvestigationId',
            'expectedDigest',
            'nextInvestigationId',
            'nextDigest',
        ]) ||
        (value.plannedCurrentWorkflowRef.expectedInvestigationId !== null &&
            typeof value.plannedCurrentWorkflowRef.expectedInvestigationId !==
                'string') ||
        (value.plannedCurrentWorkflowRef.nextInvestigationId !== null &&
            typeof value.plannedCurrentWorkflowRef.nextInvestigationId !==
                'string') ||
        !isNullableDigest(value.plannedCurrentWorkflowRef.expectedDigest) ||
        !isNullableDigest(value.plannedCurrentWorkflowRef.nextDigest) ||
        !isPlannedStartReservation(value.plannedStartReservation) ||
        !isPlannedEvidenceRefs(value.plannedEvidenceRefs) ||
        !isDigest(value.evidenceArchiveDigest) ||
        !isDigest(value.receiptDigest) ||
        !isTimestamp(value.createdAt)) {
        throw humanResolutionJournalUnsafe();
    }
    assertHumanResolutionGrantId(value.grantId);
    const target = assertHumanResolutionTarget(value.target);
    for (const candidate of [
        value.plannedCurrentWorkflowRef.expectedInvestigationId,
        value.plannedCurrentWorkflowRef.nextInvestigationId,
    ]) {
        if (typeof candidate === 'string') {
            assertInvestigationId(candidate);
        }
    }
    if (value.plannedCurrentWorkflowRef.expectedDigest !==
        investigationCurrentRefDigest(value.plannedCurrentWorkflowRef.expectedInvestigationId === null
            ? null
            : {
                changeId: target.changeId,
                investigationId: value.plannedCurrentWorkflowRef.expectedInvestigationId,
            }) ||
        value.plannedCurrentWorkflowRef.nextDigest !==
            investigationCurrentRefDigest(value.plannedCurrentWorkflowRef.nextInvestigationId === null
                ? null
                : {
                    changeId: target.changeId,
                    investigationId: value.plannedCurrentWorkflowRef.nextInvestigationId,
                }) ||
        !validPlannedStartReservation(value.plannedStartReservation) ||
        !validPlannedEvidenceRefs(target.changeId, value.plannedEvidenceRefs)) {
        throw humanResolutionJournalUnsafe();
    }
    const semantic = {
        schemaVersion: 2,
        kind: 'human-resolution-journal',
        phase: value.phase,
        grantId: value.grantId,
        grantDigest: value.grantDigest,
        target,
        beforeStateDigest: value.beforeStateDigest,
        afterStateDigest: value.afterStateDigest,
        beforeResolutionRef: value.beforeResolutionRef,
        resolutionRefMode: value.resolutionRefMode,
        plannedResolutionNodeId: value.plannedResolutionNodeId,
        plannedCurrentWorkflowRef: value.plannedCurrentWorkflowRef,
        plannedStartReservation: value.plannedStartReservation,
        plannedEvidenceRefs: value.plannedEvidenceRefs,
        evidenceArchiveDigest: value.evidenceArchiveDigest,
        receiptDigest: value.receiptDigest,
        createdAt: value.createdAt,
    };
    const journalId = sha256(canonicalJson({
        schema: 'human-resolution-journal.v2',
        journal: humanResolutionJournalIdentity(semantic),
    }));
    if (journalId !== value.journalId) {
        throw humanResolutionJournalUnsafe();
    }
    return deepFreeze(structuredClone(value));
}
function isNullableDigest(value) {
    return value === null || isDigest(value);
}
function isEvidenceRefMap(value) {
    return (isRecord(value) &&
        Object.entries(value).every(([name, nodeId]) => /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(name) && isDigest(nodeId)));
}
function isPlannedStartReservation(value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'mode',
            'expectedDigest',
            'nextDigest',
            'archiveDigest',
        ]) &&
        (value.mode === 'preserve' ||
            value.mode === 'retire' ||
            value.mode === 'quarantine-whole') &&
        isNullableDigest(value.expectedDigest) &&
        isNullableDigest(value.nextDigest) &&
        isNullableDigest(value.archiveDigest));
}
function validPlannedStartReservation(value) {
    return value.mode === 'preserve'
        ? value.nextDigest === value.expectedDigest && value.archiveDigest === null
        : value.expectedDigest !== null &&
            value.nextDigest === null &&
            value.archiveDigest === value.expectedDigest;
}
function isPlannedEvidenceRefs(value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'mode',
            'expectedDigest',
            'nextDigest',
            'expectedClosureDigest',
            'nextClosureDigest',
            'retiredRefs',
            'retainedRefs',
            'archiveDigest',
        ]) &&
        (value.mode === 'preserve' ||
            value.mode === 'partition' ||
            value.mode === 'quarantine-whole') &&
        isNullableDigest(value.expectedDigest) &&
        isNullableDigest(value.nextDigest) &&
        isNullableDigest(value.expectedClosureDigest) &&
        isNullableDigest(value.nextClosureDigest) &&
        isEvidenceRefMap(value.retiredRefs) &&
        isEvidenceRefMap(value.retainedRefs) &&
        isNullableDigest(value.archiveDigest));
}
function validPlannedEvidenceRefs(changeId, value) {
    if (Object.keys(value.retiredRefs).some((name) => Object.hasOwn(value.retainedRefs, name))) {
        return false;
    }
    if (value.mode === 'preserve') {
        return (value.nextDigest === value.expectedDigest &&
            value.nextClosureDigest === value.expectedClosureDigest &&
            Object.keys(value.retiredRefs).length === 0 &&
            value.archiveDigest === null);
    }
    if (value.mode === 'quarantine-whole') {
        return (value.expectedDigest !== null &&
            value.nextDigest === null &&
            value.nextClosureDigest === null &&
            Object.keys(value.retiredRefs).length === 0 &&
            Object.keys(value.retainedRefs).length === 0 &&
            value.archiveDigest === value.expectedDigest);
    }
    const nextDigest = Object.keys(value.retainedRefs).length === 0
        ? null
        : sha256(canonicalJson({
            schemaVersion: 1,
            changeId,
            refs: value.retainedRefs,
        }));
    return (value.expectedDigest !== null &&
        Object.keys(value.retiredRefs).length > 0 &&
        value.nextDigest === nextDigest &&
        isDigest(value.expectedClosureDigest) &&
        (value.nextDigest === null
            ? value.nextClosureDigest === null
            : isDigest(value.nextClosureDigest)) &&
        value.archiveDigest === value.expectedDigest);
}
function humanResolutionJournalIdentity(journal) {
    const { phase: _phase, ...identity } = journal;
    return identity;
}
export function humanResolutionJournalUnsafe() {
    return workflowError('HUMAN_RESOLUTION_JOURNAL_UNSAFE', 'Human resolution journal is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
