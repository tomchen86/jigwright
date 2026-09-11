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
