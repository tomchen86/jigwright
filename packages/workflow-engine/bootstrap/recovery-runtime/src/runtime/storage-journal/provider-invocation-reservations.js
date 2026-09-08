/**
 * Create, read, and retire exact investigation-start and provider-retry reservations.
 *
 * Invariants:
 * - Reservation locks, CAS checks, schemas, and canonical bytes retain their order.
 * - Retry policy and replacement bindings remain attached to the exact request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { withPrivateRuntimeLock, createPrivateCanonicalJson, privatePathExists, readPrivateCanonicalJson, } from "./investigation-private-files.js";
import { assertChangeId, assertInvestigationId, assertInvocationId, } from "../session-workspace/paths.js";
import { assertBlindSurveyManifest, assertProviderRequest, blindSurveyManifestDigest, assertBlindInvocationBinding, assertProviderInvocationManifest, providerInvocationManifestDigest, assertProviderInvocationBinding, } from "./provider-invocation-validation.js";
import { isTimestamp, invocationInvalid, investigationStartReservationPath, invocationUnsafe, startReservationLockInvalid, deepFreeze, absentInvestigationStartReservationSnapshot, sha256, DIGEST, startReservationCasMismatch, fsyncDirectory, providerRetryReservationPath, isRecord, hasExactKeys, isTaskMandateBinding, isBaseline, isDigest, } from "./provider-invocation-common.js";
import { storeProviderExecutionPolicySnapshot, createProviderExecutionPolicySnapshot, ensureProviderExecutionPolicySnapshotFromSnapshot, validateProviderExecutionPolicySnapshot, } from "./provider-invocation-policy.js";
import { readPrivateCanonicalDocument } from "./provider-invocation-artifacts.js";
export function createInvestigationStartReservation(paths, input) {
    const changeId = assertChangeId(input.changeId);
    const investigationId = assertInvestigationId(input.investigationId);
    const manifest = assertBlindSurveyManifest(input.manifest);
    const request = assertProviderRequest(input.request);
    const manifestDigest = blindSurveyManifestDigest(manifest);
    assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
    const createdAt = input.createdAt ?? new Date().toISOString();
    if (!isTimestamp(createdAt)) {
        throw invocationInvalid();
    }
    const reservation = assertInvestigationStartReservation({
        schemaVersion: 1,
        kind: 'investigation-start-reservation',
        changeId,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        investigationId,
        invocationId: request.invocationId,
        repositoryRoot: input.repositoryRoot,
        gitCommonDirectory: input.gitCommonDirectory,
        branch: input.branch,
        baseline: input.baseline,
        manifestDigest,
        requestDigest: request.requestDigest,
        manifest,
        request,
        createdAt,
    });
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${changeId}.investigation-start.lock`), () => {
        storeProviderExecutionPolicySnapshot(paths, request, input.executionPolicy);
        createPrivateCanonicalJson(paths, investigationStartReservationPath(paths, changeId), reservation, invocationUnsafe, 'INVESTIGATION_START_RESERVATION_CONFLICT');
        return readInvestigationStartReservation(paths, changeId);
    }, 'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT', startReservationLockInvalid);
}
export function readInvestigationStartReservation(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const reservationPath = investigationStartReservationPath(paths, changeId);
    if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
        return null;
    }
    const reservation = assertInvestigationStartReservation(readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe));
    if (reservation.changeId !== changeId) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(reservation));
}
export function readInvestigationStartReservationSnapshot(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const reservationPath = investigationStartReservationPath(paths, changeId);
    if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
        return absentInvestigationStartReservationSnapshot();
    }
    const rawDocument = readPrivateCanonicalDocument(paths, reservationPath, invocationUnsafe);
    let parsed;
    try {
        parsed = JSON.parse(rawDocument);
    }
    catch {
        throw invocationInvalid();
    }
    const reservation = assertInvestigationStartReservation(parsed);
    if (reservation.changeId !== changeId ||
        rawDocument !== `${canonicalJson(parsed)}\n`) {
        throw invocationInvalid();
    }
    return Object.freeze({
        rawDocument,
        digest: sha256(rawDocument),
        reservation,
    });
}
export function retireInvestigationStartReservation(paths, input) {
    const changeId = assertChangeId(input.changeId);
    if (input.expectedDigest !== null && !DIGEST.test(input.expectedDigest)) {
        throw invocationInvalid();
    }
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${changeId}.investigation-start.lock`), () => {
        const current = readInvestigationStartReservationSnapshot(paths, changeId);
        if (current.digest === null) {
            return current;
        }
        if (current.digest !== input.expectedDigest) {
            throw startReservationCasMismatch(input.expectedDigest, current.digest);
        }
        fs.unlinkSync(investigationStartReservationPath(paths, changeId));
        fsyncDirectory(paths.refs);
        const retired = readInvestigationStartReservationSnapshot(paths, changeId);
        if (retired.digest !== null) {
            throw invocationInvalid();
        }
        return retired;
    }, 'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT', startReservationLockInvalid);
}
export function createProviderRetryReservation(paths, input) {
    const investigationId = assertInvestigationId(input.investigationId);
    const changeId = assertChangeId(input.changeId);
    const previousInvocationId = assertInvocationId(input.previousInvocationId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 2) {
        throw invocationInvalid();
    }
    const manifest = assertProviderInvocationManifest(input.manifest);
    const request = assertProviderRequest(input.request);
    if (input.retryDecision === undefined) {
        throw workflowError('PROVIDER_RETRY_DECISION_EVIDENCE_REQUIRED', 'A durable retry decision binding is required before reserving provider work.', ExitCode.guard);
    }
    const retryDecision = assertProviderRetryDecisionBinding(input.retryDecision);
    const executionPolicySnapshot = createProviderExecutionPolicySnapshot(request, input.executionPolicy, input.executionGrantAuthorization);
    const manifestDigest = providerInvocationManifestDigest(manifest);
    assertProviderInvocationBinding(changeId, manifest, manifestDigest, request);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const reservation = assertProviderRetryReservation({
        schemaVersion: input.replacement === undefined ? 2 : 3,
        kind: 'provider-retry-reservation',
        investigationId,
        changeId,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        attempt: input.attempt,
        previousInvocationId,
        invocationId: request.invocationId,
        manifestDigest,
        requestDigest: request.requestDigest,
        request,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        retryDecision,
        executionPolicySnapshot,
        ...(input.replacement === undefined
            ? {}
            : { replacement: input.replacement }),
        createdAt,
    });
    createPrivateCanonicalJson(paths, providerRetryReservationPath(paths, investigationId, input.attempt), reservation, invocationUnsafe, 'PROVIDER_RETRY_RESERVATION_CONFLICT');
    ensureProviderExecutionPolicySnapshotFromSnapshot(paths, request, executionPolicySnapshot);
    return readProviderRetryReservation(paths, investigationId, input.attempt);
}
export function readProviderRetryReservation(paths, requestedInvestigationId, attempt) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    if (!Number.isSafeInteger(attempt) || attempt < 2) {
        throw invocationInvalid();
    }
    const reservationPath = providerRetryReservationPath(paths, investigationId, attempt);
    if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
        return null;
    }
    const reservation = assertProviderRetryReservation(readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe));
    if (reservation.investigationId !== investigationId ||
        reservation.attempt !== attempt) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(reservation));
}
function assertInvestigationStartReservation(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
            'investigationId',
            'invocationId',
            'repositoryRoot',
            'gitCommonDirectory',
            'branch',
            'baseline',
            'manifestDigest',
            'requestDigest',
            'manifest',
            'request',
            'createdAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'investigation-start-reservation' ||
        typeof value.changeId !== 'string' ||
        (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
            !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
        typeof value.investigationId !== 'string' ||
        typeof value.invocationId !== 'string' ||
        typeof value.repositoryRoot !== 'string' ||
        !path.isAbsolute(value.repositoryRoot) ||
        typeof value.gitCommonDirectory !== 'string' ||
        !path.isAbsolute(value.gitCommonDirectory) ||
        (value.branch !== null &&
            (typeof value.branch !== 'string' || value.branch.length === 0)) ||
        !isBaseline(value.baseline) ||
        !isDigest(value.manifestDigest) ||
        !isDigest(value.requestDigest) ||
        !isTimestamp(value.createdAt)) {
        throw invocationInvalid();
    }
    const changeId = assertChangeId(value.changeId);
    const investigationId = assertInvestigationId(value.investigationId);
    const invocationId = assertInvocationId(value.invocationId);
    const manifest = assertBlindSurveyManifest(value.manifest);
    const request = assertProviderRequest(value.request);
    const manifestDigest = blindSurveyManifestDigest(manifest);
    assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
    if (invocationId !== request.invocationId ||
        value.manifestDigest !== manifestDigest ||
        value.requestDigest !== request.requestDigest ||
        value.baseline.head !== manifest.baseCommit ||
        value.baseline.tree !== manifest.baseTree) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone({
        ...value,
        changeId,
        investigationId,
        invocationId,
        manifest,
        request,
    }));
}
function assertProviderRetryReservation(value) {
    const baseKeys = [
        'schemaVersion',
        'kind',
        'investigationId',
        'changeId',
        'attempt',
        'previousInvocationId',
        'invocationId',
        'manifestDigest',
        'requestDigest',
        'request',
        'createdAt',
    ];
    if (!isRecord(value) ||
        (value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
        !hasExactKeys(value, [
            ...baseKeys,
            'executionPolicySnapshot',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
            'retryDecision',
            ...(value.schemaVersion === 3 ? ['replacement'] : []),
        ]) ||
        value.kind !== 'provider-retry-reservation' ||
        typeof value.investigationId !== 'string' ||
        typeof value.changeId !== 'string' ||
        (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
            !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt < 2 ||
        typeof value.previousInvocationId !== 'string' ||
        typeof value.invocationId !== 'string' ||
        !isDigest(value.manifestDigest) ||
        !isDigest(value.requestDigest) ||
        !isTimestamp(value.createdAt)) {
        throw invocationInvalid();
    }
    assertInvestigationId(value.investigationId);
    assertChangeId(value.changeId);
    assertInvocationId(value.previousInvocationId);
    const invocationId = assertInvocationId(value.invocationId);
    const request = assertProviderRequest(value.request);
    const retryDecision = assertProviderRetryDecisionBinding(value.retryDecision);
    const executionPolicySnapshot = assertEmbeddedProviderExecutionPolicySnapshot(value.executionPolicySnapshot, request);
    const replacement = value.schemaVersion === 3
        ? assertProviderRetryReplacementBinding(value.replacement)
        : undefined;
    if (invocationId !== request.invocationId ||
        value.requestDigest !== request.requestDigest ||
        value.previousInvocationId === invocationId ||
        (replacement !== undefined &&
            (replacement.attemptId !== `attempt-provider-${invocationId}` ||
                request.authorizationNodeId !== replacement.authorizationNodeId))) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone({
        ...value,
        invocationId,
        request,
        retryDecision,
        executionPolicySnapshot,
        ...(replacement === undefined ? {} : { replacement }),
    }));
}
function assertEmbeddedProviderExecutionPolicySnapshot(value, request) {
    try {
        return validateProviderExecutionPolicySnapshot(request, value);
    }
    catch {
        throw invocationInvalid();
    }
}
function assertProviderRetryDecisionBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'evaluatedAt',
            'evidenceDigest',
            'executionJobId',
            'executionRevision',
            'failedAttemptId',
            'kind',
            'schemaVersion',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-retry-decision-binding' ||
        typeof value.executionJobId !== 'string' ||
        !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
        !Number.isSafeInteger(value.executionRevision) ||
        value.executionRevision < 0 ||
        typeof value.failedAttemptId !== 'string' ||
        !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.failedAttemptId) ||
        typeof value.evidenceDigest !== 'string' ||
        !DIGEST.test(value.evidenceDigest) ||
        !isTimestamp(value.evaluatedAt)) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function assertProviderRetryReplacementBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'attemptId',
            'retryMode',
            'strategyChanges',
            'environmentDigest',
            'executionGrantId',
            'authorizationNodeId',
            'reservationNodeId',
        ]) ||
        typeof value.attemptId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.attemptId) ||
        ![
            'same-input',
            'execution-policy-change',
            'repair',
            'strategy-change',
        ].includes(value.retryMode) ||
        !Array.isArray(value.strategyChanges) ||
        value.strategyChanges.length > 32 ||
        value.strategyChanges.some((entry) => typeof entry !== 'string' ||
            entry.length < 1 ||
            Buffer.byteLength(entry, 'utf8') > 512) ||
        new Set(value.strategyChanges).size !== value.strategyChanges.length ||
        typeof value.environmentDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.environmentDigest) ||
        (value.executionGrantId !== null &&
            (typeof value.executionGrantId !== 'string' ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.executionGrantId))) ||
        typeof value.authorizationNodeId !== 'string' ||
        !DIGEST.test(value.authorizationNodeId) ||
        typeof value.reservationNodeId !== 'string' ||
        !DIGEST.test(value.reservationNodeId) ||
        (value.retryMode === 'strategy-change') !== value.strategyChanges.length > 0) {
        throw invocationInvalid();
    }
    return deepFreeze({
        attemptId: value.attemptId,
        retryMode: value.retryMode,
        strategyChanges: [...value.strategyChanges],
        environmentDigest: value.environmentDigest,
        executionGrantId: value.executionGrantId,
        authorizationNodeId: value.authorizationNodeId,
        reservationNodeId: value.reservationNodeId,
    });
}
