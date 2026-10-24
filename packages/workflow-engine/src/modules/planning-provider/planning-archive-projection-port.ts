import type { SystemDescriptionSnapshot } from '../source/spec-ownership.ts';
import type { ResolvedPlanningProviderBinding } from './planning-provider-binding.ts';
import type { PlanningPathPolicy } from '../source/planning-paths.ts';
import type { ReadSystemSpecDeltaInputs } from '../source/system-spec-deltas.ts';
export type PlanningArchiveSourcePolicy = Readonly<{
  planningPaths: PlanningPathPolicy;
  readSystemSpecDeltaInputs: ReadSystemSpecDeltaInputs;
}>;
/**
 * Adapts shared planning archive operations to workflow failure
 * conventions.
 *
 * Invariants:
 * - Only known archive contract errors are remapped; result values and
 *   other errors retain the core behavior.
 */
import {
  inspectPlanningArchiveReadiness as inspectCorePlanningArchiveReadiness,
  PlanningArchiveProjectionPortContractError,
  preparePlanningArchiveProjection as prepareCorePlanningArchiveProjection,
  validatePlanningArchiveProjectedSpecs as validateCorePlanningArchiveProjectedSpecs,
  type PlanningArchiveProjectedSpecValidation,
  type PlanningArchiveProjection,
  type PlanningArchiveProjectionContext,
  type PlanningArchiveProjectionDiagnostic,
  type PlanningArchiveProjectionPort,
  type PlanningArchiveReadiness,
  type PlanningArchiveTotals,
} from '@jigwright/core/planning-archive-projection-port';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type {
  PlanningArchiveProjectedSpecValidation,
  PlanningArchiveProjection,
  PlanningArchiveProjectionContext,
  PlanningArchiveProjectionDiagnostic,
  PlanningArchiveProjectionPort,
  PlanningArchiveReadiness,
  PlanningArchiveTotals,
};

/**
 * WorkflowError remains an application concern. Contract bytes and the exact
 * adapter boundary remain owned by @jigwright/core.
 */
export function inspectPlanningArchiveReadiness(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveReadiness {
  return mapContractError(() =>
    inspectCorePlanningArchiveReadiness(port, context),
  );
}

export function preparePlanningArchiveProjection(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjection {
  return mapContractError(() =>
    prepareCorePlanningArchiveProjection(port, context),
  );
}

export function validatePlanningArchiveProjectedSpecs(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjectedSpecValidation {
  return mapContractError(() =>
    validateCorePlanningArchiveProjectedSpecs(port, context),
  );
}

function mapContractError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof PlanningArchiveProjectionPortContractError)) {
      throw error;
    }
    throw workflowError(error.code, error.message, ExitCode.verification);
  }
}

export type ArchiveApplicabilityProjectionInput = {
  repositoryRoot: string;
  changeRoot: string;
  changeId: string;
  baselineCommit: string;
  sourceCommit: string;
  activeArtifactPaths: string[];
  planningProvider: ResolvedPlanningProviderBinding;
  source: 'worktree' | 'commit';
  now?: Date;
};

/**
 * What projecting an archive needs from the planning provider: the projection
 * port, the source policy it reads deltas through, and the system description
 * it compares against. Composition binds the trio; archive and planning
 * transition receive it.
 */
export type ArchiveProjectionDependencies = Readonly<{
  archiveProjectionPort: PlanningArchiveProjectionPort;
  sourcePolicy: PlanningArchiveSourcePolicy;
  readSystemDescriptionSnapshot(root: string): SystemDescriptionSnapshot;
}>;
