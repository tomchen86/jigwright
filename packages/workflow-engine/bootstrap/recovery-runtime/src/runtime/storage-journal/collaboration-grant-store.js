/**
 * Revokes collaboration grants through exact human authorization and durable terminal records.
 *
 * Invariants:
 * - Revocation retains historical repository-policy, task-mandate, and authorization bindings.
 * - Terminal publication precedes nonterminal cleanup and exact replay preserves its tombstone.
 *
 * Depends on: collaboration reservation records, private files, human revocation, and authority audit.
 * Failure modes: unbound revocation, divergent terminal state, or loss of the durable authorization trail.
 */
import { authorizeHumanRevocation, digestHumanRevocationSubject, canonicalHumanRevocationAuthorization, } from "../../application/control-plane/human-revocation.js";
import { discoverRepository, runGit } from "../repository-transaction/git.js";
import { assertCollaborationGrantId, canonicalCollaborationGrantEnvelope, validateCollaborationGrantPayload, parseCollaborationGrantEnvelope, } from "../../modules/authority/collaboration-grant-codec.js";
import { withRepositoryLifecycleOperation } from "../session-workspace/repository-lifecycle-lock.js";
import { deriveAuthorityAuditRepositoryId } from "./authority-audit-ledger.js";
import { inspectTaskMandate } from "../../modules/authority/task-mandate.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import path from 'node:path';
import { collaborationGrantStorePaths, ensureStoreDirectories, statePath, assertNonterminalUnambiguous, createPrivateFileAtomic, } from "./collaboration-grant-private-files.js";
import { exactDate, grantNotFound, ambiguousGrant, serialize, } from "./collaboration-grant-store-values.js";
import { loadPolicyAtCommit } from "./collaboration-grant-reservation.js";
import { assertHumanRevocationAuthorization, } from "../../modules/authority/human-revocation-contract.js";
import fs from 'node:fs';
import { readTerminal, readAvailable, readReservationOrInterrupted, inspectTerminal, cleanupNonterminal, } from "./collaboration-grant-records.js";
import { executeGrantLifecycleTransitionV1, GRANT_LIFECYCLE_CONTRACT_VERSION_V1, } from "../../modules/authority/optional-grants-package.js";
export { consumeCollaborationGrant, consumeCollaborationGrantUnderLifecycleLock, readExactConsumedCollaborationGrantUse, verifyExactConsumedCollaborationGrantCrashReplay, consumedCollaborationGrantUseForReplay, failCollaborationReservation, failCollaborationReservationUnderLifecycleLock, } from "./collaboration-grant-consumption.js";
export { collaborationGrantStorePaths } from "./collaboration-grant-private-files.js";
export { storeAvailableCollaborationGrant, storeAvailableCollaborationGrantUnderLifecycleLock, reserveCollaborationGrant, reserveCollaborationGrantUnderLifecycleLock, selectAndReserveCollaborationGrantUnderLifecycleLock, readReservedCollaborationGrant, readReservedCollaborationGrantUnderLifecycleLock, } from "./collaboration-grant-reservation.js";
export { validateCollaborationGrantUseProjection, validateCollaborationGrantUseSet, } from "./collaboration-grant-use-contract.js";
export { inspectCollaborationGrants, readCollaborationGrantInspection, listCollaborationGrantInspections, inspectCollaborationGrantsUnderLifecycleLock, } from "./collaboration-grant-records.js";
export function revokeCollaborationGrant(cwd, requestedGrantId, options) {
    const repository = discoverRepository(cwd);
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        assertOwned();
        const target = readCollaborationRevocationTarget(paths, grantId, assertOwned);
        const payload = target.envelope.payload;
        assertIndependentHumanRevocationTarget(repository.repositoryRoot, target.envelope, exactDate(options.now ?? new Date()));
        let audit = null;
        if (payload.taskId !== null) {
            const mandate = inspectTaskMandate(repository.repositoryRoot, payload.taskId, {
                now: options.now,
                signer: options.verifier ?? options.signer,
            });
            if (mandate.changeId !== payload.changeId) {
                throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Collaboration revocation task mandate binding is unavailable or different.', ExitCode.guard);
            }
            audit = {
                externalAuditRoot: mandate.externalAuditRoot,
                repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
            };
        }
        const authorization = authorizeHumanRevocation(repository.repositoryRoot, {
            subjectKind: 'collaboration-grant',
            grantId,
            grantDigest: digestHumanRevocationSubject(canonicalCollaborationGrantEnvelope(target.envelope)),
            repositoryId: payload.repositoryId,
            repositoryOrigin: payload.repositoryOrigin,
            changeId: payload.changeId,
            taskId: payload.taskId,
            workflowId: null,
            audit,
        }, options, path.join(paths.revocationAuthorizations, `${grantId}.json`), target.authorization);
        return terminallyRevokeCollaborationGrant(paths, target, authorization, assertOwned);
    });
}
/**
 * Validate the exact local revocation subject without consulting the
 * Collaboration verifier composition. This path can only remove authority:
 * authorizeHumanRevocation below still requires a separate interactive human
 * signature over the canonical envelope digest. Keeping this check independent
 * prevents verifier drift from locking maintainers out of terminal cleanup.
 */
function assertIndependentHumanRevocationTarget(repositoryRoot, envelope, now) {
    const payload = envelope.payload;
    const baselineCommit = runGit(repositoryRoot, [
        'rev-parse',
        `${payload.baselineCommit}^{commit}`,
    ]).trim();
    const baselineTree = runGit(repositoryRoot, [
        'rev-parse',
        `${baselineCommit}^{tree}`,
    ]).trim();
    const policyBlob = runGit(repositoryRoot, [
        'rev-parse',
        `${baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
    const policy = loadPolicyAtCommit(repositoryRoot, baselineCommit);
    if (baselineCommit !== payload.baselineCommit ||
        baselineTree !== payload.baselineTree ||
        policyBlob !== payload.policyBlob ||
        payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        origin !== policy.repository.origin) {
        throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Collaboration revocation target no longer matches its historical repository policy.', ExitCode.guard);
    }
    validateCollaborationGrantPayload(payload, policy, {
        now,
        expectedPolicyBlob: policyBlob,
        allowExpired: true,
    });
    parseCollaborationGrantEnvelope(canonicalCollaborationGrantEnvelope(envelope));
}
function readCollaborationRevocationTarget(paths, grantId, assertOwned) {
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        return {
            state: terminal.state,
            envelope: terminal.envelope,
            transitionDigest: terminal.transitionDigest,
            reason: terminal.reason,
            authorization: terminal.revocationAuthorization ?? null,
        };
    }
    assertNonterminalUnambiguous(paths, grantId);
    const availablePath = statePath(paths.available, grantId);
    const reservedPath = statePath(paths.reserved, grantId);
    const available = fs.existsSync(availablePath)
        ? readAvailable(availablePath, grantId)
        : undefined;
    const reservation = fs.existsSync(reservedPath)
        ? readReservationOrInterrupted(reservedPath, grantId)
        : undefined;
    if (!available && !reservation)
        throw grantNotFound(grantId);
    const envelope = available ?? reservation?.envelope;
    if (!envelope ||
        (available &&
            reservation &&
            canonicalCollaborationGrantEnvelope(available) !==
                canonicalCollaborationGrantEnvelope(reservation.envelope))) {
        throw ambiguousGrant(grantId);
    }
    return {
        state: reservation ? 'reserved' : 'available',
        envelope,
        transitionDigest: reservation?.transitionDigest ?? null,
        reason: null,
        authorization: null,
    };
}
function terminallyRevokeCollaborationGrant(paths, target, rawAuthorization, assertOwned) {
    const authorization = assertHumanRevocationAuthorization(rawAuthorization);
    const grantId = target.envelope.payload.grantId;
    if (authorization.payload.subjectKind !== 'collaboration-grant' ||
        authorization.payload.grantId !== grantId) {
        throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Collaboration revocation authorization is bound elsewhere.', ExitCode.conflict);
    }
    if (target.state === 'revoked') {
        if (target.reason !== authorization.payload.reason ||
            target.authorization === null ||
            canonicalHumanRevocationAuthorization(target.authorization) !==
                canonicalHumanRevocationAuthorization(authorization)) {
            throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Collaboration grant already has a different revocation tombstone.', ExitCode.conflict);
        }
        return inspectTerminal(readTerminal(statePath(paths.terminal, grantId), grantId));
    }
    if (target.state !== 'available' && target.state !== 'reserved') {
        throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Only active collaboration authority can be revoked.', ExitCode.guard);
    }
    const transition = executeGrantLifecycleTransitionV1({
        contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId,
        transitionDigest: target.transitionDigest,
        maxUses: target.envelope.payload.maxUses,
        event: { kind: 'revoke', reason: authorization.payload.reason },
    }, {
        clock: {
            now: () => exactDate(new Date(authorization.payload.revokedAt)),
        },
        storage: {
            readState: () => target.state,
            applyTransition(input) {
                if (input.receipt.toState !== 'revoked') {
                    throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Only active collaboration authority can be revoked.', ExitCode.guard);
                }
                const terminal = {
                    schemaVersion: 1,
                    state: 'revoked',
                    grantId,
                    transitionDigest: target.transitionDigest,
                    reason: input.receipt.reason,
                    recordedAt: input.receipt.occurredAt,
                    envelope: target.envelope,
                    use: null,
                    revocationAuthorization: authorization,
                };
                assertOwned();
                createPrivateFileAtomic(statePath(paths.terminal, grantId), serialize(terminal));
                cleanupNonterminal(paths, grantId, target.envelope, target.transitionDigest);
                assertOwned();
                return terminal;
            },
        },
    });
    return inspectTerminal(transition.value);
}
