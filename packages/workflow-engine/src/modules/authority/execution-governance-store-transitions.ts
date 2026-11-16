/** Pure state transitions applied between durable storage phases. */
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { exactDate } from './execution-governance-values.ts';
import type { ExecutionEpochStore } from './execution-governance-epoch-port.ts';
import {
  invalidEpochTransition,
  performEpochRollover,
  assertEpochCarryForwardSourceMembership,
} from './execution-governance-context.ts';
import {
  type RetentionPolicy,
  invalidRetentionRecord,
  pinEvidence,
  compactEpochTransitionReceipts,
  markEpochEvidenceExpiring,
  planEvidencePruning,
} from './execution-governance-retention.ts';
import {
  type DurableGovernanceState,
  type DurableEpochContextState,
  type DurableRetentionCatalog,
  type DurablePruneReceipt,
  type DurableEvidencePublicationInput,
  type DurableEvidencePinInput,
  type DurableEvidencePruneInput,
  manifestRetentionRecords,
  assertContextCas,
  assertCurrentManifestEvidenceBinding,
  assertCatalogCas,
  assertUniqueEvidenceIds,
  unsafeDurableGovernanceStore,
} from './execution-governance-store-contracts.ts';

export function createInitialDurableGovernanceState(
  input: Parameters<
    ExecutionEpochStore['initializeDurableEpochContextStore']
  >[1],
  updatedAt: string,
) {
  const context: DurableEpochContextState = {
    schemaVersion: 1,
    kind: 'durable-epoch-context',
    generation: 1,
    workflow: structuredClone(input.workflow),
    currentManifest: structuredClone(input.manifest),
    transitionReceipts: [],
    transitionStubs: [],
    updatedAt,
  };
  const retention: DurableRetentionCatalog = {
    schemaVersion: 1,
    kind: 'durable-retention-catalog',
    workflowId: input.workflow.workflowId,
    generation: 1,
    records: manifestRetentionRecords(input.manifest, updatedAt),
    updatedAt,
  };
  const state: DurableGovernanceState = {
    schemaVersion: 1,
    kind: 'durable-execution-governance-state',
    context,
    retention,
  };
  return { context, state };
}

export function prepareDurableEpochRollover(
  state: DurableGovernanceState,
  input: Parameters<ExecutionEpochStore['rolloverDurableEpochContextStore']>[1],
) {
  assertContextCas(state.context, input);
  if (input.nextManifest.workflowId !== input.workflowId) {
    throw invalidEpochTransition(
      'The next context manifest belongs to another workflow.',
    );
  }
  if (state.context.workflow.status !== 'active') {
    throw invalidEpochTransition(
      'A terminal workflow cannot advance to another epoch.',
    );
  }
  const transition = performEpochRollover({
    workflow: state.context.workflow,
    nextManifest: input.nextManifest,
    reason: input.reason,
    restartFrom: input.restartFrom,
    carriedForward: input.carriedForward,
    carryForwardManifest: input.carryForwardManifest,
    invalidated: input.invalidated,
    verification: input.verification,
    createdAt: input.createdAt,
  });
  assertEpochCarryForwardSourceMembership(
    transition.receipt.carryForwardManifest,
    state.context.currentManifest,
    input.nextManifest,
  );
  return transition;
}

export function completeDurableEpochRollover(
  state: DurableGovernanceState,
  input: Parameters<ExecutionEpochStore['rolloverDurableEpochContextStore']>[1],
  transition: ReturnType<typeof prepareDurableEpochRollover>,
  createdAt: string,
  policy: RetentionPolicy,
) {
  const compacted = compactEpochTransitionReceipts(
    [...state.context.transitionReceipts, transition.receipt],
    state.context.transitionStubs,
    { now: input.createdAt, policy },
  );
  const context: DurableEpochContextState = {
    ...state.context,
    generation: state.context.generation + 1,
    workflow: transition.workflow,
    currentManifest: structuredClone(input.nextManifest),
    transitionReceipts: compacted.full,
    transitionStubs: compacted.stubs,
    updatedAt: createdAt,
  };
  const expired = markEpochEvidenceExpiring(state.retention.records, {
    endedEpoch: state.context.workflow.currentEpoch,
    endedAt: input.createdAt,
    policy,
  });
  const records = [
    ...expired,
    ...manifestRetentionRecords(input.nextManifest, createdAt),
  ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  assertUniqueEvidenceIds(records);
  const retention: DurableRetentionCatalog = {
    ...state.retention,
    generation: state.retention.generation + 1,
    records,
    updatedAt: createdAt,
  };
  const next: DurableGovernanceState = {
    ...state,
    context,
    retention,
  };
  return { context, next };
}

export function assertDurableEvidencePublication(
  state: DurableGovernanceState,
  input: DurableEvidencePublicationInput,
): void {
  assertCatalogCas(state.retention, input.expectedCatalogGeneration);
  if (input.record.workflowId !== input.workflowId) {
    throw invalidRetentionRecord('Evidence belongs to another workflow.');
  }
  if (
    input.record.epoch > state.context.workflow.currentEpoch ||
    (input.record.retention === 'active' &&
      input.record.epoch !== state.context.workflow.currentEpoch)
  ) {
    throw workflowError(
      'RETENTION_STALE_EPOCH',
      'Only the current epoch may publish active evidence.',
      ExitCode.staleState,
    );
  }
  assertCurrentManifestEvidenceBinding(
    state.context.currentManifest,
    input.record,
  );
  if (
    state.retention.records.some(
      ({ evidenceId }) => evidenceId === input.record.evidenceId,
    )
  ) {
    throw workflowError(
      'RETENTION_EVIDENCE_EXISTS',
      `Evidence ${input.record.evidenceId} already exists.`,
      ExitCode.conflict,
    );
  }
}

export function addDurableRetentionEvidence(
  state: DurableGovernanceState,
  input: DurableEvidencePublicationInput,
  updatedAt: string,
): DurableRetentionCatalog {
  const retention: DurableRetentionCatalog = {
    ...state.retention,
    generation: state.retention.generation + 1,
    records: [...state.retention.records, structuredClone(input.record)].sort(
      (left, right) => left.evidenceId.localeCompare(right.evidenceId),
    ),
    updatedAt,
  };
  return retention;
}

export function pinDurableRetentionEvidence(
  state: DurableGovernanceState,
  input: DurableEvidencePinInput,
): DurableRetentionCatalog {
  assertCatalogCas(state.retention, input.expectedCatalogGeneration);
  const index = state.retention.records.findIndex(
    ({ evidenceId }) => evidenceId === input.evidenceId,
  );
  if (index < 0) throw retentionEvidenceNotFound(input.evidenceId);
  const records = state.retention.records.map((record, recordIndex) =>
    recordIndex === index
      ? pinEvidence(record, input.decision)
      : structuredClone(record),
  );
  const retention: DurableRetentionCatalog = {
    ...state.retention,
    generation: state.retention.generation + 1,
    records,
    updatedAt: exactDate(input.decision.pinnedAt, 'RETENTION_RECORD_INVALID'),
  };
  return retention;
}

export function prepareDurableEvidencePruning(
  state: DurableGovernanceState,
  input: DurableEvidencePruneInput,
  now: string,
  policy: RetentionPolicy,
) {
  if (
    state.context.generation !== input.expectedContextGeneration ||
    state.context.workflow.currentEpoch !== input.expectedEpoch ||
    state.context.workflow.contextDigest !== input.expectedContextDigest
  ) {
    throw workflowError(
      'EXECUTION_CONTEXT_CAS_MISMATCH',
      'Durable context changed before evidence pruning.',
      ExitCode.staleState,
    );
  }
  assertCatalogCas(state.retention, input.expectedCatalogGeneration);
  const plan = planEvidencePruning({
    records: state.retention.records,
    currentEpoch: state.context.workflow.currentEpoch,
    currentManifest: state.context.currentManifest,
    now: input.now,
    policy,
  });
  const deleting = new Set(plan.delete);
  const deleted = state.retention.records
    .filter(({ evidenceId }) => deleting.has(evidenceId))
    .map(({ evidenceId, digest: evidenceDigest }) => ({
      evidenceId,
      digest: evidenceDigest,
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const retention: DurableRetentionCatalog = {
    ...state.retention,
    generation: state.retention.generation + 1,
    records: state.retention.records
      .filter(({ evidenceId }) => !deleting.has(evidenceId))
      .map((record) => structuredClone(record)),
    updatedAt: now,
  };
  return { retention, deleted };
}

export function retentionEvidenceNotFound(
  evidenceId: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'RETENTION_EVIDENCE_NOT_FOUND',
    `Evidence ${evidenceId} does not exist in the current catalog.`,
    ExitCode.staleState,
  );
}

export function prepareDurablePruneRecovery(
  receipt: DurablePruneReceipt,
  currentDigest: string,
  recoveredAt: string,
): DurablePruneReceipt | null {
  if (currentDigest === receipt.catalogDigestBefore) {
    const aborted: DurablePruneReceipt = {
      ...receipt,
      state: 'aborted',
      abortedAt: recoveredAt,
      abortReason: 'Pruning stopped before catalog publication.',
    };
    return aborted;
  }
  if (currentDigest !== receipt.catalogDigestAfter) {
    throw unsafeDurableGovernanceStore();
  }

  return null;
}
