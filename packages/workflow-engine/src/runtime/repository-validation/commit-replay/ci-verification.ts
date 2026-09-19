import fs from 'node:fs';
import {
  resolveCommitOid,
  resolveTreeOid,
} from '../../repository-transaction/git-object-ids.ts';
import path from 'node:path';
import {
  discoverRepository,
  runGit,
} from '../../repository-transaction/git.ts';
import {
  commitFacts,
  commitChangedPaths,
} from '../../repository-transaction/git-transitions.ts';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import {
  assertCiCommit,
  findMergeBase,
  listRangeCommits,
  listRangePaths,
  listChangesAtCommit,
} from './ci-git.ts';
import {
  loadWorkflowConfig,
  loadChecksConfig,
  repositoryCurrentSchemaName,
} from '../../workflow-configuration/workflow-configuration.ts';
import { committedPlanningGeneration } from '../../repository-transaction/planning-generation-history.ts';
import type { CiRepositoryObservations } from '../../../modules/assurance/commit-replay/ci-git.ts';

const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';

export const ciRepositoryObservations: CiRepositoryObservations = {
  discoverRepository,
  assertCiCommit,
  findMergeBase,
  listRangeCommits,
  listRangePaths,
  listChangesAtCommit,
  readFileAtCommit,
  loadWorkflowConfig,
  loadChecksConfig,
  currentRepositorySchemaName: repositoryCurrentSchemaName,
  commitFacts,
  commitChangedPaths,
  committedPlanningGeneration,
  readCurrentFile(repositoryRoot, filePath) {
    try {
      return fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8');
    } catch {
      return undefined;
    }
  },
  listFirstParentHashes(repositoryRoot, base) {
    return runGit(repositoryRoot, ['rev-list', '--first-parent', base])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  },
  listTagRefs(repositoryRoot, prefix) {
    return runGit(repositoryRoot, [
      'for-each-ref',
      '--format=%(refname)',
      prefix,
    ])
      .split('\n')
      .filter(Boolean);
  },
  readTagObject(repositoryRoot, ref) {
    return runGit(repositoryRoot, ['cat-file', 'tag', ref]);
  },
  resolveTagCommit(repositoryRoot, ref) {
    return resolveCommitOid(repositoryRoot, ref);
  },
  resolveCommitTree(repositoryRoot, commit) {
    return resolveTreeOid(repositoryRoot, commit);
  },
  readHistoricalPolicyBlob(repositoryRoot, commit) {
    return runGit(
      repositoryRoot,
      ['rev-parse', `${commit}:${MAINTAINER_POLICY_PATH}`],
      true,
    ).trim();
  },
  readHistoricalPolicyContent(repositoryRoot, commit) {
    return runGit(repositoryRoot, [
      'show',
      `${commit}:${MAINTAINER_POLICY_PATH}`,
    ]);
  },
  latestPlanCommit(repositoryRoot, head, artifactPath) {
    return runGit(repositoryRoot, [
      'log',
      '-1',
      '--format=%H',
      head,
      '--',
      artifactPath,
    ]).trim();
  },
  commitsChangingPath(repositoryRoot, afterCommit, head, filePath) {
    const output = runGit(
      repositoryRoot,
      ['rev-list', '--reverse', `${afterCommit}..${head}`, '--', filePath],
      true,
    ).trim();
    return output === '' ? [] : output.split(/\s+/);
  },
  resolveAncestorMergeBase(repositoryRoot, ancestor, descendant) {
    return runGit(repositoryRoot, ['merge-base', ancestor, descendant]).trim();
  },
};
