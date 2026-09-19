/** Verify protected capability declarations against immutable Git objects. */
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  PROTECTED_CAPABILITY_MANIFEST_PATH,
  protectedCapabilityManifestInvalid,
  isRecord,
  hasExactKeys,
  REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES,
  isDigest,
  BUILT_IN_BOOTSTRAP_RUNTIME_PATHS,
  rawDigest,
  canonicalDigest,
} from './control-plane-bootstrap-values.ts';
import type {
  VerifiedProtectedCapabilityManifest,
  BootstrapProtectedTreeEntry,
  Sha256Digest,
} from './control-plane-bootstrap-types.ts';
import { readClosureFile } from './control-plane-bootstrap-files.ts';
import {
  exactBootstrapGitOutput,
  readBootstrapHeadTree,
  readBootstrapGitBlob,
} from './control-plane-bootstrap-provenance.ts';
import {
  sortedUniqueProtectedPaths,
  bootstrapEntryDigestsMatch,
  assertNoBootstrapCaseFoldAliases,
  matchesBootstrapProtectedPath,
  validGrantVerifierCompositionShape,
} from './control-plane-bootstrap-protected-records.ts';

export function verifiedProtectedCapabilityManifest(
  worktreeRoot: string,
  revision = 'HEAD',
  requireWorktreeMatch = true,
): VerifiedProtectedCapabilityManifest {
  const raw = exactBootstrapGitOutput(worktreeRoot, [
    'show',
    `${revision}:${PROTECTED_CAPABILITY_MANIFEST_PATH}`,
  ]);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw protectedCapabilityManifestInvalid();
  }
  if (!isRecord(value)) {
    throw protectedCapabilityManifestInvalid();
  }
  const manifestKeys = [
    'entries',
    'kind',
    'manifestPath',
    'schemaVersion',
    ...(Object.hasOwn(value, 'grantVerifierComposition')
      ? ['grantVerifierComposition']
      : []),
  ];
  if (
    !hasExactKeys(value, manifestKeys) ||
    value.kind !== 'protected-capability-manifest.v1' ||
    value.schemaVersion !== 1 ||
    value.manifestPath !== PROTECTED_CAPABILITY_MANIFEST_PATH ||
    !Array.isArray(value.entries) ||
    value.entries.length !== REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.length
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  const tree = readBootstrapHeadTree(worktreeRoot, revision);
  const capabilities: string[] = [];
  const declaredPaths: string[] = [];
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'capability',
        'closureDigest',
        'contentDigest',
        'dependencies',
        'entrypoints',
      ]) ||
      typeof entry.capability !== 'string' ||
      !Array.isArray(entry.entrypoints) ||
      entry.entrypoints.length === 0 ||
      !Array.isArray(entry.dependencies) ||
      !isDigest(entry.contentDigest) ||
      !isDigest(entry.closureDigest) ||
      !sortedUniqueProtectedPaths(entry.entrypoints, true) ||
      !sortedUniqueProtectedPaths(entry.dependencies, true) ||
      !bootstrapEntryDigestsMatch(tree, entry)
    ) {
      throw protectedCapabilityManifestInvalid();
    }
    capabilities.push(entry.capability);
    declaredPaths.push(...entry.entrypoints, ...entry.dependencies);
  }
  if (
    canonicalJson(capabilities) !==
    canonicalJson(REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES)
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  assertNoBootstrapCaseFoldAliases(declaredPaths);
  if (
    !declaredPaths.some((entry) =>
      matchesBootstrapProtectedPath(PROTECTED_CAPABILITY_MANIFEST_PATH, entry),
    ) ||
    !declaredPaths.some((entry) =>
      matchesBootstrapProtectedPath(
        'packages/workflow-engine/src/runtime/repository-validation/protected-capabilities.ts',
        entry,
      ),
    )
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  if (
    value.grantVerifierComposition !== undefined &&
    (!validGrantVerifierCompositionShape(
      value.grantVerifierComposition,
      value.entries,
    ) ||
      !bootstrapGrantVerifierCompositionSourcesMatch(
        worktreeRoot,
        revision,
        tree,
        value.grantVerifierComposition,
      ))
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  for (const requiredPath of BUILT_IN_BOOTSTRAP_RUNTIME_PATHS) {
    if (
      !declaredPaths.some((entry) =>
        matchesBootstrapProtectedPath(requiredPath, entry),
      )
    ) {
      throw protectedCapabilityManifestInvalid();
    }
  }
  const bootstrapRuntimeFiles = BUILT_IN_BOOTSTRAP_RUNTIME_PATHS.map(
    (filePath) => {
      const treeEntry = tree.find((entry) => entry.path === filePath);
      if (
        treeEntry?.type !== 'blob' ||
        (treeEntry.mode !== '100644' && treeEntry.mode !== '100755')
      ) {
        throw protectedCapabilityManifestInvalid();
      }
      const mode: '100644' | '100755' = treeEntry.mode;
      const bytes = readBootstrapGitBlob(worktreeRoot, revision, filePath);
      if (requireWorktreeMatch) {
        const worktreeBytes = readClosureFile(
          path.join(worktreeRoot, ...filePath.split('/')),
          mode === '100755' ? 0o755 : 0o644,
        );
        if (!worktreeBytes.equals(bytes)) {
          throw protectedCapabilityManifestInvalid();
        }
      }
      return {
        path: filePath.slice('packages/workflow-engine/'.length),
        mode,
        digest: rawDigest(bytes),
        bytes,
      };
    },
  );
  return {
    payload: value,
    manifestDigest: canonicalDigest(value),
    bootstrapRuntimeFiles,
  };
}

function bootstrapGrantVerifierCompositionSourcesMatch(
  worktreeRoot: string,
  revision: string,
  tree: BootstrapProtectedTreeEntry[],
  composition: Record<string, unknown>,
): boolean {
  const sourcePaths = composition.sourcePaths;
  if (!Array.isArray(sourcePaths)) return false;
  const files: Array<{ path: string; digest: Sha256Digest }> = [];
  let packageBytes: Buffer | undefined;
  for (const sourcePath of sourcePaths) {
    if (typeof sourcePath !== 'string') return false;
    const entry = tree.find(({ path: treePath }) => treePath === sourcePath);
    if (
      entry?.type !== 'blob' ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      return false;
    }
    let bytes: Buffer;
    try {
      bytes = readBootstrapGitBlob(worktreeRoot, revision, sourcePath);
    } catch {
      return false;
    }
    files.push({ path: sourcePath, digest: rawDigest(bytes) });
    if (sourcePath === composition.packageManifestPath) packageBytes = bytes;
  }
  if (packageBytes === undefined) return false;
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(packageBytes.toString('utf8')) as unknown;
  } catch {
    return false;
  }
  if (!(
    isRecord(packageValue) &&
    packageValue.name === composition.packageName &&
    packageValue.version === composition.packageVersion &&
    rawDigest(packageBytes) === composition.packageManifestDigest &&
    canonicalDigest({
      kind: 'collaboration-grant-verifier-source.v1',
      files,
    }) === composition.sourceDigest
  )) {
    return false;
  }
  const roleBinding = composition.roleContextSharingGrant;
  if (!isRecord(roleBinding) || !isRecord(packageValue.exports)) return false;
  if (
    packageValue.exports[roleBinding.packageExport as string] !==
    roleBinding.packageExportTarget
  ) {
    return false;
  }
  const roleSourcePaths = roleBinding.sourcePaths;
  if (!Array.isArray(roleSourcePaths)) return false;
  const roleFiles: Array<{ path: string; digest: Sha256Digest }> = [];
  for (const sourcePath of roleSourcePaths) {
    if (typeof sourcePath !== 'string') return false;
    const entry = tree.find(({ path: treePath }) => treePath === sourcePath);
    if (
      entry?.type !== 'blob' ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      return false;
    }
    let bytes: Buffer;
    try {
      bytes = readBootstrapGitBlob(worktreeRoot, revision, sourcePath);
    } catch {
      return false;
    }
    roleFiles.push({ path: sourcePath, digest: rawDigest(bytes) });
  }
  return (
    canonicalDigest({
      kind: 'role-context-sharing-grant-verifier-source.v1',
      files: roleFiles,
    }) === roleBinding.sourceDigest
  );
}
