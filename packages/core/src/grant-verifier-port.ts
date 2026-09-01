/**
 * Verify one exact, caller-selected signature namespace without exposing
 * signing, signer selection, or human-presence authority to validation paths.
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
