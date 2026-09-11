/**
 * Exposes reviewed built-in provider families and checks requested
 * capability profiles.
 *
 * Invariants:
 * - Capability lookup requires a registered provider and an exact
 *   purpose/profile pair.
 */
import {
  isBuiltInProviderFamily,
  listBuiltInProviderCapabilityDescriptors,
  type BuiltInProviderCapability,
  type BuiltInProviderCapabilityProfile,
  type BuiltInProviderCapabilityPurpose,
  type BuiltInProviderFamily,
} from '@jigwright/core/built-in-provider-catalog';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

/**
 * The reviewed built-in provider capability facade. The shared core catalog owns the
 * exact family identities; repository policy may enable/disable those fixed
 * identities and lower bounded limits, but it can never add an ID, executable
 * path, argv, shell fragment, module path, prompt, or result parser. This slice
 * attaches the `survey`, `plan-review`, `task-diff-review`, and
 * `task-implementation` capabilities under the `repository-read-only` profile.
 */
export type ProviderId = BuiltInProviderFamily;
export type CapabilityPurpose = BuiltInProviderCapabilityPurpose;
export type CapabilityProfile = BuiltInProviderCapabilityProfile;
export type ProviderCapability = BuiltInProviderCapability;

export type BuiltInProvider = {
  readonly id: ProviderId;
  readonly capabilities: readonly ProviderCapability[];
};

const BUILT_IN_PROVIDERS: readonly BuiltInProvider[] = Object.freeze(
  listBuiltInProviderCapabilityDescriptors().map(
    ({ providerFamily: id, capabilities }) =>
      Object.freeze({
        id,
        capabilities,
      }),
  ),
);

/**
 * Return the deeply frozen built-in provider registry. The same immutable
 * value is returned on every call, so no caller can mutate the shared registry.
 */
export function listBuiltInProviders(): readonly BuiltInProvider[] {
  return BUILT_IN_PROVIDERS;
}

/**
 * Resolve a built-in provider that supports the requested capability under the
 * requested profile. Throws `PROVIDER_UNKNOWN` for an unregistered ID and
 * `PROVIDER_CAPABILITY_UNSUPPORTED` when the provider does not declare the
 * requested purpose/profile pair.
 */
export function requireProviderCapability(
  id: ProviderId,
  purpose: CapabilityPurpose,
  profile: CapabilityProfile,
): BuiltInProvider {
  const provider = BUILT_IN_PROVIDERS.find((entry) => entry.id === id);
  if (!provider) {
    throw workflowError(
      'PROVIDER_UNKNOWN',
      `Provider "${id}" is not in the reviewed built-in registry.`,
      ExitCode.guard,
    );
  }
  const capable = provider.capabilities.some(
    (capability) =>
      capability.purpose === purpose && capability.profile === profile,
  );
  if (!capable) {
    throw workflowError(
      'PROVIDER_CAPABILITY_UNSUPPORTED',
      `Provider "${id}" does not support ${purpose} under ${profile}.`,
      ExitCode.guard,
    );
  }
  return provider;
}

export function isProviderId(value: unknown): value is ProviderId {
  return isBuiltInProviderFamily(value);
}
