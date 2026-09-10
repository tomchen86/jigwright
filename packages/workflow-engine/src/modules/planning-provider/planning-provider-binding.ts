/**
 * Adapts the shared planning binding codec to workflow errors and exit
 * categories.
 *
 * Invariants:
 * - Binding bytes and identity remain core-defined; unsupported migrations
 *   map to the guard category.
 */
import {
  parsePlanningProviderBinding as parseCorePlanningProviderBinding,
  PlanningProviderBindingError,
  planningProviderBindingDigest as corePlanningProviderBindingDigest,
  renderPlanningProviderBinding as renderCorePlanningProviderBinding,
  type PlanningProviderBindingReaderPort,
  type PlanningProviderBindingV1,
  type ResolvedPlanningProviderBinding,
} from '@jigwright/core/planning-provider-binding';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type {
  PlanningProviderBindingReaderPort,
  PlanningProviderBindingV1,
  ResolvedPlanningProviderBinding,
};

/**
 * Workflow facade for the current binding codec. Durable bytes and digests are
 * core-owned; workflow-engine retains only its stable WorkflowError/exit-code
 * surface.
 */
export function parsePlanningProviderBinding(
  source: string,
  expectedChangeId: string,
): PlanningProviderBindingV1 {
  return mapBindingError(() =>
    parseCorePlanningProviderBinding(source, expectedChangeId),
  );
}

export function renderPlanningProviderBinding(
  value: PlanningProviderBindingV1,
): string {
  return mapBindingError(() => renderCorePlanningProviderBinding(value));
}

export function planningProviderBindingDigest(
  value: PlanningProviderBindingV1,
): string {
  return mapBindingError(() => corePlanningProviderBindingDigest(value));
}

function mapBindingError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof PlanningProviderBindingError)) throw error;
    throw workflowError(
      error.code,
      error.message,
      error.code === 'PROVIDER_MIGRATION_UNSUPPORTED'
        ? ExitCode.guard
        : ExitCode.verification,
    );
  }
}
