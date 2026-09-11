/**
 * Declares the human-presence, identity, signing and verification port used
 * by maintainer operations.
 *
 * Invariants:
 * - The port declares four methods; signing and verification accept an
 *   optional signature namespace.
 */
export type MaintainerSignerProvider = {
  assertHumanPresent(): void;
  identity(): string;
  sign(payload: string, namespace?: string): string;
  verify(
    payload: string,
    signature: string,
    identity: string,
    namespace?: string,
  ): void;
};
