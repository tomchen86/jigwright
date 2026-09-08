/** Pure protected capability manifest and composition binding validation. */
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  isRecord,
  hasExactKeys,
  sortedUniqueSafePaths,
  isDigest,
  canonicalDigest,
  PROTECTED_CAPABILITY_MANIFEST_PATH,
  protectedCapabilityManifestInvalid,
  safeClosurePath,
  REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES,
  sortedUniqueStrings,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapProtectedTreeEntry,
  BootstrapProtectedClosureIdentity,
} from './control-plane-bootstrap-types.ts';

export function validGrantVerifierCompositionShape(
  value: unknown,
  entries: unknown,
): value is Record<string, unknown> {
  const keys = [
    'applyJournalClosureDigest',
    'authorizationClosureDigest',
    'authorizedEffects',
    'collaborationPolicyDigest',
    'compositionDigest',
    'controlPlaneUpdateClosureDigest',
    'humanTrustRootsClosureDigest',
    'kind',
    'packageManifestDigest',
    'packageManifestPath',
    'packageName',
    'packageVersion',
    'readerContractVersion',
    'recoveryClosureDigest',
    'repairAuthority',
    'signatureNamespaces',
    'sourceDigest',
    'sourcePaths',
    'taskDiffReviewPolicyDigest',
    'verifierContractVersion',
    'verifierImplementation',
  ];
  const exactKeys = [...keys, 'roleContextSharingGrant'];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, exactKeys) ||
    value.kind !== 'collaboration-grant-verifier-composition.v1' ||
    value.packageName !== '@jigwright/grants' ||
    value.packageVersion !== '0.1.0' ||
    value.packageManifestPath !== 'packages/grants/package.json' ||
    value.verifierImplementation !== 'ssh-maintainer-policy.v1' ||
    value.verifierContractVersion !== 'jigwright.grant-envelope-verifier.v1' ||
    value.readerContractVersion !==
      'jigwright.collaboration-grant-envelope-reader.v1' ||
    !Array.isArray(value.signatureNamespaces) ||
    value.signatureNamespaces.length !== 1 ||
    value.signatureNamespaces[0] !== 'workflow.collaboration-grant.v2' ||
    !Array.isArray(value.authorizedEffects) ||
    value.authorizedEffects.length !== 1 ||
    value.authorizedEffects[0] !== 'role-independence-degradation-only' ||
    !sortedUniqueSafePaths(value.sourcePaths, false) ||
    !(value.sourcePaths as string[]).includes('packages/grants/package.json') ||
    !isDigest(value.packageManifestDigest) ||
    !isDigest(value.sourceDigest) ||
    !/^[0-9a-f]{64}$/.test(String(value.collaborationPolicyDigest)) ||
    !/^[0-9a-f]{64}$/.test(String(value.taskDiffReviewPolicyDigest)) ||
    !isDigest(value.authorizationClosureDigest) ||
    !isDigest(value.humanTrustRootsClosureDigest) ||
    !isDigest(value.applyJournalClosureDigest) ||
    !isDigest(value.controlPlaneUpdateClosureDigest) ||
    !isDigest(value.recoveryClosureDigest) ||
    value.repairAuthority !== 'human-only-authority-plan-or-sealed-recovery' ||
    !isDigest(value.compositionDigest) ||
    !Array.isArray(entries)
  ) {
    return false;
  }
  const closure = (capability: string): unknown => {
    const entry = entries.find(
      (entry) => isRecord(entry) && entry.capability === capability,
    );
    return isRecord(entry) ? entry.closureDigest : undefined;
  };
  const authorization = entries.find(
    (entry) => isRecord(entry) && entry.capability === 'authorization.verify',
  );
  if (
    !isRecord(authorization) ||
    !Array.isArray(authorization.entrypoints) ||
    !Array.isArray(authorization.dependencies)
  ) {
    return false;
  }
  const authorizationPaths = [
    ...authorization.entrypoints,
    ...authorization.dependencies,
  ];
  if (
    (value.sourcePaths as string[]).some(
      (sourcePath) => !authorizationPaths.includes(sourcePath),
    ) ||
    value.authorizationClosureDigest !== closure('authorization.verify') ||
    value.humanTrustRootsClosureDigest !== closure('human.trust-roots') ||
    value.applyJournalClosureDigest !== closure('apply.journal') ||
    value.controlPlaneUpdateClosureDigest !== closure('control-plane.update') ||
    value.recoveryClosureDigest !== closure('recovery.rollback')
  ) {
    return false;
  }
  if (
    !validRoleContextSharingGrantVerifierBinding(
      value.roleContextSharingGrant,
      authorization,
    )
  ) {
    return false;
  }
  const { compositionDigest, ...payload } = value;
  return canonicalDigest(payload) === compositionDigest;
}

function validRoleContextSharingGrantVerifierBinding(
  value: unknown,
  authorization: Record<string, unknown>,
): value is Record<string, unknown> {
  const keys = [
    'authorizationClosureDigest',
    'authorizedEffect',
    'kind',
    'packageExport',
    'packageExportTarget',
    'policyDigest',
    'readerContractVersion',
    'signatureNamespace',
    'sourceDigest',
    'sourcePaths',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.kind !== 'role-context-sharing-grant-verifier-binding.v1' ||
    value.packageExport !== './role-context-sharing-degradation' ||
    value.packageExportTarget !== './src/role-context-sharing-degradation.ts' ||
    value.readerContractVersion !==
      'jigwright.role-context-sharing-grant-reader.v1' ||
    value.signatureNamespace !== 'workflow.role-context-sharing-grant.v1' ||
    value.authorizedEffect !== 'role-context-sharing-degradation' ||
    !/^[0-9a-f]{64}$/.test(String(value.policyDigest)) ||
    !sortedUniqueSafePaths(value.sourcePaths, false) ||
    !(value.sourcePaths as string[]).includes('packages/grants/package.json') ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.authorizationClosureDigest) ||
    value.authorizationClosureDigest !== authorization.closureDigest ||
    !Array.isArray(authorization.entrypoints) ||
    !Array.isArray(authorization.dependencies)
  ) {
    return false;
  }
  const authorizationPaths = [
    ...authorization.entrypoints,
    ...authorization.dependencies,
  ];
  return (value.sourcePaths as string[]).every((sourcePath) =>
    authorizationPaths.includes(sourcePath),
  );
}

export function bootstrapEntryDigestsMatch(
  tree: BootstrapProtectedTreeEntry[],
  entry: Record<string, unknown>,
): boolean {
  const entrypoints = entry.entrypoints as string[];
  const dependencies = entry.dependencies as string[];
  assertNoBootstrapCaseFoldAliases([...entrypoints, ...dependencies]);
  const identities = resolveBootstrapClosureIdentities(tree, [
    ...entrypoints,
    ...dependencies,
  ]);
  const contentDigest = canonicalDigest({
    kind: 'protected-capability-content.v1',
    files: identities,
  });
  const closureDigest = canonicalDigest({
    entrypoints,
    dependencies,
    contentDigest,
  });
  return (
    entry.contentDigest === contentDigest &&
    entry.closureDigest === closureDigest
  );
}

function resolveBootstrapClosureIdentities(
  tree: BootstrapProtectedTreeEntry[],
  declaredPaths: string[],
): BootstrapProtectedClosureIdentity[] {
  const identities = new Map<string, BootstrapProtectedClosureIdentity>();
  for (const declaredPath of new Set(declaredPaths)) {
    const matches = tree.filter((entry) =>
      matchesBootstrapProtectedPath(entry.path, declaredPath),
    );
    const protectsManifest = matchesBootstrapProtectedPath(
      PROTECTED_CAPABILITY_MANIFEST_PATH,
      declaredPath,
    );
    if (matches.length === 0 && !protectsManifest) {
      throw protectedCapabilityManifestInvalid();
    }
    if (protectsManifest) {
      identities.set(PROTECTED_CAPABILITY_MANIFEST_PATH, {
        path: PROTECTED_CAPABILITY_MANIFEST_PATH,
        mode: 'manifest-self',
        objectId: 'manifest-self',
      });
    }
    for (const match of matches) {
      if (match.path === PROTECTED_CAPABILITY_MANIFEST_PATH) continue;
      if (
        match.type !== 'blob' ||
        (match.mode !== '100644' && match.mode !== '100755')
      ) {
        throw protectedCapabilityManifestInvalid();
      }
      identities.set(match.path, {
        path: match.path,
        mode: match.mode,
        objectId: match.objectId,
      });
    }
  }
  const resolved = [...identities.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  assertNoBootstrapCaseFoldAliases(resolved.map((entry) => entry.path));
  return resolved;
}

export function matchesBootstrapProtectedPath(
  filePath: string,
  policyPath: string,
): boolean {
  const base = policyPath.endsWith('/**')
    ? policyPath.slice(0, -3)
    : policyPath;
  return policyPath.endsWith('/**')
    ? filePath === base || filePath.startsWith(`${base}/`)
    : filePath === policyPath;
}

export function assertNoBootstrapCaseFoldAliases(
  values: readonly string[],
): void {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const key = value.toLocaleLowerCase('en-US');
    const previous = aliases.get(key);
    if (previous !== undefined && previous !== value) {
      throw protectedCapabilityManifestInvalid();
    }
    aliases.set(key, value);
  }
}

export function sortedUniqueProtectedPaths(
  values: unknown[],
  allowRecursiveSuffix: boolean,
): values is string[] {
  if (
    !values.every((value) =>
      safeProtectedCapabilityPath(value, allowRecursiveSuffix),
    )
  ) {
    return false;
  }
  const sorted = [...new Set(values as string[])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return canonicalJson(values) === canonicalJson(sorted);
}

export function safeProtectedCapabilityPath(
  value: unknown,
  allowRecursiveSuffix: boolean,
): value is string {
  if (typeof value !== 'string') return false;
  const withoutSuffix =
    allowRecursiveSuffix && value.endsWith('/**') ? value.slice(0, -3) : value;
  return (
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    }) &&
    withoutSuffix.length > 0 &&
    withoutSuffix === withoutSuffix.normalize('NFC') &&
    !path.posix.isAbsolute(withoutSuffix) &&
    !/^[A-Za-z]:[\\/]/.test(withoutSuffix) &&
    !withoutSuffix.startsWith('./') &&
    !withoutSuffix.endsWith('/') &&
    !withoutSuffix.includes('\\') &&
    !/[*?[\]{}]/.test(withoutSuffix) &&
    withoutSuffix
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

export function validProtectedCapabilityManifestV2(
  value: Record<string, unknown>,
): boolean {
  const manifestKeys = [
    'entries',
    'kind',
    'manifestDigest',
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
    !safeClosurePath(value.manifestPath) ||
    !Array.isArray(value.entries) ||
    value.entries.length !== REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.length ||
    !isDigest(value.manifestDigest)
  ) {
    return false;
  }
  const capabilities: string[] = [];
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
      !REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.includes(
        entry.capability as (typeof REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES)[number],
      ) ||
      !sortedUniqueSafePaths(entry.entrypoints, false) ||
      entry.entrypoints.length === 0 ||
      !sortedUniqueSafePaths(entry.dependencies, true) ||
      !isDigest(entry.contentDigest) ||
      !isDigest(entry.closureDigest) ||
      entry.closureDigest !==
        canonicalDigest({
          entrypoints: entry.entrypoints,
          dependencies: entry.dependencies,
          contentDigest: entry.contentDigest,
        })
    ) {
      return false;
    }
    capabilities.push(entry.capability);
  }
  if (
    value.grantVerifierComposition !== undefined &&
    !validGrantVerifierCompositionShape(
      value.grantVerifierComposition,
      value.entries,
    )
  ) {
    return false;
  }
  const { manifestDigest, ...payload } = value;
  return (
    canonicalJson(capabilities) ===
      canonicalJson(REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES) &&
    canonicalDigest(payload) === manifestDigest
  );
}

export function affectedCapabilitiesForV2(
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
  changes: Array<Record<string, unknown>>,
): string[] | null {
  if (
    !Array.isArray(beforeManifest.entries) ||
    !Array.isArray(afterManifest.entries) ||
    typeof beforeManifest.manifestPath !== 'string'
  ) {
    return null;
  }
  const changed = new Set(changes.map((change) => String(change.path)));
  const manifestChanged =
    changed.has(beforeManifest.manifestPath) ||
    beforeManifest.manifestDigest !== afterManifest.manifestDigest;
  const affected: string[] = [];
  for (const capability of REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES) {
    const before = beforeManifest.entries.find(
      (entry) => isRecord(entry) && entry.capability === capability,
    );
    const after = afterManifest.entries.find(
      (entry) => isRecord(entry) && entry.capability === capability,
    );
    if (!isRecord(before) || !isRecord(after)) return null;
    const protectedPaths = new Set([
      ...(before.entrypoints as string[]),
      ...(before.dependencies as string[]),
      ...(after.entrypoints as string[]),
      ...(after.dependencies as string[]),
    ]);
    if (
      before.closureDigest !== after.closureDigest ||
      [...changed].some((filePath) => protectedPaths.has(filePath))
    ) {
      affected.push(capability);
    }
  }
  return manifestChanged || affected.length > 0 ? affected : null;
}

export function validAffectedCapabilitiesV2(value: unknown): value is string[] {
  return (
    sortedUniqueStrings(value, true) &&
    value.every((capability) =>
      REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.includes(
        capability as (typeof REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES)[number],
      ),
    )
  );
}
