/**
 * Reads and replays an investigation manifest from an exact immutable
 * commit tree.
 *
 * Invariants:
 * - The committed blob must preserve the exact canonical bytes of the
 *   authority-validated manifest.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import {
  validateForAuthority,
  type InvestigationManifestV3,
} from '../../modules/investigation/manifest/investigation-manifest.ts';
import { assertChangeId } from '../session-workspace/paths.ts';
import { runGitBuffer } from './git.ts';

const TREE_ENTRY = /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export type ImmutableGitTreeInvestigationObservation = Readonly<{
  kind: 'immutable-git-tree';
  commit: string;
  tree: string;
  path: string;
  blob: string;
  contentDigest: string;
}>;

export type CommittedInvestigationManifestV3 = Readonly<{
  manifest: InvestigationManifestV3;
  validation: Readonly<{
    kind: 'manifest-authority-admissible';
    manifestDigest: string;
    investigationTargetDigest: string;
  }>;
  observation: ImmutableGitTreeInvestigationObservation;
}>;

/**
 * Read one v3 Manifest from an exact commit tree. This immutable CI reader has
 * no private-current-ref fallback: commit, tree, derived path, 100644 blob,
 * canonical bytes, and strict Manifest authority replay are all explicit.
 */
export function readCommittedInvestigationManifestV3(input: {
  repositoryRoot: string;
  commit: string;
  changeRoot: string;
  changeId: string;
  expectedRepositoryId: string;
}): CommittedInvestigationManifestV3 {
  const repositoryRoot = fs.realpathSync(input.repositoryRoot);
  assertExactCommitObjectId(repositoryRoot, input.commit);
  const changeId = assertChangeId(input.changeId);
  const manifestPath = derivedManifestPath(input.changeRoot, changeId);
  const tree = readExactCommitTree(repositoryRoot, input.commit);
  const entryBytes = runPinnedGit(
    repositoryRoot,
    ['ls-tree', '-z', '--full-tree', tree, '--', `:(literal)${manifestPath}`],
    'Committed investigation path is missing or is not one exact 100644 blob.',
  );
  let entry: RegExpExecArray | null;
  try {
    entry = TREE_ENTRY.exec(UTF8.decode(entryBytes));
  } catch {
    entry = null;
  }
  if (entry === null || entry[3] !== manifestPath) {
    throw committedInvalid(
      'Committed investigation path is missing or is not one exact 100644 blob.',
    );
  }
  const blob = entry[2]!;
  const bytes = runPinnedGit(
    repositoryRoot,
    ['cat-file', 'blob', blob],
    'Committed investigation blob is unavailable.',
  );
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw committedInvalid(
      'Committed investigation Manifest exceeds its bounded canonical form.',
    );
  }

  let text: string;
  let value: unknown;
  try {
    text = UTF8.decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw committedInvalid(
      'Committed investigation Manifest is not canonical UTF-8 JSON.',
    );
  }
  const schemaVersion = record(value)?.schemaVersion;
  if (typeof schemaVersion === 'number' && schemaVersion !== 3) {
    throw workflowError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Committed investigation Manifest schema version ${schemaVersion} is unsupported; only schema version 3 is current.`,
      ExitCode.guard,
      { details: { schemaVersion, supportedSchemaVersion: 3 } },
    );
  }
  if (text !== `${canonicalJson(value)}\n`) {
    throw workflowError(
      'CI_COMMITTED_INVESTIGATION_NONCANONICAL',
      'Committed investigation Manifest bytes are not the exact canonical JSON form.',
      ExitCode.guard,
      { details: { commit: input.commit, tree, path: manifestPath, blob } },
    );
  }

  const authoring = record(value)?.authoring;
  const validation = validateForAuthority({
    repositoryRoot,
    manifest: value,
    expected: {
      repositoryId: input.expectedRepositoryId,
      changeId,
      investigationId:
        typeof record(value)?.investigationId === 'string'
          ? (record(value)!.investigationId as string)
          : '',
      sessionRevision:
        typeof record(authoring)?.sessionRevision === 'number'
          ? (record(authoring)!.sessionRevision as number)
          : -1,
      sessionSnapshotDigest:
        typeof record(authoring)?.sessionSnapshotDigest === 'string'
          ? (record(authoring)!.sessionSnapshotDigest as string)
          : '',
    },
  });
  if (validation.outcome !== 'verified') {
    throw workflowError(
      validation.blocker.failureCode,
      'Committed investigation Manifest failed strict authority replay.',
      ExitCode.guard,
      {
        details: {
          commit: input.commit,
          tree,
          path: manifestPath,
          blob,
          blocker: validation.blocker,
        },
      },
    );
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(validation.manifest)}\n`);
  if (!bytes.equals(canonicalBytes)) {
    throw workflowError(
      'CI_COMMITTED_INVESTIGATION_NONCANONICAL',
      'Committed investigation Manifest does not preserve exact validated canonical bytes.',
      ExitCode.guard,
    );
  }

  return Object.freeze({
    manifest: validation.manifest,
    validation: Object.freeze({
      kind: 'manifest-authority-admissible' as const,
      manifestDigest: validation.manifestDigest,
      investigationTargetDigest: validation.investigationTargetDigest,
    }),
    observation: Object.freeze({
      kind: 'immutable-git-tree' as const,
      commit: input.commit,
      tree,
      path: manifestPath,
      blob,
      contentDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
    }),
  });
}

function assertExactCommitObjectId(
  repositoryRoot: string,
  commit: string,
): void {
  const objectFormat = runPinnedGit(
    repositoryRoot,
    ['rev-parse', '--show-object-format'],
    'Committed investigation replay cannot determine the repository object format.',
  );
  const objectIdPattern = objectFormat.equals(Buffer.from('sha1\n'))
    ? /^[0-9a-f]{40}$/u
    : objectFormat.equals(Buffer.from('sha256\n'))
      ? /^[0-9a-f]{64}$/u
      : null;
  if (objectIdPattern === null || !objectIdPattern.test(commit)) {
    throw committedInvalid(
      'Committed investigation replay requires one full commit object ID in the repository object format.',
    );
  }
  const resolved = runPinnedGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${commit}^{commit}`],
    'Committed investigation replay cannot resolve the exact commit object.',
  );
  if (!resolved.equals(Buffer.from(`${commit}\n`))) {
    throw committedInvalid(
      'Committed investigation replay requires an exact full commit object ID.',
    );
  }
}

function derivedManifestPath(changeRoot: string, changeId: string): string {
  try {
    const normalizedRoot = normalizeExactRepositoryPath(changeRoot);
    if (normalizedRoot !== changeRoot || changeRoot.endsWith('/')) {
      throw new Error('noncanonical change root');
    }
    return normalizeExactRepositoryPath(
      `${normalizedRoot}/${changeId}/investigation.json`,
    );
  } catch {
    throw workflowError(
      'CI_COMMITTED_INVESTIGATION_PATH_INVALID',
      'Committed investigation replay requires the canonical configured change root and derived Manifest path.',
      ExitCode.guard,
      { details: { changeRoot, changeId } },
    );
  }
}

function readExactCommitTree(repositoryRoot: string, commit: string): string {
  const objectType = runPinnedGit(
    repositoryRoot,
    ['cat-file', '-t', commit],
    'Committed investigation replay cannot resolve the exact commit object.',
  );
  if (!objectType.equals(Buffer.from('commit\n'))) {
    throw committedInvalid(
      'Committed investigation replay requires an exact commit object.',
    );
  }
  const commitBytes = runPinnedGit(
    repositoryRoot,
    ['cat-file', 'commit', commit],
    'Committed investigation replay cannot read the exact commit object.',
  );
  const firstLineEnd = commitBytes.indexOf(0x0a);
  if (firstLineEnd < 0) {
    throw committedInvalid('Committed investigation commit has no tree.');
  }
  const firstLine = commitBytes.subarray(0, firstLineEnd).toString('ascii');
  const match = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(firstLine);
  if (match === null) {
    throw committedInvalid('Committed investigation commit has no exact tree.');
  }
  return match[1]!;
}

function runPinnedGit(
  repositoryRoot: string,
  args: string[],
  message: string,
): Buffer {
  try {
    return runGitBuffer(repositoryRoot, args);
  } catch {
    throw committedInvalid(message);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function committedInvalid(message: string): ReturnType<typeof workflowError> {
  return workflowError(
    'CI_COMMITTED_INVESTIGATION_INVALID',
    message,
    ExitCode.guard,
  );
}
