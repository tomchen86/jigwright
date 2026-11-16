/** Validates documentation closure commitments against exact tracked Git state. */
import { runGit } from '../../repository-transaction/git.ts';
import {
  resolveParentCommitOid,
  resolveTreeOid,
} from '../../repository-transaction/git-object-ids.ts';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  parseDocumentationClosureFromCommitMessage,
  canonicalSet,
  normalizeExactPath,
  objectId,
  sha256,
  closureInvalid,
  closureRequired,
} from '../../../modules/assurance/documentation-closure.ts';
import type { DocumentationClosureRecord } from '../../../modules/assurance/documentation-closure.ts';

export function assertDocumentationClosureCommitCurrent(input: {
  repositoryRoot: string;
  commitHash: string;
  changeId: string;
  taskId: string;
  changeBaseCommit: string;
  allowedProjectionPaths: readonly string[];
}): DocumentationClosureRecord {
  const record = parseDocumentationClosureFromCommitMessage(
    readCommitMessage(input.repositoryRoot, input.commitHash),
  );
  if (record === null) throw closureRequired();
  const commitTree = resolvedTree(input.repositoryRoot, input.commitHash);
  const changeBaseTree = resolvedTree(
    input.repositoryRoot,
    input.changeBaseCommit,
  );
  const parent = resolveParentCommitOid(input.repositoryRoot, input.commitHash);
  const allowedProjectionPaths = canonicalSet(
    input.allowedProjectionPaths.map(normalizeExactPath),
  );
  const actualProjectionPaths = treeChangedPaths(
    input.repositoryRoot,
    resolvedTree(input.repositoryRoot, parent),
    commitTree,
  ).filter((candidate) => allowedProjectionPaths.includes(candidate));
  const changePaths = treeChangedPaths(
    input.repositoryRoot,
    changeBaseTree,
    commitTree,
  ).filter((candidate) => !allowedProjectionPaths.includes(candidate));
  const transitions = changePaths.map((candidate) => ({
    path: candidate,
    before: readTreeEntry(input.repositoryRoot, changeBaseTree, candidate),
    after: readTreeEntry(input.repositoryRoot, commitTree, candidate),
  }));
  const patchDigest = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-diff-documentation-change-patch.v1',
      transitions,
    }),
  );
  const mismatches = [
    record.changeId === input.changeId ? null : 'change-id',
    record.taskId === input.taskId ? null : 'task-id',
    record.projectedCommitTree === commitTree ? null : 'projected-commit-tree',
    record.requirement.changeBaseCommit === input.changeBaseCommit
      ? null
      : 'change-base-commit',
    record.requirement.changeBaseTree === changeBaseTree
      ? null
      : 'change-base-tree',
    record.requirement.candidateTree === commitTree ? null : 'candidate-tree',
    canonicalJson(record.projectionPaths) ===
    canonicalJson(actualProjectionPaths)
      ? null
      : 'projection-paths',
    canonicalJson(record.requirement.changedPaths) ===
    canonicalJson(changePaths)
      ? null
      : 'changed-paths',
    record.requirement.patchDigest === patchDigest ? null : 'patch-digest',
  ].filter((candidate): candidate is string => candidate !== null);
  if (mismatches.length > 0) throw closureInvalid({ mismatches });
  return record;
}

function readCommitMessage(repositoryRoot: string, commitHash: string): string {
  const formatted = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%B%x00',
    commitHash,
  ]);
  const delimiter = formatted.indexOf('\0');
  if (
    delimiter < 0 ||
    delimiter !== formatted.lastIndexOf('\0') ||
    formatted.slice(delimiter + 1) !== '\n'
  ) {
    throw closureInvalid();
  }
  return formatted.slice(0, delimiter);
}

function treeChangedPaths(
  repositoryRoot: string,
  beforeTree: string,
  afterTree: string,
): readonly string[] {
  return runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    beforeTree,
    afterTree,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeExactPath)
    .sort();
}

function resolvedTree(repositoryRoot: string, commit: string): string {
  return objectId(resolveTreeOid(repositoryRoot, commit));
}

function readTreeEntry(
  repositoryRoot: string,
  tree: string,
  candidatePath: string,
) {
  const output = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${candidatePath}`,
  ]);
  if (output === '') return null;
  const match =
    /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) throw closureInvalid();
  return { mode: match[1], objectId: match[2] };
}
