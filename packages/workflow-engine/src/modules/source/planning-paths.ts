/**
 * Checks planning artifact boundaries and maps cited Sources to immutable
 * ledger paths.
 *
 * Invariants:
 * - Planning changes cannot delete a cited Source object.
 */
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

/** Provider-owned artifact grammar, after immutable engine companion paths are admitted. */
export type PlanningPathAdmission = (
  input: Readonly<{
    changeRoot: string;
    changeId: string;
    changedPaths: readonly string[];
    deletedPaths: readonly string[];
    schemaName: string;
    currentSchemaName: string;
    additionalExactPaths: readonly string[];
  }>,
) => void;

export type PlanningPathPolicy = Readonly<{
  admit: PlanningPathAdmission;
  requiredArtifactPaths(
    changeRoot: string,
    changeId: string,
    schemaName: string,
    currentSchemaName: string,
  ): string[];
}>;

export function assertPlanningPaths(
  admit: PlanningPathAdmission,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  schemaName: string,
  currentSchemaName: string,
  citedSourceRefs: readonly `SRC-${string}`[] = [],
): void {
  const sourceObjectPaths = planningSourceObjectPaths(citedSourceRefs);
  if (
    sourceObjectPaths.some((sourcePath) => deletedPaths.includes(sourcePath))
  ) {
    throw workflowError(
      'PLANNING_PATHS_INVALID',
      'Planning cannot delete an immutable cited Source object.',
      ExitCode.guard,
    );
  }
  const additionalExactPaths =
    changeId === 'archive'
      ? []
      : [planningProviderBindingPath(changeId), ...sourceObjectPaths];
  admit({
    changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
    schemaName,
    currentSchemaName,
    additionalExactPaths,
  });
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
