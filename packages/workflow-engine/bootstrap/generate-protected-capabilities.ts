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
  GRANTS_PACKAGE_PATH,
  'packages/grants/src/collaboration-grant-envelope-reader.ts',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
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
