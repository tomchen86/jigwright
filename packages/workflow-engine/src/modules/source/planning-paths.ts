import {
  OpenSpecPlanningPathError,
  assertOpenSpecPlanningPaths,
  requiredOpenSpecPlanningArtifactPaths,
} from '@jigwright/openspec-adapter/planning-paths';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function planningProviderBindingPath(changeId: string): string {
  if (!CHANGE_ID.test(changeId) || changeId === 'archive') {
    throw workflowError(
      'PLANNING_CHANGE_ID_INVALID',
      'Planning-provider binding requires one valid non-reserved change ID.',
      ExitCode.guard,
    );
  }
  return `workflow/change-providers/${changeId}.json`;
}

export function assertPlanningPaths(
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  schemaName: string,
  currentSchemaName: string,
): void {
  const additionalExactPaths =
    changeId === 'archive' ? [] : [planningProviderBindingPath(changeId)];
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
