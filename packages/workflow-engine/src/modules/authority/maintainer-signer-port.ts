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

/** Verifies exact bytes against the selected pinned maintainer public key. */
export type MaintainerDataSignatureVerifier = (
  payload: string,
  signature: string,
  signer: import('./maintainer-policy.ts').TrustedMaintainerSigner,
  namespace: string,
  errorCode: string,
) => void;

/** Creates the canonical signer used by maintainer operations. */
export type MaintainerSignerFactory = (
  repositoryRoot: string,
  policy: import('./maintainer-policy.ts').MaintainerPolicy,
) => MaintainerSignerProvider;
