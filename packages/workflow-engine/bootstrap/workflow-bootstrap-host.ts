/** Verify the ordinary workflow host against an externally supplied bootstrap pin before spawning it. */
import path from 'node:path';
import {
  assertExactPackageRoot,
  readClosureFile,
} from './control-plane-bootstrap-files.ts';
import {
  BUILT_IN_BOOTSTRAP_RUNTIME_PATHS,
  hasExactKeys,
  isDigest,
  isRecord,
  rawDigest,
  safeClosurePath,
  trustError,
} from './control-plane-bootstrap-values.ts';
import type { Sha256Digest } from './control-plane-bootstrap-types.ts';

export const WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT =
  'bootstrap/workflow-engine-host.ts';
export const WORKFLOW_BOOTSTRAP_HOST_MANIFEST_PATH =
  'bootstrap/workflow-bootstrap-host.json';
export const WORKFLOW_BOOTSTRAP_HOST_PIN_PATH =
  'bootstrap/workflow-bootstrap-host-pin.ts';

export type WorkflowBootstrapHostManifest = Readonly<{
  kind: 'workflow-bootstrap-host.v1';
  entrypoint: typeof WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT;
  engineManifestDigest: Sha256Digest;
  files: readonly Readonly<{
    path: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
  }>[];
}>;

/** The shared protected bootstrap inventory is exact, without a second allowlist or glob expansion. */
export function workflowBootstrapHostPaths(): readonly string[] {
  const prefix = 'packages/workflow-engine/';
  const paths = BUILT_IN_BOOTSTRAP_RUNTIME_PATHS.map((filePath) => {
    if (!filePath.startsWith(prefix)) throw hostMismatch();
    const relative = filePath.slice(prefix.length);
    if (
      !safeClosurePath(relative) ||
      !relative.startsWith('bootstrap/') ||
      !relative.endsWith('.ts') ||
      relative === WORKFLOW_BOOTSTRAP_HOST_PIN_PATH
    ) {
      throw hostMismatch();
    }
    return relative;
  });
  const sorted = [...new Set(paths)].sort();
  if (
    JSON.stringify(paths) !== JSON.stringify(sorted) ||
    !paths.includes(WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT) ||
    !paths.includes('bootstrap/workflow-bootstrap-host.ts')
  )
    throw hostMismatch();
  return Object.freeze(paths);
}

/** The caller independently verifies engine source first and supplies both trusted digests. */
export function verifyWorkflowBootstrapHost(
  packageRoot: string,
  expectedHostDigest: Sha256Digest,
  expectedEngineManifestDigest: Sha256Digest,
): string {
  if (!isDigest(expectedHostDigest) || !isDigest(expectedEngineManifestDigest))
    throw hostMismatch();
  assertExactPackageRoot(packageRoot);
  const bytes = readClosureFile(
    path.join(packageRoot, WORKFLOW_BOOTSTRAP_HOST_MANIFEST_PATH),
    0o644,
  );
  if (rawDigest(bytes) !== expectedHostDigest) throw hostMismatch();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw hostMismatch();
  }
  if (
    `${JSON.stringify(value, null, 2)}\n` !== bytes.toString('utf8') ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'entrypoint',
      'engineManifestDigest',
      'files',
    ]) ||
    value.kind !== 'workflow-bootstrap-host.v1' ||
    value.entrypoint !== WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT ||
    value.engineManifestDigest !== expectedEngineManifestDigest ||
    !Array.isArray(value.files)
  )
    throw hostMismatch();
  const expectedPaths = workflowBootstrapHostPaths();
  if (value.files.length !== expectedPaths.length) throw hostMismatch();
  for (const [index, entry] of value.files.entries()) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['path', 'mode', 'digest']) ||
      entry.path !== expectedPaths[index] ||
      (entry.mode !== '100644' && entry.mode !== '100755') ||
      !isDigest(entry.digest)
    )
      throw hostMismatch();
    const actual = readClosureFile(
      path.join(packageRoot, expectedPaths[index]!),
      entry.mode === '100755' ? 0o755 : 0o644,
    );
    if (rawDigest(actual) !== entry.digest) throw hostMismatch();
  }
  return path.join(packageRoot, WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT);
}

function hostMismatch(): Error & { code: string; exitCode: number } {
  return trustError(
    'WORKFLOW_BOOTSTRAP_HOST_MISMATCH',
    'Workflow bootstrap host is missing, indirect, stale, or does not match its pinned engine.',
    13,
  );
}
