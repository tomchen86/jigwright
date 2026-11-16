import { validateStoredManifestItems } from '../../modules/authority/execution-governance-store-contracts.ts';
import { parseStoredDurableGovernanceState } from '../../modules/authority/execution-governance-store-contracts.ts';
/**
 * Publishes and reads private workflow context envelopes and content-addressed objects.
 *
 * Invariants:
 * - Content digests and canonical envelope bytes are checked before returning stored values.
 * - Context items publish before their owning envelope and never overwrite a different object.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ContextManifest } from '../../modules/authority/execution-governance-context.ts';
import {
  digest,
  assertDigest,
  assertUuid,
  MAX_DOCUMENT_BYTES,
  isWorkflowError,
} from '../../modules/authority/execution-governance-values.ts';
import {
  type DurableGovernancePaths,
  unsafeDurableGovernanceStore,
  type DurableGovernanceState,
  canonicalDurableGovernanceState,
} from '../../modules/authority/execution-governance-store-contracts.ts';
import {
  ensurePrivateDirectory,
  readPrivateFile,
  replacePrivateFileAtomic,
  createDurablePrivateFileAtomic,
} from './execution-governance-private-files.ts';
import { isNodeError } from '../../modules/authority/execution-governance-values.ts';

export function persistManifestItems(
  paths: DurableGovernancePaths,
  workflowId: string,
  manifest: ContextManifest,
  items: { identity: string; content: string }[],
): void {
  const byIdentity = validateStoredManifestItems(manifest, items);
  for (const reference of manifest.items) {
    const content = byIdentity.get(reference.identity)!;
    publishDurableContentObject(paths, workflowId, reference.digest, content);
  }
}

export function ensureDurableGovernanceStore(
  storeRoot: string,
): DurableGovernancePaths {
  if (
    typeof storeRoot !== 'string' ||
    storeRoot.length < 1 ||
    storeRoot.includes('\0')
  ) {
    throw unsafeDurableGovernanceStore();
  }
  const hostRoot = path.resolve(storeRoot);
  ensurePrivateDirectory(hostRoot, false);
  const root = path.join(hostRoot, 'execution-governance-store');
  ensurePrivateDirectory(root, true);
  const states = path.join(root, 'states');
  const objects = path.join(root, 'objects');
  const locks = path.join(root, 'locks');
  const pruneReceipts = path.join(root, 'prune-receipts');
  ensurePrivateDirectory(states, true);
  ensurePrivateDirectory(objects, true);
  ensurePrivateDirectory(locks, true);
  ensurePrivateDirectory(pruneReceipts, true);
  return { root, states, objects, locks, pruneReceipts };
}

export function workflowStorageKey(workflowId: string): string {
  return crypto.createHash('sha256').update(workflowId).digest('hex');
}

export function durableStatePath(
  paths: DurableGovernancePaths,
  workflowId: string,
): string {
  return path.join(paths.states, `${workflowStorageKey(workflowId)}.json`);
}

export function durableWorkflowObjectDirectory(
  paths: DurableGovernancePaths,
  workflowId: string,
  create: boolean,
): string {
  const directory = path.join(paths.objects, workflowStorageKey(workflowId));
  ensurePrivateDirectory(directory, create);
  return directory;
}

export function durableObjectPath(
  paths: DurableGovernancePaths,
  workflowId: string,
  contentDigest: string,
): string {
  assertDigest(contentDigest, unsafeDurableGovernanceStore, 'object digest');
  return path.join(
    durableWorkflowObjectDirectory(paths, workflowId, true),
    `${contentDigest.slice('sha256:'.length)}.blob`,
  );
}

export function durableWorkflowReceiptDirectory(
  paths: DurableGovernancePaths,
  workflowId: string,
  create: boolean,
): string {
  const directory = path.join(
    paths.pruneReceipts,
    workflowStorageKey(workflowId),
  );
  ensurePrivateDirectory(directory, create);
  return directory;
}

export function durablePruneReceiptPath(
  paths: DurableGovernancePaths,
  workflowId: string,
  receiptId: string,
): string {
  assertUuid(receiptId, unsafeDurableGovernanceStore);
  return path.join(
    durableWorkflowReceiptDirectory(paths, workflowId, true),
    `${receiptId}.json`,
  );
}

export function readDurableGovernanceState(
  paths: DurableGovernancePaths,
  workflowId: string,
): DurableGovernanceState {
  const statePath = durableStatePath(paths, workflowId);
  if (fs.lstatSync(statePath, { throwIfNoEntry: false }) === undefined) {
    throw workflowError(
      'EXECUTION_CONTEXT_NOT_FOUND',
      `Durable context for ${workflowId} does not exist.`,
      ExitCode.staleState,
    );
  }
  try {
    const raw = readPrivateFile(statePath, MAX_DOCUMENT_BYTES);
    return parseStoredDurableGovernanceState(raw, workflowId);
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

export function replaceDurableGovernanceState(
  paths: DurableGovernancePaths,
  state: DurableGovernanceState,
): void {
  replacePrivateFileAtomic(
    durableStatePath(paths, state.context.workflow.workflowId),
    canonicalDurableGovernanceState(state),
  );
}

export function publishDurableContentObject(
  paths: DurableGovernancePaths,
  workflowId: string,
  contentDigest: string,
  content: string,
): void {
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content) > MAX_DOCUMENT_BYTES ||
    digest(content) !== contentDigest
  ) {
    throw workflowError(
      'EXECUTION_CONTENT_OBJECT_MISMATCH',
      'Content-addressed object does not match its digest.',
      ExitCode.verification,
    );
  }
  const objectPath = durableObjectPath(paths, workflowId, contentDigest);
  if (fs.lstatSync(objectPath, { throwIfNoEntry: false }) !== undefined) {
    if (readPrivateFile(objectPath, MAX_DOCUMENT_BYTES) !== content) {
      throw unsafeDurableGovernanceStore();
    }
    return;
  }
  try {
    createDurablePrivateFileAtomic(objectPath, content);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  if (readPrivateFile(objectPath, MAX_DOCUMENT_BYTES) !== content) {
    throw unsafeDurableGovernanceStore();
  }
}

export function readDurableContentObject(
  paths: DurableGovernancePaths,
  workflowId: string,
  contentDigest: string,
): string {
  try {
    const content = readPrivateFile(
      durableObjectPath(paths, workflowId, contentDigest),
      MAX_DOCUMENT_BYTES,
    );
    if (digest(content) !== contentDigest) {
      throw unsafeDurableGovernanceStore();
    }
    return content;
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
