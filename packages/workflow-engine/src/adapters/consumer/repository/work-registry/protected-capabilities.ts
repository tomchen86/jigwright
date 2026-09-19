/**
 * Loads and verifies protected capability manifests and their code and
 * policy closures.
 *
 * Invariants:
 * - Each required capability appears once in canonical order, and the
 *   manifest protects both itself and its loader.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../../../foundation/canonical-json/canonical-json.ts';
import {
  isRecord,
  isStringArray,
} from '../../../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  runGit,
  runGitBuffer,
} from '../../../../runtime/repository-transaction/git.ts';
import {
  matchesAllowedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../../../../foundation/repository-path/repository-path.ts';
import {
  readBlobBytes,
  readFileAtRevision,
} from '../../../../runtime/repository-transaction/git-command.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';
const LOADER_PATH =
  'packages/workflow-engine/src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const REQUIRED_GRANTS_PACKAGE_EXPORTS = Object.freeze({
  './collaboration-grant-envelope-reader':
    './src/collaboration-grant-envelope-reader.ts',
  './grant-envelope-verifier': './src/grant-envelope-verifier.ts',
  './grant-lifecycle': './src/grant-lifecycle.ts',
} as const);

export const REQUIRED_PROTECTED_CAPABILITIES = [
  'adoption.journal',
  'apply.journal',
  'audit.append',
  'authorization.verify',
  'control-plane.update',
  'effect.monitor',
  'human.trust-roots',
  'policy.classify',
  'recovery.rollback',
  'ref-generation.ledger',
  'sandbox.enforce',
  'workflow.abort-or-supersede',
] as const;

export type ProtectedCapability =
  (typeof REQUIRED_PROTECTED_CAPABILITIES)[number];

export type Sha256Digest = `sha256:${string}`;

export type ProtectedCapabilityEntry = {
  capability: ProtectedCapability;
  entrypoints: string[];
  dependencies: string[];
  contentDigest: Sha256Digest;
  closureDigest: Sha256Digest;
};

export type RoleContextSharingGrantVerifierBindingV1 = {
  kind: 'role-context-sharing-grant-verifier-binding.v1';
  packageExport: './role-context-sharing-degradation';
  packageExportTarget: './src/role-context-sharing-degradation.ts';
  readerContractVersion: 'jigwright.role-context-sharing-grant-reader.v1';
  signatureNamespace: 'workflow.role-context-sharing-grant.v1';
  authorizedEffect: 'role-context-sharing-degradation';
  policyDigest: string;
  sourcePaths: string[];
  sourceDigest: Sha256Digest;
  authorizationClosureDigest: Sha256Digest;
};

export type CollaborationGrantVerifierCompositionV1 = {
  kind: 'collaboration-grant-verifier-composition.v1';
  packageName: '@jigwright/grants';
  packageVersion: '0.1.0';
  packageManifestPath: 'packages/grants/package.json';
  packageManifestDigest: Sha256Digest;
  verifierImplementation: 'ssh-maintainer-policy.v1';
  verifierContractVersion: 'jigwright.grant-envelope-verifier.v1';
  readerContractVersion: 'jigwright.collaboration-grant-envelope-reader.v1';
  signatureNamespaces: ['workflow.collaboration-grant.v2'];
  authorizedEffects: ['role-independence-degradation-only'];
  sourcePaths: string[];
  sourceDigest: Sha256Digest;
  collaborationPolicyDigest: string;
  taskDiffReviewPolicyDigest: string;
  roleContextSharingGrant: RoleContextSharingGrantVerifierBindingV1;
  authorizationClosureDigest: Sha256Digest;
  humanTrustRootsClosureDigest: Sha256Digest;
  applyJournalClosureDigest: Sha256Digest;
  controlPlaneUpdateClosureDigest: Sha256Digest;
  recoveryClosureDigest: Sha256Digest;
  repairAuthority: 'human-only-authority-plan-or-sealed-recovery';
  compositionDigest: Sha256Digest;
};

export type ProtectedCapabilitiesManifest = {
  kind: 'protected-capability-manifest.v1';
  schemaVersion: 1;
  manifestPath: typeof MANIFEST_PATH;
  grantVerifierComposition?: CollaborationGrantVerifierCompositionV1;
  entries: ProtectedCapabilityEntry[];
  manifestDigest: Sha256Digest;
};

export type ProtectedCapabilitiesManifestSource = Omit<
  ProtectedCapabilitiesManifest,
  'manifestDigest'
>;

type TreeEntry = {
  path: string;
  mode: string;
  objectId: string;
};

type ClosureIdentity =
  | TreeEntry
  | {
      path: typeof MANIFEST_PATH;
      mode: 'manifest-self';
      objectId: 'manifest-self';
    };

export type ProtectedCapabilityEntryDigests = {
  contentDigest: Sha256Digest;
  closureDigest: Sha256Digest;
};

export function computeProtectedCapabilityEntryDigests(
  repositoryRoot: string,
  trustBaseCommit: string,
  input: { entrypoints: string[]; dependencies: string[] },
): ProtectedCapabilityEntryDigests {
  const entrypoints = validatePolicyPaths(
    input.entrypoints,
    'entrypoints',
    true,
  );
  const dependencies = validatePolicyPaths(
    input.dependencies,
    'dependencies',
    false,
  );
  assertNoCaseFoldAliases([...entrypoints, ...dependencies]);
  const tree = readTrustBaseTree(repositoryRoot, trustBaseCommit);
  const identities = resolveClosureIdentities(tree, [
    ...entrypoints,
    ...dependencies,
  ]);
  return entryDigests(entrypoints, dependencies, identities);
}

export function computeProtectedCapabilityEntryDigestsFromWorktree(
  repositoryRoot: string,
  input: { entrypoints: string[]; dependencies: string[] },
): ProtectedCapabilityEntryDigests {
  const entrypoints = validatePolicyPaths(
    input.entrypoints,
    'entrypoints',
    true,
  );
  const dependencies = validatePolicyPaths(
    input.dependencies,
    'dependencies',
    false,
  );
  assertNoCaseFoldAliases([...entrypoints, ...dependencies]);
  const identities = resolveClosureIdentities(
    readWorktreeFiles(repositoryRoot),
    [...entrypoints, ...dependencies],
  );
  return entryDigests(entrypoints, dependencies, identities);
}

function entryDigests(
  entrypoints: string[],
  dependencies: string[],
  identities: ClosureIdentity[],
): ProtectedCapabilityEntryDigests {
  const contentDigest = digest(
    canonicalJson({
      kind: 'protected-capability-content.v1',
      files: identities,
    }),
  );
  const closureDigest = digest(
    canonicalJson({ entrypoints, dependencies, contentDigest }),
  );
  return { contentDigest, closureDigest };
}

export function loadProtectedCapabilitiesFromTrustBase(
  repositoryRoot: string,
  trustBaseCommit: string,
): ProtectedCapabilitiesManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileAtRevision(repositoryRoot, trustBaseCommit, `${MANIFEST_PATH}`),
    ) as unknown;
  } catch {
    throw protectedManifestInvalid(
      'The trust base has no readable protected capability manifest.',
    );
  }
  const payload = parseProtectedCapabilitiesManifestSource(parsed);
  for (const entry of payload.entries) {
    const observed = computeProtectedCapabilityEntryDigests(
      repositoryRoot,
      trustBaseCommit,
      entry,
    );
    if (
      observed.contentDigest !== entry.contentDigest ||
      observed.closureDigest !== entry.closureDigest
    ) {
      throw workflowError(
        'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH',
        `Protected capability ${entry.capability} no longer matches its trust-base dependency closure.`,
        ExitCode.verification,
      );
    }
  }
  if (payload.grantVerifierComposition !== undefined) {
    const projected = projectCollaborationGrantVerifierCompositionFromTrustBase(
      repositoryRoot,
      trustBaseCommit,
      payload.grantVerifierComposition,
      payload.entries,
    );
    if (
      canonicalJson(projected) !==
      canonicalJson(payload.grantVerifierComposition)
    ) {
      throw workflowError(
        'PROTECTED_GRANT_VERIFIER_COMPOSITION_MISMATCH',
        'The Collaboration Grant verifier composition no longer matches its sealed trust base.',
        ExitCode.verification,
      );
    }
  }

  return {
    ...payload,
    manifestDigest: digest(canonicalJson(payload)),
  };
}

export function loadProtectedCapabilitiesFromWorktree(
  repositoryRoot: string,
): ProtectedCapabilitiesManifest {
  const root = fs.realpathSync(repositoryRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'),
    ) as unknown;
  } catch {
    throw protectedManifestInvalid(
      'The worktree has no readable protected capability manifest.',
    );
  }
  const payload = parseProtectedCapabilitiesManifestSource(parsed);
  for (const entry of payload.entries) {
    const observed = computeProtectedCapabilityEntryDigestsFromWorktree(
      root,
      entry,
    );
    if (
      observed.contentDigest !== entry.contentDigest ||
      observed.closureDigest !== entry.closureDigest
    ) {
      throw workflowError(
        'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH',
        `Protected capability ${entry.capability} no longer matches its candidate dependency closure.`,
        ExitCode.verification,
      );
    }
  }
  if (payload.grantVerifierComposition !== undefined) {
    const projected = projectCollaborationGrantVerifierCompositionFromWorktree(
      root,
      payload.grantVerifierComposition,
      payload.entries,
    );
    if (
      canonicalJson(projected) !==
      canonicalJson(payload.grantVerifierComposition)
    ) {
      throw workflowError(
        'PROTECTED_GRANT_VERIFIER_COMPOSITION_MISMATCH',
        'The Collaboration Grant verifier composition no longer matches its sealed candidate.',
        ExitCode.verification,
      );
    }
  }
  return {
    ...payload,
    manifestDigest: digest(canonicalJson(payload)),
  };
}

export function parseProtectedCapabilitiesManifestSource(
  parsed: unknown,
): ProtectedCapabilitiesManifestSource {
  if (
    !isRecord(parsed) ||
    !hasAllowedExactKeys(
      parsed,
      ['kind', 'schemaVersion', 'manifestPath', 'entries'],
      ['grantVerifierComposition'],
    ) ||
    parsed.kind !== 'protected-capability-manifest.v1' ||
    parsed.schemaVersion !== 1 ||
    parsed.manifestPath !== MANIFEST_PATH ||
    !Array.isArray(parsed.entries)
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest is malformed.',
    );
  }

  const entries = parsed.entries.map(parseManifestEntry);
  const grantVerifierComposition =
    parsed.grantVerifierComposition === undefined
      ? undefined
      : parseCollaborationGrantVerifierComposition(
          parsed.grantVerifierComposition,
        );
  const capabilities = entries.map(({ capability }) => capability);
  if (
    capabilities.length !== REQUIRED_PROTECTED_CAPABILITIES.length ||
    capabilities.some(
      (capability, index) =>
        capability !== REQUIRED_PROTECTED_CAPABILITIES[index],
    )
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest must contain every required capability exactly once in canonical order.',
    );
  }

  const declaredPaths = entries.flatMap(({ entrypoints, dependencies }) => [
    ...entrypoints,
    ...dependencies,
  ]);
  assertNoCaseFoldAliases(declaredPaths);
  if (
    !declaredPaths.some((entry) => matchesAllowedPath(MANIFEST_PATH, entry)) ||
    !declaredPaths.some((entry) => matchesAllowedPath(LOADER_PATH, entry))
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest must protect itself and its loader.',
    );
  }

  return {
    kind: 'protected-capability-manifest.v1' as const,
    schemaVersion: 1 as const,
    manifestPath: MANIFEST_PATH,
    ...(grantVerifierComposition === undefined
      ? {}
      : { grantVerifierComposition }),
    entries,
  };
}

export function projectCollaborationGrantVerifierCompositionFromWorktree(
  repositoryRoot: string,
  reviewed: CollaborationGrantVerifierCompositionV1,
  entries: ProtectedCapabilityEntry[],
): CollaborationGrantVerifierCompositionV1 {
  const root = fs.realpathSync(repositoryRoot);
  return projectCollaborationGrantVerifierComposition(
    reviewed,
    entries,
    (sourcePath) => readCompositionSource(root, sourcePath),
  );
}

export function projectCollaborationGrantVerifierCompositionFromTrustBase(
  repositoryRoot: string,
  trustBaseCommit: string,
  reviewed: CollaborationGrantVerifierCompositionV1,
  entries: ProtectedCapabilityEntry[],
): CollaborationGrantVerifierCompositionV1 {
  const tree = readTrustBaseTree(repositoryRoot, trustBaseCommit);
  return projectCollaborationGrantVerifierComposition(
    reviewed,
    entries,
    (sourcePath) =>
      readPinnedCompositionSource(repositoryRoot, tree, sourcePath),
  );
}

function projectCollaborationGrantVerifierComposition(
  reviewed: CollaborationGrantVerifierCompositionV1,
  entries: ProtectedCapabilityEntry[],
  readSource: (sourcePath: string) => Buffer,
): CollaborationGrantVerifierCompositionV1 {
  const packageManifestPath = normalizeExactRepositoryPath(
    reviewed.packageManifestPath,
  );
  const packageManifest = readSource(packageManifestPath);
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(packageManifest.toString('utf8')) as unknown;
  } catch {
    throw protectedManifestInvalid(
      'The Collaboration Grant package manifest is not valid JSON.',
    );
  }
  if (
    !isRecord(packageValue) ||
    packageValue.name !== reviewed.packageName ||
    packageValue.version !== reviewed.packageVersion ||
    !isRecord(packageValue.exports)
  ) {
    throw protectedManifestInvalid(
      'The Collaboration Grant package identity is invalid.',
    );
  }
  const packageExports = packageValue.exports;
  if (
    Object.entries(REQUIRED_GRANTS_PACKAGE_EXPORTS).some(
      ([subpath, sourcePath]) => packageExports[subpath] !== sourcePath,
    ) ||
    packageExports[reviewed.roleContextSharingGrant.packageExport] !==
      reviewed.roleContextSharingGrant.packageExportTarget
  ) {
    throw protectedManifestInvalid(
      'The Collaboration Grant package identity is invalid.',
    );
  }
  const sourcePaths = validatePolicyPaths(
    reviewed.sourcePaths,
    'grant verifier composition source paths',
    true,
  );
  if (sourcePaths.some((sourcePath) => sourcePath.includes('*'))) {
    throw protectedManifestInvalid(
      'The Collaboration Grant verifier composition requires exact source paths.',
    );
  }
  if (!sourcePaths.includes(packageManifestPath)) {
    throw protectedManifestInvalid(
      'The Collaboration Grant verifier composition must bind its package manifest.',
    );
  }
  const authorization = entries.find(
    ({ capability }) => capability === 'authorization.verify',
  );
  if (
    authorization === undefined ||
    sourcePaths.some(
      (sourcePath) =>
        ![...authorization.entrypoints, ...authorization.dependencies].includes(
          sourcePath,
        ),
    )
  ) {
    throw protectedManifestInvalid(
      'The Collaboration Grant verifier sources are outside authorization.verify.',
    );
  }
  const sourceFiles = sourcePaths.map((sourcePath) => ({
    path: sourcePath,
    digest: digest(readSource(sourcePath)),
  }));
  const closure = (capability: ProtectedCapability): Sha256Digest => {
    const entry = entries.find(
      (candidate) => candidate.capability === capability,
    );
    if (entry === undefined) {
      throw protectedManifestInvalid(
        `The Collaboration Grant verifier composition lacks ${capability}.`,
      );
    }
    return entry.closureDigest;
  };
  const roleContextSharingGrant = projectRoleContextSharingGrantVerifierBinding(
    reviewed.roleContextSharingGrant,
    authorization,
    closure('authorization.verify'),
    readSource,
  );
  const projectedWithoutDigest = {
    kind: reviewed.kind,
    packageName: reviewed.packageName,
    packageVersion: reviewed.packageVersion,
    packageManifestPath: reviewed.packageManifestPath,
    packageManifestDigest: digest(packageManifest),
    verifierImplementation: reviewed.verifierImplementation,
    verifierContractVersion: reviewed.verifierContractVersion,
    readerContractVersion: reviewed.readerContractVersion,
    signatureNamespaces: reviewed.signatureNamespaces,
    authorizedEffects: reviewed.authorizedEffects,
    sourcePaths,
    sourceDigest: digest(
      canonicalJson({
        kind: 'collaboration-grant-verifier-source.v1',
        files: sourceFiles,
      }),
    ),
    collaborationPolicyDigest: reviewed.collaborationPolicyDigest,
    taskDiffReviewPolicyDigest: reviewed.taskDiffReviewPolicyDigest,
    roleContextSharingGrant,
    authorizationClosureDigest: closure('authorization.verify'),
    humanTrustRootsClosureDigest: closure('human.trust-roots'),
    applyJournalClosureDigest: closure('apply.journal'),
    controlPlaneUpdateClosureDigest: closure('control-plane.update'),
    recoveryClosureDigest: closure('recovery.rollback'),
    repairAuthority: reviewed.repairAuthority,
  } as const;
  return {
    ...projectedWithoutDigest,
    compositionDigest: digest(canonicalJson(projectedWithoutDigest)),
  };
}

function parseCollaborationGrantVerifierComposition(
  value: unknown,
): CollaborationGrantVerifierCompositionV1 {
  const keys = [
    'kind',
    'packageName',
    'packageVersion',
    'packageManifestPath',
    'packageManifestDigest',
    'verifierImplementation',
    'verifierContractVersion',
    'readerContractVersion',
    'signatureNamespaces',
    'authorizedEffects',
    'sourcePaths',
    'sourceDigest',
    'collaborationPolicyDigest',
    'taskDiffReviewPolicyDigest',
    'authorizationClosureDigest',
    'humanTrustRootsClosureDigest',
    'applyJournalClosureDigest',
    'controlPlaneUpdateClosureDigest',
    'recoveryClosureDigest',
    'repairAuthority',
    'compositionDigest',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...keys, 'roleContextSharingGrant']) ||
    value.kind !== 'collaboration-grant-verifier-composition.v1' ||
    value.packageName !== '@jigwright/grants' ||
    value.packageVersion !== '0.1.0' ||
    value.packageManifestPath !== 'packages/grants/package.json' ||
    value.verifierImplementation !== 'ssh-maintainer-policy.v1' ||
    value.verifierContractVersion !== 'jigwright.grant-envelope-verifier.v1' ||
    value.readerContractVersion !==
      'jigwright.collaboration-grant-envelope-reader.v1' ||
    !DIGEST.test(String(value.packageManifestDigest)) ||
    !DIGEST.test(String(value.sourceDigest)) ||
    !DIGEST.test(String(value.authorizationClosureDigest)) ||
    !DIGEST.test(String(value.humanTrustRootsClosureDigest)) ||
    !DIGEST.test(String(value.applyJournalClosureDigest)) ||
    !DIGEST.test(String(value.controlPlaneUpdateClosureDigest)) ||
    !DIGEST.test(String(value.recoveryClosureDigest)) ||
    !DIGEST.test(String(value.compositionDigest)) ||
    !/^[0-9a-f]{64}$/.test(String(value.collaborationPolicyDigest)) ||
    !/^[0-9a-f]{64}$/.test(String(value.taskDiffReviewPolicyDigest)) ||
    !Array.isArray(value.signatureNamespaces) ||
    value.signatureNamespaces.length !== 1 ||
    value.signatureNamespaces[0] !== 'workflow.collaboration-grant.v2' ||
    !Array.isArray(value.authorizedEffects) ||
    value.authorizedEffects.length !== 1 ||
    value.authorizedEffects[0] !== 'role-independence-degradation-only' ||
    !isStringArray(value.sourcePaths) ||
    value.repairAuthority !== 'human-only-authority-plan-or-sealed-recovery'
  ) {
    throw protectedManifestInvalid(
      'The Collaboration Grant verifier composition is malformed.',
    );
  }
  const sourcePaths = validatePolicyPaths(
    value.sourcePaths,
    'grant verifier composition source paths',
    true,
  );
  const roleContextSharingGrant = parseRoleContextSharingGrantVerifierBinding(
    value.roleContextSharingGrant,
  );
  return {
    kind: value.kind,
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    packageManifestPath: value.packageManifestPath,
    packageManifestDigest: value.packageManifestDigest as Sha256Digest,
    verifierImplementation: value.verifierImplementation,
    verifierContractVersion: value.verifierContractVersion,
    readerContractVersion: value.readerContractVersion,
    signatureNamespaces: ['workflow.collaboration-grant.v2'],
    authorizedEffects: ['role-independence-degradation-only'],
    sourcePaths,
    sourceDigest: value.sourceDigest as Sha256Digest,
    collaborationPolicyDigest: value.collaborationPolicyDigest as string,
    taskDiffReviewPolicyDigest: value.taskDiffReviewPolicyDigest as string,
    roleContextSharingGrant,
    authorizationClosureDigest:
      value.authorizationClosureDigest as Sha256Digest,
    humanTrustRootsClosureDigest:
      value.humanTrustRootsClosureDigest as Sha256Digest,
    applyJournalClosureDigest: value.applyJournalClosureDigest as Sha256Digest,
    controlPlaneUpdateClosureDigest:
      value.controlPlaneUpdateClosureDigest as Sha256Digest,
    recoveryClosureDigest: value.recoveryClosureDigest as Sha256Digest,
    repairAuthority: value.repairAuthority,
    compositionDigest: value.compositionDigest as Sha256Digest,
  };
}

function parseRoleContextSharingGrantVerifierBinding(
  value: unknown,
): RoleContextSharingGrantVerifierBindingV1 {
  const keys = [
    'kind',
    'packageExport',
    'packageExportTarget',
    'readerContractVersion',
    'signatureNamespace',
    'authorizedEffect',
    'policyDigest',
    'sourcePaths',
    'sourceDigest',
    'authorizationClosureDigest',
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
    !isStringArray(value.sourcePaths) ||
    !DIGEST.test(String(value.sourceDigest)) ||
    !DIGEST.test(String(value.authorizationClosureDigest))
  ) {
    throw protectedManifestInvalid(
      'The role-context-sharing Grant verifier binding is malformed.',
    );
  }
  return {
    kind: value.kind,
    packageExport: value.packageExport,
    packageExportTarget: value.packageExportTarget,
    readerContractVersion: value.readerContractVersion,
    signatureNamespace: value.signatureNamespace,
    authorizedEffect: value.authorizedEffect,
    policyDigest: value.policyDigest as string,
    sourcePaths: validatePolicyPaths(
      value.sourcePaths,
      'role-context-sharing Grant verifier source paths',
      true,
    ),
    sourceDigest: value.sourceDigest as Sha256Digest,
    authorizationClosureDigest:
      value.authorizationClosureDigest as Sha256Digest,
  };
}

function projectRoleContextSharingGrantVerifierBinding(
  reviewed: RoleContextSharingGrantVerifierBindingV1,
  authorization: ProtectedCapabilityEntry,
  authorizationClosureDigest: Sha256Digest,
  readSource: (sourcePath: string) => Buffer,
): RoleContextSharingGrantVerifierBindingV1 {
  const sourcePaths = validatePolicyPaths(
    reviewed.sourcePaths,
    'role-context-sharing Grant verifier source paths',
    true,
  );
  if (
    sourcePaths.some((sourcePath) => sourcePath.includes('*')) ||
    !sourcePaths.includes('packages/grants/package.json') ||
    sourcePaths.some(
      (sourcePath) =>
        ![...authorization.entrypoints, ...authorization.dependencies].includes(
          sourcePath,
        ),
    )
  ) {
    throw protectedManifestInvalid(
      'The role-context-sharing Grant verifier sources are outside authorization.verify.',
    );
  }
  const files = sourcePaths.map((sourcePath) => ({
    path: sourcePath,
    digest: digest(readSource(sourcePath)),
  }));
  return {
    kind: reviewed.kind,
    packageExport: reviewed.packageExport,
    packageExportTarget: reviewed.packageExportTarget,
    readerContractVersion: reviewed.readerContractVersion,
    signatureNamespace: reviewed.signatureNamespace,
    authorizedEffect: reviewed.authorizedEffect,
    policyDigest: reviewed.policyDigest,
    sourcePaths,
    sourceDigest: digest(
      canonicalJson({
        kind: 'role-context-sharing-grant-verifier-source.v1',
        files,
      }),
    ),
    authorizationClosureDigest,
  };
}

export function classifyProtectedCapabilityPaths(
  repositoryRoot: string,
  trustBaseCommit: string,
  requestedPaths: string[],
): {
  protectedPaths: string[];
  affectedCapabilities: ProtectedCapability[];
  manifestDigest: string;
} {
  const manifest = loadProtectedCapabilitiesFromTrustBase(
    repositoryRoot,
    trustBaseCommit,
  );
  const paths = requestedPaths.map(normalizeExactRepositoryPath);
  const unique = [...new Set(paths)].sort(compareCanonicalStrings);
  assertNoCaseFoldAliases(paths);
  if (unique.length !== paths.length) {
    throw protectedManifestInvalid(
      'Protected capability classification requires unique exact paths.',
    );
  }
  const affectedCapabilities = manifest.entries
    .filter(({ entrypoints, dependencies }) =>
      paths.some((filePath) =>
        [...entrypoints, ...dependencies].some((protectedPath) =>
          matchesAllowedPath(filePath, protectedPath),
        ),
      ),
    )
    .map(({ capability }) => capability);
  const affected = new Set(affectedCapabilities);
  return {
    protectedPaths: unique.filter((filePath) =>
      manifest.entries.some(
        ({ capability, entrypoints, dependencies }) =>
          affected.has(capability) &&
          [...entrypoints, ...dependencies].some((protectedPath) =>
            matchesAllowedPath(filePath, protectedPath),
          ),
      ),
    ),
    affectedCapabilities,
    manifestDigest: manifest.manifestDigest,
  };
}

function parseManifestEntry(value: unknown): ProtectedCapabilityEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'capability',
      'entrypoints',
      'dependencies',
      'contentDigest',
      'closureDigest',
    ]) ||
    typeof value.capability !== 'string' ||
    !isProtectedCapability(value.capability) ||
    !isStringArray(value.entrypoints) ||
    !isStringArray(value.dependencies) ||
    typeof value.contentDigest !== 'string' ||
    !DIGEST.test(value.contentDigest) ||
    typeof value.closureDigest !== 'string' ||
    !DIGEST.test(value.closureDigest)
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest contains a malformed entry.',
    );
  }
  const entrypoints = validatePolicyPaths(
    value.entrypoints,
    'entrypoints',
    true,
  );
  const dependencies = validatePolicyPaths(
    value.dependencies,
    'dependencies',
    false,
  );
  assertNoCaseFoldAliases([...entrypoints, ...dependencies]);
  return {
    capability: value.capability,
    entrypoints,
    dependencies,
    contentDigest: value.contentDigest as Sha256Digest,
    closureDigest: value.closureDigest as Sha256Digest,
  };
}

function validatePolicyPaths(
  values: string[],
  label: string,
  requireNonEmpty: boolean,
): string[] {
  if (requireNonEmpty && values.length === 0) {
    throw protectedManifestInvalid(
      `Protected capability ${label} cannot be empty.`,
    );
  }
  const normalized = values.map((entry) => {
    try {
      return normalizePolicyPath(entry);
    } catch {
      throw protectedManifestInvalid(
        `Protected capability ${label} contain an unsafe repository path.`,
      );
    }
  });
  const sorted = [...new Set(normalized)].sort(compareCanonicalStrings);
  if (
    sorted.length !== normalized.length ||
    normalized.some((entry, index) => entry !== sorted[index])
  ) {
    throw protectedManifestInvalid(
      `Protected capability ${label} must be normalized, sorted, and unique.`,
    );
  }
  return normalized;
}

function assertNoCaseFoldAliases(paths: readonly string[]): void {
  const aliases = new Map<string, string>();
  for (const entry of paths) {
    const key = entry.toLocaleLowerCase('en-US');
    const previous = aliases.get(key);
    if (previous !== undefined && previous !== entry) {
      throw protectedManifestInvalid(
        'Protected capability paths contain a case-fold alias.',
      );
    }
    aliases.set(key, entry);
  }
}

function readTrustBaseTree(
  repositoryRoot: string,
  trustBaseCommit: string,
): TreeEntry[] {
  let output: string;
  try {
    output = runGit(repositoryRoot, [
      '-c',
      'core.quotePath=false',
      'ls-tree',
      '-r',
      '--full-tree',
      trustBaseCommit,
    ]);
  } catch {
    throw protectedManifestInvalid(
      'The protected capability trust-base tree is unreadable.',
    );
  }
  if (!output) return [];
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf('\t');
      const metadata = tab === -1 ? [] : line.slice(0, tab).split(' ');
      const filePath = tab === -1 ? '' : line.slice(tab + 1);
      const [mode, type, objectId] = metadata;
      let normalizedPath: string;
      try {
        normalizedPath = normalizeExactRepositoryPath(filePath);
      } catch {
        throw protectedManifestInvalid(
          'The protected capability trust-base tree contains an unsafe path.',
        );
      }
      if (
        metadata.length !== 3 ||
        mode === undefined ||
        objectId === undefined ||
        !OBJECT_ID.test(objectId)
      ) {
        throw protectedManifestInvalid(
          'The protected capability trust-base tree contains an unsupported object.',
        );
      }
      return type === 'blob'
        ? { path: normalizedPath, mode, objectId }
        : { path: normalizedPath, mode: 'unsupported', objectId };
    });
}

function readWorktreeFiles(repositoryRoot: string): TreeEntry[] {
  let root: string;
  let objectFormat: string;
  let output: Buffer;
  try {
    root = fs.realpathSync(repositoryRoot);
    objectFormat = runGit(repositoryRoot, [
      'rev-parse',
      '--show-object-format',
    ]).trim();
    output = runGitBuffer(repositoryRoot, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
  } catch {
    throw protectedManifestInvalid(
      'The protected capability candidate worktree is unreadable.',
    );
  }
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw protectedManifestInvalid(
      'The protected capability candidate uses an unsupported Git object format.',
    );
  }
  const rawPaths = output
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
  const normalizedPaths = rawPaths.map((entry) => {
    try {
      return normalizeExactRepositoryPath(entry);
    } catch {
      throw protectedManifestInvalid(
        'The protected capability candidate contains an unsafe path.',
      );
    }
  });
  return normalizedPaths.flatMap((filePath): TreeEntry[] => {
    const absolute = path.join(root, filePath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stats === undefined) return [];
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return [{ path: filePath, mode: 'unsupported', objectId: 'unsupported' }];
    }
    const content = fs.readFileSync(absolute);
    const header = Buffer.from(`blob ${content.length}\0`);
    const objectId = crypto
      .createHash(objectFormat)
      .update(header)
      .update(content)
      .digest('hex');
    return [
      {
        path: filePath,
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        objectId,
      },
    ];
  });
}

function readCompositionSource(
  repositoryRoot: string,
  sourcePath: string,
): Buffer {
  const absolute = path.join(repositoryRoot, sourcePath);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw protectedManifestInvalid(
      `Collaboration Grant verifier source ${sourcePath} is unsafe or missing.`,
    );
  }
  return fs.readFileSync(absolute);
}

function readPinnedCompositionSource(
  repositoryRoot: string,
  tree: readonly TreeEntry[],
  sourcePath: string,
): Buffer {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeExactRepositoryPath(sourcePath);
  } catch {
    throw protectedManifestInvalid(
      `Collaboration Grant verifier source ${sourcePath} is unsafe or missing.`,
    );
  }
  const matches = tree.filter(
    ({ path: treePath }) => treePath === normalizedPath,
  );
  if (matches.length !== 1 || !REGULAR_GIT_MODES.has(matches[0]?.mode ?? '')) {
    throw protectedManifestInvalid(
      `Collaboration Grant verifier source ${sourcePath} is unsafe or missing.`,
    );
  }
  try {
    return readBlobBytes(repositoryRoot, matches[0]!.objectId);
  } catch {
    throw protectedManifestInvalid(
      `Collaboration Grant verifier source ${sourcePath} is unreadable.`,
    );
  }
}

function resolveClosureIdentities(
  tree: TreeEntry[],
  declaredPaths: string[],
): ClosureIdentity[] {
  const identities = new Map<string, ClosureIdentity>();
  for (const declaredPath of [...new Set(declaredPaths)]) {
    const matches = tree.filter(({ path }) =>
      matchesAllowedPath(path, declaredPath),
    );
    const protectsManifest = matchesAllowedPath(MANIFEST_PATH, declaredPath);
    if (matches.length === 0 && !protectsManifest) {
      throw protectedManifestInvalid(
        `Protected capability path ${declaredPath} does not resolve in the trust base.`,
      );
    }
    if (protectsManifest) {
      identities.set(MANIFEST_PATH, {
        path: MANIFEST_PATH,
        mode: 'manifest-self',
        objectId: 'manifest-self',
      });
    }
    for (const match of matches) {
      if (match.path === MANIFEST_PATH) continue;
      if (!REGULAR_GIT_MODES.has(match.mode)) {
        throw protectedManifestInvalid(
          `Protected capability path ${match.path} is not a regular executable or data file.`,
        );
      }
      identities.set(match.path, match);
    }
  }
  const resolved = [...identities.values()].sort((left, right) =>
    compareCanonicalStrings(left.path, right.path),
  );
  assertNoCaseFoldAliases(resolved.map(({ path: filePath }) => filePath));
  return resolved;
}

function isProtectedCapability(value: string): value is ProtectedCapability {
  return (REQUIRED_PROTECTED_CAPABILITIES as readonly string[]).includes(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort(compareCanonicalStrings);
  const sortedExpected = [...expected].sort(compareCanonicalStrings);
  return (
    keys.length === sortedExpected.length &&
    keys.every((entry, index) => entry === sortedExpected[index])
  );
}

function hasAllowedExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): boolean {
  const actual = Object.keys(value);
  return (
    required.every((key) => actual.includes(key)) &&
    actual.every((key) => required.includes(key) || optional.includes(key))
  );
}

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function protectedManifestInvalid(message: string) {
  return workflowError(
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
    message,
    ExitCode.guard,
  );
}
