/**
 * Resolve durable provider retention bindings and classify exact pruning eligibility.
 *
 * Invariants:
 * - Pins, accepted results, current attempts, and receipt bindings retain their existing precedence.
 * - Eligibility remains a read-only decision over the same durable facts.
 *
 * Depends on: invocation state, execution journals, context retention bindings, and artifact observations.
 * Failure modes: Stale or incomplete evidence can be classified as safe to delete.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type AttemptRecord,
  projectProviderInvocationExecution,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  type DurableExecutionJobState,
  readExecutionJobState,
} from '../storage-journal/execution-store.ts';
import {
  type EvidenceRetentionRecord,
  inspectDurableRetentionCatalog,
} from '../../modules/authority/execution-governance.ts';
import {
  type ProviderPromptContextRetentionBinding,
  providerRuntimeEvidenceId,
  inspectProviderPromptContextRetentionBinding,
} from './provider-execution-governance.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import { readProviderInvocationLifecycleProjection } from '../storage-journal/provider-invocation-lifecycle.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  type ProviderInvocationRecord,
  readProviderInvocationRequest,
  readProviderInvocationManifest,
} from '../storage-journal/provider-invocation-store.ts';
import { type ProviderRetentionReceipt } from '../storage-journal/provider-retention-receipt.ts';
import {
  type ProviderRetentionEligibilityInput,
  type ProviderRetentionDenyReason,
} from './provider-retention.ts';
import {
  type PhysicalArtifact,
  collectPhysicalArtifacts,
} from './provider-retention-artifacts.ts';
import { deny, sha256, receiptUnsafe } from './provider-retention-values.ts';

/**
 * Reads the human pins recorded for one workflow. Only a genuinely absent
 * workflow catalog means no pin has been recorded. An unreadable or invalid
 * catalog must block physical pruning because treating uncertain authority as
 * an empty pin set could delete evidence that a human retained.
 */
function readHumanPinnedEvidenceIds(
  storeRoot: string,
  workflowId: string,
): ReadonlySet<string> {
  let records: readonly EvidenceRetentionRecord[];
  try {
    records = inspectDurableRetentionCatalog(storeRoot, workflowId).records;
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_CONTEXT_NOT_FOUND'
    ) {
      return new Set();
    }
    throw error;
  }
  return new Set(
    records
      .filter((record) => record.retention === 'pinned' && record.pin !== null)
      .map(({ evidenceId }) => evidenceId),
  );
}

/**
 * Resolves human pins once per workflow within a single pass. The cache is
 * per-pass on purpose: a pin recorded between passes has to be visible to the
 * next one.
 */
export function humanPinResolver(
  storeRoot: string,
): (workflowId: string) => ReadonlySet<string> {
  const seen = new Map<string, ReadonlySet<string>>();
  return (workflowId) => {
    const cached = seen.get(workflowId);
    if (cached !== undefined) return cached;
    const pins = readHumanPinnedEvidenceIds(storeRoot, workflowId);
    seen.set(workflowId, pins);
    return pins;
  };
}

/** Pure policy projection used by the physical pass and contract tests. */
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

export type InvocationBinding = Readonly<{
  state: DurableExecutionJobState;
  attempt: AttemptRecord;
  record: ProviderInvocationRecord;
  context: ProviderPromptContextRetentionBinding;
}>;

export type CandidateDecision =
  | Readonly<{
      kind: 'deny';
      invocationId: string;
      reason: ProviderRetentionDenyReason;
    }>
  | Readonly<{
      kind: 'prune';
      binding: InvocationBinding;
      artifacts: PhysicalArtifact[];
    }>;

export function decideCandidate(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  binding: InvocationBinding | undefined,
  cutoffAt: string,
  humanPinnedEvidenceIds: ReadonlySet<string>,
): CandidateDecision {
  if (binding === undefined) {
    return deny(record.invocationId, 'schema-currentness-unknown');
  }
  const { state, attempt, context } = binding;
  if (
    attempt.epoch !== state.job.epoch ||
    state.job.workflowId !== state.workflow.workflowId ||
    state.job.epoch > state.workflow.currentEpoch ||
    attempt.workflowId !== state.workflow.workflowId ||
    context.epoch > context.currentEpoch ||
    attempt.providerInvocation?.invocationId !== record.invocationId ||
    attempt.providerInvocation.invocationRevision !== record.revision
  ) {
    return deny(record.invocationId, 'schema-currentness-unknown');
  }
  const policyDenial = classifyProviderRetentionEligibility({
    invocationState: record.state,
    historyComplete: state.invocationProjection.completeHistory,
    attemptEpoch: context.epoch,
    currentEpoch: context.currentEpoch,
    retention: attempt.retention,
    humanPinned: humanPinnedEvidenceIds.has(
      providerRuntimeEvidenceId(attempt.attemptId),
    ),
    acceptedAttempt: state.job.acceptedAttemptId === attempt.attemptId,
    latestUnacceptedAttempt:
      state.job.acceptedAttemptId === null &&
      attempt.attemptNumber ===
        Math.max(...state.attempts.map(({ attemptNumber }) => attemptNumber)),
    terminalAt: record.updatedAt,
    cutoffAt,
  });
  if (policyDenial !== null) {
    return deny(record.invocationId, policyDenial);
  }
  if (
    fs.lstatSync(
      path.join(paths.invocations, record.invocationId, 'repair-evidence.json'),
      { throwIfNoEntry: false },
    )
  ) {
    // Current provider repair lineage still reads this exact predecessor
    // evidence. Until that reader has a receipt-backed logical projection,
    // physical deletion would make retry lineage unverifiable.
    return deny(record.invocationId, 'consumed-repair-evidence-unproven');
  }

  // Re-run the strict closure scanner immediately before capturing bytes.
  // This rejects unknown invocation files and any unsafe link without deleting
  // even a single pathname.
  try {
    readProviderInvocationLifecycleProjection(paths, record.invocationId);
  } catch {
    return deny(record.invocationId, 'unsafe-artifact');
  }
  let artifacts: PhysicalArtifact[];
  try {
    artifacts = collectPhysicalArtifacts(paths, binding);
  } catch {
    return deny(record.invocationId, 'unsafe-artifact');
  }
  if (artifacts.length === 0) {
    return deny(record.invocationId, 'nothing-prunable');
  }
  return { kind: 'prune', binding, artifacts };
}

export function assertReceiptBinding(
  receipt: ProviderRetentionReceipt,
  binding: InvocationBinding | undefined,
  record: ProviderInvocationRecord,
): asserts binding is InvocationBinding {
  if (
    binding === undefined ||
    receipt.invocationId !== record.invocationId ||
    receipt.workflowId !== binding.context.workflowId ||
    receipt.jobId !== binding.state.job.jobId ||
    receipt.attemptId !== binding.attempt.attemptId ||
    receipt.executionRevision !== binding.state.revision ||
    receipt.executionStateDigest !== sha256(canonicalJson(binding.state)) ||
    receipt.contextDigest !== binding.context.contextDigest ||
    receipt.epoch !== binding.context.epoch ||
    receipt.currentEpoch > binding.context.currentEpoch ||
    receipt.currentEpoch < receipt.epoch ||
    receipt.attemptRetention !== binding.attempt.retention ||
    receipt.acceptedAttemptId !== binding.state.job.acceptedAttemptId ||
    receipt.requestDigest !== record.requestDigest ||
    receipt.manifestDigest !== record.manifestDigest ||
    receipt.invocationRevision !== record.revision ||
    receipt.terminalState !== record.state ||
    receipt.terminalAt !== record.updatedAt ||
    Date.parse(receipt.terminalAt) > Date.parse(receipt.cutoffAt)
  ) {
    throw receiptUnsafe();
  }
}

export function readInvocationBinding(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
): InvocationBinding | undefined {
  try {
    const request = readProviderInvocationRequest(paths, record.invocationId);
    const manifest = readProviderInvocationManifest(paths, record.invocationId);
    const context = inspectProviderPromptContextRetentionBinding(
      paths.root,
      request,
      manifest,
      record.investigationId,
      record.createdAt,
    );
    if (context === null) return undefined;
    const projected = projectProviderInvocationExecution({ record, request });
    const state = readExecutionJobState(paths, projected.job.jobId);
    if (state === null) return undefined;
    const sources = state.invocationProjection.invocations.filter(
      ({ invocationId }) => invocationId === record.invocationId,
    );
    if (sources.length !== 1) return undefined;
    const source = sources[0]!;
    const attempts = state.attempts.filter(
      ({ attemptId }) => attemptId === source.attemptId,
    );
    if (
      attempts.length !== 1 ||
      source.invocationRevision !== record.revision ||
      attempts[0]!.attemptId !== projected.attempt.attemptId ||
      attempts[0]!.providerInvocation?.invocationId !== record.invocationId ||
      attempts[0]!.providerInvocation?.invocationRevision !== record.revision
    ) {
      return undefined;
    }
    return { state, attempt: attempts[0]!, record, context };
  } catch (error) {
    // A missing or stale binding retains evidence as unprovable. Corruption of
    // the same governance state that owns human pins is different: swallowing
    // it here would later model an uncertain catalog as an empty pin set.
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    return undefined;
  }
}
