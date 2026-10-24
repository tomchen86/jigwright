import type { CiPlanningReplayOperations } from './ci-planning.ts';
import type { TaskExecutionGenerationReader } from '../task-execution-evidence.ts';
/** Canonical commit replay contracts and pure predicates. */
import { isArchiveName } from './ci-archive-tree.ts';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { WorkflowError } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';
import { preparePlanningArchiveProjection } from '../../planning-provider/planning-archive-projection-port.ts';
import type { PlanningArchiveProjection } from '@jigwright/core/planning-archive-projection-port';
import type { PlanningArchiveProjectionContext } from '@jigwright/core/planning-archive-projection-port';
import type { PlanningArchiveProjectionPort } from '@jigwright/core/planning-archive-projection-port';

export type ArchiveTotals = {
  added: number;
  modified: number;
  removed: number;
  renamed: number;
};

export type CiArchiveValidation = {
  changeId: string;
  archivePath: string;
  changedPaths: string[];
  checkDefinitions: Record<string, string>;
};

export function prepareArchiveProjectionForReplay(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjection {
  try {
    return preparePlanningArchiveProjection(port, context);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      (error.code === 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID' ||
        error.code === 'PLANNING_ARCHIVE_PROJECTION_PORT_INVALID')
    ) {
      throw replayMismatch();
    }
    throw error;
  }
}

export function archivePayloadFromProjection(
  projection: PlanningArchiveProjection,
  changeRoot: string,
  changeId: string,
): { archivePath: string; totals: ArchiveTotals } {
  const totals = projection.totals;
  if (
    !projection.specsUpdated ||
    totals === undefined ||
    !isArchiveName(projection.archiveName, changeId) ||
    projection.archivePath !== `${changeRoot}/archive/${projection.archiveName}`
  ) {
    throw replayMismatch();
  }
  return { archivePath: projection.archivePath, totals };
}

export function isTotals(value: unknown): value is ArchiveTotals {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['added', 'modified', 'removed', 'renamed']) &&
    ['added', 'modified', 'removed', 'renamed'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    )
  );
}

export function assertChangeId(changeId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) throw replayMismatch();
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function replayMismatch() {
  return archiveError(
    'CI_ARCHIVE_REPLAY_MISMATCH',
    'Archive commit differs from the independently replayed transformation.',
  );
}

export function archiveError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

export type CiArchiveReplayOperations = {
  validateCiArchiveCommit(
    repositoryRoot: string,
    commitHash: string,
    changeId: string,
  ): CiArchiveValidation;
};

export type ArchiveEligibilityReplayServices = {
  planningReplay: Pick<
    CiPlanningReplayOperations,
    'collectHistoricalCollaborationGrantUses'
  >;
  taskExecutionGeneration: TaskExecutionGenerationReader;
};
