/** Adapts OpenSpec artifact grammar and its failures to planning transition semantics. */
import {
  OpenSpecPlanningPathError,
  assertOpenSpecPlanningPaths,
  requiredOpenSpecPlanningArtifactPaths,
} from '@jigwright/openspec-adapter/planning-paths';
import type {
  PlanningPathAdmission,
  PlanningPathPolicy,
} from '../../../../modules/source/planning-paths.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';

export const openSpecPlanningPathAdmission: PlanningPathAdmission = (input) => {
  try {
    assertOpenSpecPlanningPaths(input);
  } catch (error) {
    if (!(error instanceof OpenSpecPlanningPathError)) throw error;
    throw mapOpenSpecPlanningPathError(error, input.schemaName);
  }
};

export const openSpecPlanningPathPolicy: PlanningPathPolicy = Object.freeze({
  admit: openSpecPlanningPathAdmission,
  requiredArtifactPaths: requiredOpenSpecPlanningArtifactPaths,
});

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
