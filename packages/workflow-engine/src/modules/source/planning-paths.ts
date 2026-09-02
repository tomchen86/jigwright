import {
  OpenSpecPlanningPathError,
  assertOpenSpecPlanningPaths,
  requiredOpenSpecPlanningArtifactPaths,
} from '@jigwright/openspec-adapter/planning-paths';
import {
  PlanningProviderBindingError,
  planningProviderBindingPath as corePlanningProviderBindingPath,
} from '@jigwright/core/planning-provider-binding';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export function planningProviderBindingPath(changeId: string): string {
  try {
    return corePlanningProviderBindingPath(changeId);
  } catch (error) {
    if (!(error instanceof PlanningProviderBindingError)) throw error;
    throw workflowError(
      'PLANNING_CHANGE_ID_INVALID',
      error.message,
      ExitCode.guard,
    );
  }
}

export function assertPlanningPaths(
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  schemaName: string,
  currentSchemaName: string,
  citedSourceRefs: readonly `SRC-${string}`[] = [],
): void {
  const sourceObjectPaths = planningSourceObjectPaths(citedSourceRefs);
  const additionalExactPaths =
    changeId === 'archive'
      ? []
      : [planningProviderBindingPath(changeId), ...sourceObjectPaths];
  try {
    assertOpenSpecPlanningPaths({
      changeRoot,
      changeId,
      changedPaths,
      deletedPaths,
      schemaName,
      currentSchemaName,
      additionalExactPaths,
    });
  } catch (error) {
    if (!(error instanceof OpenSpecPlanningPathError)) throw error;
    throw mapOpenSpecPlanningPathError(error, schemaName);
  }
}

export function planningSourceObjectPaths(
  citedSourceRefs: readonly `SRC-${string}`[],
): string[] {
  if (
    JSON.stringify(citedSourceRefs) !==
      JSON.stringify([...new Set(citedSourceRefs)].sort()) ||
    citedSourceRefs.some((sourceRef) => !/^SRC-[0-9a-f]{64}$/.test(sourceRef))
  ) {
    throw workflowError(
      'PLANNING_PATHS_INVALID',
      'Planning Source citations must be identity-valid, canonical, and unique.',
      ExitCode.guard,
    );
  }
  return citedSourceRefs.map((sourceRef) => {
    const digest = sourceRef.slice('SRC-'.length);
    return `${GOVERNANCE_SOURCE_LEDGER_ROOT}/${digest.slice(0, 2)}/${digest}.json`;
  });
}

function mapOpenSpecPlanningPathError(
  error: OpenSpecPlanningPathError,
  schemaName: string,
): ReturnType<typeof workflowError> {
  if (error.code === 'PLANNING_CHANGE_ID_RESERVED') {
    return workflowError(error.code, error.message, ExitCode.guard);
  }
  if (error.code === 'PLANNING_PATH_SYNTAX_INVALID') {
    const invalidPath = error.invalidPaths[0] ?? '';
    return workflowError(
      'INVALID_REPOSITORY_PATH',
      `Invalid repository path reported by Git: ${invalidPath}`,
      ExitCode.guard,
      { details: { path: invalidPath } },
    );
  }
  return workflowError(
    error.code,
    `Planning transition contains paths outside the named ${schemaName} planning tree.`,
    ExitCode.guard,
    { details: { invalidPaths: [...error.invalidPaths] } },
  );
}

export function requiredPlanningArtifactPaths(
  changeRoot: string,
  changeId: string,
  schemaName: string,
  currentSchemaName: string,
): string[] {
  return requiredOpenSpecPlanningArtifactPaths(
    changeRoot,
    changeId,
    schemaName,
    currentSchemaName,
  );
}
