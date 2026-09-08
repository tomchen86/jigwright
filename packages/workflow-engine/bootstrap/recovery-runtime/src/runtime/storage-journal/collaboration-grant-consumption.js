import { withRepositoryLifecycleOperation } from "../session-workspace/repository-lifecycle-lock.js";
import { collaborationGrantStorePaths, assertExistingStoreReadOnlySafe, statePath, assertNonterminalUnambiguous, ensureStoreDirectories, createPrivateFileAtomic, existingStateDirectories, } from "./collaboration-grant-private-files.js";
import { assertCollaborationGrantId, verifyCollaborationGrantCapability, bindingFromPayload, collaborationGrantEnvelopeDigest, COLLABORATION_GRANT_AUTHORIZED_EFFECT, COLLABORATION_GRANT_RETAINED_OBLIGATIONS, COLLABORATION_GRANT_REPLAY_SCOPE, COLLABORATION_GRANT_RESIDUALS, } from "../../modules/authority/collaboration-grant-codec.js";
import fs from 'node:fs';
import { assertAuthoritativeCollaborationGrantVerifier, assertConsumedCollaborationGrantReplayVerifier, verifyConsumedCollaborationGrantReplaySignature, } from "../../modules/authority/grant-verifier-port.js";
import { executeGrantLifecycleTransitionV1, GRANT_LIFECYCLE_CONTRACT_VERSION_V1, } from "../../modules/authority/optional-grants-package.js";
import { exactDigest, unavailableGrant, exactDate, serialize, bindingMismatch, invalidUse, nonEmpty, } from "./collaboration-grant-store-values.js";
import { readTerminal, cleanupNonterminal, inspectTerminal, readReservation, assertResidualCopiesMatch, readAvailable, } from "./collaboration-grant-records.js";
import { consumptionMatches, assertGrantedAssignment, assertContentAdmission, assertDirectHumanAttestationReference, validateCollaborationGrantUseProjection, } from "./collaboration-grant-use-contract.js";
import { loadPolicyAtCommit, collaborationRoleTransitionDigest, exactRepositoryCommit, } from "./collaboration-grant-reservation.js";
import { discoverRepository } from "../repository-transaction/git.js";
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
const verifiedConsumedCollaborationGrantReplays = new WeakMap();
export function consumeCollaborationGrant(gitCommonDirectory, requestedGrantId, request) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => consumeCollaborationGrantUnderLifecycleLock(gitCommonDirectory, requestedGrantId, request, assertOwned));
}
export function consumeCollaborationGrantUnderLifecycleLock(gitCommonDirectory, requestedGrantId, request, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(request.transitionDigest, 'transition digest');
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    if (!assertExistingStoreReadOnlySafe(paths)) {
        throw unavailableGrant(grantId);
    }
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        if (terminal.state !== 'consumed' ||
            !terminal.use ||
            !consumptionMatches(terminal.use, request, transitionDigest)) {
            throw unavailableGrant(grantId);
        }
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        return inspectTerminal(terminal);
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservation = readReservation(statePath(paths.reserved, grantId), grantId);
    if (reservation.transitionDigest !== transitionDigest) {
        throw unavailableGrant(grantId);
    }
    const historicalPolicy = loadPolicyAtCommit(reservation.repositoryRoot, reservation.envelope.payload.baselineCommit);
    const verifier = request.verifier;
    assertAuthoritativeCollaborationGrantVerifier(verifier);
    verifier.assertCurrent();
    const transition = executeGrantLifecycleTransitionV1({
        contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId,
        transitionDigest,
        maxUses: reservation.envelope.payload.maxUses,
        event: {
            kind: 'consume',
            reason: 'Exact structured collaboration reference bound; governing validation remains required',
        },
        validationFailureReason: 'Exact role-result content admission failed',
        validate() {
            verifyCollaborationGrantCapability(reservation.envelope, historicalPolicy, {
                now: exactDate(request.now ?? new Date()),
                expected: bindingFromPayload(reservation.envelope.payload),
                verifier,
                allowExpired: true,
            });
            const assignment = assertGrantedAssignment(request.assignment, reservation.envelope);
            const contentAdmission = assertContentAdmission(request.contentAdmission, reservation.envelope.payload.lifecyclePhase);
            const structuredContent = {
                kind: contentAdmission.kind,
                nodeId: contentAdmission.nodeId,
                resultDigest: contentAdmission.resultDigest,
            };
            const directHumanReviewAttestation = assertDirectHumanAttestationReference(request.directHumanReviewAttestation ?? null, assignment, reservation.envelope, transitionDigest, structuredContent);
            const use = {
                schemaVersion: 1,
                grantId,
                signedEnvelopeDigest: collaborationGrantEnvelopeDigest(reservation.envelope),
                transitionDigest,
                reservedAt: reservation.reservedAt,
                lifecyclePhase: reservation.envelope.payload.lifecyclePhase,
                targetDigest: reservation.envelope.payload.targetDigest,
                degradedForm: reservation.envelope.payload.degradedForm,
                authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
                assignment,
                structuredContent,
                contentAuthority: 'reference-only-requires-governing-validator',
                directHumanReviewAttestation,
                retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
                replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
                residuals: COLLABORATION_GRANT_RESIDUALS,
                envelope: reservation.envelope,
            };
            return use;
        },
    }, {
        clock: { now: () => exactDate(request.now ?? new Date()) },
        storage: {
            readState: () => 'reserved',
            applyTransition(input) {
                let terminal;
                if (input.receipt.toState === 'failed') {
                    terminal = {
                        schemaVersion: 1,
                        state: 'failed',
                        grantId,
                        transitionDigest,
                        reason: input.receipt.reason,
                        recordedAt: input.receipt.occurredAt,
                        envelope: reservation.envelope,
                        use: null,
                    };
                }
                else if (input.receipt.toState === 'consumed' &&
                    input.validation !== undefined) {
                    terminal = {
                        schemaVersion: 1,
                        state: 'consumed',
                        grantId,
                        transitionDigest,
                        reason: input.receipt.reason,
                        recordedAt: input.receipt.occurredAt,
                        envelope: reservation.envelope,
                        use: input.validation,
                    };
                }
                else {
                    throw unavailableGrant(grantId);
                }
                assertOwned();
                ensureStoreDirectories(paths);
                assertOwned();
                createPrivateFileAtomic(terminalPath, serialize(terminal));
                cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
                assertOwned();
                return terminal;
            },
        },
    });
    return inspectTerminal(transition.value);
}
export function readExactConsumedCollaborationGrantUse(gitCommonDirectory, requestedGrantId, request) {
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(request.transitionDigest, 'transition digest');
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    existingStateDirectories(paths);
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        assertResidualCopiesMatch(paths, grantId, terminal.envelope, terminal.transitionDigest);
        if (terminal.state !== 'consumed' ||
            terminal.use === null ||
            !consumptionMatches(terminal.use, request, transitionDigest)) {
            throw unavailableGrant(grantId);
        }
        return terminal.use;
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservedPath = statePath(paths.reserved, grantId);
    if (fs.existsSync(reservedPath)) {
        const reservation = readReservation(reservedPath, grantId);
        if (reservation.transitionDigest !== transitionDigest) {
            throw unavailableGrant(grantId);
        }
        const assignment = assertGrantedAssignment(request.assignment, reservation.envelope);
        const contentAdmission = assertContentAdmission(request.contentAdmission, reservation.envelope.payload.lifecyclePhase);
        assertDirectHumanAttestationReference(request.directHumanReviewAttestation ?? null, assignment, reservation.envelope, transitionDigest, {
            kind: contentAdmission.kind,
            nodeId: contentAdmission.nodeId,
            resultDigest: contentAdmission.resultDigest,
        });
        return null;
    }
    const availablePath = statePath(paths.available, grantId);
    if (fs.existsSync(availablePath)) {
        readAvailable(availablePath, grantId);
    }
    return null;
}
/**
 * Authenticate one exact terminal `consumed` record for crash replay without
 * restoring live grant authority. The verifier is purpose-branded and cannot
 * be passed to reserve/consume; this function additionally binds the signed
 * envelope, assignment, content, optional direct-human attestation, and
 * independently derived historical transition before minting an ephemeral
 * proof. Reserved, available, and every other terminal state fail closed.
 */
export function verifyExactConsumedCollaborationGrantCrashReplay(cwd, requestedGrantId, request, options) {
    assertConsumedCollaborationGrantReplayVerifier(options.verifier);
    const repository = discoverRepository(cwd);
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(request.transitionDigest, 'transition digest');
    if (transitionDigest !==
        collaborationRoleTransitionDigest(options.expectedBinding)) {
        throw bindingMismatch();
    }
    const use = readExactConsumedCollaborationGrantUse(repository.gitCommonDirectory, grantId, request);
    if (use === null)
        throw unavailableGrant(grantId);
    const baselineCommit = exactRepositoryCommit(repository.repositoryRoot, options.expectedBinding.baselineCommit);
    if (use.envelope.payload.baselineCommit !== baselineCommit) {
        throw bindingMismatch();
    }
    const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
    const trustedSignersDigest = crypto
        .createHash('sha256')
        .update(canonicalJson(policy.trustedSigners))
        .digest('hex');
    if (options.verifier?.trustedSignersDigest !== trustedSignersDigest) {
        throw invalidUse();
    }
    const validated = validateCollaborationGrantUseProjection(use, {
        now: new Date(use.envelope.payload.expiresAt),
        expectedBinding: options.expectedBinding,
        policy,
        verifier: Object.freeze({
            verify(payload, signature, identity, namespace) {
                verifyConsumedCollaborationGrantReplaySignature(options.verifier, payload, signature, identity, namespace);
            },
        }),
        transitionDigest,
        expectedAssignment: request.assignment,
        contentAdmission: request.contentAdmission,
    });
    const proof = Object.freeze({
        schemaVersion: 1,
        kind: 'verified-consumed-collaboration-grant-replay.v1',
        grantId,
        transitionDigest,
        useDigest: crypto
            .createHash('sha256')
            .update(canonicalJson(validated))
            .digest('hex'),
    });
    verifiedConsumedCollaborationGrantReplays.set(proof, validated);
    return proof;
}
/** Role admission consumes only proofs minted by the exact terminal reader. */
export function consumedCollaborationGrantUseForReplay(proof) {
    const use = verifiedConsumedCollaborationGrantReplays.get(proof);
    if (use === undefined)
        throw invalidUse();
    return use;
}
export function failCollaborationReservation(gitCommonDirectory, requestedGrantId, requestedTransitionDigest, reason, now = new Date()) {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => failCollaborationReservationUnderLifecycleLock(gitCommonDirectory, requestedGrantId, requestedTransitionDigest, reason, now, assertOwned));
}
export function failCollaborationReservationUnderLifecycleLock(gitCommonDirectory, requestedGrantId, requestedTransitionDigest, reason, now, assertOwned) {
    assertOwned();
    const grantId = assertCollaborationGrantId(requestedGrantId);
    const transitionDigest = exactDigest(requestedTransitionDigest, 'transition digest');
    const terminalReason = nonEmpty(reason, 'failure reason');
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    ensureStoreDirectories(paths);
    assertOwned();
    const terminalPath = statePath(paths.terminal, grantId);
    if (fs.existsSync(terminalPath)) {
        const terminal = readTerminal(terminalPath, grantId);
        if (terminal.state !== 'failed' ||
            terminal.transitionDigest !== transitionDigest ||
            terminal.reason !== terminalReason) {
            throw unavailableGrant(grantId);
        }
        cleanupNonterminal(paths, grantId, terminal.envelope, terminal.transitionDigest);
        return inspectTerminal(terminal);
    }
    assertNonterminalUnambiguous(paths, grantId);
    const reservation = readReservation(statePath(paths.reserved, grantId), grantId);
    if (reservation.transitionDigest !== transitionDigest) {
        throw unavailableGrant(grantId);
    }
    const transition = executeGrantLifecycleTransitionV1({
        contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId,
        transitionDigest,
        maxUses: reservation.envelope.payload.maxUses,
        event: { kind: 'fail', reason: terminalReason },
    }, {
        clock: { now: () => exactDate(now) },
        storage: {
            readState: () => 'reserved',
            applyTransition(input) {
                if (input.receipt.toState !== 'failed') {
                    throw unavailableGrant(grantId);
                }
                const terminal = {
                    schemaVersion: 1,
                    state: 'failed',
                    grantId,
                    transitionDigest,
                    reason: input.receipt.reason,
                    recordedAt: input.receipt.occurredAt,
                    envelope: reservation.envelope,
                    use: null,
                };
                assertOwned();
                createPrivateFileAtomic(terminalPath, serialize(terminal));
                cleanupNonterminal(paths, grantId, reservation.envelope, transitionDigest);
                assertOwned();
                return terminal;
            },
        },
    });
    return inspectTerminal(transition.value);
}
