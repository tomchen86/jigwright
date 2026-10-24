/** Canonical mechanical-move and authority-remap request/result contracts. */
import type { PathRole } from '../source/path-role-registry.ts';
import type { FileRole } from './maintainer-manifest-contracts.ts';

export const PATH_ROLES_PATH = 'workflow/path-roles.json';

export const CHECKS_PATH = 'workflow/checks.json';

export const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';

export const MAINTAINER_PROFILES_PATH = 'workflow/maintainer-profiles.json';

export const REGENERATION_STEPS = [
  'built-in-engine-closure',
  'workflow-bootstrap-host',
  'harness-bootstrap-runtime',
  'protected-capabilities',
] as const;

export const PROFILE_PATH_FIELDS = [
  'implementationPaths',
  'evidencePaths',
  'policyPaths',
  'verificationInfrastructurePaths',
  'forbiddenPaths',
] as const;

export type ProfilePathField = (typeof PROFILE_PATH_FIELDS)[number];

export type AuthorityRemapRegenerationStep =
  (typeof REGENERATION_STEPS)[number];

export type AuthorityRemapPair = Readonly<{ from: string; to: string }>;

export type MechanicalMoveProof = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.mechanical-move-proof.v1';
  baseCommit: string;
  baseTree: string;
  moveCommit: string;
  moveTree: string;
  moves: readonly Readonly<{
    from: string;
    to: string;
    objectId: string;
    mode: '100644' | '100755';
  }>[];
  proofDigest: `sha256:${string}`;
}>;

export type AuthorityRemapPathRoleProjection = Readonly<{
  proof: MechanicalMoveProof;
  roles: readonly Readonly<{
    from: string;
    to: string;
    role: PathRole;
    beforePattern: string;
    afterPattern: string;
  }>[];
  mutation: Readonly<{
    path: typeof PATH_ROLES_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapCheckProjection = Readonly<{
  proof: MechanicalMoveProof;
  checks: readonly Readonly<{
    checkId: string;
    from: string;
    to: string;
  }>[];
  mutation: Readonly<{
    path: typeof CHECKS_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapGuardProjection = Readonly<{
  proof: MechanicalMoveProof;
  guards: readonly Readonly<{
    path: string;
    replacements: readonly Readonly<{
      taskId: string;
      from: string;
      to: string;
    }>[];
  }>[];
  mutations: readonly Readonly<{
    path: string;
    expectedBeforeSha256: string;
    content: string;
  }>[];
}>;

export type AuthorityRemapMaintainerPolicyProjection = Readonly<{
  proof: MechanicalMoveProof;
  paths: readonly Readonly<{
    field: 'bootstrapEligiblePaths' | 'sealedImmutablePaths';
    from: string;
    to: string;
  }>[];
  mutation: Readonly<{
    path: typeof MAINTAINER_POLICY_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapProfileProjection = Readonly<{
  proof: MechanicalMoveProof;
  profiles: readonly Readonly<{
    profileId: string;
    from: string;
    to: string;
    beforeRole: FileRole;
    afterRole: FileRole;
    changedFields: readonly ProfilePathField[];
  }>[];
  mutation: Readonly<{
    path: typeof MAINTAINER_PROFILES_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapRegenerationDescriptor = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.authority-remap-regeneration.v1';
  mechanicalProofDigest: `sha256:${string}`;
  moveTree: string;
  materializationCommit: string;
  materializationTree: string;
  affectedMoves: readonly Readonly<{ from: string; to: string }>[];
  steps: readonly AuthorityRemapRegenerationStep[];
  descriptorDigest: `sha256:${string}`;
}>;

export type AuthorityRemapManifestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.authority-remap-manifest.v1';
  baseCommit: string;
  baseTree: string;
  moveCommit: string;
  moveTree: string;
  materializationCommit: string;
  materializationTree: string;
  mechanicalProofDigest: `sha256:${string}`;
  moves: readonly Readonly<{
    from: string;
    to: string;
    objectId: string;
    mode: '100644' | '100755';
    role: Readonly<{
      name: PathRole;
      beforePattern: string;
      afterPattern: string;
    }>;
  }>[];
  projections: readonly Readonly<{
    path: string;
    beforeSha256: `sha256:${string}`;
    afterSha256: `sha256:${string}`;
  }>[];
  regenerationDescriptorDigest: `sha256:${string}` | null;
  authorityPlanIntentDigest: `sha256:${string}` | null;
  manifestDigest: `sha256:${string}`;
}>;

export type AuthorityRemapProjection =
  | Readonly<{
      status: 'ready';
      manifest: AuthorityRemapManifestV1;
      intent: AuthorityRemapPlanIntent | null;
      regeneration: null;
    }>
  | Readonly<{
      status: 'requires-regeneration';
      manifest: AuthorityRemapManifestV1;
      intent: null;
      regeneration: AuthorityRemapRegenerationDescriptor;
    }>;

export type AuthorityRemapPlanIntent = Readonly<{
  schemaVersion: 1;
  kind: 'authority-plan-intent.v1';
  changeId: string;
  taskId: string;
  profileId: string;
  reason: string;
  message: string;
  mutations: readonly AuthorityRemapMutation[];
  externalEffects: readonly [];
  evidenceWaivers: readonly [];
}>;

export type AuthorityRemapMutation = Readonly<{
  path: string;
  expectedBeforeSha256: string | null;
  content: string | null;
}>;

export type AuthorityRemapRequest = {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  materializationCommit?: string;
  renamePairs: readonly AuthorityRemapPair[];
  authorityPlan: Readonly<{
    changeId: string;
    taskId: string;
    profileId: string;
    reason: string;
    message: string;
  }>;
};
export type AuthorityRemapProjector = (
  request: AuthorityRemapRequest,
) => AuthorityRemapProjection;
