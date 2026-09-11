/**
 * Projects the protected capability manifest: for each protected capability,
 * the reviewed entrypoints and dependency sources with their content and closure
 * digests, plus the grant verifier composition binding when the grants package
 * is present.
 *
 * Invariants:
 * - The manifest bytes are generator-owned; `--check` compares them exactly, so
 *   never reformat the file by hand or with prettier.
 * - Digests come from the current tree, so regenerate after the built-in
 *   closure and the harness bootstrap runtime, in that order.
 * - The authorization.verify capability must list every collaboration grant
 *   composition source; an omission is an error, never a silent widening.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  computeProtectedCapabilityEntryDigestsFromWorktree,
  parseProtectedCapabilitiesManifestSource,
  projectCollaborationGrantVerifierCompositionFromWorktree,
  type ProtectedCapabilitiesManifestSource,
} from '../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
import { replaceTextAtomic } from '../src/runtime/repository-transaction/atomic-text.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';
const GRANTS_PACKAGE_PATH = 'packages/grants/package.json';
const COLLABORATION_GRANT_COMPOSITION_SOURCES = [
  'packages/core/src/collaboration-grant-envelope-codec.ts',
  'packages/core/src/grant-envelope-contracts.ts',
  'packages/core/src/grant-lifecycle-contracts.ts',
  'packages/core/src/role-context-sharing-grant-codec.ts',
  'packages/core/src/signed-attestation-envelope-codec.ts',
  'packages/grants/package.json',
  'packages/grants/src/collaboration-grant-envelope-reader.ts',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/grants/src/role-context-sharing-degradation.ts',
  'packages/grants/src/signed-attestation-envelope-reader.ts',
  'packages/workflow-engine/src/application/control-plane/collaboration-grant-revocation.ts',
  'packages/workflow-engine/src/composition-root/collaboration-grant-production.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-codec.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-records.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-use.ts',
  'packages/workflow-engine/src/modules/authority/grant-errors.ts',
  'packages/workflow-engine/src/modules/authority/grant-revocation-contract.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-consumed-replay.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-lifecycle-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant.ts',
  'packages/workflow-engine/src/runtime/grants/collaboration-grant-issuance.ts',
  'packages/workflow-engine/src/runtime/grants/grant-services.ts',
  'packages/workflow-engine/src/runtime/grants/optional-grants-package.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-consumption.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-private-files.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-records.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-reservation.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-revocation-store.ts',
] as const;
export type ProtectedCapabilitiesGenerationMode = '--check' | '--write';

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
): ProtectedCapabilitiesGenerationMode {
  if (argv.length !== 1 || (argv[0] !== '--check' && argv[0] !== '--write')) {
    throw new Error(
      'Usage: generate-protected-capabilities.ts [--check|--write]',
    );
  }
  return argv[0];
}

if (import.meta.main) {
  const mode = parseMode(process.argv.slice(2));
  const manifest = await generateProtectedCapabilitiesManifest(
    process.cwd(),
    mode,
  );
  process.stdout.write(
    `${JSON.stringify({
      command: 'protected-capabilities',
      ok: true,
      mode,
      entries: manifest.entries.length,
    })}\n`,
  );
}
