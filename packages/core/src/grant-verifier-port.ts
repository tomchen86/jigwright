/**
 * Declares signature verification and optional verifier-currentness
 * capabilities.
 *
 * Invariants:
 * - Every verification call requires the payload, signature, signer
 *   identity and explicit namespace.
 */
export type GrantVerifierPort = Readonly<{
  verify(
    payload: string,
    signature: string,
    identity: string,
    namespace: string,
  ): void;
}>;

/** A verifier that can also prove its protected composition is current. */
export type CurrentGrantVerifierPort = GrantVerifierPort &
  Readonly<{
    assertCurrent(): void;
  }>;
