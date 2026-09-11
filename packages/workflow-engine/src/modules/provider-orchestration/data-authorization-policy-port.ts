/**
 * Exposes shared current data authorization policy types to provider
 * orchestration.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export type {
  DataAuthorizationLimits,
  DataAuthorizationPolicyPort,
  DataAuthorizationPolicyV4,
  DataAuthorizationProviderPolicy,
  DataAuthorizationProviderReservation,
  DataAuthorizationRetryAccounting,
  LoadedDataAuthorizationPolicyV4,
} from '@jigwright/core/data-authorization-policy-port';
