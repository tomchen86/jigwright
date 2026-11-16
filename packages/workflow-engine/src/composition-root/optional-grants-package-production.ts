/**
 * Exposes optional Grant availability and role-context-sharing envelope
 * encoding to production callers.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  assertOptionalGrantsPackageAvailable,
  canonicalRoleContextSharingGrantEnvelopeV1,
} from '../runtime/grants/optional-grants-package.ts';
