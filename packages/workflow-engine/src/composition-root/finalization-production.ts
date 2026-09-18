import {
  normalizeCompletionRollbackReason,
  type RollbackCompletionResult,
} from '../modules/lifecycle/completion-rollback.ts';
import { reviewedGeneratedAssets } from './planning-provider-authoring-production.ts';
import { rollbackCompletionProjection } from '../runtime/managed-documents/transaction/completion-rollback.ts';
import {
  loadActiveSessionContext,
  runSessionOperation,
} from './lifecycle-context.ts';
import { systemDocumentDispositions } from './system-document-disposition-production.ts';
import type { LocalEngineSelectionReaders } from '../modules/authority/local-engine-selection.ts';
import { maintainerManifestOperations } from './maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from './task-strategy-gate-production.ts';
import { productionChangeRoutingAdmissionReader } from './change-routing-observation-production.ts';
import { taskDiffReview } from './task-diff-review-production.ts';
import { managedDocuments } from './managed-documents-production.ts';
/** Binds the mandatory reconciliation gate for every finalization path. */
import { createFinalizationService } from '../application/finalize/lifecycle.ts';
import { assertCurrentImplementationReconciliation } from './implementation-reconciliation-production.ts';
export function createProductionFinalizationService(
  localEngineSelection: LocalEngineSelectionReaders,
) {
  const finalization = createFinalizationService(
    reviewedGeneratedAssets,
    localEngineSelection,
    maintainerManifestOperations,
    productionTaskStrategyExecutionGate,
    productionChangeRoutingAdmissionReader,
    taskDiffReview,
    managedDocuments,
    assertCurrentImplementationReconciliation,
    systemDocumentDispositions,
  );
  function rollbackCompletion(
    cwd: string,
    requestedSessionId: string,
    reason: string,
  ): RollbackCompletionResult {
    const normalizedReason = normalizeCompletionRollbackReason(reason);
    return runSessionOperation(cwd, requestedSessionId, () =>
      rollbackCompletionProjection(
        loadActiveSessionContext(cwd, requestedSessionId),
        normalizedReason,
        managedDocuments,
      ),
    );
  }
  return Object.freeze({ rollbackCompletion, ...finalization });
}

export type ProductionFinalizationService = ReturnType<
  typeof createProductionFinalizationService
>;
export type ProtectedTaskApplyFinalizer =
  ProductionFinalizationService['finalizeProtectedTaskApplyUnderGrant'];
export type { LocalEngineSelectionReaders } from '../modules/authority/local-engine-selection.ts';

import {
  cancelFinalizeRecovery as cancelFinalizeRecoveryWithTaskDiffReview,
  cancelProtectedTaskApplyRecoveryUnderGrant as cancelProtectedTaskApplyRecoveryUnderGrantWithTaskDiffReview,
  inspectFinalizeRecoveryStatus as inspectFinalizeRecoveryStatusWithTaskDiffReview,
} from '../application/finalize/lifecycle.ts';
export const cancelFinalizeRecovery =
  cancelFinalizeRecoveryWithTaskDiffReview.bind(undefined, taskDiffReview);
export const cancelProtectedTaskApplyRecoveryUnderGrant =
  cancelProtectedTaskApplyRecoveryUnderGrantWithTaskDiffReview.bind(
    undefined,
    taskDiffReview,
  );
export const inspectFinalizeRecoveryStatus =
  inspectFinalizeRecoveryStatusWithTaskDiffReview.bind(
    undefined,
    taskDiffReview,
  );
