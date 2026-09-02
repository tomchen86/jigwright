import fs from 'node:fs';
import path from 'node:path';

import { renderHandoff } from '../adapters/consumer/repository/handoff/handoff.ts';
import {
  loadWorkflowConfig,
  repositoryHandoffRelativePath,
} from '../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';

export function renderGovernanceIntakeHandoff(repositoryRoot: string): string {
  renderHandoff(repositoryRoot);
  return repositoryHandoffRelativePath(repositoryRoot);
}

export function resolveGovernanceIntakeRuntimeRoot(cwd: string): string {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return runtimePaths(git.gitCommonDirectory, config.runtimeDirectory).root;
}

export function assertExistingGovernanceIntakeChange(
  cwd: string,
  requestedChangeId: string,
): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedChangeId)) {
    throw governanceIntakeUsage('Finding link change identity is invalid.');
  }
  const repositoryRoot = fs.realpathSync(cwd);
  const config = loadWorkflowConfig(repositoryRoot);
  const changeRoot = path.resolve(repositoryRoot, config.changeRoot);
  const relativeChangeRoot = path.relative(repositoryRoot, changeRoot);
  const changeRootStats = fs.lstatSync(changeRoot, { throwIfNoEntry: false });
  if (
    relativeChangeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeChangeRoot) ||
    !changeRootStats?.isDirectory() ||
    changeRootStats.isSymbolicLink() ||
    fs.realpathSync(changeRoot) !== changeRoot
  ) {
    throw governanceIntakeUsage('Configured change root is unsafe.');
  }
  const changeDirectory = path.join(changeRoot, requestedChangeId);
  const changeStats = fs.lstatSync(changeDirectory, {
    throwIfNoEntry: false,
  });
  if (
    !changeStats?.isDirectory() ||
    changeStats.isSymbolicLink() ||
    fs.realpathSync(changeDirectory) !== changeDirectory ||
    path.dirname(changeDirectory) !== changeRoot
  ) {
    throw governanceIntakeUsage(
      'Finding link requires one existing plain change.',
    );
  }
  return requestedChangeId;
}

function governanceIntakeUsage(message: string): Error {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}
