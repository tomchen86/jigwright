import type { RetentionPolicy } from './execution-governance-retention.ts';
import { parseDocument, UUID_V4 } from './execution-governance-values.ts';
import { invalidContextManifest } from './execution-governance-context.ts';
/**
 * Validates durable context, retention, and prune envelopes with their exact CAS bindings.
 *
 * Invariants:
 * - Canonical envelopes bind context and retention to the same workflow and exact manifest.
 * - Prepared prune records retain before and after catalog digests and their transition state.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  workflowError,
  ExitCode,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import type { ContextManifest } from './execution-governance-context.ts';
import {
  digest,
  MAX_DOCUMENT_BYTES,
  isRecord,
  hasExactKeys,
  assertPositiveInteger,
  assertTimestamp,
  assertIdentity,
  assertDigest,
  assertUuid,
  assertReason,
} from './execution-governance-values.ts';
import {
  type WorkflowContextState,
  type EpochTransitionReceipt,
  validateContextManifest,
  validateEpochTransitionReceipt,
} from './execution-governance-context.ts';
import {
  type EpochTransitionStub,
  type EvidenceRetentionRecord,
  DEFAULT_RETENTION_POLICY,
  transitionKey,
  validateEpochTransitionStub,
  validateEvidenceRetentionRecord,
  invalidRetentionRecord,
} from './execution-governance-retention.ts';

export type DurableEpochContextState = {
  schemaVersion: 1;
  kind: 'durable-epoch-context';
  generation: number;
  workflow: WorkflowContextState;
  currentManifest: ContextManifest;
  transitionReceipts: EpochTransitionReceipt[];
  transitionStubs: EpochTransitionStub[];
  updatedAt: string;
};

export type DurableRetentionCatalog = {
  schemaVersion: 1;
  kind: 'durable-retention-catalog';
  workflowId: string;
  generation: number;
  records: EvidenceRetentionRecord[];
  updatedAt: string;
};

export type DurablePruneReceipt = {
  schemaVersion: 1;
  kind: 'durable-evidence-prune';
  receiptId: string;
  state: 'prepared' | 'complete' | 'aborted';
  workflowId: string;
  contextGeneration: number;
  epoch: number;
  contextDigest: string;
  catalogGenerationBefore: number;
  catalogDigestBefore: string;
  catalogGenerationAfter: number;
  catalogDigestAfter: string;
  deleted: { evidenceId: string; digest: string }[];
  preparedAt: string;
  completedAt: string | null;
  abortedAt: string | null;
  abortReason: string | null;
};

export type DurableGovernanceState = {
  schemaVersion: 1;
  kind: 'durable-execution-governance-state';
  context: DurableEpochContextState;
  retention: DurableRetentionCatalog;
};

export type DurableGovernancePaths = {
  root: string;
  states: string;
  objects: string;
  locks: string;
  pruneReceipts: string;
};

export type DurableEpochTransitionCompactionResult = Readonly<{
  workflowId: string;
  changed: boolean;
  contextGeneration: number;
  fullReceiptsBefore: number;
  fullReceiptsAfter: number;
  stubsBefore: number;
  stubsAfter: number;
  discarded: readonly string[];
}>;

/** Immutable result shared by durable maintenance and its repository-facing envelope. */
export type DurableContextRetentionMaintenanceResult = Readonly<{
  examined: number;
  compacted: ReadonlyArray<{
    workflowId: string;
    fullReceiptsBefore: number;
    fullReceiptsAfter: number;
    stubsBefore: number;
    stubsAfter: number;
    discarded: readonly string[];
  }>;
  pruned: ReadonlyArray<{
    workflowId: string;
    deleted: number;
    receipt: DurablePruneReceipt;
  }>;
  skipped: ReadonlyArray<{
    workflowId: string;
    reason: 'context-not-found' | 'nothing-expired';
  }>;
}>;

export function canonicalDurableGovernanceState(
  state: DurableGovernanceState,
): string {
  validateDurableGovernanceState(state);
  return boundedDurableDocument(`${canonicalJson(state)}\n`);
}

function canonicalDurableRetentionCatalog(
  catalog: DurableRetentionCatalog,
): string {
  validateDurableRetentionCatalog(catalog);
  return boundedDurableDocument(`${canonicalJson(catalog)}\n`);
}

export function durableRetentionCatalogDigest(
  catalog: DurableRetentionCatalog,
): string {
  return digest(canonicalDurableRetentionCatalog(catalog));
}

export function canonicalDurablePruneReceipt(
  receipt: DurablePruneReceipt,
): string {
  validateDurablePruneReceipt(receipt);
  return boundedDurableDocument(`${canonicalJson(receipt)}\n`);
}

function boundedDurableDocument(content: string): string {
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
    throw workflowError(
      'EXECUTION_GOVERNANCE_STORE_CAPACITY',
      'Durable execution-governance document exceeds its size bound.',
      ExitCode.guard,
    );
  }
  return content;
}

export function validateDurableGovernanceState(
  value: unknown,
): asserts value is DurableGovernanceState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'kind', 'context', 'retention']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-execution-governance-state'
  ) {
    throw unsafeDurableGovernanceStore();
  }
  validateDurableEpochContextState(value.context);
  validateDurableRetentionCatalog(value.retention);
  const context = value.context;
  const retention = value.retention;
  if (retention.workflowId !== context.workflow.workflowId) {
    throw unsafeDurableGovernanceStore();
  }
  const currentItems = new Map(
    context.currentManifest.items.map(({ identity, digest: itemDigest }) => [
      identity,
      itemDigest,
    ]),
  );
  for (const record of retention.records) {
    if (
      record.epoch > context.workflow.currentEpoch ||
      (record.retention === 'active' &&
        record.epoch !== context.workflow.currentEpoch)
    ) {
      throw unsafeDurableGovernanceStore();
    }
    if (record.itemIdentity !== null) {
      const currentDigest = currentItems.get(record.itemIdentity);
      if (
        record.epoch === context.workflow.currentEpoch &&
        currentDigest !== undefined &&
        currentDigest !== record.digest
      ) {
        throw unsafeDurableGovernanceStore();
      }
    }
  }
  for (const [identity, itemDigest] of currentItems) {
    if (
      !retention.records.some(
        (record) =>
          record.itemIdentity === identity &&
          record.digest === itemDigest &&
          record.epoch === context.workflow.currentEpoch &&
          record.evidenceClass === 'manifest-item' &&
          record.retention !== 'expiring',
      )
    ) {
      throw unsafeDurableGovernanceStore();
    }
  }
}

function validateDurableEpochContextState(
  value: unknown,
): asserts value is DurableEpochContextState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'generation',
      'workflow',
      'currentManifest',
      'transitionReceipts',
      'transitionStubs',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-epoch-context'
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertPositiveInteger(
    value.generation,
    unsafeDurableGovernanceStore,
    'context generation',
  );
  validateStoredWorkflowContextState(value.workflow);
  validateContextManifest(value.currentManifest);
  assertStoredContextManifestBinding(value.workflow, value.currentManifest);
  if (
    !Array.isArray(value.transitionReceipts) ||
    value.transitionReceipts.length >
      DEFAULT_RETENTION_POLICY.maxFullTransitionReceipts ||
    !Array.isArray(value.transitionStubs) ||
    value.transitionStubs.length > 200
  ) {
    throw unsafeDurableGovernanceStore();
  }
  const transitionKeys = new Set<string>();
  for (const receipt of value.transitionReceipts) {
    validateEpochTransitionReceipt(receipt);
    if (
      receipt.workflowId !== value.workflow.workflowId ||
      transitionKeys.has(transitionKey(receipt))
    ) {
      throw unsafeDurableGovernanceStore();
    }
    transitionKeys.add(transitionKey(receipt));
  }
  for (const stub of value.transitionStubs) {
    validateEpochTransitionStub(stub);
    if (
      stub.workflowId !== value.workflow.workflowId ||
      transitionKeys.has(transitionKey(stub))
    ) {
      throw unsafeDurableGovernanceStore();
    }
    transitionKeys.add(transitionKey(stub));
  }
  assertTimestamp(
    value.updatedAt,
    unsafeDurableGovernanceStore,
    'context updatedAt',
  );
}

function validateStoredWorkflowContextState(
  value: unknown,
): asserts value is WorkflowContextState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'workflowId',
      'currentEpoch',
      'contractVersion',
      'contextDigest',
      'snapshotDigest',
      'status',
      'checkpoint',
      'blocker',
    ])
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
  assertPositiveInteger(
    value.currentEpoch,
    unsafeDurableGovernanceStore,
    'current epoch',
  );
  assertPositiveInteger(
    value.contractVersion,
    unsafeDurableGovernanceStore,
    'contract version',
  );
  assertDigest(
    value.contextDigest,
    unsafeDurableGovernanceStore,
    'context digest',
  );
  assertDigest(
    value.snapshotDigest,
    unsafeDurableGovernanceStore,
    'snapshot digest',
  );
  assertIdentity(value.checkpoint, unsafeDurableGovernanceStore, 'checkpoint');
  if (
    !['active', 'completed', 'cancelled', 'superseded'].includes(
      String(value.status),
    )
  ) {
    throw unsafeDurableGovernanceStore();
  }
  if (value.blocker !== null) {
    if (
      !isRecord(value.blocker) ||
      !hasExactKeys(value.blocker, ['kind', 'since'])
    ) {
      throw unsafeDurableGovernanceStore();
    }
    assertIdentity(
      value.blocker.kind,
      unsafeDurableGovernanceStore,
      'blocker kind',
    );
    assertTimestamp(
      value.blocker.since,
      unsafeDurableGovernanceStore,
      'blocker since',
    );
  }
}

function validateDurableRetentionCatalog(
  value: unknown,
): asserts value is DurableRetentionCatalog {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'generation',
      'records',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-retention-catalog'
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
  assertPositiveInteger(
    value.generation,
    unsafeDurableGovernanceStore,
    'catalog generation',
  );
  if (!Array.isArray(value.records) || value.records.length > 8_192) {
    throw unsafeDurableGovernanceStore();
  }
  let previous = '';
  for (const record of value.records) {
    validateEvidenceRetentionRecord(record);
    if (
      record.workflowId !== value.workflowId ||
      record.evidenceId <= previous
    ) {
      throw unsafeDurableGovernanceStore();
    }
    previous = record.evidenceId;
  }
  assertTimestamp(
    value.updatedAt,
    unsafeDurableGovernanceStore,
    'catalog updatedAt',
  );
}

export function validateDurablePruneReceipt(
  value: unknown,
): asserts value is DurablePruneReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'receiptId',
      'state',
      'workflowId',
      'contextGeneration',
      'epoch',
      'contextDigest',
      'catalogGenerationBefore',
      'catalogDigestBefore',
      'catalogGenerationAfter',
      'catalogDigestAfter',
      'deleted',
      'preparedAt',
      'completedAt',
      'abortedAt',
      'abortReason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'durable-evidence-prune' ||
    !['prepared', 'complete', 'aborted'].includes(String(value.state))
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertUuid(value.receiptId, unsafeDurableGovernanceStore);
  assertIdentity(value.workflowId, unsafeDurableGovernanceStore, 'workflow ID');
  assertPositiveInteger(
    value.contextGeneration,
    unsafeDurableGovernanceStore,
    'context generation',
  );
  assertPositiveInteger(value.epoch, unsafeDurableGovernanceStore, 'epoch');
  assertDigest(
    value.contextDigest,
    unsafeDurableGovernanceStore,
    'context digest',
  );
  assertPositiveInteger(
    value.catalogGenerationBefore,
    unsafeDurableGovernanceStore,
    'catalog generation before',
  );
  if (value.catalogGenerationAfter !== value.catalogGenerationBefore + 1) {
    throw unsafeDurableGovernanceStore();
  }
  assertDigest(
    value.catalogDigestBefore,
    unsafeDurableGovernanceStore,
    'catalog digest before',
  );
  assertDigest(
    value.catalogDigestAfter,
    unsafeDurableGovernanceStore,
    'catalog digest after',
  );
  if (!Array.isArray(value.deleted) || value.deleted.length > 8_192) {
    throw unsafeDurableGovernanceStore();
  }
  let previous = '';
  for (const entry of value.deleted) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['evidenceId', 'digest'])) {
      throw unsafeDurableGovernanceStore();
    }
    assertIdentity(
      entry.evidenceId,
      unsafeDurableGovernanceStore,
      'evidence ID',
    );
    assertDigest(entry.digest, unsafeDurableGovernanceStore, 'evidence digest');
    if (entry.evidenceId <= previous) throw unsafeDurableGovernanceStore();
    previous = entry.evidenceId;
  }
  assertTimestamp(value.preparedAt, unsafeDurableGovernanceStore, 'preparedAt');
  if (value.state === 'prepared') {
    if (
      value.completedAt !== null ||
      value.abortedAt !== null ||
      value.abortReason !== null
    ) {
      throw unsafeDurableGovernanceStore();
    }
  } else if (value.state === 'complete') {
    assertTimestamp(
      value.completedAt,
      unsafeDurableGovernanceStore,
      'completedAt',
    );
    if (value.abortedAt !== null || value.abortReason !== null) {
      throw unsafeDurableGovernanceStore();
    }
  } else {
    assertTimestamp(value.abortedAt, unsafeDurableGovernanceStore, 'abortedAt');
    assertReason(
      value.abortReason,
      unsafeDurableGovernanceStore,
      'abort reason',
    );
    if (value.completedAt !== null) throw unsafeDurableGovernanceStore();
  }
}

export function assertContextManifestBinding(
  workflow: WorkflowContextState,
  manifest: ContextManifest,
): void {
  if (
    workflow.workflowId !== manifest.workflowId ||
    workflow.currentEpoch !== manifest.epoch ||
    workflow.contractVersion !== manifest.contractVersion ||
    workflow.contextDigest !== manifest.contextDigest ||
    workflow.snapshotDigest !== manifest.baselineDigest
  ) {
    throw invalidDurableContext(
      'Workflow state must exactly bind the current context manifest.',
    );
  }
}

function assertStoredContextManifestBinding(
  workflow: WorkflowContextState,
  manifest: ContextManifest,
): void {
  try {
    assertContextManifestBinding(workflow, manifest);
  } catch {
    throw unsafeDurableGovernanceStore();
  }
}

export function assertCurrentManifestEvidenceBinding(
  manifest: ContextManifest,
  record: EvidenceRetentionRecord,
): void {
  if (
    record.evidenceClass === 'manifest-item' &&
    record.itemIdentity === null
  ) {
    throw invalidRetentionRecord(
      'Manifest-item evidence requires an item identity.',
    );
  }
  if (record.itemIdentity === null) return;
  const reference = manifest.items.find(
    ({ identity }) => identity === record.itemIdentity,
  );
  if (
    record.epoch === manifest.epoch &&
    reference !== undefined &&
    reference.digest !== record.digest
  ) {
    throw workflowError(
      'RETENTION_MANIFEST_DIGEST_MISMATCH',
      `Evidence ${record.evidenceId} conflicts with the current manifest digest.`,
      ExitCode.staleState,
    );
  }
}

export function assertContextCas(
  context: DurableEpochContextState,
  expected: {
    expectedGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
  },
): void {
  assertPositiveInteger(
    expected.expectedGeneration,
    invalidDurableContext,
    'expected generation',
  );
  assertPositiveInteger(
    expected.expectedEpoch,
    invalidDurableContext,
    'expected epoch',
  );
  assertDigest(
    expected.expectedContextDigest,
    invalidDurableContext,
    'expected context digest',
  );
  if (
    context.generation !== expected.expectedGeneration ||
    context.workflow.currentEpoch !== expected.expectedEpoch ||
    context.workflow.contextDigest !== expected.expectedContextDigest
  ) {
    throw workflowError(
      'EXECUTION_CONTEXT_CAS_MISMATCH',
      'Durable context changed before the epoch transition.',
      ExitCode.staleState,
    );
  }
}

export function assertCatalogCas(
  catalog: DurableRetentionCatalog,
  expectedGeneration: number,
): void {
  assertPositiveInteger(
    expectedGeneration,
    invalidRetentionRecord,
    'expected catalog generation',
  );
  if (catalog.generation !== expectedGeneration) {
    throw workflowError(
      'RETENTION_CATALOG_CAS_MISMATCH',
      'The retention catalog changed before the requested operation.',
      ExitCode.staleState,
    );
  }
}

export function manifestRetentionRecords(
  manifest: ContextManifest,
  createdAt: string,
): EvidenceRetentionRecord[] {
  return manifest.items
    .map(({ identity, digest: itemDigest }) => ({
      schemaVersion: 1 as const,
      kind: 'evidence-retention' as const,
      evidenceId: `manifest-${manifest.epoch}-${crypto
        .createHash('sha256')
        .update(identity)
        .digest('hex')
        .slice(0, 32)}`,
      itemIdentity: identity,
      workflowId: manifest.workflowId,
      epoch: manifest.epoch,
      evidenceClass: 'manifest-item' as const,
      digest: itemDigest,
      retention: 'active' as const,
      createdAt,
      expiresAt: null,
      pin: null,
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

export function assertUniqueEvidenceIds(
  records: EvidenceRetentionRecord[],
): void {
  const ids = new Set(records.map(({ evidenceId }) => evidenceId));
  if (ids.size !== records.length) {
    throw invalidRetentionRecord('Evidence IDs must be unique.');
  }
}

export function invalidDurableContext(message: string): WorkflowError {
  return workflowError('EXECUTION_CONTEXT_INVALID', message, ExitCode.usage);
}

export function unsafeDurableGovernanceStore(): WorkflowError {
  return workflowError(
    'EXECUTION_GOVERNANCE_STORE_UNSAFE',
    'Durable execution-governance state is missing, malformed, or unsafe.',
    ExitCode.staleState,
  );
}

export function parseStoredDurableGovernanceState(
  raw: string,
  workflowId: string,
): DurableGovernanceState {
  const value = parseDocument(raw);
  validateDurableGovernanceState(value);
  if (
    value.context.workflow.workflowId !== workflowId ||
    canonicalDurableGovernanceState(value) !== raw
  ) {
    throw unsafeDurableGovernanceStore();
  }
  return value;
}

export function parseStoredDurablePruneReceipt(
  raw: string,
): DurablePruneReceipt {
  const value = parseDocument(raw);
  validateDurablePruneReceipt(value);
  if (canonicalDurablePruneReceipt(value) !== raw) {
    throw unsafeDurableGovernanceStore();
  }
  return value;
}

export function validateStoredManifestItems(
  manifest: ContextManifest,
  items: { identity: string; content: string }[],
): Map<string, string> {
  if (!Array.isArray(items) || items.length !== manifest.items.length) {
    throw invalidContextManifest(
      'Stored context items must exactly match the manifest item set.',
    );
  }
  const byIdentity = new Map<string, string>();
  for (const item of items) {
    if (!isRecord(item) || !hasExactKeys(item, ['identity', 'content'])) {
      throw invalidContextManifest('Stored context item is malformed.');
    }
    assertIdentity(
      item.identity,
      invalidContextManifest,
      'context item identity',
    );
    if (
      typeof item.content !== 'string' ||
      Buffer.byteLength(item.content) > 262_144 ||
      byIdentity.has(item.identity)
    ) {
      throw invalidContextManifest('Stored context item content is invalid.');
    }
    byIdentity.set(item.identity, item.content);
  }
  for (const reference of manifest.items) {
    const content = byIdentity.get(reference.identity);
    if (content === undefined || digest(content) !== reference.digest) {
      throw workflowError(
        'CONTEXT_ITEM_MISMATCH',
        `Context item ${reference.identity} does not match its manifest digest.`,
        ExitCode.verification,
      );
    }
  }
  return byIdentity;
}

export function parseDurableGovernanceLockOwner(
  raw: string,
  workflowId: string,
) {
  let value: unknown;
  try {
    value = parseDocument(raw);
  } catch {
    throw unsafeDurableGovernanceStore();
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'workflowId', 'pid', 'createdAt']) ||
    value.schemaVersion !== 1 ||
    value.workflowId !== workflowId ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    `${canonicalJson(value)}\n` !== raw
  ) {
    throw unsafeDurableGovernanceStore();
  }
  assertTimestamp(
    value.createdAt,
    unsafeDurableGovernanceStore,
    'lock createdAt',
  );
  return value;
}

export function isDurablePruneReceiptTemporary(name: string): boolean {
  const [receiptId, json, pid, temporaryId, suffix, ...extra] = name.split('.');
  return (
    extra.length === 0 &&
    json === 'json' &&
    suffix === 'tmp' &&
    UUID_V4.test(receiptId ?? '') &&
    /^[1-9][0-9]*$/.test(pid ?? '') &&
    UUID_V4.test(temporaryId ?? '')
  );
}

export function currentDurablePruneReceiptReferences(
  state: DurableGovernanceState,
  receipt: DurablePruneReceipt,
): Set<string> {
  if (
    durableRetentionCatalogDigest(state.retention) !==
      receipt.catalogDigestAfter ||
    state.context.generation !== receipt.contextGeneration ||
    state.context.workflow.currentEpoch !== receipt.epoch ||
    state.context.workflow.contextDigest !== receipt.contextDigest
  ) {
    throw unsafeDurableGovernanceStore();
  }
  const referenced = new Set([
    ...state.context.currentManifest.items.map(
      ({ digest: itemDigest }) => itemDigest,
    ),
    ...state.retention.records.map(
      ({ digest: evidenceDigest }) => evidenceDigest,
    ),
  ]);
  return referenced;
}

export type DurableEvidencePublicationInput = {
  workflowId: string;
  expectedCatalogGeneration: number;
  record: EvidenceRetentionRecord;
  content: string;
};

export type DurableEvidencePinInput = {
  workflowId: string;
  evidenceId: string;
  expectedCatalogGeneration: number;
  decision: {
    actor: string;
    reason: string;
    pinnedAt: Date;
    humanConfirmed: true;
  };
};

export type DurableEvidencePruneInput = {
  workflowId: string;
  expectedContextGeneration: number;
  expectedEpoch: number;
  expectedContextDigest: string;
  expectedCatalogGeneration: number;
  now: Date;
  policy?: RetentionPolicy;
};
