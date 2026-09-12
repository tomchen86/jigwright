import { productionChangeRoutingInspector } from './change-routing-observation-production.ts';
import { loadChangeContract as productionChangeContractReader } from './consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
/**
 * Resolves repository and active-task context for governance intake and
 * handoff rendering.
 *
 * Invariants:
 * - Active sessions must resolve to the current canonical worktree;
 *   unreadable session records are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

export {
  deferredIntakeDestination,
  INTAKE_KINDS,
  isRequirementKind,
} from '../modules/governance-intake/intake-policy.ts';

import { renderHandoff as renderHandoffWithContractReader } from '../adapters/consumer/repository/handoff/handoff.ts';
import {
  loadWorkflowConfig,
  repositoryHandoffRelativePath,
} from '../runtime/repository-observation/workflow-configuration.ts';
import type { GovernanceFindingContextV1 } from '../modules/governance-intake/governance-intake.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  readSessionFile,
  runtimePaths,
} from '../runtime/session-workspace/session-store.ts';

export function renderGovernanceIntakeHandoff(repositoryRoot: string): string {
  renderHandoff(repositoryRoot);
  return repositoryHandoffRelativePath(repositoryRoot);
}

/**
 * The repository-scoped staging context used when no task session is open. The
 * reserved scope keeps these notes in their own directory and marks them as
 * belonging to no change, which is exactly what they record.
 */
const REPOSITORY_FINDING_SCOPE = 'repository';

export function resolveRepositoryFindingScope(
  cwd: string,
): GovernanceFindingContextV1 {
  const git = discoverRepository(cwd);
  return {
    repositoryRoot: git.repositoryRoot,
    runtimeRoot: resolveGovernanceIntakeRuntimeRoot(cwd),
    sessionId: REPOSITORY_FINDING_SCOPE,
    changeId: REPOSITORY_FINDING_SCOPE,
    branch: git.branch ?? REPOSITORY_FINDING_SCOPE,
    head: git.head,
    tree: git.tree,
  };
}

/**
 * The active task session whose worktree is `cwd`, if any. Intake verbs use it
 * to decide where an observation lands: inside a task it is staged as a
 * Finding so the task diff stays scoped; outside one it goes straight to the
 * inbox. Unreadable session files are skipped rather than blocking intake.
 */
export function findActiveTaskSessionId(cwd: string): string | null {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  if (
    !fs.statSync(runtime.sessions, { throwIfNoEntry: false })?.isDirectory()
  ) {
    return null;
  }
  const here = git.repositoryRealPath;
  for (const entry of fs.readdirSync(runtime.sessions).sort()) {
    if (!entry.endsWith('.json')) continue;
    try {
      const session = readSessionFile(path.join(runtime.sessions, entry));
      if (
        session.state === 'active' &&
        fs.realpathSync(session.repositoryRoot) === here
      ) {
        return session.sessionId;
      }
    } catch {
      continue;
    }
  }
  return null;
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
