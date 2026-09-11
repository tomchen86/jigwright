/**
 * Creates, reads, and compare-and-swaps investigation sessions and current refs.
 *
 * Invariants:
 * - Session writes retain revision checks and monotonic transition validation under the same lock.
 * - Current refs bind the exact session and preserve their existing compare-and-swap rules.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertChangeId, assertInvestigationId, } from "../../foundation/repository-path/repository-path.js";
import { createPrivateCanonicalJson, fsyncDirectory, privatePathExists, readPrivateCanonicalJson, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, } from "./investigation-private-files.js";
import { currentInvestigationRefPath, investigationCasMismatch, investigationSessionPath, refUnsafe, sessionLockInvalid, sessionUnsafe, } from "./investigation-resolution-values.js";
import { sessionTransitionInvalid } from "../../modules/investigation/domain/investigation-session-contract.js";
import { assertInvestigationSession, assertMonotonicSessionTransition, semanticSessionContentChanged, } from "../../modules/investigation/domain/investigation-session-contract.js";
import { deepFreeze, hasExactKeys, isRecord, } from "../../modules/investigation/domain/investigation-store-values.js";
export function createInvestigationId() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
    return `investigation-${timestamp}-${crypto.randomUUID()}`;
}
export function createInvestigationSessionRecord(paths, session) {
    const validated = assertInvestigationSession(session);
    const sessionPath = investigationSessionPath(paths, validated.investigationId);
    createPrivateCanonicalJson(paths, sessionPath, validated, sessionUnsafe, 'INVESTIGATION_SESSION_COLLISION');
    return readInvestigationSession(paths, validated.investigationId);
}
export function readInvestigationSession(paths, requestedInvestigationId) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    const value = readPrivateCanonicalJson(paths, investigationSessionPath(paths, investigationId), sessionUnsafe);
    const session = assertInvestigationSession(value);
    if (session.investigationId !== investigationId) {
        throw workflowError('INVESTIGATION_SESSION_ID_MISMATCH', 'Investigation session content does not match its filename.', ExitCode.staleState);
    }
    return deepFreeze(structuredClone(session));
}
export function investigationSessionExists(paths, requestedInvestigationId) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    return privatePathExists(paths, investigationSessionPath(paths, investigationId), sessionUnsafe);
}
export function compareAndSwapInvestigationSession(paths, requestedInvestigationId, expectedRevision, transition) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${investigationId}.lock`), () => {
        const current = readInvestigationSession(paths, investigationId);
        if (current.revision !== expectedRevision) {
            throw investigationCasMismatch(expectedRevision, current.revision);
        }
        const proposed = transition(deepFreeze(structuredClone(current)));
        if (proposed.semanticRevision !== current.semanticRevision ||
            proposed.lifecycleRevision !== current.lifecycleRevision) {
            throw sessionTransitionInvalid();
        }
        const next = assertInvestigationSession({
            ...proposed,
            semanticRevision: current.semanticRevision +
                (semanticSessionContentChanged(current, proposed) ? 1 : 0),
            lifecycleRevision: current.lifecycleRevision + 1,
        });
        assertMonotonicSessionTransition(current, next);
        writePrivateCanonicalJsonAtomic(paths, investigationSessionPath(paths, investigationId), next, sessionUnsafe);
        return readInvestigationSession(paths, investigationId);
    }, 'INVESTIGATION_SESSION_OPERATION_CONFLICT', sessionLockInvalid);
}
export function createCurrentInvestigationRef(paths, changeId, investigationId) {
    const ref = {
        schemaVersion: 1,
        changeId: assertChangeId(changeId),
        investigationId: assertInvestigationId(investigationId),
    };
    createPrivateCanonicalJson(paths, currentInvestigationRefPath(paths, ref.changeId), ref, refUnsafe, 'CURRENT_INVESTIGATION_CONFLICT');
}
export function readCurrentInvestigationRef(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const refPath = currentInvestigationRefPath(paths, changeId);
    if (!privatePathExists(paths, refPath, refUnsafe)) {
        return null;
    }
    const value = readPrivateCanonicalJson(paths, refPath, refUnsafe);
    if (!isRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'changeId', 'investigationId']) ||
        value.schemaVersion !== 1 ||
        value.changeId !== changeId ||
        typeof value.investigationId !== 'string') {
        throw refUnsafe();
    }
    assertInvestigationId(value.investigationId);
    return deepFreeze(value);
}
export function compareAndSwapCurrentInvestigationRef(paths, requestedChangeId, expectedInvestigationId, nextInvestigationId) {
    const changeId = assertChangeId(requestedChangeId);
    if (expectedInvestigationId !== null) {
        assertInvestigationId(expectedInvestigationId);
    }
    if (nextInvestigationId !== null) {
        assertInvestigationId(nextInvestigationId);
        const next = readInvestigationSession(paths, nextInvestigationId);
        if (next.changeId !== changeId) {
            throw workflowError('CURRENT_INVESTIGATION_REPAIR_INVALID', 'A replacement current investigation must belong to the same change.', ExitCode.guard);
        }
    }
    withPrivateRuntimeLock(paths, path.join(paths.locks, `${changeId}.current-investigation.lock`), () => {
        const observed = readCurrentInvestigationRef(paths, changeId);
        if ((observed?.investigationId ?? null) !==
            (expectedInvestigationId ?? null)) {
            throw workflowError('CURRENT_INVESTIGATION_REF_STALE', 'The current investigation ref no longer matches the authorized state.', ExitCode.staleState);
        }
        const refPath = currentInvestigationRefPath(paths, changeId);
        if (nextInvestigationId === null) {
            if (observed !== null) {
                fs.unlinkSync(refPath);
                fsyncDirectory(path.dirname(refPath));
            }
            return;
        }
        writePrivateCanonicalJsonAtomic(paths, refPath, {
            schemaVersion: 1,
            changeId,
            investigationId: nextInvestigationId,
        }, refUnsafe);
    }, 'CURRENT_INVESTIGATION_OPERATION_CONFLICT', refUnsafe);
}
