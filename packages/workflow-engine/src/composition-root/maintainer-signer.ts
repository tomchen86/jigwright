/**
 * Exposes the maintainer signer provider type at the composition boundary.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export type { MaintainerSignerProvider } from '../modules/authority/maintainer-signer-port.ts';
