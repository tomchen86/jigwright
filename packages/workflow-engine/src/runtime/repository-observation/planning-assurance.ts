/** Observes current planning artifacts and exact Git-backed review evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { runGit, runGitBuffer } from '../repository-transaction/git.ts';
import { repositoryCurrentSchemaName } from '../workflow-configuration/workflow-configuration.ts';
import {
  planningNotReady,
  sha256,
} from '../../modules/assurance/planning-assurance-values.ts';
import type { PlanningAssuranceObservations } from '../../modules/assurance/planning-assurance-observations.ts';
import type { PlanReviewTargetSnapshot } from '../../modules/assurance/plan-review-target-snapshot-record.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { readPlanReviewCoverageTarget } from './plan-review-coverage.ts';
import { readFileAtRevision } from '../repository-transaction/git-command.ts';

export const planningAssuranceObservations: PlanningAssuranceObservations =
  Object.freeze({
    readCurrentSchema: repositoryCurrentSchemaName,
    readPlanningArtifact(repositoryRoot, artifactPath) {
      return fs.readFileSync(path.join(repositoryRoot, artifactPath), 'utf8');
    },
    readPlanningSchemaDigest(repositoryRoot, schemaPath) {
      return sha256(
        fs.readFileSync(path.join(repositoryRoot, schemaPath), 'utf8'),
      );
    },
    readRepositoryCitation,
    readPlanningSnapshotOrigin: resolvePlanReviewSnapshotCommit,
    readPlanningSnapshotArtifact(repositoryRoot, commit, artifactPath) {
      return commit === null
        ? readCurrentPlanningTarget(repositoryRoot, artifactPath)
        : readCommittedPlanningTarget(repositoryRoot, commit, artifactPath);
    },
    loadMaintainerPolicyAtCommit,
    readCoverageTarget: readPlanReviewCoverageTarget,
  });

function readRepositoryCitation(
  repositoryRoot: string,
  tree: string,
  repositoryPath: string,
): ReturnType<PlanningAssuranceObservations['readRepositoryCitation']> {
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${repositoryPath}`,
  ]);
  const match = /^100\d{3} blob ([0-9a-f]{40,64})\t/.exec(listing);
  if (!match) {
    throw planningNotReady(
      'PlanReview cites a path absent from its investigation baseline.',
    );
  }
  const content = readFileAtRevision(repositoryRoot, tree, `${repositoryPath}`);

  return { blobOid: match[1]!, content };
}
function resolvePlanReviewSnapshotCommit(
  repositoryRoot: string,
  snapshot: PlanReviewTargetSnapshot,
): string | null {
  const metadataPaths = snapshot.artifacts
    .map(({ path: artifactPath }) => artifactPath)
    .filter((artifactPath) => artifactPath.endsWith('/.openspec.yaml'));
  if (metadataPaths.length !== 1) {
    throw planningNotReady(
      'PlanReview target snapshot does not identify one planning root.',
    );
  }
  const changePrefix = path.posix.dirname(metadataPaths[0]!);
  if (
    snapshot.artifacts.some(
      ({ path: artifactPath }) =>
        artifactPath !== changePrefix &&
        !artifactPath.startsWith(`${changePrefix}/`),
    )
  ) {
    throw planningNotReady(
      'PlanReview target snapshot crosses planning roots.',
    );
  }
  const planReviewPath = `${changePrefix}/plan-review.json`;
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    'HEAD',
    '--',
    `:(literal)${planReviewPath}`,
  ]);
  const match = /^(100644) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(listing);
  if (!match || match[2] !== planReviewPath) return null;

  const absolutePath = path.join(repositoryRoot, planReviewPath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!stats) {
    // The committed review has been withdrawn from the worktree — an
    // amendment returning the graph to review-pending. Absence is "no
    // committed review applies", exactly like current bytes that differ; only
    // a file that exists in an unsafe shape is refused.
    return null;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o644
  ) {
    throw planningNotReady(
      'PlanReview artifact is not a regular mode-0644 file.',
    );
  }
  const current = fs.readFileSync(absolutePath);
  const committed = runGitBuffer(repositoryRoot, [
    'show',
    `HEAD:${planReviewPath}`,
  ]);
  if (!current.equals(committed)) return null;

  const commit = runGit(repositoryRoot, [
    'log',
    '-1',
    '--format=%H',
    'HEAD',
    '--',
    `:(literal)${planReviewPath}`,
  ]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw planningNotReady(
      'Committed PlanReview target snapshot origin is not resolvable.',
    );
  }
  const origin = runGitBuffer(repositoryRoot, [
    'show',
    `${commit}:${planReviewPath}`,
  ]);
  if (!origin.equals(committed)) {
    throw planningNotReady(
      'Committed PlanReview target snapshot origin is ambiguous.',
    );
  }
  return commit;
}

function readCurrentPlanningTarget(
  repositoryRoot: string,
  artifactPath: string,
): Buffer {
  const absolutePath = path.join(repositoryRoot, artifactPath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o644
  ) {
    throw planningNotReady(
      'PlanReview planning evidence is not a regular mode-0644 file.',
    );
  }
  return fs.readFileSync(absolutePath);
}

function readCommittedPlanningTarget(
  repositoryRoot: string,
  commit: string,
  artifactPath: string,
): Buffer {
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${artifactPath}`,
  ]);
  const match = /^(100644) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(listing);
  if (!match || match[2] !== artifactPath) {
    throw planningNotReady(
      'Committed PlanReview planning evidence is not an exact mode-100644 blob.',
    );
  }
  return runGitBuffer(repositoryRoot, ['show', `${commit}:${artifactPath}`]);
}

export function loadMaintainerPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): ReturnType<typeof parseMaintainerPolicy> {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileAtRevision(
        repositoryRoot,
        commit,
        'workflow/maintainer-policy.json',
      ),
    );
  } catch (error) {
    throw planningNotReady(
      `The baseline maintainer policy cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseMaintainerPolicy(value);
}
