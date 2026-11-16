/**
 * Exposes reviewed built-in provider families and checks requested
 * capability profiles.
 *
 * Invariants:
 * - Capability lookup requires a registered provider and an exact
 *   purpose/profile pair.
 */
import { isBuiltInProviderFamily, listBuiltInProviderCapabilityDescriptors, listBuiltInProviderFamilies, } from '@jigwright/core/built-in-provider-catalog';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
const BUILT_IN_PROVIDERS = Object.freeze(listBuiltInProviderCapabilityDescriptors().map(({ providerFamily: id, capabilities }) => Object.freeze({
    id,
    capabilities,
})));
/**
 * Return the deeply frozen built-in provider registry. The same immutable
 * value is returned on every call, so no caller can mutate the shared registry.
 */
/**
 * The reviewed provider identities in stable preference order. Callers build
 * per-provider candidates from this instead of repeating the identities.
 */
export function listProviderIds() {
    return listBuiltInProviderFamilies();
}
export function listBuiltInProviders() {
    return BUILT_IN_PROVIDERS;
}
/**
 * Resolve a built-in provider that supports the requested capability under the
 * requested profile. Throws `PROVIDER_UNKNOWN` for an unregistered ID and
 * `PROVIDER_CAPABILITY_UNSUPPORTED` when the provider does not declare the
 * requested purpose/profile pair.
 */
export function requireProviderCapability(id, purpose, profile) {
    const provider = BUILT_IN_PROVIDERS.find((entry) => entry.id === id);
    if (!provider) {
        throw workflowError('PROVIDER_UNKNOWN', `Provider "${id}" is not in the reviewed built-in registry.`, ExitCode.guard);
    }
    const capable = provider.capabilities.some((capability) => capability.purpose === purpose && capability.profile === profile);
    if (!capable) {
        throw workflowError('PROVIDER_CAPABILITY_UNSUPPORTED', `Provider "${id}" does not support ${purpose} under ${profile}.`, ExitCode.guard);
    }
    return provider;
}
export function isProviderId(value) {
    return isBuiltInProviderFamily(value);
}
