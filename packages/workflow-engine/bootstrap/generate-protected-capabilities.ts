import fs from 'node:fs';
import path from 'node:path';

import {
  computeProtectedCapabilityEntryDigestsFromWorktree,
  parseProtectedCapabilitiesManifestSource,
  projectCollaborationGrantVerifierCompositionFromWorktree,
  type ProtectedCapabilitiesManifestSource,
} from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { compareCanonicalStrings } from '../src/foundation/canonical-json/canonical-json.ts';
import { ROLE_CONTEXT_SHARING_POLICY_DIGEST } from '../src/modules/authority/role-context-sharing-grant.ts';
import { replaceTextAtomic } from '../src/runtime/repository-transaction/atomic-text.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';
const GRANTS_PACKAGE_PATH = 'packages/grants/package.json';
const COLLABORATION_GRANT_COMPOSITION_SOURCES = [
  GRANTS_PACKAGE_PATH,
  'packages/grants/src/collaboration-grant-envelope-reader.ts',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
] as const;
const ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES = [
  'packages/agent-runtime/package.json',
  'packages/agent-runtime/src/built-in-provider-definition.ts',
  'packages/agent-runtime/src/index.ts',
  'packages/agent-runtime/src/provider-definition-snapshot.ts',
  'packages/core/package.json',
  'packages/core/src/canonical-json.ts',
  GRANTS_PACKAGE_PATH,
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
const ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_EXPANSION_SOURCES = [
  'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci-attestation.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci-planning.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
] as const;

export type ProtectedCapabilitiesGenerationMode = '--check' | '--write';
export type ProtectedCapabilitiesInitializationMode =
  | '--initialize-collaboration-grant-verifier'
  | '--authorize-role-context-sharing-grant';

export function projectProtectedCapabilitiesManifest(
  repositoryRoot: string,
): ProtectedCapabilitiesManifestSource {
  const root = fs.realpathSync(repositoryRoot);
  const source = readManifestSource(root);
  return projectProtectedCapabilitiesManifestFromSource(root, source);
}

function projectProtectedCapabilitiesManifestFromSource(
  root: string,
  source: ProtectedCapabilitiesManifestSource,
): ProtectedCapabilitiesManifestSource {
  const publishesGrantComposition = fs.existsSync(
    path.join(root, GRANTS_PACKAGE_PATH),
  );
  const entries = source.entries.map(
    ({ capability, entrypoints, dependencies: reviewedDependencies }) => {
      if (
        publishesGrantComposition &&
        capability === 'authorization.verify' &&
        COLLABORATION_GRANT_COMPOSITION_SOURCES.some(
          (sourcePath) => !reviewedDependencies.includes(sourcePath),
        )
      ) {
        throw new Error(
          'The reviewed authorization.verify closure does not declare the Collaboration Grant verifier composition.',
        );
      }
      const dependencies = reviewedDependencies;
      return {
        capability,
        entrypoints,
        dependencies,
        ...computeProtectedCapabilityEntryDigestsFromWorktree(root, {
          entrypoints,
          dependencies,
        }),
      };
    },
  );
  const reviewedComposition = source.grantVerifierComposition;
  if (publishesGrantComposition && reviewedComposition === undefined) {
    throw new Error(
      'The reviewed protected manifest does not declare the Collaboration Grant verifier composition.',
    );
  }
  return {
    kind: source.kind,
    schemaVersion: source.schemaVersion,
    manifestPath: source.manifestPath,
    ...(reviewedComposition === undefined
      ? {}
      : {
          grantVerifierComposition:
            projectCollaborationGrantVerifierCompositionFromWorktree(
              root,
              reviewedComposition,
              entries,
            ),
        }),
    entries,
  };
}

export function initializeCollaborationGrantVerifierComposition(
  repositoryRoot: string,
): ProtectedCapabilitiesManifestSource {
  const root = fs.realpathSync(repositoryRoot);
  const manifestPath = path.join(root, MANIFEST_PATH);
  const parsed = parseJson(readRegularTextFile(manifestPath));
  if (!isRecord(parsed) || !isRecord(parsed.grantVerifierComposition)) {
    throw new Error(
      'The protected manifest does not have the exact pre-migration shape.',
    );
  }
  const composition = parsed.grantVerifierComposition;
  const expectedKeys = [
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
    'readerContractVersion',
    'recoveryClosureDigest',
    'repairAuthority',
    'signatureNamespaces',
    'sourceDigest',
    'sourcePaths',
    'taskDiffReviewPolicyDigest',
    'verifierContractVersion',
  ];
  if (
    Object.hasOwn(composition, 'packageVersion') ||
    Object.hasOwn(composition, 'verifierImplementation') ||
    !hasExactKeys(composition, expectedKeys)
  ) {
    throw new Error(
      'The Collaboration Grant verifier composition does not have the exact pre-migration shape.',
    );
  }
  const initialized = parseProtectedCapabilitiesManifestSource({
    ...parsed,
    grantVerifierComposition: {
      ...composition,
      packageVersion: '0.1.0',
      verifierImplementation: 'ssh-maintainer-policy.v1',
    },
  });
  const projected = projectProtectedCapabilitiesManifestFromSource(
    root,
    initialized,
  );
  replaceTextAtomic(manifestPath, renderManifestJson(projected));
  return projected;
}

export function authorizeRoleContextSharingGrantVerifierComposition(
  repositoryRoot: string,
): ProtectedCapabilitiesManifestSource {
  const root = fs.realpathSync(repositoryRoot);
  const manifestPath = path.join(root, MANIFEST_PATH);
  const source = readManifestSource(root);
  const composition = source.grantVerifierComposition;
  const reviewedRoleContextSharingBinding =
    composition?.roleContextSharingGrant;
  const preTerminalReceiptSources =
    ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES.filter(
      (sourcePath) =>
        !ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_EXPANSION_SOURCES.includes(
          sourcePath as (typeof ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_EXPANSION_SOURCES)[number],
        ),
    );
  if (
    composition === undefined ||
    (reviewedRoleContextSharingBinding !== undefined &&
      (preTerminalReceiptSources.length !== 31 ||
        reviewedRoleContextSharingBinding.policyDigest !==
          ROLE_CONTEXT_SHARING_POLICY_DIGEST ||
        reviewedRoleContextSharingBinding.sourcePaths.length !==
          preTerminalReceiptSources.length ||
        reviewedRoleContextSharingBinding.sourcePaths.some(
          (sourcePath, index) =>
            sourcePath !== preTerminalReceiptSources[index],
        )))
  ) {
    throw new Error(
      'The Collaboration Grant verifier composition does not have the exact pre-authorization shape.',
    );
  }
  const entries = source.entries.map((entry) =>
    entry.capability === 'authorization.verify'
      ? {
          ...entry,
          dependencies: [
            ...new Set([
              ...entry.dependencies,
              ...ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES,
            ]),
          ].sort(compareCanonicalStrings),
        }
      : entry,
  );
  const zeroDigest = `sha256:${'0'.repeat(64)}` as const;
  const authorized = parseProtectedCapabilitiesManifestSource({
    ...source,
    entries,
    grantVerifierComposition: {
      ...composition,
      roleContextSharingGrant: {
        kind: 'role-context-sharing-grant-verifier-binding.v1',
        packageExport: './role-context-sharing-degradation',
        packageExportTarget: './src/role-context-sharing-degradation.ts',
        readerContractVersion: 'jigwright.role-context-sharing-grant-reader.v1',
        signatureNamespace: 'workflow.role-context-sharing-grant.v1',
        authorizedEffect: 'role-context-sharing-degradation',
        policyDigest: ROLE_CONTEXT_SHARING_POLICY_DIGEST,
        sourcePaths: [...ROLE_CONTEXT_SHARING_COMPOSITION_SOURCES],
        sourceDigest: zeroDigest,
        authorizationClosureDigest: zeroDigest,
      },
    },
  });
  const projected = projectProtectedCapabilitiesManifestFromSource(
    root,
    authorized,
  );
  replaceTextAtomic(manifestPath, renderManifestJson(projected));
  return projected;
}

export async function renderProtectedCapabilitiesManifest(
  repositoryRoot: string,
): Promise<string> {
  return renderManifestJson(
    projectProtectedCapabilitiesManifest(repositoryRoot),
  );
}

function renderManifestJson(
  manifest: ProtectedCapabilitiesManifestSource,
): string {
  const serialized = JSON.stringify(manifest, null, 2).replace(
    / {4}"authorizedEffects": \[\n {6}("(?:[^"\\]|\\.)*")\n {4}\]/u,
    '    "authorizedEffects": [$1]',
  );
  return `${serialized}\n`;
}

export async function generateProtectedCapabilitiesManifest(
  repositoryRoot: string,
  mode: ProtectedCapabilitiesGenerationMode,
): Promise<ProtectedCapabilitiesManifestSource> {
  const root = fs.realpathSync(repositoryRoot);
  const manifestPath = path.join(root, MANIFEST_PATH);
  const expected = await renderProtectedCapabilitiesManifest(root);
  if (mode === '--write') {
    replaceTextAtomic(manifestPath, expected);
  } else {
    const observed = readRegularTextFile(manifestPath);
    if (observed !== expected) {
      throw new Error(
        'Protected capability manifest is stale; run generate-protected-capabilities.ts --write.',
      );
    }
  }
  return parseProtectedCapabilitiesManifestSource(JSON.parse(expected));
}

function readManifestSource(
  repositoryRoot: string,
): ProtectedCapabilitiesManifestSource {
  const manifestPath = path.join(repositoryRoot, MANIFEST_PATH);
  return parseProtectedCapabilitiesManifestSource(
    parseJson(readRegularTextFile(manifestPath)),
  );
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error('Protected capability manifest is not valid JSON.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function readRegularTextFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw new Error('Protected capability manifest path is unsafe.');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function parseMode(
  argv: readonly string[],
):
  | ProtectedCapabilitiesGenerationMode
  | ProtectedCapabilitiesInitializationMode {
  if (
    argv.length !== 1 ||
    (argv[0] !== '--check' &&
      argv[0] !== '--write' &&
      argv[0] !== '--initialize-collaboration-grant-verifier' &&
      argv[0] !== '--authorize-role-context-sharing-grant')
  ) {
    throw new Error(
      'Usage: generate-protected-capabilities.ts [--check|--write|--initialize-collaboration-grant-verifier|--authorize-role-context-sharing-grant]',
    );
  }
  return argv[0];
}

if (import.meta.main) {
  const mode = parseMode(process.argv.slice(2));
  const manifest =
    mode === '--initialize-collaboration-grant-verifier'
      ? initializeCollaborationGrantVerifierComposition(process.cwd())
      : mode === '--authorize-role-context-sharing-grant'
        ? authorizeRoleContextSharingGrantVerifierComposition(process.cwd())
        : await generateProtectedCapabilitiesManifest(process.cwd(), mode);
  process.stdout.write(
    `${JSON.stringify({
      command: 'protected-capabilities',
      ok: true,
      mode,
      entries: manifest.entries.length,
    })}\n`,
  );
}
