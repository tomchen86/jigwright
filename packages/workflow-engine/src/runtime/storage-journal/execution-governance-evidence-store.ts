import { retentionEvidenceNotFound } from '../../modules/authority/execution-governance-store-transitions.ts';
import { prepareDurableEvidencePruning } from '../../modules/authority/execution-governance-store-transitions.ts';
import { pinDurableRetentionEvidence } from '../../modules/authority/execution-governance-store-transitions.ts';
import { addDurableRetentionEvidence } from '../../modules/authority/execution-governance-store-transitions.ts';
import { assertDurableEvidencePublication } from '../../modules/authority/execution-governance-store-transitions.ts';
import type { DurableEvidencePruneInput } from '../../modules/authority/execution-governance-store-contracts.ts';
import type { DurableEvidencePinInput } from '../../modules/authority/execution-governance-store-contracts.ts';
import type { DurableEvidencePublicationInput } from '../../modules/authority/execution-governance-store-contracts.ts';
import type { ExecutionEpochStore } from '../../modules/authority/execution-governance-epoch-port.ts';
/**
 * Stores, pins, and prunes evidence through the current durable retention catalog.
 *
 * Invariants:
 * - Catalog mutations retain current context and catalog-generation checks.
 * - Prune receipts become durable before catalog publication and object deletion.
 * - Pinned evidence and current manifest content remain reachable after pruning.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  assertIdentity,
  MAX_DOCUMENT_BYTES,
  digest,
  exactDate,
  UUID_V4,
} from '../../modules/authority/execution-governance-values.ts';
import {
  invalidRetentionRecord,
  type EvidenceRetentionRecord,
  validateEvidenceRetentionRecord,
  DEFAULT_RETENTION_POLICY,
  validateRetentionPolicy,
} from '../../modules/authority/execution-governance-retention.ts';
import {
  type DurableRetentionCatalog,
  type DurablePruneReceipt,
  durableRetentionCatalogDigest,
  canonicalDurablePruneReceipt,
  type DurableGovernanceState,
  unsafeDurableGovernanceStore,
} from '../../modules/authority/execution-governance-store-contracts.ts';
import {
  readDurableGovernanceState,
  ensureDurableGovernanceStore,
  publishDurableContentObject,
  replaceDurableGovernanceState,
  readDurableContentObject,
  durablePruneReceiptPath,
  durableWorkflowReceiptDirectory,
} from './execution-governance-store-objects.ts';
import { withDurableGovernanceLock } from './execution-governance-locks.ts';
import {
  recoverPreparedPruneReceipts,
  deleteUnreferencedReceiptObjects,
  readDurablePruneReceipt,
} from './execution-governance-prune-recovery.ts';
import { isDurablePruneReceiptTemporary } from '../../modules/authority/execution-governance-store-contracts.ts';
import {
  createDurablePrivateFileAtomic,
  replacePrivateFileAtomic,
} from './execution-governance-private-files.ts';

export const inspectDurableRetentionCatalog: ExecutionEpochStore['inspectDurableRetentionCatalog'] =
  (storeRoot, workflowId) => {
    assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
    const state = readDurableGovernanceState(
      ensureDurableGovernanceStore(storeRoot),
      workflowId,
    );
    return structuredClone(state.retention);
  };

export function storeDurableEvidence(
  storeRoot: string,
  input: DurableEvidencePublicationInput,
): DurableRetentionCatalog {
  assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
  validateEvidenceRetentionRecord(input.record);
  if (input.record.retention === 'pinned') {
    throw workflowError(
      'RETENTION_PIN_REQUIRES_HUMAN',
      'Pinned evidence must be created through an explicit human pin decision.',
      ExitCode.guard,
    );
  }
  if (
    typeof input.content !== 'string' ||
    Buffer.byteLength(input.content) > MAX_DOCUMENT_BYTES ||
    digest(input.content) !== input.record.digest
  ) {
    throw workflowError(
      'RETENTION_EVIDENCE_DIGEST_MISMATCH',
      'Evidence content does not match its retention digest.',
      ExitCode.verification,
    );
  }
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    assertDurableEvidencePublication(state, input);
    publishDurableContentObject(
      paths,
      input.workflowId,
      input.record.digest,
      input.content,
    );
    const updatedAt = new Date().toISOString();
    const retention = addDurableRetentionEvidence(state, input, updatedAt);
    replaceDurableGovernanceState(paths, {
      ...state,
      retention,
    });
    return structuredClone(retention);
  });
}

export function pinDurableEvidence(
  storeRoot: string,
  input: DurableEvidencePinInput,
): DurableRetentionCatalog {
  assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
  assertIdentity(input.evidenceId, invalidRetentionRecord, 'evidence ID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    const retention = pinDurableRetentionEvidence(state, input);
    replaceDurableGovernanceState(paths, { ...state, retention });
    return structuredClone(retention);
  });
}

export function readDurableEvidence(
  storeRoot: string,
  workflowId: string,
  evidenceId: string,
): { record: EvidenceRetentionRecord; content: string } {
  assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
  assertIdentity(evidenceId, invalidRetentionRecord, 'evidence ID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  const state = readDurableGovernanceState(paths, workflowId);
  const record = state.retention.records.find(
    (candidate) => candidate.evidenceId === evidenceId,
  );
  if (record === undefined) throw retentionEvidenceNotFound(evidenceId);
  return {
    record: structuredClone(record),
    content: readDurableContentObject(paths, workflowId, record.digest),
  };
}

/**
 * Performs one explicit pruning pass. The prepared receipt is durable before
 * the catalog CAS, and object deletion happens only after the catalog no longer
 * names the records. A later mutation recovers a prepared pass idempotently.
 */
export function pruneDurableEvidence(
  storeRoot: string,
  input: DurableEvidencePruneInput,
): { catalog: DurableRetentionCatalog; receipt: DurablePruneReceipt } {
  assertIdentity(input.workflowId, invalidRetentionRecord, 'workflow ID');
  const now = exactDate(input.now, 'RETENTION_RECORD_INVALID');
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    const { retention, deleted } = prepareDurableEvidencePruning(
      state,
      input,
      now,
      policy,
    );
    const receipt: DurablePruneReceipt = {
      schemaVersion: 1,
      kind: 'durable-evidence-prune',
      receiptId: crypto.randomUUID(),
      state: 'prepared',
      workflowId: input.workflowId,
      contextGeneration: state.context.generation,
      epoch: state.context.workflow.currentEpoch,
      contextDigest: state.context.workflow.contextDigest,
      catalogGenerationBefore: state.retention.generation,
      catalogDigestBefore: durableRetentionCatalogDigest(state.retention),
      catalogGenerationAfter: retention.generation,
      catalogDigestAfter: durableRetentionCatalogDigest(retention),
      deleted,
      preparedAt: now,
      completedAt: null,
      abortedAt: null,
      abortReason: null,
    };
    const receiptPath = durablePruneReceiptPath(
      paths,
      input.workflowId,
      receipt.receiptId,
    );
    createDurablePrivateFileAtomic(
      receiptPath,
      canonicalDurablePruneReceipt(receipt),
    );
    const next: DurableGovernanceState = { ...state, retention };
    replaceDurableGovernanceState(paths, next);
    deleteUnreferencedReceiptObjects(paths, next, receipt);
    const complete: DurablePruneReceipt = {
      ...receipt,
      state: 'complete',
      completedAt: now,
    };
    replacePrivateFileAtomic(
      receiptPath,
      canonicalDurablePruneReceipt(complete),
    );
    return {
      catalog: structuredClone(retention),
      receipt: structuredClone(complete),
    };
  });
}

export function listDurablePruneReceipts(
  storeRoot: string,
  workflowId: string,
): DurablePruneReceipt[] {
  assertIdentity(workflowId, invalidRetentionRecord, 'workflow ID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  const directory = durableWorkflowReceiptDirectory(paths, workflowId, true);
  const receipts = fs
    .readdirSync(directory)
    .filter((name) => !isDurablePruneReceiptTemporary(name))
    .map((name) => {
      if (
        !UUID_V4.test(name.replace(/\.json$/, '')) ||
        !name.endsWith('.json')
      ) {
        throw unsafeDurableGovernanceStore();
      }
      const receipt = readDurablePruneReceipt(path.join(directory, name));
      if (receipt.workflowId !== workflowId) {
        throw unsafeDurableGovernanceStore();
      }
      return receipt;
    });
  return receipts
    .sort(
      (left, right) =>
        left.preparedAt.localeCompare(right.preparedAt) ||
        left.receiptId.localeCompare(right.receiptId),
    )
    .map((receipt) => structuredClone(receipt));
}
