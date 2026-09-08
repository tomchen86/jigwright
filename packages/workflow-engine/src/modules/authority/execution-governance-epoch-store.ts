/**
 * Publishes and advances durable epoch contexts under their workflow-generation lock.
 *
 * Invariants:
 * - Manifest objects publish before the atomic context and retention envelope.
 * - Rollover and guarded result acceptance retain exact epoch, context, and generation bindings.
 * - Receipt compaction preserves semantic context while advancing only operational generation.
 */
import fs from 'node:fs';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ContextManifest } from '../lifecycle/context-manifest-contract.ts';
import {
  exactDate,
  assertIdentity,
  assertPositiveInteger,
  assertDigest,
} from './execution-governance-values.ts';
import {
  type WorkflowContextState,
  validateContextManifest,
  validateWorkflowContextState,
  type EpochCarryForwardDecision,
  type EpochTransitionVerification,
  invalidEpochTransition,
  performEpochRollover,
  assertEpochCarryForwardSourceMembership,
  assemblePromptFromManifest,
  type ResultEligibilityJob,
  type AttemptResultCandidate,
  type AttemptResultEligibility,
  assessAttemptResultEligibility,
} from './execution-governance-context.ts';
import {
  type RetentionPolicy,
  DEFAULT_RETENTION_POLICY,
  validateRetentionPolicy,
  compactEpochTransitionReceipts,
  markEpochEvidenceExpiring,
} from './execution-governance-retention.ts';
import {
  type DurableEpochContextState,
  assertContextManifestBinding,
  type DurableRetentionCatalog,
  manifestRetentionRecords,
  type DurableGovernanceState,
  canonicalDurableGovernanceState,
  invalidDurableContext,
  type DurableEpochTransitionCompactionResult,
  assertContextCas,
  assertUniqueEvidenceIds,
} from './execution-governance-store-contracts.ts';
import {
  ensureDurableGovernanceStore,
  durableStatePath,
  persistManifestItems,
  readDurableGovernanceState,
  readDurableContentObject,
} from './execution-governance-store-objects.ts';
import { withDurableGovernanceLock } from './execution-governance-locks.ts';
import {
  createDurablePrivateFileAtomic,
  replacePrivateFileAtomic,
} from './execution-governance-private-files.ts';
import { recoverPreparedPruneReceipts } from './execution-governance-prune-recovery.ts';

/**
 * Creates the first durable context generation and its retention catalog as one
 * atomic workflow envelope. Context objects are published before the envelope,
 * so an interrupted initialization can leave only unreachable content objects.
 */
export function initializeDurableEpochContextStore(
  storeRoot: string,
  input: {
    workflow: WorkflowContextState;
    manifest: ContextManifest;
    items: { identity: string; content: string }[];
    now: Date;
  },
): DurableEpochContextState {
  validateContextManifest(input.manifest);
  validateWorkflowContextState(input.workflow);
  assertContextManifestBinding(input.workflow, input.manifest);
  const updatedAt = exactDate(input.now, 'EXECUTION_CONTEXT_INVALID');
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflow.workflowId, () => {
    const statePath = durableStatePath(paths, input.workflow.workflowId);
    if (fs.lstatSync(statePath, { throwIfNoEntry: false }) !== undefined) {
      throw workflowError(
        'EXECUTION_CONTEXT_EXISTS',
        `Durable context for ${input.workflow.workflowId} already exists.`,
        ExitCode.conflict,
      );
    }
    persistManifestItems(
      paths,
      input.workflow.workflowId,
      input.manifest,
      input.items,
    );
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
    createDurablePrivateFileAtomic(
      statePath,
      canonicalDurableGovernanceState(state),
    );
    return structuredClone(context);
  });
}

export function inspectDurableEpochContextStore(
  storeRoot: string,
  workflowId: string,
): DurableEpochContextState {
  assertIdentity(workflowId, invalidDurableContext, 'workflow ID');
  const state = readDurableGovernanceState(
    ensureDurableGovernanceStore(storeRoot),
    workflowId,
  );
  return structuredClone(state.context);
}

/**
 * Applies transition-receipt TTL and count bounds without requiring another
 * semantic epoch rollover. Receipt retention is operational maintenance: it
 * may advance the durable context envelope generation, but it must not change
 * the current epoch, manifest, workflow binding, or evidence catalog.
 */
export function compactDurableEpochTransitionReceipts(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedContextGeneration: number;
    now: Date;
    policy?: RetentionPolicy;
  },
): DurableEpochTransitionCompactionResult {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  assertPositiveInteger(
    input.expectedContextGeneration,
    invalidDurableContext,
    'expected context generation',
  );
  const updatedAt = exactDate(input.now, 'RETENTION_POLICY_INVALID');
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
    if (state.context.generation !== input.expectedContextGeneration) {
      throw workflowError(
        'EXECUTION_CONTEXT_CAS_MISMATCH',
        'Durable context changed before transition receipts were compacted.',
        ExitCode.staleState,
      );
    }
    const fullReceiptsBefore = state.context.transitionReceipts.length;
    const stubsBefore = state.context.transitionStubs.length;
    const compacted = compactEpochTransitionReceipts(
      state.context.transitionReceipts,
      state.context.transitionStubs,
      { now: input.now, policy },
    );
    const changed =
      canonicalJson(compacted.full) !==
        canonicalJson(state.context.transitionReceipts) ||
      canonicalJson(compacted.stubs) !==
        canonicalJson(state.context.transitionStubs);
    if (!changed) {
      return Object.freeze({
        workflowId: input.workflowId,
        changed: false,
        contextGeneration: state.context.generation,
        fullReceiptsBefore,
        fullReceiptsAfter: fullReceiptsBefore,
        stubsBefore,
        stubsAfter: stubsBefore,
        discarded: Object.freeze([...compacted.discarded]),
      });
    }
    const context: DurableEpochContextState = {
      ...state.context,
      generation: state.context.generation + 1,
      transitionReceipts: compacted.full,
      transitionStubs: compacted.stubs,
      updatedAt,
    };
    replacePrivateFileAtomic(
      durableStatePath(paths, input.workflowId),
      canonicalDurableGovernanceState({ ...state, context }),
    );
    return Object.freeze({
      workflowId: input.workflowId,
      changed: true,
      contextGeneration: context.generation,
      fullReceiptsBefore,
      fullReceiptsAfter: context.transitionReceipts.length,
      stubsBefore,
      stubsAfter: context.transitionStubs.length,
      discarded: Object.freeze([...compacted.discarded]),
    });
  });
}

/**
 * Revalidate one exact current context and execute a short synchronous
 * acceptance operation while holding the same per-workflow lock used by epoch
 * rollover. Callers receive no raw lock primitive and must not perform
 * long-running provider or tool work inside the callback.
 */
export function withCurrentDurableEpochContextStore<T>(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
    expectedManifest: ContextManifest;
  },
  operation: (context: DurableEpochContextState) => T,
): T {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  assertPositiveInteger(
    input.expectedGeneration,
    invalidDurableContext,
    'expected generation',
  );
  assertPositiveInteger(
    input.expectedEpoch,
    invalidDurableContext,
    'expected epoch',
  );
  assertDigest(
    input.expectedContextDigest,
    invalidDurableContext,
    'expected context digest',
  );
  validateContextManifest(input.expectedManifest);
  if (
    input.expectedManifest.workflowId !== input.workflowId ||
    input.expectedManifest.epoch !== input.expectedEpoch ||
    input.expectedManifest.contextDigest !== input.expectedContextDigest
  ) {
    throw invalidDurableContext(
      'Expected context manifest does not match its acceptance binding.',
    );
  }
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    const state = readDurableGovernanceState(paths, input.workflowId);
    if (
      state.context.generation !== input.expectedGeneration ||
      state.context.workflow.status !== 'active' ||
      state.context.workflow.currentEpoch !== input.expectedEpoch ||
      state.context.workflow.contextDigest !== input.expectedContextDigest ||
      canonicalJson(state.context.currentManifest) !==
        canonicalJson(input.expectedManifest)
    ) {
      throw workflowError(
        'EXECUTION_CONTEXT_CAS_MISMATCH',
        'Durable context changed before the guarded acceptance operation.',
        ExitCode.staleState,
      );
    }
    return operation(structuredClone(state.context));
  });
}

/**
 * Rolls the current epoch under a context-generation CAS. Only the new
 * manifest is retained as the assembly authority; historical manifests are
 * represented by bounded transition receipts/stubs, not prompt inputs.
 */
export function rolloverDurableEpochContextStore(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedGeneration: number;
    expectedEpoch: number;
    expectedContextDigest: string;
    nextManifest: ContextManifest;
    items: { identity: string; content: string }[];
    reason: string;
    restartFrom: string;
    carriedForward: string[];
    carryForwardManifest: {
      sourceWorkflow: string;
      sourceEpoch: number;
      carriedForward: EpochCarryForwardDecision[];
      excluded: EpochCarryForwardDecision[];
    };
    invalidated: string[];
    verification: EpochTransitionVerification | null;
    createdAt: Date;
    policy?: RetentionPolicy;
  },
): DurableEpochContextState {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  validateContextManifest(input.nextManifest);
  const createdAt = exactDate(input.createdAt, 'EPOCH_TRANSITION_INVALID');
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  validateRetentionPolicy(policy);
  const paths = ensureDurableGovernanceStore(storeRoot);
  return withDurableGovernanceLock(paths, input.workflowId, () => {
    let state = readDurableGovernanceState(paths, input.workflowId);
    recoverPreparedPruneReceipts(paths, input.workflowId, state);
    state = readDurableGovernanceState(paths, input.workflowId);
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
    persistManifestItems(
      paths,
      input.workflowId,
      input.nextManifest,
      input.items,
    );
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
    replacePrivateFileAtomic(
      durableStatePath(paths, input.workflowId),
      canonicalDurableGovernanceState(next),
    );
    return structuredClone(context);
  });
}

/** Prompt assembly is deliberately a current-manifest-only traversal. */
export function assembleCurrentPromptFromStore(
  storeRoot: string,
  input: {
    workflowId: string;
    expectedEpoch: number;
    expectedContextDigest: string;
  },
): string {
  assertIdentity(input.workflowId, invalidDurableContext, 'workflow ID');
  assertPositiveInteger(
    input.expectedEpoch,
    invalidDurableContext,
    'expected epoch',
  );
  assertDigest(
    input.expectedContextDigest,
    invalidDurableContext,
    'expected context digest',
  );
  const paths = ensureDurableGovernanceStore(storeRoot);
  const state = readDurableGovernanceState(paths, input.workflowId);
  if (state.context.workflow.currentEpoch !== input.expectedEpoch) {
    throw workflowError(
      'EXECUTION_CONTEXT_STALE_EPOCH',
      `Epoch ${input.expectedEpoch} is not the current epoch for ${input.workflowId}.`,
      ExitCode.staleState,
    );
  }
  if (state.context.workflow.contextDigest !== input.expectedContextDigest) {
    throw workflowError(
      'EXECUTION_CONTEXT_STALE_MANIFEST',
      `The expected manifest is not current for ${input.workflowId}.`,
      ExitCode.staleState,
    );
  }
  return assemblePromptFromManifest(
    state.context.currentManifest,
    (reference) => ({
      ...reference,
      content: readDurableContentObject(
        paths,
        input.workflowId,
        reference.digest,
      ),
    }),
  );
}

export function assessStoredAttemptResultEligibility(
  storeRoot: string,
  workflowId: string,
  job: ResultEligibilityJob,
  result: AttemptResultCandidate,
): AttemptResultEligibility {
  const state = inspectDurableEpochContextStore(storeRoot, workflowId);
  return assessAttemptResultEligibility(state.workflow, job, result);
}
