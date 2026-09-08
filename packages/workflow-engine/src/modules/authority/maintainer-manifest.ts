import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  listChangedPaths,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { normalizeExactRepositoryPath } from '../../runtime/session-workspace/paths.ts';
import {
  GIT_MODES,
  MANIFEST_SCHEMA,
  PROFILE_ID,
  assertNoDuplicatePaths,
  assertRoleRelationships,
  classifyFileRole,
  digestManifestBody,
  hasExactKeys,
  manifestError,
  parseCapabilityProfile,
  profileInvalid,
} from './maintainer-manifest-contracts.ts';
export {
  parseCapabilityProfile,
  classifyFileRole,
  canonicalPatchManifest,
  parsePatchManifest,
} from './maintainer-manifest-contracts.ts';

export type FileRole =
  | 'implementation'
  | 'evidence'
  | 'policy'
  | 'verification-infrastructure'
  | 'forbidden';

export type CheckDependency =
  | 'source-tree'
  | 'base-commit'
  | 'harness-engine'
  | 'policy'
  | 'runner'
  | 'external-state';

export type ProfileAuthorityClass =
  'ordinary' | 'root-one-shot' | 'control-plane';

export type PatchOperation = 'add' | 'modify' | 'delete';

export type CapabilityProfileConstraints = {
  evidenceOnlyGrantForbidden: boolean;
  samePackageRequired: boolean;
  evidenceAdditionsAllowed: boolean;
  maximumFiles: number;
};

export type CapabilityProfile = {
  id: string;
  version: number;
  authorityClass: ProfileAuthorityClass;
  implementationPaths: string[];
  evidencePaths: string[];
  policyPaths: string[];
  verificationInfrastructurePaths: string[];
  forbiddenPaths: string[];
  constraints: CapabilityProfileConstraints;
  requiredChecks: string[];
  checkDependencies: Record<string, CheckDependency[]>;
  externalStateFreshness?: Record<string, { maxAgeMs: number }>;
};

export type PatchManifestFile = {
  path: string;
  role: Exclude<FileRole, 'forbidden'>;
  operation: PatchOperation;
  beforeBlobOid: string | null;
  afterSha256: string | null;
  beforeMode: string | null;
  afterMode: string | null;
};

export type PatchManifest = {
  schema: typeof MANIFEST_SCHEMA;
  profile: string;
  profileVersion: number;
  trustBaseCommit: string;
  policyDigest: string;
  files: PatchManifestFile[];
  patchDigest: string;
};

export type PatchManifestRequest = {
  profile: CapabilityProfile;
  trustBaseCommit: string;
  policyDigest: string;
};

/**
 * Profiles are part of the trust base: they are read from the pinned commit,
 * never from the working tree, so a candidate patch can neither invent nor
 * relax the profile that judges it.
 */
export function loadCapabilityProfileFromTrustBase(
  repositoryRoot: string,
  trustBaseCommit: string,
  profileId: string,
): CapabilityProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${trustBaseCommit}:workflow/maintainer-profiles.json`,
      ]),
    );
  } catch {
    throw profileInvalid(
      'The trust base does not contain a valid workflow/maintainer-profiles.json.',
    );
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['schemaVersion', 'profiles']) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.profiles)
  ) {
    throw profileInvalid('Maintainer profiles file is malformed.');
  }
  const profiles = Object.fromEntries(
    Object.entries(parsed.profiles).map(([declaredId, raw]) => {
      if (!PROFILE_ID.test(declaredId)) {
        throw profileInvalid(
          'Maintainer profiles file contains an invalid ID.',
        );
      }
      const profile = parseCapabilityProfile(raw);
      if (profile.id !== declaredId) {
        throw profileInvalid(
          `Profile ${declaredId} declares a mismatched id ${profile.id}.`,
        );
      }
      return [declaredId, profile];
    }),
  );
  const profile = profiles[profileId];
  if (!profile) {
    throw profileInvalid(`Unknown capability profile ${profileId}.`);
  }
  return profile;
}

export function buildMaintainerPatchManifest(
  repositoryRoot: string,
  request: PatchManifestRequest,
): PatchManifest {
  const { profile, trustBaseCommit, policyDigest } = request;
  const changedPaths = listChangedPaths(repositoryRoot, trustBaseCommit);
  if (changedPaths.length === 0) {
    throw manifestError(
      'MAINTAINER_PATCH_EMPTY',
      'An exact-patch manifest requires at least one changed file.',
    );
  }
  if (changedPaths.length > profile.constraints.maximumFiles) {
    throw manifestError(
      'MAINTAINER_PATCH_TOO_LARGE',
      `Profile ${profile.id} admits at most ${profile.constraints.maximumFiles} files.`,
    );
  }

  const files = changedPaths
    .map((filePath) =>
      describeFile(repositoryRoot, profile, trustBaseCommit, filePath),
    )
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  assertNoDuplicatePaths(files);
  assertRoleRelationships(profile, files);

  const manifest: PatchManifest = {
    schema: MANIFEST_SCHEMA,
    profile: profile.id,
    profileVersion: profile.version,
    trustBaseCommit,
    policyDigest,
    files,
    patchDigest: '',
  };
  return { ...manifest, patchDigest: digestManifestBody(manifest) };
}

/**
 * Re-derives every identity in the manifest from the working tree and rejects
 * any difference: an extra changed file, a missing one, altered content, or a
 * changed mode. This is what makes the signature bind the patch rather than
 * the paths.
 */
export function verifyPatchManifestAgainstWorktree(
  repositoryRoot: string,
  manifest: PatchManifest,
): void {
  const observed = listChangedPaths(repositoryRoot, manifest.trustBaseCommit);
  const expected = manifest.files.map((file) => file.path);
  if (
    observed.length !== expected.length ||
    observed.some((filePath, index) => filePath !== expected[index])
  ) {
    throw manifestError(
      'MAINTAINER_PATCH_DRIFT',
      'The working tree changed set differs from the signed manifest.',
      { expected, observed },
    );
  }
  for (const file of manifest.files) {
    const current = describeFile(
      repositoryRoot,
      undefined,
      manifest.trustBaseCommit,
      file.path,
      file.role,
    );
    if (
      current.operation !== file.operation ||
      current.beforeBlobOid !== file.beforeBlobOid ||
      current.afterSha256 !== file.afterSha256 ||
      current.beforeMode !== file.beforeMode ||
      current.afterMode !== file.afterMode
    ) {
      throw manifestError(
        'MAINTAINER_PATCH_DRIFT',
        `File ${file.path} no longer matches its signed identity.`,
        { path: file.path },
      );
    }
  }
}

/**
 * Revalidates the signed manifest against only trust-base facts. This is the
 * admission check used by a clean authority worktree before the candidate is
 * materialized there; after materialization, verifyPatchManifestAgainstWorktree
 * additionally proves every after-byte and mode.
 */
export function validatePatchManifestAgainstProfile(
  repositoryRoot: string,
  manifest: PatchManifest,
  profile: CapabilityProfile,
): void {
  if (
    manifest.profile !== profile.id ||
    manifest.profileVersion !== profile.version ||
    manifest.files.length > profile.constraints.maximumFiles
  ) {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest does not match its capability profile.',
    );
  }
  for (const file of manifest.files) {
    if (
      file.role === 'evidence' &&
      (file.beforeMode === '100755' || file.afterMode === '100755')
    ) {
      throw manifestError(
        'MAINTAINER_PATH_UNSAFE',
        `Evidence ${file.path} must never be executable.`,
        { path: file.path },
      );
    }
    if (classifyFileRole(profile, file.path) !== file.role) {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        `File ${file.path} does not carry its trust-base role.`,
        { path: file.path },
      );
    }
    const before = readTrustBaseEntry(
      repositoryRoot,
      manifest.trustBaseCommit,
      file.path,
    );
    if (
      before?.oid !== (file.beforeBlobOid ?? undefined) ||
      before?.mode !== (file.beforeMode ?? undefined)
    ) {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        `File ${file.path} no longer matches the trust base.`,
        { path: file.path },
      );
    }
  }
  assertRoleRelationships(profile, manifest.files);
}

function describeFile(
  repositoryRoot: string,
  profile: CapabilityProfile | undefined,
  trustBaseCommit: string,
  filePath: string,
  knownRole?: PatchManifestFile['role'],
): PatchManifestFile {
  const normalized = normalizeExactRepositoryPath(filePath);
  const role = knownRole ?? classifyRoleForManifest(profile, normalized);
  const before = readTrustBaseEntry(
    repositoryRoot,
    trustBaseCommit,
    normalized,
  );
  const after = readWorktreeEntry(repositoryRoot, normalized);

  if (!before && !after) {
    throw manifestError(
      'MAINTAINER_PATCH_DRIFT',
      `File ${normalized} exists in neither the trust base nor the working tree.`,
    );
  }
  if (
    role === 'evidence' &&
    (before?.mode === '100755' || after?.mode === '100755')
  ) {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `Evidence ${normalized} must never be executable.`,
      { path: normalized },
    );
  }
  const operation: PatchOperation = !before
    ? 'add'
    : !after
      ? 'delete'
      : 'modify';
  return {
    path: normalized,
    role,
    operation,
    beforeBlobOid: before?.oid ?? null,
    afterSha256: after?.sha256 ?? null,
    beforeMode: before?.mode ?? null,
    afterMode: after?.mode ?? null,
  };
}

function classifyRoleForManifest(
  profile: CapabilityProfile | undefined,
  filePath: string,
): PatchManifestFile['role'] {
  if (!profile) {
    throw manifestError(
      'MAINTAINER_PATH_UNCLASSIFIED',
      `File ${filePath} has no verified role.`,
    );
  }
  const role = classifyFileRole(profile, filePath);
  if (role === undefined) {
    throw manifestError(
      'MAINTAINER_PATH_UNCLASSIFIED',
      `File ${filePath} is outside every root of profile ${profile.id}.`,
      { path: filePath },
    );
  }
  if (role === 'forbidden') {
    throw manifestError(
      'MAINTAINER_PATH_FORBIDDEN',
      `File ${filePath} is forbidden by profile ${profile.id}.`,
      { path: filePath },
    );
  }
  return role;
}

function readTrustBaseEntry(
  repositoryRoot: string,
  trustBaseCommit: string,
  filePath: string,
): { oid: string; mode: string } | undefined {
  const output = runGit(
    repositoryRoot,
    ['ls-tree', '-z', trustBaseCommit, '--', filePath],
    true,
  );
  const entry = output.split('\0').filter(Boolean)[0];
  if (!entry) {
    return undefined;
  }
  const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64})\t/.exec(entry);
  if (!match || match[2] !== 'blob' || !GIT_MODES.has(match[1]!)) {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `File ${filePath} is not a plain tracked file in the trust base.`,
      { path: filePath },
    );
  }
  return { oid: match[3]!, mode: match[1]! };
}

function readWorktreeEntry(
  repositoryRoot: string,
  filePath: string,
): { sha256: string; mode: string } | undefined {
  const absolute = path.join(repositoryRoot, filePath);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stats) {
    return undefined;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `File ${filePath} must be a regular non-symlink file.`,
      { path: filePath },
    );
  }
  const mode = (stats.mode & 0o111) === 0 ? '100644' : '100755';
  if (mode !== '100644') {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `File ${filePath} must not be executable.`,
      { path: filePath },
    );
  }
  return {
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(absolute))
      .digest('hex'),
    mode,
  };
}
