/** Concrete durable-context compaction and evidence pruning, independent of repository authority. */
import {
  compactDurableEpochTransitionReceipts,
  inspectDurableEpochContextStore,
} from '../storage-journal/execution-governance-epoch-store.ts';
import {
  inspectDurableRetentionCatalog,
  pruneDurableEvidence,
} from '../storage-journal/execution-governance-evidence-store.ts';
import {
  planEvidencePruning,
  assertEvidenceRetentionLimit as assertLimit,
  exactRetentionTimestamp as exactTimestamp,
} from '../../modules/authority/execution-governance-retention.ts';
import type {
  DurablePruneReceipt,
  DurableContextRetentionMaintenanceResult,
} from '../../modules/authority/execution-governance-store-contracts.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';

export function runDurableContextRetentionMaintenance(
  storeRoot: string,
  workflowIds: readonly string[],
  input: { limit: number; now: Date },
): DurableContextRetentionMaintenanceResult {
  const limit = assertLimit(input.limit);
  const now = new Date(exactTimestamp(input.now.toISOString()));
  const workflows = [...new Set(workflowIds)].sort().slice(0, limit);
  const compacted: Array<{
    workflowId: string;
    fullReceiptsBefore: number;
    fullReceiptsAfter: number;
    stubsBefore: number;
    stubsAfter: number;
    discarded: readonly string[];
  }> = [];
  const pruned: Array<{
    workflowId: string;
    deleted: number;
    receipt: DurablePruneReceipt;
  }> = [];
  const skipped: Array<{
    workflowId: string;
    reason: 'context-not-found' | 'nothing-expired';
  }> = [];
  for (const workflowId of workflows) {
    let context;
    let catalog;
    try {
      context = inspectDurableEpochContextStore(storeRoot, workflowId);
      catalog = inspectDurableRetentionCatalog(storeRoot, workflowId);
    } catch (error) {
      if (isWorkflowError(error, 'EXECUTION_CONTEXT_NOT_FOUND')) {
        skipped.push({ workflowId, reason: 'context-not-found' });
        continue;
      }
      throw error;
    }
    const receiptCompaction = compactDurableEpochTransitionReceipts(storeRoot, {
      workflowId,
      expectedContextGeneration: context.generation,
      now,
    });
    if (receiptCompaction.changed) {
      compacted.push({
        workflowId,
        fullReceiptsBefore: receiptCompaction.fullReceiptsBefore,
        fullReceiptsAfter: receiptCompaction.fullReceiptsAfter,
        stubsBefore: receiptCompaction.stubsBefore,
        stubsAfter: receiptCompaction.stubsAfter,
        discarded: receiptCompaction.discarded,
      });
      context = inspectDurableEpochContextStore(storeRoot, workflowId);
    }
    const plan = planEvidencePruning({
      records: catalog.records,
      currentEpoch: context.workflow.currentEpoch,
      currentManifest: context.currentManifest,
      now,
    });
    if (plan.delete.length === 0) {
      skipped.push({ workflowId, reason: 'nothing-expired' });
      continue;
    }
    const result = pruneDurableEvidence(storeRoot, {
      workflowId,
      expectedContextGeneration: context.generation,
      expectedEpoch: context.workflow.currentEpoch,
      expectedContextDigest: context.workflow.contextDigest,
      expectedCatalogGeneration: catalog.generation,
      now,
    });
    pruned.push({
      workflowId,
      deleted: result.receipt.deleted.length,
      receipt: result.receipt,
    });
  }
  return deepFreeze({
    examined: workflows.length,
    compacted,
    pruned,
    skipped,
  });
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
