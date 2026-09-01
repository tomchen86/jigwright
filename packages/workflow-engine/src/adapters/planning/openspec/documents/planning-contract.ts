import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  parseTasks,
  readManagedSchemaName,
  repositoryPlanningPolicy as loadRepositoryPlanningPolicy,
  type ManagedSchemaName,
  type ParsedTask,
} from '../../../consumer/repository/work-registry/contracts.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../../../runtime/repository-transaction/git.ts';
import type { PlanningProviderBindingReaderPort } from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { assertPlanningTaskHistory } from '../../../../modules/planning-provider/planning-task-history.ts';
import { normalizeChangedPath } from '../../../../runtime/session-workspace/paths.ts';
import {
  assertPlanningPaths,
  requiredPlanningArtifactPaths,
} from '../../../../modules/source/planning-paths.ts';
import { loadStableValidatedChangeContract } from '../../../../composition-root/validated-contract-context.ts';
import type { PlanningTransitionReport } from '../../../../runtime/storage-journal/planning-report.ts';
import type { ResolvedPlanningProviderBinding } from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { planningProviderBindingPath } from '../../../../modules/source/planning-paths.ts';
import {
  resolveCurrentOpenSpecPlanningTransitionBinding,
  resolveHistoricalOpenSpecProviderBinding as resolveHistoricalOpenSpecProviderBindingWithReader,
  resolveHistoricalOpenSpecPlanningTransitionBinding as resolveHistoricalOpenSpecPlanningTransitionBindingWithReader,
} from './openspec-provider-binding.ts';

export type PlanningInspection = {
  /** Completed tasks this transition reopened, named rather than counted. */
  reopenedTasks: string[];
  transitionKind: 'introduction' | 'revision';
  schemaName: ManagedSchemaName;
  contract: ReturnType<typeof loadChangeContract>;
  beforeTasks: ParsedTask[] | undefined;
  currentPaths: string[];
  artifactDigests: Record<string, string>;
  planningProvider: ResolvedPlanningProviderBinding;
};

export { assertPlanningPaths } from '../../../../modules/source/planning-paths.ts';

export function resolveHistoricalOpenSpecPlanningTransitionBinding(
  planningProviderReader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  parentCommit: string,
  candidateCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
): ResolvedPlanningProviderBinding {
  return resolveHistoricalOpenSpecPlanningTransitionBindingWithReader(
    planningProviderReader,
    repositoryRoot,
    parentCommit,
    candidateCommit,
    changeRoot,
    changeId,
    transitionKind,
  );
}

export function resolveHistoricalOpenSpecProviderBinding(
  planningProviderReader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
): ResolvedPlanningProviderBinding {
  return resolveHistoricalOpenSpecProviderBindingWithReader(
    planningProviderReader,
    repositoryRoot,
    commit,
    changeRoot,
    changeId,
  );
}

export function inspectPlanningTransition(
  planningProviderReader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  baselineHead: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  reopenAuthorized = false,
): PlanningInspection {
  const metadataPath = path.join(
    repositoryRoot,
    changeRoot,
    changeId,
    '.openspec.yaml',
  );
  const schemaName = readManagedSchemaName(repositoryRoot, metadataPath);
  const currentSchemaName =
    loadRepositoryPlanningPolicy(repositoryRoot).currentSchemaName;
  assertPlanningPaths(
    changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
    schemaName,
    currentSchemaName,
  );
  const currentPaths = assertPlanningArtifactTree(
    repositoryRoot,
    changeRoot,
    changeId,
    schemaName,
    currentSchemaName,
  );
  const tasksPath = `${changeRoot}/${changeId}/tasks.md`;
  const beforeTaskContent = readFileAtCommit(
    repositoryRoot,
    baselineHead,
    tasksPath,
  );
  const beforeTasks = beforeTaskContent
    ? parseTasks(beforeTaskContent)
    : undefined;
  const baselinePaths = listTreePaths(
    repositoryRoot,
    baselineHead,
    `${changeRoot}/${changeId}`,
  );
  const transitionKind = beforeTasks ? 'revision' : 'introduction';
  const planningProvider = resolveCurrentOpenSpecPlanningTransitionBinding(
    planningProviderReader,
    repositoryRoot,
    baselineHead,
    changeRoot,
    changeId,
    transitionKind,
  );
  const bindingPath = planningProviderBindingPath(changeId);
  if (
    transitionKind === 'introduction' &&
    (baselinePaths.length > 0 ||
      JSON.stringify([...currentPaths, bindingPath].sort()) !==
        JSON.stringify(changedPaths))
  ) {
    throw workflowError(
      'PLANNING_INTRODUCTION_INVALID',
      'A planning introduction must add one complete new planning tree.',
      ExitCode.guard,
    );
  }
  const contract = loadChangeContract(repositoryRoot, changeId, schemaName);
  const reopenedTasks = assertPlanningTaskHistory(beforeTasks, contract.tasks, {
    reopenAuthorized: reopenAuthorized === true,
  });
  const artifactDigests = digestArtifacts(repositoryRoot, [
    ...contract.artifactPaths,
    metadataPath,
  ]);
  return {
    reopenedTasks,
    transitionKind,
    schemaName,
    contract,
    beforeTasks,
    currentPaths,
    artifactDigests,
    planningProvider,
  };
}

export function validateOpenSpecPlanning(
  repositoryRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName,
): Pick<PlanningTransitionReport, 'openspec' | 'planningAssurance'> {
  const validated = loadStableValidatedChangeContract(
    discoverRepository(repositoryRoot),
    changeId,
  ).contract;
  if (validated.schemaName !== schemaName) {
    throw workflowError(
      'OPENSPEC_CHANGE_STATE_CHANGED',
      'Managed change schema selection changed during planning validation.',
      ExitCode.staleState,
    );
  }
  return {
    openspec: validated.openspec,
    planningAssurance: validated.planningAssurance,
  };
}

function assertPlanningArtifactTree(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName,
  currentSchemaName: ManagedSchemaName,
): string[] {
  const changeDirectory = path.join(repositoryRoot, changeRoot, changeId);
  const files: string[] = [];
  walk(changeDirectory);
  const relativeFiles = files
    .map((filePath) => relative(repositoryRoot, filePath))
    .sort();
  assertPlanningPaths(
    changeRoot,
    changeId,
    relativeFiles,
    [],
    schemaName,
    currentSchemaName,
  );
  const required = requiredPlanningArtifactPaths(
    changeRoot,
    changeId,
    schemaName,
    currentSchemaName,
  );
  if (
    required.some((requiredPath) => !relativeFiles.includes(requiredPath)) ||
    !relativeFiles.some((filePath) =>
      filePath.startsWith(`${changeRoot}/${changeId}/specs/`),
    )
  ) {
    throw workflowError(
      'PLANNING_TREE_INVALID',
      'Planning tree is missing a required artifact.',
      ExitCode.guard,
    );
  }
  return relativeFiles;

  function walk(directory: string): void {
    const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      !directoryStats?.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw unsafePlanningTree();
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = fs.lstatSync(entryPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        walk(entryPath);
      } else if (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        (stats.mode & 0o111) === 0 &&
        fs.realpathSync(entryPath) === path.resolve(entryPath)
      ) {
        files.push(entryPath);
      } else {
        throw unsafePlanningTree();
      }
    }
  }
}

function listTreePaths(
  repositoryRoot: string,
  commit: string,
  prefix: string,
): string[] {
  return runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    commit,
    '--',
    `:(literal)${prefix}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeChangedPath)
    .sort();
}

export function readFileAtCommit(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string | undefined {
  return runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${filePath}`,
  ])
    ? runGit(repositoryRoot, ['show', `${commit}:${filePath}`])
    : undefined;
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function unsafePlanningTree() {
  return workflowError(
    'PLANNING_TREE_UNSAFE',
    'Planning artifacts must be canonical non-executable regular files.',
    ExitCode.unsafeEnvironment,
  );
}
