import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
const DIGEST = /^[0-9a-f]{64}$/;
const authoritativeRoleContextSharingGrantVerifiers = new WeakSet();
const consumedRoleContextSharingGrantReplayVerifiers = new WeakMap();
/**
 * Seal the distinct R-007 verifier authority. A Collaboration Grant verifier
 * is deliberately not interchangeable with this capability even when both
 * ultimately verify SSH signatures through the same protected composition.
 */
export function sealAuthoritativeRoleContextSharingGrantVerifier(verifier, compositionDigest) {
    if (typeof verifier?.verify !== 'function' ||
        typeof verifier?.assertCurrent !== 'function' ||
        !compositionDigest.startsWith('sha256:') ||
        !DIGEST.test(compositionDigest.slice('sha256:'.length))) {
        throw authoritativeRoleContextSharingVerifierUnavailable();
    }
    const sealed = Object.freeze({
        compositionDigest: compositionDigest,
        assertCurrent() {
            verifier.assertCurrent();
        },
        verify(payload, signature, identity, namespace) {
            verifier.verify(payload, signature, identity, namespace);
        },
    });
    authoritativeRoleContextSharingGrantVerifiers.add(sealed);
    return sealed;
}
export function assertAuthoritativeRoleContextSharingGrantVerifier(value) {
    if (value === null ||
        typeof value !== 'object' ||
        !authoritativeRoleContextSharingGrantVerifiers.has(value)) {
        throw authoritativeRoleContextSharingVerifierUnavailable();
    }
}
export function isAuthoritativeRoleContextSharingGrantVerifier(value) {
    return (value !== null &&
        typeof value === 'object' &&
        authoritativeRoleContextSharingGrantVerifiers.has(value));
}
/** Composition-root-only constructor for historical terminal replay. */
export function sealConsumedRoleContextSharingGrantReplayVerifier(verifier, trustedSignersDigest) {
    if (typeof verifier?.verify !== 'function' ||
        !DIGEST.test(trustedSignersDigest)) {
        throw consumedRoleContextSharingReplayUnavailable();
    }
    const sealed = Object.freeze({
        kind: 'role-context-sharing-consumed-replay-verifier.v1',
        trustedSignersDigest,
    });
    consumedRoleContextSharingGrantReplayVerifiers.set(sealed, verifier);
    return sealed;
}
export function assertConsumedRoleContextSharingGrantReplayVerifier(value) {
    if (value === null ||
        typeof value !== 'object' ||
        !consumedRoleContextSharingGrantReplayVerifiers.has(value)) {
        throw consumedRoleContextSharingReplayUnavailable();
    }
}
export function verifyConsumedRoleContextSharingGrantReplaySignature(authority, payload, signature, identity, namespace) {
    assertConsumedRoleContextSharingGrantReplayVerifier(authority);
    consumedRoleContextSharingGrantReplayVerifiers
        .get(authority)
        .verify(payload, signature, identity, namespace);
}
function authoritativeRoleContextSharingVerifierUnavailable() {
    return workflowError('ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE', 'The authoritative role-context-sharing Grant verifier composition is missing or stale.', ExitCode.guard, {
        recovery: 'A human maintainer must authorize or repair the protected binding through authority-plan or sealed recovery; unsealed verifier fallback is disabled.',
    });
}
function consumedRoleContextSharingReplayUnavailable() {
    return workflowError('ROLE_CONTEXT_SHARING_GRANT_REPLAY_VERIFIER_UNAVAILABLE', 'The consumed role-context-sharing Grant replay verifier is unavailable.', ExitCode.guard);
}
