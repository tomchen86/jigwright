/** Provider retention contracts and pure eligibility decisions. */
import type { AttemptRecord } from './execution-core.ts';
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';

export type ProviderRetentionDenyReason =
  | 'accepted-result-current'
  | 'active-invocation'
  | 'active-retention'
  | 'already-pruned'
  | 'current-attempt'
  | 'consumed-repair-evidence-unproven'
  | 'nothing-prunable'
  | 'pinned'
  | 'schema-currentness-unknown'
  | 'schema-history-incomplete'
  | 'ttl-not-expired'
  | 'unsafe-artifact';

export type ProviderRetentionPassResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-runtime-prune-pass';
  policy: {
    schemaVersion: 1;
    ttlDays: number;
    maxTtlDays: number;
    cutoffAt: string;
    limit: number;
  };
  examined: number;
  recovered: string[];
  pruned: Array<{
    invocationId: string;
    receiptId: string;
    receiptPath: string;
    artifactCount: number;
    bytes: number;
  }>;
  deniedCount: number;
  denied: Array<{
    invocationId: string;
    reason: ProviderRetentionDenyReason;
  }>;
  deniedTruncated: boolean;
}>;

export type ProviderRetentionOptions = Readonly<{
  limit: number;
  now?: string;
  ttlDays?: number;
}>;

export type ProviderRetentionHooks = Readonly<{
  afterArtifactStaged?: (count: number, invocationId: string) => void;
  afterReceiptCompleted?: (invocationId: string) => void;
}>;

export type ProviderRetentionEligibilityInput = Readonly<{
  invocationState: ProviderInvocationRecord['state'];
  historyComplete: boolean;
  attemptEpoch: number;
  currentEpoch: number;
  retention: AttemptRecord['retention'];
  acceptedAttempt: boolean;
  latestUnacceptedAttempt: boolean;
  terminalAt: string;
  cutoffAt: string;
  /**
   * A human pin recorded in the durable governance catalog. An Attempt's own
   * retention is projected from its provider invocation and never carries a pin,
   * so the catalog is the only place a maintainer's decision can be read from.
   */
  humanPinned?: boolean;
}>;

export type ProviderRetentionMetrics = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retention-metrics';
  measuredAt: string;
  ttlDays: number;
  rawEvidenceBytesByRetentionClass: Readonly<{
    active: number;
    debug: number;
    pinned: number;
  }>;
  expiredPendingDeletion: Readonly<{
    count: number;
    bytes: number;
  }>;
  pinnedCount: number;
  receiptCount: number;
}>;

export function classifyProviderRetentionEligibility(
  input: ProviderRetentionEligibilityInput,
): ProviderRetentionDenyReason | null {
  if (
    input.invocationState === 'prepared' ||
    input.invocationState === 'leased'
  ) {
    return 'active-invocation';
  }
  if (!input.historyComplete) return 'schema-history-incomplete';
  if (input.retention === 'pinned' || input.humanPinned === true) {
    return 'pinned';
  }
  if (input.acceptedAttempt && input.attemptEpoch === input.currentEpoch) {
    return 'accepted-result-current';
  }
  if (
    !input.acceptedAttempt &&
    input.latestUnacceptedAttempt &&
    input.attemptEpoch === input.currentEpoch
  ) {
    return 'current-attempt';
  }
  // An old epoch is no longer current even if an invocation projection still calls
  // its retention "active". The accepted Result/core stays durable, while its
  // private raw runtime becomes TTL-eligible rather than permanent by accident.
  if (
    input.retention === 'active' &&
    input.attemptEpoch === input.currentEpoch
  ) {
    return 'active-retention';
  }
  if (Date.parse(input.terminalAt) > Date.parse(input.cutoffAt)) {
    return 'ttl-not-expired';
  }
  return null;
}
