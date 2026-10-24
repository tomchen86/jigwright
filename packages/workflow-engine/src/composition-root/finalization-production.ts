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
import { createProductionSessionCheckService } from './session-check-production.ts';
import { productionTaskStrategyExecutionGate } from './task-strategy-gate-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { taskDiffReview } from './task-diff-review-production.ts';
import { managedDocuments } from './managed-documents-production.ts';
/** Binds the mandatory reconciliation gate for every finalization path. */
import { createFinalizationService } from '../runtime/finalization/finalization-service.ts';
import { assertCurrentImplementationReconciliation } from './implementation-reconciliation-production.ts';
export function createProductionFinalizationService() {
  const finalization = createFinalizationService(
    reviewedGeneratedAssets,
    createProductionSessionCheckService(),
    productionTaskStrategyExecutionGate,
    productionChangeContract,
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

import {
  cancelFinalizeRecovery as cancelFinalizeRecoveryWithTaskDiffReview,
  cancelProtectedTaskApplyRecoveryUnderGrant as cancelProtectedTaskApplyRecoveryUnderGrantWithTaskDiffReview,
  inspectFinalizeRecoveryStatus as inspectFinalizeRecoveryStatusWithTaskDiffReview,
} from '../runtime/finalization/recovery.ts';
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
