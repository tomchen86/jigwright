/** Shared, immutable built-in provider family and capability policy, independent of execution. */
export type BuiltInProviderFamily = 'codex' | 'claude';

const BUILT_IN_PROVIDER_FAMILIES: readonly BuiltInProviderFamily[] =
  Object.freeze(['codex', 'claude']);

/**
 * Return the code-owned built-in provider family identities in stable
 * preference order. Provider adapters and workflow policy consume these identities without
 * maintaining separate registries.
 */
export function listBuiltInProviderFamilies(): readonly BuiltInProviderFamily[] {
  return BUILT_IN_PROVIDER_FAMILIES;
}

export function isBuiltInProviderFamily(
  value: unknown,
): value is BuiltInProviderFamily {
  return BUILT_IN_PROVIDER_FAMILIES.some((family) => family === value);
}

export type BuiltInProviderCapabilityPurpose =
  'survey' | 'plan-review' | 'task-diff-review' | 'task-implementation';
export type BuiltInProviderCapabilityProfile = 'repository-read-only';
export type BuiltInProviderCapability = Readonly<{
  purpose: BuiltInProviderCapabilityPurpose;
  profile: BuiltInProviderCapabilityProfile;
}>;
export type BuiltInProviderCapabilityDescriptor = Readonly<{
  providerFamily: BuiltInProviderFamily;
  capabilities: readonly BuiltInProviderCapability[];
}>;

function repositoryReadOnlyCapabilities(): readonly BuiltInProviderCapability[] {
  return Object.freeze([
    Object.freeze({ purpose: 'survey', profile: 'repository-read-only' }),
    Object.freeze({
      purpose: 'plan-review',
      profile: 'repository-read-only',
    }),
    Object.freeze({
      purpose: 'task-implementation',
      profile: 'repository-read-only',
    }),
    Object.freeze({
      purpose: 'task-diff-review',
      profile: 'repository-read-only',
    }),
  ]);
}

const BUILT_IN_PROVIDER_CAPABILITY_DESCRIPTORS: readonly BuiltInProviderCapabilityDescriptor[] =
  Object.freeze(
    BUILT_IN_PROVIDER_FAMILIES.map((providerFamily) =>
      Object.freeze({
        providerFamily,
        capabilities: repositoryReadOnlyCapabilities(),
      }),
    ),
  );

/**
 * Return the reviewed role-purpose capability policy for every built-in
 * provider family. Repository role assignment may select from this policy but
 * cannot redefine it.
 */
export function listBuiltInProviderCapabilityDescriptors(): readonly BuiltInProviderCapabilityDescriptor[] {
  return BUILT_IN_PROVIDER_CAPABILITY_DESCRIPTORS;
}
