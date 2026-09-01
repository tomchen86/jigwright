import {
  RepositoryPathError,
  normalizeChangedPath,
} from '@jigwright/core/repository-path';

export type OpenSpecPlanningPathErrorCode =
  | 'PLANNING_CHANGE_ID_RESERVED'
  | 'PLANNING_PATH_SYNTAX_INVALID'
  | 'PLANNING_PATHS_INVALID';

export class OpenSpecPlanningPathError extends TypeError {
  readonly code: OpenSpecPlanningPathErrorCode;
  readonly invalidPaths: readonly string[];

  constructor(
    code: OpenSpecPlanningPathErrorCode,
    message: string,
    invalidPaths: readonly string[] = [],
  ) {
    super(message);
    this.name = 'OpenSpecPlanningPathError';
    this.code = code;
    this.invalidPaths = Object.freeze([...invalidPaths]);
  }
}

export type OpenSpecPlanningPathInput = Readonly<{
  changeRoot: string;
  changeId: string;
  changedPaths: readonly string[];
  deletedPaths: readonly string[];
  schemaName: string;
  currentSchemaName: string;
  additionalExactPaths?: readonly string[];
}>;

/**
 * Own the OpenSpec artifact grammar without owning repository transition
 * authority. The caller supplies any engine-owned companion paths explicitly.
 */
export function assertOpenSpecPlanningPaths(
  input: OpenSpecPlanningPathInput,
): void {
  if (input.changeId === 'archive') {
    throw new OpenSpecPlanningPathError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
    );
  }
  const prefix = `${input.changeRoot}/${input.changeId}/`;
  const exact = new Set([
    ...requiredOpenSpecPlanningArtifactPaths(
      input.changeRoot,
      input.changeId,
      input.schemaName,
      input.currentSchemaName,
    ),
    ...(input.schemaName === input.currentSchemaName
      ? [`${prefix}origin.json`, `${prefix}survey.json`]
      : []),
    ...(input.additionalExactPaths ?? []),
  ]);
  const deleted = new Set(input.deletedPaths.map(normalizePlanningPath));
  const invalid = input.changedPaths.filter((candidate) => {
    const normalized = normalizePlanningPath(candidate);
    if (exact.has(normalized)) {
      return false;
    }
    if (deleted.has(normalized) && normalized.startsWith(prefix)) {
      return false;
    }
    if (!normalized.startsWith(`${prefix}specs/`)) {
      return true;
    }
    const relative = normalized.slice(`${prefix}specs/`.length);
    const segments = relative.split('/');
    return (
      segments.length < 2 ||
      segments.at(-1) !== 'spec.md' ||
      segments
        .slice(0, -1)
        .some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segment))
    );
  });
  if (invalid.length > 0) {
    throw new OpenSpecPlanningPathError(
      'PLANNING_PATHS_INVALID',
      `Planning transition contains paths outside the named ${input.schemaName} planning tree.`,
      invalid.sort(),
    );
  }
}

export function requiredOpenSpecPlanningArtifactPaths(
  changeRoot: string,
  changeId: string,
  schemaName: string,
  currentSchemaName: string,
): string[] {
  const prefix = `${changeRoot}/${changeId}/`;
  return [
    '.openspec.yaml',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    ...(schemaName === currentSchemaName
      ? ['investigation.json', 'execution.json', 'plan-review.json']
      : []),
  ]
    .map((entry) => `${prefix}${entry}`)
    .sort();
}

function normalizePlanningPath(value: string): string {
  try {
    return normalizeChangedPath(value);
  } catch (error) {
    if (!(error instanceof RepositoryPathError)) throw error;
    throw new OpenSpecPlanningPathError(
      'PLANNING_PATH_SYNTAX_INVALID',
      'OpenSpec planning path syntax is invalid.',
      [error.value],
    );
  }
}
