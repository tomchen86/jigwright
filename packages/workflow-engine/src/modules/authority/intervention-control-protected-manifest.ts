/**
 * Builds exact protected-capability manifests shared by ordinary Grant policy.
 * Every required capability and any optional verifier composition are validated.
 */
import {
  type Sha256Digest,
  assertDigest,
  assertSafePath,
  assertSortedUnique,
  canonicalDigest,
  freezeDeep,
  hasExactObjectKeys,
  sameJson,
} from './intervention-control-values.ts';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

import { compareCanonicalStrings } from '../../foundation/canonical-json/canonical-json.ts';

// ---------------------------------------------------------------------------
// M11: protected capability closure and candidate classification
// ---------------------------------------------------------------------------

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

export interface ProtectedCapabilityEntry {
  capability: ProtectedCapability;
  entrypoints: string[];
  dependencies: string[];
  contentDigest: Sha256Digest;
  closureDigest: Sha256Digest;
}

export interface CollaborationGrantVerifierComposition {
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
  roleContextSharingGrant: RoleContextSharingGrantVerifierBinding;
  authorizationClosureDigest: Sha256Digest;
  humanTrustRootsClosureDigest: Sha256Digest;
  applyJournalClosureDigest: Sha256Digest;
  controlPlaneUpdateClosureDigest: Sha256Digest;
  recoveryClosureDigest: Sha256Digest;
  repairAuthority: 'human-only-authority-plan-or-sealed-recovery';
  compositionDigest: Sha256Digest;
}

export interface RoleContextSharingGrantVerifierBinding {
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
}

export interface ProtectedCapabilityManifest {
  kind: 'protected-capability-manifest.v1';
  schemaVersion: 1;
  manifestPath: string;
  grantVerifierComposition?: CollaborationGrantVerifierComposition;
  entries: ProtectedCapabilityEntry[];
  manifestDigest: Sha256Digest;
}

export function protectedCapabilityClosureDigest(
  entrypoints: readonly string[],
  dependencies: readonly string[],
  contentDigest: Sha256Digest,
): Sha256Digest {
  for (const path of [...entrypoints, ...dependencies]) {
    assertSafePath(path, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  }
  assertSortedUnique(entrypoints, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  assertSortedUnique(dependencies, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  assertDigest(contentDigest, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  return canonicalDigest({ entrypoints, dependencies, contentDigest });
}

export function createCollaborationGrantVerifierComposition(
  value: unknown,
  entries: ProtectedCapabilityEntry[],
): CollaborationGrantVerifierComposition {
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
  ] as const;
  const exactKeys = [...keys, 'roleContextSharingGrant'];
  if (!hasExactObjectKeys(value, exactKeys)) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The Collaboration Grant verifier composition is malformed.',
      ExitCode.usage,
    );
  }
  const record = value as Record<string, unknown>;
  const expectedNamespaces = ['workflow.collaboration-grant.v2'] as const;
  const expectedEffects = ['role-independence-degradation-only'] as const;
  if (
    record.kind !== 'collaboration-grant-verifier-composition.v1' ||
    record.packageName !== '@jigwright/grants' ||
    record.packageVersion !== '0.1.0' ||
    record.packageManifestPath !== 'packages/grants/package.json' ||
    record.verifierImplementation !== 'ssh-maintainer-policy.v1' ||
    record.verifierContractVersion !== 'jigwright.grant-envelope-verifier.v1' ||
    record.readerContractVersion !==
      'jigwright.collaboration-grant-envelope-reader.v1' ||
    !Array.isArray(record.signatureNamespaces) ||
    !sameJson(record.signatureNamespaces, expectedNamespaces) ||
    !Array.isArray(record.authorizedEffects) ||
    !sameJson(record.authorizedEffects, expectedEffects) ||
    !Array.isArray(record.sourcePaths) ||
    !record.sourcePaths.every((entry) => typeof entry === 'string') ||
    record.sourcePaths.length === 0 ||
    typeof record.collaborationPolicyDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.collaborationPolicyDigest) ||
    typeof record.taskDiffReviewPolicyDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.taskDiffReviewPolicyDigest) ||
    record.repairAuthority !== 'human-only-authority-plan-or-sealed-recovery'
  ) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The Collaboration Grant verifier composition is malformed.',
      ExitCode.usage,
    );
  }
  for (const digestValue of [
    record.packageManifestDigest,
    record.sourceDigest,
    record.authorizationClosureDigest,
    record.humanTrustRootsClosureDigest,
    record.applyJournalClosureDigest,
    record.controlPlaneUpdateClosureDigest,
    record.recoveryClosureDigest,
    record.compositionDigest,
  ]) {
    assertDigest(digestValue, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  }
  const sourcePaths = [...record.sourcePaths] as string[];
  for (const sourcePath of sourcePaths) {
    assertSafePath(sourcePath, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  }
  assertSortedUnique(sourcePaths, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  if (!sourcePaths.includes('packages/grants/package.json')) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The Collaboration Grant verifier composition must bind its package manifest.',
      ExitCode.usage,
    );
  }
  const closure = (capability: ProtectedCapability): Sha256Digest => {
    const entry = entries.find(
      (candidate) => candidate.capability === capability,
    );
    if (entry === undefined) {
      throw workflowError(
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
        `The Collaboration Grant verifier composition lacks ${capability}.`,
        ExitCode.usage,
      );
    }
    return entry.closureDigest;
  };
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
    ) ||
    record.authorizationClosureDigest !== closure('authorization.verify') ||
    record.humanTrustRootsClosureDigest !== closure('human.trust-roots') ||
    record.applyJournalClosureDigest !== closure('apply.journal') ||
    record.controlPlaneUpdateClosureDigest !==
      closure('control-plane.update') ||
    record.recoveryClosureDigest !== closure('recovery.rollback')
  ) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The Collaboration Grant verifier composition is not bound to the protected closure.',
      ExitCode.verification,
    );
  }
  const roleContextSharingGrant = createRoleContextSharingGrantVerifierBinding(
    record.roleContextSharingGrant,
    authorization,
    closure('authorization.verify'),
  );
  const payload = {
    kind: record.kind,
    packageName: record.packageName,
    packageVersion: record.packageVersion,
    packageManifestPath: record.packageManifestPath,
    packageManifestDigest: record.packageManifestDigest,
    verifierImplementation: record.verifierImplementation,
    verifierContractVersion: record.verifierContractVersion,
    readerContractVersion: record.readerContractVersion,
    signatureNamespaces: [...expectedNamespaces],
    authorizedEffects: [...expectedEffects],
    sourcePaths,
    sourceDigest: record.sourceDigest,
    collaborationPolicyDigest: record.collaborationPolicyDigest,
    taskDiffReviewPolicyDigest: record.taskDiffReviewPolicyDigest,
    roleContextSharingGrant,
    authorizationClosureDigest: record.authorizationClosureDigest,
    humanTrustRootsClosureDigest: record.humanTrustRootsClosureDigest,
    applyJournalClosureDigest: record.applyJournalClosureDigest,
    controlPlaneUpdateClosureDigest: record.controlPlaneUpdateClosureDigest,
    recoveryClosureDigest: record.recoveryClosureDigest,
    repairAuthority: record.repairAuthority,
  } as Omit<CollaborationGrantVerifierComposition, 'compositionDigest'>;
  if (record.compositionDigest !== canonicalDigest(payload)) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The Collaboration Grant verifier composition digest is invalid.',
      ExitCode.verification,
    );
  }
  return freezeDeep({
    ...payload,
    compositionDigest: record.compositionDigest as Sha256Digest,
  });
}

export function createRoleContextSharingGrantVerifierBinding(
  value: unknown,
  authorization: ProtectedCapabilityEntry,
  authorizationClosureDigest: Sha256Digest,
): RoleContextSharingGrantVerifierBinding {
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
  ] as const;
  if (!hasExactObjectKeys(value, keys)) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The role-context-sharing Grant verifier binding is malformed.',
      ExitCode.usage,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'role-context-sharing-grant-verifier-binding.v1' ||
    record.packageExport !== './role-context-sharing-degradation' ||
    record.packageExportTarget !==
      './src/role-context-sharing-degradation.ts' ||
    record.readerContractVersion !==
      'jigwright.role-context-sharing-grant-reader.v1' ||
    record.signatureNamespace !== 'workflow.role-context-sharing-grant.v1' ||
    record.authorizedEffect !== 'role-context-sharing-degradation' ||
    typeof record.policyDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.policyDigest) ||
    !Array.isArray(record.sourcePaths) ||
    record.sourcePaths.length === 0 ||
    !record.sourcePaths.every((entry) => typeof entry === 'string')
  ) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The role-context-sharing Grant verifier binding is malformed.',
      ExitCode.usage,
    );
  }
  assertDigest(record.sourceDigest, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  assertDigest(
    record.authorizationClosureDigest,
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
  );
  const sourcePaths = [...record.sourcePaths] as string[];
  for (const sourcePath of sourcePaths) {
    assertSafePath(sourcePath, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  }
  assertSortedUnique(sourcePaths, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
  if (
    !sourcePaths.includes('packages/grants/package.json') ||
    sourcePaths.some(
      (sourcePath) =>
        ![...authorization.entrypoints, ...authorization.dependencies].includes(
          sourcePath,
        ),
    ) ||
    record.authorizationClosureDigest !== authorizationClosureDigest
  ) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'The role-context-sharing Grant verifier binding is not bound to authorization.verify.',
      ExitCode.verification,
    );
  }
  return freezeDeep({
    kind: record.kind,
    packageExport: record.packageExport,
    packageExportTarget: record.packageExportTarget,
    readerContractVersion: record.readerContractVersion,
    signatureNamespace: record.signatureNamespace,
    authorizedEffect: record.authorizedEffect,
    policyDigest: record.policyDigest,
    sourcePaths,
    sourceDigest: record.sourceDigest as Sha256Digest,
    authorizationClosureDigest:
      record.authorizationClosureDigest as Sha256Digest,
  });
}

export function protectedManifestPayload(
  input: Omit<ProtectedCapabilityManifest, 'manifestDigest'>,
) {
  return { ...input };
}

export function createProtectedCapabilityManifest(input: {
  schemaVersion: 1;
  manifestPath: string;
  grantVerifierComposition?: unknown;
  entries: ProtectedCapabilityEntry[];
}): ProtectedCapabilityManifest {
  if (input.schemaVersion !== 1) {
    throw workflowError(
      'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      'Unknown manifest schema.',
      ExitCode.usage,
    );
  }
  assertSafePath(
    input.manifestPath,
    false,
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
  );
  const entries = [...input.entries]
    .map((entry) => {
      if (!REQUIRED_PROTECTED_CAPABILITIES.includes(entry.capability)) {
        throw workflowError(
          'PROTECTED_CAPABILITY_UNKNOWN',
          `Unknown protected capability: ${String(entry.capability)}`,
          ExitCode.guard,
        );
      }
      if (entry.entrypoints.length === 0) {
        throw workflowError(
          'PROTECTED_CAPABILITY_MANIFEST_INVALID',
          `Protected capability ${entry.capability} needs an entrypoint.`,
          ExitCode.usage,
        );
      }
      for (const path of [...entry.entrypoints, ...entry.dependencies]) {
        assertSafePath(path, false, 'PROTECTED_CAPABILITY_MANIFEST_INVALID');
      }
      assertSortedUnique(
        entry.entrypoints,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      assertSortedUnique(
        entry.dependencies,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      assertDigest(
        entry.contentDigest,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      assertDigest(
        entry.closureDigest,
        'PROTECTED_CAPABILITY_MANIFEST_INVALID',
      );
      if (
        entry.closureDigest !==
        protectedCapabilityClosureDigest(
          entry.entrypoints,
          entry.dependencies,
          entry.contentDigest,
        )
      ) {
        throw workflowError(
          'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH',
          `Protected capability ${entry.capability} closure digest is invalid.`,
          ExitCode.verification,
        );
      }
      return {
        capability: entry.capability,
        entrypoints: [...entry.entrypoints],
        dependencies: [...entry.dependencies],
        contentDigest: entry.contentDigest,
        closureDigest: entry.closureDigest,
      };
    })
    .sort((left, right) =>
      compareCanonicalStrings(left.capability, right.capability),
    );
  assertSortedUnique(
    entries.map((entry) => entry.capability),
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
  );
  const missing = REQUIRED_PROTECTED_CAPABILITIES.filter(
    (capability) => !entries.some((entry) => entry.capability === capability),
  );
  if (missing.length > 0) {
    throw workflowError(
      'PROTECTED_CAPABILITY_REQUIRED_MISSING',
      `Protected capability manifest is missing: ${missing.join(', ')}`,
      ExitCode.guard,
    );
  }
  const grantVerifierComposition =
    input.grantVerifierComposition === undefined
      ? undefined
      : createCollaborationGrantVerifierComposition(
          input.grantVerifierComposition,
          entries,
        );
  const payload = protectedManifestPayload({
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: input.manifestPath,
    ...(grantVerifierComposition === undefined
      ? {}
      : { grantVerifierComposition }),
    entries,
  });
  return freezeDeep({ ...payload, manifestDigest: canonicalDigest(payload) });
}
