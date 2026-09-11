import { prepareDurablePruneRecovery } from '../../modules/authority/execution-governance-store-transitions.ts';
import { isDurablePruneReceiptTemporary } from '../../modules/authority/execution-governance-store-contracts.ts';
import { currentDurablePruneReceiptReferences } from '../../modules/authority/execution-governance-store-contracts.ts';
import { parseStoredDurablePruneReceipt } from '../../modules/authority/execution-governance-store-contracts.ts';
/**
 * Reconciles prepared prune receipts against the published catalog before deleting objects.
 *
 * Invariants:
 * - The before-catalog digest aborts a prepared prune; the exact after digest permits completion.
 * - Objects still referenced by the manifest or catalog survive receipt recovery.
 * - Deletion and receipt completion preserve their existing directory-fsync order.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_DOCUMENT_BYTES,
  isWorkflowError,
  UUID_V4,
  digest,
} from '../../modules/authority/execution-governance-values.ts';
import {
  type DurablePruneReceipt,
  canonicalDurablePruneReceipt,
  unsafeDurableGovernanceStore,
  type DurableGovernancePaths,
  type DurableGovernanceState,
  durableRetentionCatalogDigest,
} from '../../modules/authority/execution-governance-store-contracts.ts';
import {
  readPrivateFile,
  replacePrivateFileAtomic,
  fsyncDirectory,
} from '../storage-journal/execution-governance-private-files.ts';
import {
  durableWorkflowReceiptDirectory,
  durableWorkflowObjectDirectory,
  durableObjectPath,
} from '../storage-journal/execution-governance-store-objects.ts';

export function readDurablePruneReceipt(filePath: string): DurablePruneReceipt {
  try {
    const raw = readPrivateFile(filePath, MAX_DOCUMENT_BYTES);
    return parseStoredDurablePruneReceipt(raw);
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeDurableGovernanceStore();
  }
}

export function recoverPreparedPruneReceipts(
  paths: DurableGovernancePaths,
  workflowId: string,
  state: DurableGovernanceState,
): void {
  const directory = durableWorkflowReceiptDirectory(paths, workflowId, true);
  const names = fs.readdirSync(directory).sort();
  for (const name of names) {
    if (isDurablePruneReceiptTemporary(name)) continue;
    if (!name.endsWith('.json') || !UUID_V4.test(name.slice(0, -5))) {
      throw unsafeDurableGovernanceStore();
    }
    const receiptPath = path.join(directory, name);
    const receipt = readDurablePruneReceipt(receiptPath);
    if (receipt.workflowId !== workflowId || receipt.state !== 'prepared') {
      if (receipt.workflowId !== workflowId) {
        throw unsafeDurableGovernanceStore();
      }
      continue;
    }
    const currentDigest = durableRetentionCatalogDigest(state.retention);
    const recoveredAt = new Date().toISOString();
    const aborted = prepareDurablePruneRecovery(
      receipt,
      currentDigest,
      recoveredAt,
    );
    if (aborted !== null) {
      replacePrivateFileAtomic(
        receiptPath,
        canonicalDurablePruneReceipt(aborted),
      );
      continue;
    }
    deleteUnreferencedReceiptObjects(paths, state, receipt);
    const complete: DurablePruneReceipt = {
      ...receipt,
      state: 'complete',
      completedAt: recoveredAt,
    };
    replacePrivateFileAtomic(
      receiptPath,
      canonicalDurablePruneReceipt(complete),
    );
  }
}

export function deleteUnreferencedReceiptObjects(
  paths: DurableGovernancePaths,
  state: DurableGovernanceState,
  receipt: DurablePruneReceipt,
): void {
  const referenced = currentDurablePruneReceiptReferences(state, receipt);

  const objectDirectory = durableWorkflowObjectDirectory(
    paths,
    receipt.workflowId,
    true,
  );
  let changed = false;
  for (const entry of receipt.deleted) {
    if (referenced.has(entry.digest)) continue;
    const objectPath = durableObjectPath(
      paths,
      receipt.workflowId,
      entry.digest,
    );
    if (fs.lstatSync(objectPath, { throwIfNoEntry: false }) === undefined) {
      continue;
    }
    const content = readPrivateFile(objectPath, MAX_DOCUMENT_BYTES);
    if (digest(content) !== entry.digest) {
      throw unsafeDurableGovernanceStore();
    }
    fs.unlinkSync(objectPath);
    changed = true;
  }
  if (changed) fsyncDirectory(objectDirectory);
}
