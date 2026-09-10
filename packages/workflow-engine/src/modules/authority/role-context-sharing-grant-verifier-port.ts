/**
 * Seals and checks live and consumed-replay role-context-sharing verifier
 * capabilities.
 *
 * Invariants:
 * - A value is treated as the authoritative verifier only if it is present
 *   in the module-private WeakSet populated by
 *   sealAuthoritativeRoleContextSharingGrantVerifier.
 * - The sealed consumed-replay verifier is a frozen {kind,
 *   trustedSignersDigest} record whose backing GrantVerifierPort is held in
 *   a module-private WeakMap.
 */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  CurrentGrantVerifierPort,
  GrantVerifierPort,
} from './grant-verifier-port.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const authoritativeRoleContextSharingGrantVerifiers = new WeakSet<object>();
const consumedRoleContextSharingGrantReplayVerifiers = new WeakMap<
  object,
  GrantVerifierPort
>();

export type AuthoritativeRoleContextSharingGrantVerifier =
  CurrentGrantVerifierPort &
    Readonly<{
      compositionDigest: `sha256:${string}`;
    }>;

/**
 * A terminal-only verifier purpose for one already-consumed R-007 record. It
 * intentionally exposes neither `verify` nor `assertCurrent`, so it cannot be
 * substituted for live reserve/consume authority.
 */
export type ConsumedRoleContextSharingGrantReplayVerifier = Readonly<{
  kind: 'role-context-sharing-consumed-replay-verifier.v1';
  trustedSignersDigest: string;
}>;

/**
 * Seal the distinct R-007 verifier authority. A Collaboration Grant verifier
 * is deliberately not interchangeable with this capability even when both
 * ultimately verify SSH signatures through the same protected composition.
 */
export function sealAuthoritativeRoleContextSharingGrantVerifier(
  verifier: CurrentGrantVerifierPort,
  compositionDigest: string,
): AuthoritativeRoleContextSharingGrantVerifier {
  if (
    typeof verifier?.verify !== 'function' ||
    typeof verifier?.assertCurrent !== 'function' ||
    !compositionDigest.startsWith('sha256:') ||
    !DIGEST.test(compositionDigest.slice('sha256:'.length))
  ) {
    throw authoritativeRoleContextSharingVerifierUnavailable();
  }
  const sealed = Object.freeze({
    compositionDigest: compositionDigest as `sha256:${string}`,
    assertCurrent(): void {
      verifier.assertCurrent();
    },
    verify(
      payload: string,
      signature: string,
      identity: string,
      namespace: string,
    ): void {
      verifier.verify(payload, signature, identity, namespace);
    },
  });
  authoritativeRoleContextSharingGrantVerifiers.add(sealed);
  return sealed;
}

export function assertAuthoritativeRoleContextSharingGrantVerifier(
  value: unknown,
): asserts value is AuthoritativeRoleContextSharingGrantVerifier {
  if (
    value === null ||
    typeof value !== 'object' ||
    !authoritativeRoleContextSharingGrantVerifiers.has(value)
  ) {
    throw authoritativeRoleContextSharingVerifierUnavailable();
  }
}

export function isAuthoritativeRoleContextSharingGrantVerifier(
  value: GrantVerifierPort,
): value is AuthoritativeRoleContextSharingGrantVerifier {
  return (
    value !== null &&
    typeof value === 'object' &&
    authoritativeRoleContextSharingGrantVerifiers.has(value)
  );
}

/** Composition-root-only constructor for historical terminal replay. */
export function sealConsumedRoleContextSharingGrantReplayVerifier(
  verifier: GrantVerifierPort,
  trustedSignersDigest: string,
): ConsumedRoleContextSharingGrantReplayVerifier {
  if (
    typeof verifier?.verify !== 'function' ||
    !DIGEST.test(trustedSignersDigest)
  ) {
    throw consumedRoleContextSharingReplayUnavailable();
  }
  const sealed = Object.freeze({
    kind: 'role-context-sharing-consumed-replay-verifier.v1' as const,
    trustedSignersDigest,
  });
  consumedRoleContextSharingGrantReplayVerifiers.set(sealed, verifier);
  return sealed;
}

export function assertConsumedRoleContextSharingGrantReplayVerifier(
  value: unknown,
): asserts value is ConsumedRoleContextSharingGrantReplayVerifier {
  if (
    value === null ||
    typeof value !== 'object' ||
    !consumedRoleContextSharingGrantReplayVerifiers.has(value)
  ) {
    throw consumedRoleContextSharingReplayUnavailable();
  }
}

export function verifyConsumedRoleContextSharingGrantReplaySignature(
  authority: ConsumedRoleContextSharingGrantReplayVerifier,
  payload: string,
  signature: string,
  identity: string,
  namespace: string,
): void {
  assertConsumedRoleContextSharingGrantReplayVerifier(authority);
  consumedRoleContextSharingGrantReplayVerifiers
    .get(authority)!
    .verify(payload, signature, identity, namespace);
}

function authoritativeRoleContextSharingVerifierUnavailable() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
    'The authoritative role-context-sharing Grant verifier composition is missing or stale.',
    ExitCode.guard,
    {
      recovery:
        'A human maintainer must authorize or repair the protected binding through authority-plan or sealed recovery; unsealed verifier fallback is disabled.',
    },
  );
}

function consumedRoleContextSharingReplayUnavailable() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_REPLAY_VERIFIER_UNAVAILABLE',
    'The consumed role-context-sharing Grant replay verifier is unavailable.',
    ExitCode.guard,
  );
}
