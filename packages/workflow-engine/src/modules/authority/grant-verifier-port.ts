import type {
  CurrentGrantVerifierPort,
  GrantVerifierPort,
} from '@jigwright/core/grant-verifier-port';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type {
  CurrentGrantVerifierPort,
  GrantVerifierPort,
} from '@jigwright/core/grant-verifier-port';

const DIGEST = /^[0-9a-f]{64}$/;
const authoritativeCollaborationGrantVerifiers = new WeakSet<object>();
const consumedCollaborationGrantReplayVerifiers = new WeakMap<
  object,
  GrantVerifierPort
>();

export type AuthoritativeCollaborationGrantVerifier = CurrentGrantVerifierPort &
  Readonly<{
    compositionDigest: `sha256:${string}`;
  }>;

/**
 * A deliberately non-verifier-shaped capability for authenticating one
 * already-consumed terminal record during exact crash replay. It has neither
 * `verify` nor `assertCurrent`, so it cannot be substituted for the protected
 * reserve/consume authority even structurally.
 */
export type ConsumedCollaborationGrantReplayVerifier = Readonly<{
  kind: 'collaboration-grant-consumed-replay-verifier.v1';
  trustedSignersDigest: string;
}>;

/**
 * Seal one verifier implementation for the protected Collaboration Grant
 * composition. Composition-root code owns construction; runtime consumers
 * accept only capabilities branded here, never a caller-supplied verify
 * callback.
 */
export function sealAuthoritativeCollaborationGrantVerifier(
  verifier: CurrentGrantVerifierPort,
  compositionDigest: string,
): AuthoritativeCollaborationGrantVerifier {
  if (
    typeof verifier?.verify !== 'function' ||
    typeof verifier?.assertCurrent !== 'function' ||
    !compositionDigest.startsWith('sha256:') ||
    !DIGEST.test(compositionDigest.slice('sha256:'.length))
  ) {
    throw authoritativeVerifierUnavailable();
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
  authoritativeCollaborationGrantVerifiers.add(sealed);
  return sealed;
}

export function assertAuthoritativeCollaborationGrantVerifier(
  value: unknown,
): asserts value is AuthoritativeCollaborationGrantVerifier {
  if (
    value === null ||
    typeof value !== 'object' ||
    !authoritativeCollaborationGrantVerifiers.has(value)
  ) {
    throw authoritativeVerifierUnavailable();
  }
}

/** Composition-root-only constructor; consumers receive an opaque purpose. */
export function sealConsumedCollaborationGrantReplayVerifier(
  verifier: GrantVerifierPort,
  trustedSignersDigest: string,
): ConsumedCollaborationGrantReplayVerifier {
  if (
    typeof verifier?.verify !== 'function' ||
    !DIGEST.test(trustedSignersDigest)
  ) {
    throw consumedReplayVerifierUnavailable();
  }
  const sealed = Object.freeze({
    kind: 'collaboration-grant-consumed-replay-verifier.v1' as const,
    trustedSignersDigest,
  });
  consumedCollaborationGrantReplayVerifiers.set(sealed, verifier);
  return sealed;
}

/**
 * Invoke the hidden verifier only from the terminal replay proof minter. The
 * opaque public capability itself cannot be passed to any live grant API.
 */
export function verifyConsumedCollaborationGrantReplaySignature(
  authority: ConsumedCollaborationGrantReplayVerifier,
  payload: string,
  signature: string,
  identity: string,
  namespace: string,
): void {
  assertConsumedCollaborationGrantReplayVerifier(authority);
  const verifier = consumedCollaborationGrantReplayVerifiers.get(authority)!;
  verifier.verify(payload, signature, identity, namespace);
}

export function assertConsumedCollaborationGrantReplayVerifier(
  value: unknown,
): asserts value is ConsumedCollaborationGrantReplayVerifier {
  if (
    value === null ||
    typeof value !== 'object' ||
    !consumedCollaborationGrantReplayVerifiers.has(value)
  ) {
    throw consumedReplayVerifierUnavailable();
  }
}

function authoritativeVerifierUnavailable() {
  return workflowError(
    'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
    'The authoritative Collaboration Grant verifier composition is missing or stale.',
    ExitCode.guard,
    {
      recovery:
        'A human maintainer must repair the protected manifest through authority-plan or sealed recovery; unsealed verifier fallback is disabled.',
    },
  );
}

function consumedReplayVerifierUnavailable() {
  return workflowError(
    'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
    'The terminal-only Collaboration Grant replay verifier is unavailable.',
    ExitCode.guard,
  );
}
