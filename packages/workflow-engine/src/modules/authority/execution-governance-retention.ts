/**
 * Decides evidence retention and compacts epoch history without mutating durable storage.
 *
 * Invariants:
 * - Current manifest content, current-epoch evidence, and explicitly pinned evidence survive pruning.
 * - Expiry limits and receipt or stub bounds retain deterministic ordering and canonical bytes.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import type { ContextManifest } from '../lifecycle/context-manifest-contract.ts';
import {
  assertBoundedInteger,
  assertDigest,
  assertIdentity,
  assertPositiveInteger,
  assertReason,
  assertTimestamp,
  exactDate,
  hasExactKeys,
  isRecord,
  normalizeInvalid,
  parseDocument,
} from './execution-governance-values.ts';
import {
  type EpochTransitionReceipt,
  validateContextManifest,
  validateEpochTransitionReceipt,
} from './execution-governance-context.ts';

export type EpochTransitionStub = {
  schemaVersion: 1;
  kind: 'epoch-transition-stub';
  workflowId: string;
  fromEpoch: number;
  toEpoch: number;
  prunedAt: string;
  pruningPolicyVersion: number;
};

export type Retention = 'active' | 'expiring' | 'pinned';

export type EvidenceRetentionRecord = {
  schemaVersion: 1;
  kind: 'evidence-retention';
  evidenceId: string;
  itemIdentity: string | null;
  workflowId: string;
  epoch: number;
  evidenceClass: 'raw' | 'derived' | 'manifest-item';
  digest: string;
  retention: Retention;
  createdAt: string;
  expiresAt: string | null;
  pin: {
    actor: string;
    reason: string;
    pinnedAt: string;
  } | null;
};

export type RetentionPolicy = {
  schemaVersion: 1;
  previousEpochTtlDays: number;
  maxExpiringTtlDays: number;
  transitionReceiptTtlDays: number;
  maxFullTransitionReceipts: number;
  maxTransitionReceiptStubs: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  schemaVersion: 1,
  previousEpochTtlDays: 7,
  maxExpiringTtlDays: 90,
  transitionReceiptTtlDays: 90,
  maxFullTransitionReceipts: 20,
  maxTransitionReceiptStubs: 100,
});

export function pinEvidence(
  record: EvidenceRetentionRecord,
  decision: {
    actor: string;
    reason: string;
    pinnedAt: Date;
    humanConfirmed: true;
  },
): EvidenceRetentionRecord {
  validateEvidenceRetentionRecord(record);
  if (decision.humanConfirmed !== true) {
    throw workflowError(
      'RETENTION_PIN_REQUIRES_HUMAN',
      'Evidence may be pinned only by an explicit human decision.',
      ExitCode.guard,
    );
  }
  assertIdentity(decision.actor, invalidRetentionRecord, 'pin actor');
  assertReason(decision.reason, invalidRetentionRecord, 'pin reason');
  const result: EvidenceRetentionRecord = {
    ...record,
    retention: 'pinned',
    expiresAt: null,
    pin: {
      actor: decision.actor,
      reason: decision.reason,
      pinnedAt: exactDate(decision.pinnedAt, 'RETENTION_RECORD_INVALID'),
    },
  };
  if (
    new Date(result.pin!.pinnedAt).getTime() <
    new Date(record.createdAt).getTime()
  ) {
    throw invalidRetentionRecord('Evidence cannot be pinned before it exists.');
  }
  validateEvidenceRetentionRecord(result);
  return result;
}

export function markEpochEvidenceExpiring(
  records: EvidenceRetentionRecord[],
  input: {
    endedEpoch: number;
    endedAt: Date;
    policy?: RetentionPolicy;
  },
): EvidenceRetentionRecord[] {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  assertPositiveInteger(
    input.endedEpoch,
    invalidRetentionRecord,
    'ended epoch',
  );
  const endedAt = new Date(
    exactDate(input.endedAt, 'RETENTION_RECORD_INVALID'),
  );
  const expiresAt = new Date(
    endedAt.getTime() + policy.previousEpochTtlDays * 86_400_000,
  ).toISOString();
  return records.map((record) => {
    validateEvidenceRetentionRecord(record, policy);
    if (record.epoch !== input.endedEpoch || record.retention !== 'active') {
      return cloneRetentionRecord(record);
    }
    const next: EvidenceRetentionRecord = {
      ...record,
      retention: 'expiring',
      expiresAt,
      pin: null,
    };
    validateEvidenceRetentionRecord(next, policy);
    return next;
  });
}

export function planEvidencePruning(input: {
  records: EvidenceRetentionRecord[];
  currentEpoch: number;
  currentManifest: ContextManifest;
  now: Date;
  policy?: RetentionPolicy;
}): { keep: string[]; delete: string[] } {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  validateContextManifest(input.currentManifest);
  assertPositiveInteger(
    input.currentEpoch,
    invalidRetentionRecord,
    'current epoch',
  );
  if (input.currentManifest.epoch !== input.currentEpoch) {
    throw invalidRetentionRecord(
      'Current manifest epoch must equal the pruning current epoch.',
    );
  }
  const now = new Date(exactDate(input.now, 'RETENTION_RECORD_INVALID'));
  const manifestItems = new Map(
    input.currentManifest.items.map(({ identity, digest: itemDigest }) => [
      identity,
      itemDigest,
    ]),
  );
  const seen = new Set<string>();
  const keep: string[] = [];
  const remove: string[] = [];
  for (const record of input.records) {
    validateEvidenceRetentionRecord(record, policy);
    if (seen.has(record.evidenceId)) {
      throw invalidRetentionRecord(
        'Evidence IDs must be unique while pruning.',
      );
    }
    seen.add(record.evidenceId);
    const manifestDigest =
      record.itemIdentity === null
        ? undefined
        : manifestItems.get(record.itemIdentity);
    if (manifestDigest !== undefined) {
      if (manifestDigest === record.digest) {
        keep.push(record.evidenceId);
        continue;
      }
      if (record.epoch === input.currentEpoch) {
        throw workflowError(
          'RETENTION_MANIFEST_DIGEST_MISMATCH',
          `Evidence ${record.evidenceId} conflicts with the current manifest digest.`,
          ExitCode.staleState,
        );
      }
    }
    if (record.retention === 'pinned' || record.epoch === input.currentEpoch) {
      keep.push(record.evidenceId);
      continue;
    }
    if (record.retention === 'active') {
      throw invalidRetentionRecord(
        `Non-current evidence ${record.evidenceId} must be expiring or pinned.`,
      );
    }
    const expired = new Date(record.expiresAt!).getTime() <= now.getTime();
    const olderRaw =
      record.evidenceClass === 'raw' && record.epoch < input.currentEpoch - 1;
    (expired || olderRaw ? remove : keep).push(record.evidenceId);
  }
  return { keep: keep.sort(), delete: remove.sort() };
}

export function canonicalEvidenceRetentionRecord(
  record: EvidenceRetentionRecord,
): string {
  validateEvidenceRetentionRecord(record);
  return `${canonicalJson(record)}\n`;
}

export function parseEvidenceRetentionRecord(
  raw: string,
): EvidenceRetentionRecord {
  try {
    const value = parseDocument(raw);
    validateEvidenceRetentionRecord(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'RETENTION_RECORD_INVALID',
      'Evidence retention record is malformed.',
    );
  }
}

export function compactEpochTransitionReceipts(
  receipts: EpochTransitionReceipt[],
  existingStubs: EpochTransitionStub[],
  input: { now: Date; policy?: RetentionPolicy },
): {
  full: EpochTransitionReceipt[];
  stubs: EpochTransitionStub[];
  discarded: string[];
} {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const nowIso = exactDate(input.now, 'RETENTION_POLICY_INVALID');
  const now = new Date(nowIso);
  receipts.forEach(validateEpochTransitionReceipt);
  existingStubs.forEach(validateEpochTransitionStub);
  const ordered = [...receipts].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const full: EpochTransitionReceipt[] = [];
  const compacted: EpochTransitionStub[] = [];
  const maxAgeMs = policy.transitionReceiptTtlDays * 86_400_000;
  for (const receipt of ordered) {
    const withinAge =
      now.getTime() - new Date(receipt.createdAt).getTime() <= maxAgeMs;
    if (withinAge && full.length < policy.maxFullTransitionReceipts) {
      full.push(receipt);
    } else {
      compacted.push({
        schemaVersion: 1,
        kind: 'epoch-transition-stub',
        workflowId: receipt.workflowId,
        fromEpoch: receipt.fromEpoch,
        toEpoch: receipt.toEpoch,
        prunedAt: nowIso,
        pruningPolicyVersion: policy.schemaVersion,
      });
    }
  }
  const uniqueStubs = new Map<string, EpochTransitionStub>();
  for (const stub of [...existingStubs, ...compacted]) {
    validateEpochTransitionStub(stub);
    uniqueStubs.set(transitionKey(stub), stub);
  }
  const orderedStubs = [...uniqueStubs.values()].sort((left, right) => {
    const byPruned =
      new Date(right.prunedAt).getTime() - new Date(left.prunedAt).getTime();
    return byPruned || right.toEpoch - left.toEpoch;
  });
  const stubs = orderedStubs.slice(0, policy.maxTransitionReceiptStubs);
  const discarded = orderedStubs
    .slice(policy.maxTransitionReceiptStubs)
    .map(transitionKey);
  return { full, stubs, discarded };
}

export function canonicalEpochTransitionStub(
  stub: EpochTransitionStub,
): string {
  validateEpochTransitionStub(stub);
  return `${canonicalJson(stub)}\n`;
}

export function validateEvidenceRetentionRecord(
  value: unknown,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): asserts value is EvidenceRetentionRecord {
  validateRetentionPolicy(policy);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'evidenceId',
      'itemIdentity',
      'workflowId',
      'epoch',
      'evidenceClass',
      'digest',
      'retention',
      'createdAt',
      'expiresAt',
      'pin',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'evidence-retention'
  ) {
    throw invalidRetentionRecord('Retention record has an invalid shape.');
  }
  assertIdentity(value.evidenceId, invalidRetentionRecord, 'evidence ID');
  if (value.itemIdentity !== null) {
    assertIdentity(value.itemIdentity, invalidRetentionRecord, 'item identity');
  }
  assertIdentity(value.workflowId, invalidRetentionRecord, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidRetentionRecord, 'epoch');
  if (
    !['raw', 'derived', 'manifest-item'].includes(String(value.evidenceClass))
  ) {
    throw invalidRetentionRecord('Evidence class is invalid.');
  }
  assertDigest(value.digest, invalidRetentionRecord, 'evidence digest');
  if (!['active', 'expiring', 'pinned'].includes(String(value.retention))) {
    throw invalidRetentionRecord('Retention state is invalid.');
  }
  const createdAt = assertTimestamp(
    value.createdAt,
    invalidRetentionRecord,
    'createdAt',
  );
  if (value.retention === 'expiring') {
    const expiresAt = assertTimestamp(
      value.expiresAt,
      invalidRetentionRecord,
      'expiresAt',
    );
    if (
      value.pin !== null ||
      new Date(expiresAt).getTime() <= new Date(createdAt).getTime() ||
      new Date(expiresAt).getTime() - new Date(createdAt).getTime() >
        policy.maxExpiringTtlDays * 86_400_000
    ) {
      throw invalidRetentionRecord(
        'Expiring evidence must have a bounded TTL.',
      );
    }
  } else if (value.expiresAt !== null) {
    throw invalidRetentionRecord('Only expiring evidence may have expiresAt.');
  }
  if (value.retention === 'pinned') {
    if (
      !isRecord(value.pin) ||
      !hasExactKeys(value.pin, ['actor', 'reason', 'pinnedAt'])
    ) {
      throw invalidRetentionRecord(
        'Pinned evidence requires a human pin record.',
      );
    }
    assertIdentity(value.pin.actor, invalidRetentionRecord, 'pin actor');
    assertReason(value.pin.reason, invalidRetentionRecord, 'pin reason');
    assertTimestamp(value.pin.pinnedAt, invalidRetentionRecord, 'pinnedAt');
  } else if (value.pin !== null) {
    throw invalidRetentionRecord(
      'Unpinned evidence cannot carry pin metadata.',
    );
  }
}

export function validateRetentionPolicy(
  value: unknown,
): asserts value is RetentionPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'previousEpochTtlDays',
      'maxExpiringTtlDays',
      'transitionReceiptTtlDays',
      'maxFullTransitionReceipts',
      'maxTransitionReceiptStubs',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw invalidRetentionPolicy('Retention policy has an invalid shape.');
  }
  assertBoundedInteger(
    value.previousEpochTtlDays,
    1,
    30,
    invalidRetentionPolicy,
    'previous epoch TTL',
  );
  assertBoundedInteger(
    value.maxExpiringTtlDays,
    value.previousEpochTtlDays as number,
    90,
    invalidRetentionPolicy,
    'maximum evidence TTL',
  );
  assertBoundedInteger(
    value.transitionReceiptTtlDays,
    1,
    90,
    invalidRetentionPolicy,
    'transition receipt TTL',
  );
  assertBoundedInteger(
    value.maxFullTransitionReceipts,
    1,
    20,
    invalidRetentionPolicy,
    'full transition receipt count',
  );
  assertBoundedInteger(
    value.maxTransitionReceiptStubs,
    0,
    200,
    invalidRetentionPolicy,
    'transition receipt stub count',
  );
}

export function validateEpochTransitionStub(
  value: unknown,
): asserts value is EpochTransitionStub {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'fromEpoch',
      'toEpoch',
      'prunedAt',
      'pruningPolicyVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'epoch-transition-stub'
  ) {
    throw invalidRetentionRecord('Transition receipt stub is malformed.');
  }
  assertIdentity(value.workflowId, invalidRetentionRecord, 'workflow ID');
  assertPositiveInteger(value.fromEpoch, invalidRetentionRecord, 'from epoch');
  if (value.toEpoch !== (value.fromEpoch as number) + 1) {
    throw invalidRetentionRecord('Transition receipt stub epochs are invalid.');
  }
  assertTimestamp(value.prunedAt, invalidRetentionRecord, 'prunedAt');
  assertPositiveInteger(
    value.pruningPolicyVersion,
    invalidRetentionRecord,
    'pruning policy version',
  );
}

function cloneRetentionRecord(
  record: EvidenceRetentionRecord,
): EvidenceRetentionRecord {
  return {
    ...record,
    pin: record.pin === null ? null : { ...record.pin },
  };
}

export function transitionKey(
  value: EpochTransitionReceipt | EpochTransitionStub,
): string {
  return `${value.workflowId}:${value.fromEpoch}:${value.toEpoch}`;
}

export function invalidRetentionRecord(message: string): WorkflowError {
  return workflowError('RETENTION_RECORD_INVALID', message, ExitCode.usage);
}

function invalidRetentionPolicy(message: string): WorkflowError {
  return workflowError('RETENTION_POLICY_INVALID', message, ExitCode.usage);
}
