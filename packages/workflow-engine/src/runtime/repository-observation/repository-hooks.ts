/** Observe the current Git hook message and staged lifecycle paths in their original order. */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import { listStagedPaths } from '../repository-transaction/git-transitions.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { createRepositorySpecificationPolicy } from '../../modules/lifecycle/repository-specification-policy.ts';
import {
  invalidCommitMessage,
  type RepositoryHookDependencies,
} from '../../modules/lifecycle/repository-hooks.ts';
import { changeLifecycleRelativePath } from '../../modules/lifecycle/change-routing.ts';

export const repositoryHookObservations: Pick<
  RepositoryHookDependencies,
  | 'readCommitMessage'
  | 'realRepositoryPath'
  | 'findStagedLifecyclePaths'
  | 'readStagedLifecycleSource'
> = {
  readCommitMessage,
  realRepositoryPath: fs.realpathSync,
  findStagedLifecyclePaths,
  readStagedLifecycleSource(repositoryRoot) {
    return runGit(repositoryRoot, ['show', `:${changeLifecycleRelativePath}`]);
  },
};

function findStagedLifecyclePaths(repositoryRoot: string): string[] {
  const config = loadWorkflowConfig(repositoryRoot);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const stagedPaths = listStagedPaths(repositoryRoot, head);
  return createRepositorySpecificationPolicy(
    config.changeRoot,
  ).stagedLifecyclePaths(stagedPaths);
}

function readCommitMessage(cwd: string, requestedPath: string): string {
  const git = discoverRepository(cwd);
  const expectedValue = runGit(git.repositoryRoot, [
    'rev-parse',
    '--git-path',
    'COMMIT_EDITMSG',
  ]).trim();
  const expectedPath = path.resolve(git.repositoryRoot, expectedValue);
  const messagePath = path.resolve(git.repositoryRoot, requestedPath);
  const stats = fs.lstatSync(messagePath, { throwIfNoEntry: false });
  const expectedStats = fs.lstatSync(expectedPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > 1024 * 1024 ||
    !expectedStats?.isFile() ||
    expectedStats.isSymbolicLink()
  ) {
    throw invalidCommitMessage(['Commit message file is missing or unsafe.']);
  }
  if (fs.realpathSync(messagePath) !== fs.realpathSync(expectedPath)) {
    throw workflowError(
      'COMMIT_MESSAGE_FILE_UNEXPECTED',
      'commit-msg must validate the current worktree Git message file.',
      ExitCode.guard,
    );
  }
  return fs.readFileSync(messagePath, 'utf8');
}
