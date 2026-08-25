/**
 * Authority-owned signing contract. Concrete key discovery and SSH execution
 * remain adapter concerns; authority and application code depend only on this
 * port.
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
