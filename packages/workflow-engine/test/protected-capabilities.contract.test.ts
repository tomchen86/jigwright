import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  classifyProtectedCapabilityPaths,
  computeProtectedCapabilityEntryDigests,
  computeProtectedCapabilityEntryDigestsFromWorktree,
  loadProtectedCapabilitiesFromTrustBase,
  loadProtectedCapabilitiesFromWorktree,
  parseProtectedCapabilitiesManifestSource,
  projectCollaborationGrantVerifierCompositionFromWorktree,
  type Sha256Digest,
} from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';
const LOADER_PATH =
  'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
const GENERATOR_PATH =
  'packages/workflow-engine/bootstrap/generate-protected-capabilities.ts';
const SOURCE_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES = [
  'packages/agent-runtime/package.json',
  'packages/agent-runtime/src/built-in-provider-definition.ts',
  'packages/agent-runtime/src/index.ts',
  'packages/agent-runtime/src/provider-definition-snapshot.ts',
  'packages/core/package.json',
  'packages/core/src/canonical-json.ts',
  'packages/grants/package.json',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/grants/src/role-context-sharing-degradation.ts',
  'packages/workflow-engine/src/adapters/planning/openspec/documents/managed-change-contract.ts',
  'packages/workflow-engine/src/adapters/providers/built-in-provider-definition.ts',
  'packages/workflow-engine/src/adapters/signing/ssh/maintainer-signer.ts',
  'packages/workflow-engine/src/application/propose/plan-review-role-topology.ts',
  'packages/workflow-engine/src/application/propose/role-context-sharing-plan-review.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-approval-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-lifecycle-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
  'packages/workflow-engine/src/composition-root/role-topology-resolution-production.ts',
  'packages/workflow-engine/src/composition-root/validated-contract-context.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci-attestation.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci-planning.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci.ts',
  'packages/workflow-engine/src/entrypoints/cli/role-context-sharing-grant-cli.ts',
  'packages/workflow-engine/src/modules/assurance/planning-assurance-validator.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-consumed-replay.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-lifecycle-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-verifier-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/agent-role-plan.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-scheduler.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-topology-resolution.ts',
  'packages/workflow-engine/src/runtime/repository-transaction/agent-role-plan-store.ts',
  'packages/workflow-engine/src/runtime/storage-journal/role-context-sharing-store.ts',
] as const;

const R007_EQUIVALENT_PROTECTED_SOURCE_PATHS = [
  'packages/workflow-engine/src/modules/provider-orchestration/provider-registry.ts',
] as const;

function installTypedManifest(repository: string): string {
  const loader = path.join(repository, LOADER_PATH);
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, 'export const protectedLoader = true;\n');
  git(repository, ['add', LOADER_PATH]);
  git(repository, ['commit', '-m', 'Install protected capability loader']);

  const contentBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const entrypoints = [LOADER_PATH];
  const dependencies = [MANIFEST_PATH];
  const digests = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  const manifest = {
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: MANIFEST_PATH,
    entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
      capability,
      entrypoints,
      dependencies,
      ...digests,
    })),
  };
  fs.writeFileSync(
    path.join(repository, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  git(repository, ['add', MANIFEST_PATH]);
  git(repository, ['commit', '-m', 'Install typed capability closure']);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function installTypedCompositionManifest(repository: string): string {
  const packageManifestPath: 'packages/grants/package.json' =
    'packages/grants/package.json';
  const sourcePaths = [
    packageManifestPath,
    'packages/grants/src/collaboration-grant-envelope-reader.ts',
    'packages/grants/src/grant-envelope-verifier.ts',
    'packages/grants/src/grant-lifecycle.ts',
  ];
  for (const [filePath, content] of [
    [LOADER_PATH, 'export const protectedLoader = true;\n'],
    [
      packageManifestPath,
      `${JSON.stringify(
        {
          name: '@jigwright/grants',
          version: '0.1.0',
          type: 'module',
          exports: {
            './collaboration-grant-envelope-reader':
              './src/collaboration-grant-envelope-reader.ts',
            './grant-envelope-verifier': './src/grant-envelope-verifier.ts',
            './grant-lifecycle': './src/grant-lifecycle.ts',
          },
        },
        null,
        2,
      )}\n`,
    ],
    [sourcePaths[1], 'export const reader = true;\n'],
    [sourcePaths[2], 'export const verifier = true;\n'],
    [sourcePaths[3], 'export const lifecycle = true;\n'],
  ] as const) {
    const absolute = path.join(repository, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install protected verifier sources']);

  const contentBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const entrypoints = [LOADER_PATH];
  const dependencies = [MANIFEST_PATH, ...sourcePaths].sort();
  const digests = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  const entries = REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
    capability,
    entrypoints,
    dependencies,
    ...digests,
  }));
  const zeroDigest = `sha256:${'0'.repeat(64)}` as Sha256Digest;
  const reviewed = {
    kind: 'collaboration-grant-verifier-composition.v1' as const,
    packageName: '@jigwright/grants' as const,
    packageVersion: '0.1.0' as const,
    packageManifestPath,
    packageManifestDigest: zeroDigest,
    verifierImplementation: 'ssh-maintainer-policy.v1' as const,
    verifierContractVersion: 'jigwright.grant-envelope-verifier.v1' as const,
    readerContractVersion:
      'jigwright.collaboration-grant-envelope-reader.v1' as const,
    signatureNamespaces: ['workflow.collaboration-grant.v2'] as [
      'workflow.collaboration-grant.v2',
    ],
    authorizedEffects: ['role-independence-degradation-only'] as [
      'role-independence-degradation-only',
    ],
    sourcePaths,
    sourceDigest: zeroDigest,
    collaborationPolicyDigest: '1'.repeat(64),
    taskDiffReviewPolicyDigest: '2'.repeat(64),
    authorizationClosureDigest: zeroDigest,
    humanTrustRootsClosureDigest: zeroDigest,
    applyJournalClosureDigest: zeroDigest,
    controlPlaneUpdateClosureDigest: zeroDigest,
    recoveryClosureDigest: zeroDigest,
    repairAuthority: 'human-only-authority-plan-or-sealed-recovery' as const,
    compositionDigest: zeroDigest,
  };
  const grantVerifierComposition =
    projectCollaborationGrantVerifierCompositionFromWorktree(
      repository,
      reviewed,
      entries,
    );
  const manifest = {
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: MANIFEST_PATH,
    grantVerifierComposition,
    entries,
  };
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  git(repository, ['add', MANIFEST_PATH]);
  git(repository, ['commit', '-m', 'Install verifier composition']);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

test('typed protected manifest verifies trust-base content and reports affected capabilities', () => {
  const repository = createFixtureRepository();
  try {
    const trustBase = installTypedManifest(repository);
    const manifest = loadProtectedCapabilitiesFromTrustBase(
      repository,
      trustBase,
    );
    assert.equal(manifest.kind, 'protected-capability-manifest.v1');
    assert.equal(
      manifest.entries.length,
      REQUIRED_PROTECTED_CAPABILITIES.length,
    );
    assert.match(manifest.manifestDigest, /^sha256:[0-9a-f]{64}$/);

    const loaderImpact = classifyProtectedCapabilityPaths(
      repository,
      trustBase,
      [LOADER_PATH],
    );
    assert.deepEqual(loaderImpact.protectedPaths, [LOADER_PATH]);
    assert.deepEqual(loaderImpact.affectedCapabilities, [
      ...REQUIRED_PROTECTED_CAPABILITIES,
    ]);

    const ordinaryImpact = classifyProtectedCapabilityPaths(
      repository,
      trustBase,
      ['src/ordinary.ts'],
    );
    assert.deepEqual(ordinaryImpact.protectedPaths, []);
    assert.deepEqual(ordinaryImpact.affectedCapabilities, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('typed protected manifest fails closed when closure content changes without regenerated digests', () => {
  const repository = createFixtureRepository();
  try {
    installTypedManifest(repository);
    fs.writeFileSync(
      path.join(repository, LOADER_PATH),
      'export const protectedLoader = false;\n',
    );
    git(repository, ['add', LOADER_PATH]);
    git(repository, ['commit', '-m', 'Tamper protected loader']);
    const staleTrustBase = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => loadProtectedCapabilitiesFromTrustBase(repository, staleTrustBase),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('trust-base verifier composition is recomputed from pinned sources', () => {
  const repository = createFixtureRepository();
  try {
    const trustBase = installTypedCompositionManifest(repository);
    assert.doesNotThrow(() =>
      loadProtectedCapabilitiesFromTrustBase(repository, trustBase),
    );

    const manifestPath = path.join(repository, MANIFEST_PATH);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: {
        packageManifestDigest: string;
        compositionDigest: string;
      };
    };
    manifest.grantVerifierComposition.packageManifestDigest = `sha256:${'f'.repeat(64)}`;
    manifest.grantVerifierComposition.compositionDigest = `sha256:${'e'.repeat(64)}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(repository, ['add', MANIFEST_PATH]);
    git(repository, ['commit', '-m', 'Forge verifier composition identity']);
    const forged = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => loadProtectedCapabilitiesFromTrustBase(repository, forged),
      (error) =>
        isWorkflowError(error, 'PROTECTED_GRANT_VERIFIER_COMPOSITION_MISMATCH'),
    );

    fs.writeFileSync(
      path.join(repository, 'packages/grants/src/grant-lifecycle.ts'),
      'export const lifecycle = false;\n',
    );
    assert.doesNotThrow(() =>
      loadProtectedCapabilitiesFromTrustBase(repository, trustBase),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('role-context-sharing composition binding is optional historically but exact when present', () => {
  const current = JSON.parse(
    fs.readFileSync(path.join(SOURCE_REPOSITORY_ROOT, MANIFEST_PATH), 'utf8'),
  ) as Record<string, unknown> & {
    grantVerifierComposition: Record<string, unknown>;
  };
  const historical = structuredClone(current);
  delete historical.grantVerifierComposition.roleContextSharingGrant;
  const parsedHistorical = parseProtectedCapabilitiesManifestSource(historical);
  assert.equal(
    parsedHistorical.grantVerifierComposition?.roleContextSharingGrant,
    undefined,
  );

  const zeroDigest = `sha256:${'0'.repeat(64)}`;
  const roleContextSharingGrant = {
    kind: 'role-context-sharing-grant-verifier-binding.v1',
    packageExport: './role-context-sharing-degradation',
    packageExportTarget: './src/role-context-sharing-degradation.ts',
    readerContractVersion: 'jigwright.role-context-sharing-grant-reader.v1',
    signatureNamespace: 'workflow.role-context-sharing-grant.v1',
    authorizedEffect: 'role-context-sharing-degradation',
    policyDigest: '1'.repeat(64),
    sourcePaths: [...ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES],
    sourceDigest: zeroDigest,
    authorizationClosureDigest: zeroDigest,
  };
  const present = structuredClone(historical);
  present.grantVerifierComposition = {
    ...present.grantVerifierComposition,
    roleContextSharingGrant,
  };
  assert.deepEqual(
    parseProtectedCapabilitiesManifestSource(present).grantVerifierComposition
      ?.roleContextSharingGrant,
    roleContextSharingGrant,
  );

  for (const invalid of [
    { ...roleContextSharingGrant, unreviewedFallback: true },
    (({ policyDigest: _omitted, ...partial }) => partial)(
      roleContextSharingGrant,
    ),
  ]) {
    assert.throws(
      () =>
        parseProtectedCapabilitiesManifestSource({
          ...historical,
          grantVerifierComposition: {
            ...historical.grantVerifierComposition,
            roleContextSharingGrant: invalid,
          },
        }),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_MANIFEST_INVALID'),
    );
  }
});

test('R-007 topology inputs use either the exact binding or an equivalent current protected closure', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SOURCE_REPOSITORY_ROOT, MANIFEST_PATH), 'utf8'),
  ) as {
    entries: Array<{
      entrypoints: string[];
      dependencies: string[];
    }>;
  };
  for (const sourcePath of R007_EQUIVALENT_PROTECTED_SOURCE_PATHS) {
    assert.ok(
      manifest.entries.some(({ entrypoints, dependencies }) =>
        [...entrypoints, ...dependencies].includes(sourcePath),
      ),
      `${sourcePath} must participate in worktree currentness even when another protected capability owns it`,
    );
  }
});

test('flat path manifests, incomplete capability sets, and case-fold aliases are rejected', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(
      path.join(repository, MANIFEST_PATH),
      `${JSON.stringify({ schemaVersion: 1, protectedPaths: [MANIFEST_PATH] })}\n`,
    );
    git(repository, ['add', MANIFEST_PATH]);
    git(repository, ['commit', '-m', 'Install obsolete flat manifest']);
    const flatTrustBase = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => loadProtectedCapabilitiesFromTrustBase(repository, flatTrustBase),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_MANIFEST_INVALID'),
    );

    assert.throws(
      () =>
        computeProtectedCapabilityEntryDigests(repository, flatTrustBase, {
          entrypoints: [
            'packages/workflow-engine/src/Engine.ts',
            'packages/workflow-engine/src/engine.ts',
          ],
          dependencies: [MANIFEST_PATH],
        }),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_MANIFEST_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('worktree closure identity matches the committed trust-base identity and detects candidate bytes', () => {
  const repository = createFixtureRepository();
  try {
    const loader = path.join(repository, LOADER_PATH);
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'export const protectedLoader = true;\n');
    const paths = {
      entrypoints: [LOADER_PATH],
      dependencies: [MANIFEST_PATH],
    };
    const candidate = computeProtectedCapabilityEntryDigestsFromWorktree(
      repository,
      paths,
    );

    git(repository, ['add', LOADER_PATH]);
    git(repository, ['commit', '-m', 'Commit candidate closure']);
    const committed = computeProtectedCapabilityEntryDigests(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      paths,
    );
    assert.deepEqual(candidate, committed);

    fs.writeFileSync(loader, 'export const protectedLoader = false;\n');
    assert.notDeepEqual(
      computeProtectedCapabilityEntryDigestsFromWorktree(repository, paths),
      committed,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected closure content uses canonical code-unit order for non-ASCII paths', () => {
  const repository = createFixtureRepository();
  const entrypoints = ['protected/Zeta.ts', 'protected/éclair.ts'];
  try {
    for (const filePath of entrypoints) {
      const absolute = path.join(repository, filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        `export const path = ${JSON.stringify(filePath)};\n`,
      );
    }

    const result = computeProtectedCapabilityEntryDigestsFromWorktree(
      repository,
      { entrypoints, dependencies: [] },
    );
    const files = entrypoints.map((filePath) => {
      const content = fs.readFileSync(path.join(repository, filePath));
      return {
        path: filePath,
        mode: '100644',
        objectId: crypto
          .createHash('sha1')
          .update(Buffer.from(`blob ${content.length}\0`))
          .update(content)
          .digest('hex'),
      };
    });
    const expectedContentDigest = `sha256:${crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          kind: 'protected-capability-content.v1',
          files,
        }),
      )
      .digest('hex')}`;

    assert.equal(result.contentDigest, expectedContentDigest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('unrelated gitlinks do not invalidate a regular-file protected closure', () => {
  const repository = createFixtureRepository();
  try {
    const loader = path.join(repository, LOADER_PATH);
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'export const protectedLoader = true;\n');
    git(repository, ['add', LOADER_PATH]);
    git(repository, ['commit', '-m', 'Install protected loader']);
    const gitlinkTarget = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlinkTarget},vendor/example`,
    ]);
    git(repository, ['commit', '-m', 'Add unrelated gitlink']);

    assert.doesNotThrow(() =>
      computeProtectedCapabilityEntryDigests(
        repository,
        git(repository, ['rev-parse', 'HEAD']).trim(),
        {
          entrypoints: [LOADER_PATH],
          dependencies: [MANIFEST_PATH],
        },
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository publishes the complete typed control-plane capability closure', () => {
  const value = JSON.parse(
    fs.readFileSync(path.join(SOURCE_REPOSITORY_ROOT, MANIFEST_PATH), 'utf8'),
  ) as {
    kind?: unknown;
    schemaVersion?: unknown;
    manifestPath?: unknown;
    entries?: Array<{
      capability?: unknown;
      entrypoints?: unknown;
      dependencies?: unknown;
      contentDigest?: unknown;
      closureDigest?: unknown;
    }>;
  };
  assert.equal(value.kind, 'protected-capability-manifest.v1');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.manifestPath, MANIFEST_PATH);
  assert.deepEqual(
    value.entries?.map(({ capability }) => capability),
    [...REQUIRED_PROTECTED_CAPABILITIES],
  );
  for (const entry of value.entries ?? []) {
    assert.ok(Array.isArray(entry.entrypoints));
    assert.ok((entry.entrypoints as unknown[]).length > 0);
    assert.ok(Array.isArray(entry.dependencies));
    assert.match(String(entry.contentDigest), /^sha256:[0-9a-f]{64}$/);
    assert.match(String(entry.closureDigest), /^sha256:[0-9a-f]{64}$/);
  }

  const byCapability = new Map(
    (value.entries ?? []).map((entry) => [entry.capability, entry]),
  );
  assert.equal(
    (byCapability.get('audit.append')?.entrypoints as unknown[]).includes(
      'packages/workflow-engine/src/runtime/storage-journal/authority-audit-ledger.ts',
    ),
    true,
  );
  assert.equal(
    (byCapability.get('apply.journal')?.entrypoints as unknown[]).includes(
      'packages/workflow-engine/src/application/control-plane/maintainer-recovery.ts',
    ),
    true,
  );
  assert.equal(
    (byCapability.get('apply.journal')?.entrypoints as unknown[]).includes(
      'packages/workflow-engine/src/application/control-plane/authority-plan.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('authorization.verify')?.entrypoints as unknown[]
    ).includes(
      'packages/workflow-engine/src/entrypoints/ci/pre-merge-assurance-git.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('authorization.verify')?.dependencies as unknown[]
    ).includes(
      'packages/workflow-engine/src/modules/assurance/pre-merge-assurance.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('control-plane.update')?.entrypoints as unknown[]
    ).includes(
      'packages/workflow-engine/src/application/control-plane/intervention-control-updater.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('control-plane.update')?.entrypoints as unknown[]
    ).includes(GENERATOR_PATH),
    true,
  );
  assert.equal(
    (byCapability.get('policy.classify')?.entrypoints as unknown[]).includes(
      GENERATOR_PATH,
    ),
    true,
  );
});

test('repository protected capability manifest is generator-current', () => {
  const result = runProtectedCapabilityGenerator(
    path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH),
    SOURCE_REPOSITORY_ROOT,
    '--check',
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('protected generator refuses to synthesize a missing Grant verifier composition', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'protected-grant-composition-missing-'),
  );
  const generator = path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH);
  const compositionSources = [
    'packages/grants/package.json',
    'packages/grants/src/collaboration-grant-envelope-reader.ts',
    'packages/grants/src/grant-envelope-verifier.ts',
    'packages/grants/src/grant-lifecycle.ts',
    'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
    'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
    'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
  ];
  try {
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    for (const sourcePath of [LOADER_PATH, ...compositionSources]) {
      const absolute = path.join(repository, sourcePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        sourcePath === 'packages/grants/package.json'
          ? `${JSON.stringify({ name: '@jigwright/grants', version: '0.1.0' })}\n`
          : `export const fixture = ${JSON.stringify(sourcePath)};\n`,
      );
    }
    const staleDigest = `sha256:${'0'.repeat(64)}`;
    const manifest = {
      kind: 'protected-capability-manifest.v1',
      schemaVersion: 1,
      manifestPath: MANIFEST_PATH,
      entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
        capability,
        entrypoints: [LOADER_PATH],
        dependencies:
          capability === 'authorization.verify'
            ? [...compositionSources, MANIFEST_PATH].sort()
            : [MANIFEST_PATH],
        contentDigest: staleDigest,
        closureDigest: staleDigest,
      })),
    };
    const manifestPath = path.join(repository, MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const reviewedBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, reviewedBytes);
    git(repository, ['add', '.']);

    const result = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /reviewed protected manifest does not declare/i,
    );
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), reviewedBytes);

    const explicitMissing = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--initialize-collaboration-grant-verifier',
    );
    assert.notEqual(explicitMissing.status, 0);
    assert.match(
      `${explicitMissing.stdout}${explicitMissing.stderr}`,
      /exact pre-migration shape/i,
    );
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), reviewedBytes);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected generator initializes only the exact reviewed pre-migration Grant verifier composition', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'protected-grant-composition-initialize-'),
  );
  const generator = path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH);
  const additionalSources = [
    'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
    'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
    'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
  ];
  try {
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    installTypedCompositionManifest(repository);
    for (const sourcePath of additionalSources) {
      const absolute = path.join(repository, sourcePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        `export const fixture = ${JSON.stringify(sourcePath)};\n`,
      );
    }
    const manifestPath = path.join(repository, MANIFEST_PATH);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: Record<string, unknown> & {
        sourcePaths: string[];
      };
      entries: Array<{
        capability: string;
        dependencies: string[];
      }>;
    };
    manifest.grantVerifierComposition.sourcePaths = [
      ...manifest.grantVerifierComposition.sourcePaths,
      ...additionalSources,
    ].sort();
    delete manifest.grantVerifierComposition.packageVersion;
    delete manifest.grantVerifierComposition.verifierImplementation;
    const authorization = manifest.entries.find(
      ({ capability }) => capability === 'authorization.verify',
    );
    assert.ok(authorization);
    authorization.dependencies = [
      ...authorization.dependencies,
      ...additionalSources,
    ].sort();
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const explicitMigration = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--initialize-collaboration-grant-verifier',
    );
    assert.equal(
      explicitMigration.status,
      0,
      `${explicitMigration.stdout}${explicitMigration.stderr}`,
    );
    const initialized = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: {
        packageVersion: string;
        verifierImplementation: string;
      };
    };
    assert.equal(initialized.grantVerifierComposition.packageVersion, '0.1.0');
    assert.equal(
      initialized.grantVerifierComposition.verifierImplementation,
      'ssh-maintainer-policy.v1',
    );

    const repeatedMigration = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--initialize-collaboration-grant-verifier',
    );
    assert.notEqual(repeatedMigration.status, 0);
    assert.match(
      `${repeatedMigration.stdout}${repeatedMigration.stderr}`,
      /exact pre-migration shape/i,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected generator authorizes role-context-sharing only through the exact one-time migration', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'protected-role-context-composition-authorize-'),
  );
  const generator = path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH);
  const additionalCollaborationSources = [
    'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
    'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
    'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
  ];
  try {
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    installTypedCompositionManifest(repository);
    for (const sourcePath of additionalCollaborationSources) {
      const absolute = path.join(repository, sourcePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        `export const fixture = ${JSON.stringify(sourcePath)};\n`,
      );
    }
    for (const sourcePath of ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES) {
      const absolute = path.join(repository, sourcePath);
      if (fs.existsSync(absolute)) continue;
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        `export const fixture = ${JSON.stringify(sourcePath)};\n`,
      );
    }
    const packagePath = path.join(repository, 'packages/grants/package.json');
    const packageManifest = JSON.parse(
      fs.readFileSync(packagePath, 'utf8'),
    ) as {
      exports: Record<string, string>;
    };
    packageManifest.exports['./role-context-sharing-degradation'] =
      './src/role-context-sharing-degradation.ts';
    fs.writeFileSync(
      packagePath,
      `${JSON.stringify(packageManifest, null, 2)}\n`,
    );
    const manifestPath = path.join(repository, MANIFEST_PATH);
    const reviewed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: { sourcePaths: string[] };
      entries: Array<{ capability: string; dependencies: string[] }>;
    };
    reviewed.grantVerifierComposition.sourcePaths = [
      ...new Set([
        ...reviewed.grantVerifierComposition.sourcePaths,
        ...additionalCollaborationSources,
      ]),
    ].sort();
    const reviewedAuthorization = reviewed.entries.find(
      ({ capability }) => capability === 'authorization.verify',
    );
    assert.ok(reviewedAuthorization);
    reviewedAuthorization.dependencies = [
      ...new Set([
        ...reviewedAuthorization.dependencies,
        ...additionalCollaborationSources,
      ]),
    ].sort();
    fs.writeFileSync(manifestPath, `${JSON.stringify(reviewed, null, 2)}\n`);

    const ordinary = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.equal(ordinary.status, 0, `${ordinary.stdout}${ordinary.stderr}`);
    const before = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: Record<string, unknown>;
    };
    assert.equal(
      'roleContextSharingGrant' in before.grantVerifierComposition,
      false,
    );

    const authorized = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--authorize-role-context-sharing-grant',
    );
    assert.equal(
      authorized.status,
      0,
      `${authorized.stdout}${authorized.stderr}`,
    );
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: {
        roleContextSharingGrant: {
          sourcePaths: string[];
          policyDigest: string;
        };
      };
      entries: Array<{ capability: string; dependencies: string[] }>;
    };
    assert.deepEqual(
      after.grantVerifierComposition.roleContextSharingGrant.sourcePaths,
      ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES,
    );
    assert.match(
      after.grantVerifierComposition.roleContextSharingGrant.policyDigest,
      /^[0-9a-f]{64}$/,
    );
    const authorization = after.entries.find(
      ({ capability }) => capability === 'authorization.verify',
    );
    assert.ok(authorization);
    for (const sourcePath of ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES) {
      assert.ok(authorization.dependencies.includes(sourcePath));
    }

    const terminalReceiptExpansionSources = new Set<string>([
      'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
      'packages/workflow-engine/src/entrypoints/ci/ci-attestation.ts',
      'packages/workflow-engine/src/entrypoints/ci/ci-planning.ts',
      'packages/workflow-engine/src/entrypoints/ci/ci.ts',
      'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
    ]);
    const legacy = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      grantVerifierComposition: {
        roleContextSharingGrant: { sourcePaths: string[] };
      };
      entries: Array<{ capability: string; dependencies: string[] }>;
    };
    legacy.grantVerifierComposition.roleContextSharingGrant.sourcePaths =
      ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES.filter(
        (sourcePath) => !terminalReceiptExpansionSources.has(sourcePath),
      );
    assert.equal(
      legacy.grantVerifierComposition.roleContextSharingGrant.sourcePaths
        .length,
      31,
    );
    const legacyAuthorization = legacy.entries.find(
      ({ capability }) => capability === 'authorization.verify',
    );
    assert.ok(legacyAuthorization);
    legacyAuthorization.dependencies = legacyAuthorization.dependencies.filter(
      (sourcePath) =>
        sourcePath !==
        'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
    );
    fs.writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const reprojectedLegacy = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.equal(
      reprojectedLegacy.status,
      0,
      `${reprojectedLegacy.stdout}${reprojectedLegacy.stderr}`,
    );
    const expanded = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--authorize-role-context-sharing-grant',
    );
    assert.equal(expanded.status, 0, `${expanded.stdout}${expanded.stderr}`);
    const expandedManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as {
      grantVerifierComposition: {
        roleContextSharingGrant: { sourcePaths: string[] };
      };
      entries: Array<{ capability: string; dependencies: string[] }>;
    };
    assert.deepEqual(
      expandedManifest.grantVerifierComposition.roleContextSharingGrant
        .sourcePaths,
      ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES,
    );
    assert.ok(
      expandedManifest.entries
        .find(({ capability }) => capability === 'authorization.verify')
        ?.dependencies.includes(
          'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
        ),
    );

    assert.doesNotThrow(() =>
      loadProtectedCapabilitiesFromWorktree(repository),
    );
    const driftedSource = ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES.find(
      (sourcePath) =>
        sourcePath.endsWith('/role-context-sharing-plan-review.ts'),
    );
    assert.ok(driftedSource);
    fs.appendFileSync(
      path.join(repository, driftedSource),
      'export const unreviewedAuthorityDrift = true;\n',
    );
    assert.throws(
      () => loadProtectedCapabilitiesFromWorktree(repository),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH'),
    );
    fs.rmSync(path.join(repository, driftedSource));
    assert.throws(() => loadProtectedCapabilitiesFromWorktree(repository));

    const repeated = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--authorize-role-context-sharing-grant',
    );
    assert.notEqual(repeated.status, 0);
    assert.match(
      `${repeated.stdout}${repeated.stderr}`,
      /exact pre-authorization shape/i,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository-owned protected capability generator writes, checks, and preserves the manifest-self sentinel', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'protected-capability-generator-'),
  );
  const generator = path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH);
  const protectedDependency = 'src/protected.ts';
  try {
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    for (const [filePath, content] of [
      [LOADER_PATH, 'export const protectedLoader = true;\n'],
      [protectedDependency, 'export const protectedValue = true;\n'],
    ] as const) {
      const absolute = path.join(repository, filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
    const staleDigest = `sha256:${'0'.repeat(64)}`;
    const manifest = {
      kind: 'protected-capability-manifest.v1',
      schemaVersion: 1,
      manifestPath: MANIFEST_PATH,
      entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
        capability,
        entrypoints: [LOADER_PATH],
        dependencies: [protectedDependency, MANIFEST_PATH],
        contentDigest: staleDigest,
        closureDigest: staleDigest,
      })),
    };
    const manifestAbsolute = path.join(repository, MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifestAbsolute), { recursive: true });
    fs.writeFileSync(
      manifestAbsolute,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    git(repository, ['add', '.']);

    const staleCheck = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--check',
    );
    assert.notEqual(staleCheck.status, 0);
    assert.match(`${staleCheck.stdout}${staleCheck.stderr}`, /stale/i);

    const write = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.equal(write.status, 0, write.stderr);
    const firstProjection = fs.readFileSync(manifestAbsolute, 'utf8');
    const projected = JSON.parse(firstProjection) as {
      entries: Array<{
        capability: string;
        entrypoints: string[];
        dependencies: string[];
        contentDigest: string;
        closureDigest: string;
      }>;
    };
    assert.deepEqual(Object.keys(projected), [
      'kind',
      'schemaVersion',
      'manifestPath',
      'entries',
    ]);
    assert.deepEqual(
      projected.entries.map(({ capability }) => capability),
      [...REQUIRED_PROTECTED_CAPABILITIES],
    );
    for (const entry of projected.entries) {
      assert.deepEqual(entry.entrypoints, [LOADER_PATH]);
      assert.deepEqual(entry.dependencies, [
        protectedDependency,
        MANIFEST_PATH,
      ]);
      assert.notEqual(entry.contentDigest, staleDigest);
      assert.notEqual(entry.closureDigest, staleDigest);
    }
    const currentCheck = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--check',
    );
    assert.equal(currentCheck.status, 0, currentCheck.stderr);
    git(repository, ['add', '.']);
    git(repository, ['commit', '--quiet', '-m', 'Generate protected closure']);
    const trustBase = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      loadProtectedCapabilitiesFromTrustBase(repository, trustBase).entries
        .length,
      REQUIRED_PROTECTED_CAPABILITIES.length,
    );

    for (const entry of projected.entries) {
      entry.contentDigest = staleDigest;
      entry.closureDigest = staleDigest;
    }
    fs.writeFileSync(
      manifestAbsolute,
      `${JSON.stringify(projected, null, 2)}\n`,
    );
    const rewrite = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.equal(rewrite.status, 0, rewrite.stderr);
    assert.equal(fs.readFileSync(manifestAbsolute, 'utf8'), firstProjection);

    fs.writeFileSync(
      path.join(repository, protectedDependency),
      'export const protectedValue = false;\n',
    );
    const changedClosure = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--check',
    );
    assert.notEqual(changedClosure.status, 0);
    assert.match(`${changedClosure.stdout}${changedClosure.stderr}`, /stale/i);

    const invalidMode = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--unknown',
    );
    assert.notEqual(invalidMode.status, 0);
    assert.match(
      `${invalidMode.stdout}${invalidMode.stderr}`,
      /--check\|--write/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function runProtectedCapabilityGenerator(
  generator: string,
  repository: string,
  mode:
    | '--check'
    | '--write'
    | '--initialize-collaboration-grant-verifier'
    | '--authorize-role-context-sharing-grant'
    | '--unknown',
) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', generator, mode],
    { cwd: repository, encoding: 'utf8' },
  );
}
