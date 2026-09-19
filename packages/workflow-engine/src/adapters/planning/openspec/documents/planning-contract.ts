import type { PlanningTransitionReport } from '../../../../modules/lifecycle/planning-transition-report.ts';
import { openSpecPlanningPathPolicy } from './planning-path-policy.ts';
import type { ChangeContractReader } from '../../../../modules/planning-provider/change-contract.ts';
/**
 * Inspects planning introductions and revisions against the baseline
 * artifact tree and provider binding.
 *
 * Invariants:
 * - A planning introduction must add a complete new planning tree with its
 *   provider binding and cited Source additions.
 */
import fs from 'node:fs';
import path from 'node:path';

import { digestArtifacts } from '../../../../runtime/repository-observation/contract-artifact-observation.ts';

import { parseTasks } from '../../../../modules/planning-provider/planning-artifact-parsers.ts';
import { readManagedSchemaName } from '../../../../runtime/repository-observation/change-metadata.ts';
import { repositoryPlanningPolicy as loadRepositoryPlanningPolicy } from '../../../../runtime/workflow-configuration/workflow-configuration.ts';
import { type ManagedSchemaName } from '../../../../modules/planning-provider/change-contract.ts';
import { type ParsedTask } from '../../../../modules/planning-provider/planning-artifact-types.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  discoverRepository,
  readFileAtCommit,
  runGit,
} from '../../../../runtime/repository-transaction/git.ts';
import type { PlanningProviderBindingReaderPort } from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { assertPlanningTaskHistory } from '../../../../modules/planning-provider/planning-task-history.ts';
import { normalizeChangedPath } from '../../../../foundation/repository-path/repository-path.ts';
import {
  assertPlanningPaths as assertPlanningPathsWithAdmission,
  planningSourceObjectPaths,
} from '../../../../modules/source/planning-paths.ts';
import type { CurrentChangeOriginReader } from '../../../../modules/governance-intake/work-registry-contracts.ts';
import type { StableValidatedChangeContractLoader } from '../../../../modules/assurance/validated-change-contract.ts';

import type { ResolvedPlanningProviderBinding } from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { planningProviderBindingPath } from '../../../../modules/source/planning-paths.ts';
import {
  resolveCurrentOpenSpecPlanningTransitionBinding,
  resolveHistoricalOpenSpecProviderBinding as resolveHistoricalOpenSpecProviderBindingWithReader,
  resolveHistoricalOpenSpecPlanningTransitionBinding as resolveHistoricalOpenSpecPlanningTransitionBindingWithReader,
} from './openspec-provider-binding.ts';

export type { PlanningInspection } from '../../../../modules/planning-provider/change-contract.ts';
import type { PlanningInspection } from '../../../../modules/planning-provider/change-contract.ts';

export const assertPlanningPaths = assertPlanningPathsWithAdmission.bind(
  undefined,
  openSpecPlanningPathPolicy.admit,
);
const requiredPlanningArtifactPaths =
  openSpecPlanningPathPolicy.requiredArtifactPaths;

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
  loadChangeContract: ChangeContractReader,
  planningProviderReader: PlanningProviderBindingReaderPort,
  readCurrentChangeOrigin: CurrentChangeOriginReader,
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
  const sourceRefs =
    readCurrentChangeOrigin(repositoryRoot, changeId)?.sourceRefs ?? [];
  assertPlanningPaths(
    changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
    schemaName,
    currentSchemaName,
    sourceRefs,
  );
  const currentPaths = assertPlanningArtifactTree(
    readCurrentChangeOrigin,
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
      JSON.stringify(
        [
          ...currentPaths,
          bindingPath,
          ...planningSourceObjectPaths(sourceRefs).filter((sourcePath) =>
            changedPaths.includes(sourcePath),
          ),
        ].sort(),
      ) !== JSON.stringify(changedPaths))
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
  loadStableValidatedChangeContract: StableValidatedChangeContractLoader,
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
  readCurrentChangeOrigin: CurrentChangeOriginReader,
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
    readCurrentChangeOrigin(repositoryRoot, changeId)?.sourceRefs ?? [],
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
