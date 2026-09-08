/**
 * Defines manifest-bound prompts, result eligibility, and explicit epoch rollover decisions.
 *
 * Invariants:
 * - Prompt contents match the exact item identities and digests recorded in the manifest.
 * - Result eligibility retains workflow, job, epoch, snapshot, and attempt classification order.
 * - Rollover advances one epoch and records exact carry-forward decisions and new context identity.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import type {
  ContextManifest,
  ContextManifestItemReference,
} from '../lifecycle/context-manifest-contract.ts';
import {
  assertDigest,
  assertIdentity,
  assertPositiveInteger,
  assertReason,
  assertTimestamp,
  digest,
  exactDate,
  hasExactKeys,
  hasKeysEither,
  IDENTITY,
  isRecord,
  isWorkflowError,
  MAX_DOCUMENT_BYTES,
  normalizeInvalid,
  parseDocument,
  SHA256,
  sortedUniqueIdentities,
} from './execution-governance-values.ts';

export function buildContextManifest(input: {
  workflowId: string;
  epoch: number;
  contractVersion: number;
  baselineDigest: string;
  intentDigest: string;
  termSetDigest: string;
  planningSnapshotDigest: string;
  items: { identity: string; content: string }[];
}): ContextManifest {
  const references = [...input.items]
    .map(({ identity, content }) => {
      assertIdentity(identity, invalidContextManifest, 'context item identity');
      if (typeof content !== 'string' || Buffer.byteLength(content) > 262_144) {
        throw invalidContextManifest('Context item content is invalid.');
      }
      return { identity, digest: digest(content) };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const contextIdentity = {
    workflowId: input.workflowId,
    epoch: input.epoch,
    contractVersion: input.contractVersion,
    baselineDigest: input.baselineDigest,
    intentDigest: input.intentDigest,
    termSetDigest: input.termSetDigest,
    planningSnapshotDigest: input.planningSnapshotDigest,
    items: references,
  };
  const manifest: ContextManifest = {
    schemaVersion: 1,
    kind: 'epoch-context-manifest',
    ...contextIdentity,
    contextDigest: digest(canonicalJson(contextIdentity)),
  };
  validateContextManifest(manifest);
  return manifest;
}

export function canonicalContextManifest(manifest: ContextManifest): string {
  validateContextManifest(manifest);
  return `${canonicalJson(manifest)}\n`;
}

export function parseContextManifest(raw: string): ContextManifest {
  try {
    const value = parseDocument(raw);
    validateContextManifest(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'CONTEXT_MANIFEST_INVALID',
      'Epoch context manifest is malformed.',
    );
  }
}

export function assemblePromptFromManifest(
  manifest: ContextManifest,
  loadExactItem: (reference: ContextManifestItemReference) => {
    identity: string;
    digest: string;
    content: string;
  },
): string {
  validateContextManifest(manifest);
  const contents = manifest.items.map((reference) => {
    let loaded: ReturnType<typeof loadExactItem>;
    try {
      loaded = loadExactItem({ ...reference });
    } catch (error) {
      if (isWorkflowError(error)) throw error;
      throw workflowError(
        'CONTEXT_ITEM_UNAVAILABLE',
        `Context item ${reference.identity} could not be loaded.`,
        ExitCode.staleState,
      );
    }
    if (
      !isRecord(loaded) ||
      !hasExactKeys(loaded, ['identity', 'digest', 'content']) ||
      loaded.identity !== reference.identity ||
      loaded.digest !== reference.digest ||
      typeof loaded.content !== 'string' ||
      digest(loaded.content) !== reference.digest
    ) {
      throw workflowError(
        'CONTEXT_ITEM_MISMATCH',
        `Context item ${reference.identity} does not match its manifest digest.`,
        ExitCode.staleState,
      );
    }
    return loaded.content;
  });
  const prompt = contents.join('\n\n');
  if (Buffer.byteLength(prompt) > MAX_DOCUMENT_BYTES) {
    throw workflowError(
      'CONTEXT_PROMPT_TOO_LARGE',
      'Manifest-only prompt exceeds the bounded context size.',
      ExitCode.guard,
    );
  }
  return prompt;
}

export type WorkflowContextState = {
  workflowId: string;
  currentEpoch: number;
  contractVersion: number;
  contextDigest: string;
  snapshotDigest: string;
  status: 'active' | 'completed' | 'cancelled' | 'superseded';
  checkpoint: string;
  blocker: { kind: string; since: string } | null;
};

export type ResultEligibilityJob = {
  workflowId: string;
  jobId: string;
  epoch: number;
  contextDigest: string;
  snapshotDigest: string;
  acceptedAttemptId: string | null;
  eligibleAttemptIds: string[];
};

export type AttemptResultCandidate = {
  workflowId: string;
  jobId: string;
  attemptId: string;
  epoch: number;
  contextDigest: string;
  snapshotDigest: string;
};

export type AttemptResultEligibility = {
  eligible: boolean;
  classification: 'eligible' | 'stale' | 'late-duplicate' | 'rejected';
  reasonCode?: string;
  doNotMerge?: true;
};

export function assessAttemptResultEligibility(
  workflow: WorkflowContextState,
  job: ResultEligibilityJob,
  result: AttemptResultCandidate,
): AttemptResultEligibility {
  if (
    result.workflowId !== workflow.workflowId ||
    job.workflowId !== workflow.workflowId
  ) {
    return rejectedResult('RESULT_WRONG_OWNER');
  }
  if (workflow.status !== 'active') {
    return rejectedResult('RESULT_WORKFLOW_TERMINAL');
  }
  if (
    result.epoch !== workflow.currentEpoch ||
    job.epoch !== workflow.currentEpoch
  ) {
    return staleResult('RESULT_STALE_EPOCH');
  }
  if (
    result.contextDigest !== workflow.contextDigest ||
    job.contextDigest !== workflow.contextDigest
  ) {
    return staleResult('RESULT_CONTEXT_MISMATCH');
  }
  if (result.jobId !== job.jobId) {
    return rejectedResult('RESULT_WRONG_JOB');
  }
  if (
    result.snapshotDigest !== workflow.snapshotDigest ||
    job.snapshotDigest !== workflow.snapshotDigest
  ) {
    return staleResult('RESULT_SNAPSHOT_MISMATCH');
  }
  if (job.acceptedAttemptId !== null) {
    return {
      eligible: false,
      classification: 'late-duplicate',
      reasonCode: 'RESULT_ALREADY_ACCEPTED',
      doNotMerge: true,
    };
  }
  if (!job.eligibleAttemptIds.includes(result.attemptId)) {
    return rejectedResult('RESULT_ATTEMPT_INELIGIBLE');
  }
  return { eligible: true, classification: 'eligible' };
}

export type EpochTransitionVerification = {
  check: string;
  result: 'passed' | 'failed';
  reportDigest?: string;
};

export type EpochCarryForwardDecision = {
  identity: string;
  reason: string;
};

export type EpochCarryForwardManifest = {
  schemaVersion: 1;
  kind: 'epoch-carry-forward-manifest';
  sourceWorkflow: string;
  sourceEpoch: number;
  carriedForward: EpochCarryForwardDecision[];
  excluded: EpochCarryForwardDecision[];
};

type EpochTransitionReceiptCommon = {
  kind: 'epoch-transition';
  workflowId: string;
  fromEpoch: number;
  toEpoch: number;
  fromContractVersion: number;
  toContractVersion: number;
  reason: string;
  restartFrom: string;
  carriedForward: string[];
  invalidated: string[];
  previousContextDigest: string;
  newContextDigest: string;
  verification: EpochTransitionVerification | null;
  createdAt: string;
};

export type EpochTransitionReceipt = EpochTransitionReceiptCommon & {
  schemaVersion: 2;
  carryForwardManifest: EpochCarryForwardManifest;
};

export function performEpochRollover(input: {
  workflow: WorkflowContextState;
  nextManifest: ContextManifest;
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
}): { workflow: WorkflowContextState; receipt: EpochTransitionReceipt } {
  validateContextManifest(input.nextManifest);
  validateWorkflowContextState(input.workflow);
  if (
    input.nextManifest.workflowId !== input.workflow.workflowId ||
    input.nextManifest.epoch !== input.workflow.currentEpoch + 1 ||
    input.nextManifest.contextDigest === input.workflow.contextDigest
  ) {
    throw invalidEpochTransition(
      'Epoch rollover must advance the same workflow by one to a new context digest.',
    );
  }
  assertReason(input.reason, invalidEpochTransition, 'rollover reason');
  assertIdentity(
    input.restartFrom,
    invalidEpochTransition,
    'restart checkpoint',
  );
  const carriedForward = sortedUniqueIdentities(
    input.carriedForward,
    invalidEpochTransition,
    'carried-forward identity',
  );
  const allowed = new Set(
    input.nextManifest.items.map(({ identity }) => identity),
  );
  if (carriedForward.some((identity) => !allowed.has(identity))) {
    throw invalidEpochTransition(
      'Every carried-forward identity must appear in the new context manifest.',
    );
  }
  const invalidated = sortedUniqueIdentities(
    input.invalidated,
    invalidEpochTransition,
    'invalidated stage',
  );
  const verification = validateEpochVerification(input.verification);
  const createdAt = exactDate(input.createdAt, 'EPOCH_TRANSITION_INVALID');
  const carryForwardManifest = normalizeEpochCarryForwardManifest(
    input.carryForwardManifest,
    input.workflow,
    carriedForward,
  );
  const workflow: WorkflowContextState = {
    ...input.workflow,
    currentEpoch: input.nextManifest.epoch,
    contractVersion: input.nextManifest.contractVersion,
    contextDigest: input.nextManifest.contextDigest,
    snapshotDigest: input.nextManifest.baselineDigest,
    checkpoint: input.restartFrom,
    status: 'active',
    blocker: null,
  };
  const receiptCommon: EpochTransitionReceiptCommon = {
    kind: 'epoch-transition',
    workflowId: workflow.workflowId,
    fromEpoch: input.workflow.currentEpoch,
    toEpoch: workflow.currentEpoch,
    fromContractVersion: input.workflow.contractVersion,
    toContractVersion: workflow.contractVersion,
    reason: input.reason,
    restartFrom: input.restartFrom,
    carriedForward,
    invalidated,
    previousContextDigest: input.workflow.contextDigest,
    newContextDigest: workflow.contextDigest,
    verification,
    createdAt,
  };
  const receipt: EpochTransitionReceipt = {
    schemaVersion: 2,
    ...receiptCommon,
    carryForwardManifest,
  };
  validateEpochTransitionReceipt(receipt);
  return { workflow, receipt };
}

export function canonicalEpochTransitionReceipt(
  receipt: EpochTransitionReceipt,
): string {
  validateEpochTransitionReceipt(receipt);
  return `${canonicalJson(receipt)}\n`;
}

export function parseEpochTransitionReceipt(
  raw: string,
): EpochTransitionReceipt {
  try {
    const value = parseDocument(raw);
    validateEpochTransitionReceipt(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'EPOCH_TRANSITION_INVALID',
      'Epoch transition receipt is malformed.',
    );
  }
}

export function validateContextManifest(
  value: unknown,
): asserts value is ContextManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'epoch',
      'contractVersion',
      'baselineDigest',
      'intentDigest',
      'termSetDigest',
      'planningSnapshotDigest',
      'contextDigest',
      'items',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'epoch-context-manifest'
  ) {
    throw invalidContextManifest('Context manifest has an invalid shape.');
  }
  assertIdentity(value.workflowId, invalidContextManifest, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidContextManifest, 'epoch');
  assertPositiveInteger(
    value.contractVersion,
    invalidContextManifest,
    'contract version',
  );
  for (const [label, itemDigest] of [
    ['baseline digest', value.baselineDigest],
    ['intent digest', value.intentDigest],
    ['term set digest', value.termSetDigest],
    ['planning snapshot digest', value.planningSnapshotDigest],
    ['context digest', value.contextDigest],
  ] as const) {
    assertDigest(itemDigest, invalidContextManifest, label);
  }
  if (!Array.isArray(value.items) || value.items.length > 256) {
    throw invalidContextManifest('Context manifest item list is invalid.');
  }
  let previous = '';
  for (const item of value.items as unknown[]) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['identity', 'digest']) ||
      typeof item.identity !== 'string'
    ) {
      throw invalidContextManifest('Context manifest item is malformed.');
    }
    assertIdentity(
      item.identity,
      invalidContextManifest,
      'context item identity',
    );
    assertDigest(item.digest, invalidContextManifest, 'context item digest');
    if (item.identity <= previous) {
      throw invalidContextManifest(
        'Context manifest items must be sorted and unique.',
      );
    }
    previous = item.identity;
  }
  const expected = digest(
    canonicalJson({
      workflowId: value.workflowId,
      epoch: value.epoch,
      contractVersion: value.contractVersion,
      baselineDigest: value.baselineDigest,
      intentDigest: value.intentDigest,
      termSetDigest: value.termSetDigest,
      planningSnapshotDigest: value.planningSnapshotDigest,
      items: value.items,
    }),
  );
  if (value.contextDigest !== expected) {
    throw invalidContextManifest(
      'Context digest does not bind every semantic input and manifest identity.',
    );
  }
}

export function validateWorkflowContextState(
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
    throw invalidEpochTransition(
      'Workflow context state has an invalid shape.',
    );
  }
  assertIdentity(value.workflowId, invalidEpochTransition, 'workflow ID');
  assertPositiveInteger(
    value.currentEpoch,
    invalidEpochTransition,
    'current epoch',
  );
  assertPositiveInteger(
    value.contractVersion,
    invalidEpochTransition,
    'contract version',
  );
  assertDigest(value.contextDigest, invalidEpochTransition, 'context digest');
  assertDigest(value.snapshotDigest, invalidEpochTransition, 'snapshot digest');
  assertIdentity(value.checkpoint, invalidEpochTransition, 'checkpoint');
  if (
    !['active', 'completed', 'cancelled', 'superseded'].includes(
      String(value.status),
    )
  ) {
    throw invalidEpochTransition('Workflow status is invalid.');
  }
  if (value.blocker !== null) {
    if (
      !isRecord(value.blocker) ||
      !hasExactKeys(value.blocker, ['kind', 'since'])
    ) {
      throw invalidEpochTransition('Workflow blocker is malformed.');
    }
    assertIdentity(value.blocker.kind, invalidEpochTransition, 'blocker kind');
    assertTimestamp(
      value.blocker.since,
      invalidEpochTransition,
      'blocker since',
    );
  }
}

function normalizeEpochCarryForwardManifest(
  value: unknown,
  workflow: WorkflowContextState,
  carriedForwardSummary: readonly string[],
): EpochCarryForwardManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceWorkflow',
      'sourceEpoch',
      'carriedForward',
      'excluded',
    ])
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward manifest has an invalid shape.',
    );
  }
  const manifest = validateEpochCarryForwardManifest({
    schemaVersion: 1,
    kind: 'epoch-carry-forward-manifest',
    ...value,
  });
  if (
    manifest.sourceWorkflow !== workflow.workflowId ||
    manifest.sourceEpoch !== workflow.currentEpoch
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward manifest does not identify the source workflow epoch.',
    );
  }
  if (
    canonicalJson(manifest.carriedForward.map(({ identity }) => identity)) !==
    canonicalJson(carriedForwardSummary)
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward decisions must exactly match the receipt summary.',
    );
  }
  return manifest;
}

function validateEpochCarryForwardManifest(
  value: unknown,
): EpochCarryForwardManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sourceWorkflow',
      'sourceEpoch',
      'carriedForward',
      'excluded',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'epoch-carry-forward-manifest'
  ) {
    throw invalidEpochTransition(
      'Epoch carry-forward manifest has an invalid shape.',
    );
  }
  assertIdentity(
    value.sourceWorkflow,
    invalidEpochTransition,
    'carry-forward source workflow',
  );
  assertPositiveInteger(
    value.sourceEpoch,
    invalidEpochTransition,
    'carry-forward source epoch',
  );
  const carriedForward = normalizeEpochCarryForwardDecisions(
    value.carriedForward,
    'carried-forward',
  );
  const excluded = normalizeEpochCarryForwardDecisions(
    value.excluded,
    'excluded',
  );
  const carriedIdentities = new Set(
    carriedForward.map(({ identity }) => identity),
  );
  if (excluded.some(({ identity }) => carriedIdentities.has(identity))) {
    throw invalidEpochTransition(
      'An epoch item cannot be both carried forward and excluded.',
    );
  }
  return {
    schemaVersion: 1,
    kind: 'epoch-carry-forward-manifest',
    sourceWorkflow: value.sourceWorkflow as string,
    sourceEpoch: value.sourceEpoch as number,
    carriedForward,
    excluded,
  };
}

function normalizeEpochCarryForwardDecisions(
  value: unknown,
  label: string,
): EpochCarryForwardDecision[] {
  if (!Array.isArray(value)) {
    throw invalidEpochTransition(`${label} decisions must be an array.`);
  }
  const decisions = value.map((decision) => {
    if (
      !isRecord(decision) ||
      !hasExactKeys(decision, ['identity', 'reason'])
    ) {
      throw invalidEpochTransition(`${label} decision is malformed.`);
    }
    assertIdentity(
      decision.identity,
      invalidEpochTransition,
      `${label} identity`,
    );
    assertReason(decision.reason, invalidEpochTransition, `${label} reason`);
    return {
      identity: decision.identity as string,
      reason: decision.reason as string,
    };
  });
  decisions.sort((left, right) => left.identity.localeCompare(right.identity));
  if (
    decisions.some(
      ({ identity }, index) =>
        index > 0 && identity === decisions[index - 1]!.identity,
    )
  ) {
    throw invalidEpochTransition(`${label} decisions contain duplicates.`);
  }
  return decisions;
}

export function assertEpochCarryForwardSourceMembership(
  manifest: EpochCarryForwardManifest,
  sourceManifest: ContextManifest,
  nextManifest: ContextManifest,
): void {
  if (
    manifest.sourceWorkflow !== sourceManifest.workflowId ||
    manifest.sourceEpoch !== sourceManifest.epoch
  ) {
    throw invalidEpochTransition(
      'Carry-forward decisions do not match the stored source manifest.',
    );
  }
  const sourceIdentities = new Set(
    sourceManifest.items.map(({ identity }) => identity),
  );
  const decidedIdentities = [...manifest.carriedForward, ...manifest.excluded]
    .map(({ identity }) => identity)
    .sort();
  if (decidedIdentities.some((identity) => !sourceIdentities.has(identity))) {
    throw invalidEpochTransition(
      'Every carry-forward decision must identify an item in the source manifest.',
    );
  }
  if (
    canonicalJson(decidedIdentities) !==
    canonicalJson([...sourceIdentities].sort())
  ) {
    throw invalidEpochTransition(
      'Every source manifest item must have a carry-forward decision.',
    );
  }
  const sourceDigests = new Map(
    sourceManifest.items.map(({ identity, digest }) => [identity, digest]),
  );
  const nextDigests = new Map(
    nextManifest.items.map(({ identity, digest }) => [identity, digest]),
  );
  if (
    manifest.carriedForward.some(
      ({ identity }) =>
        nextDigests.get(identity) !== sourceDigests.get(identity),
    )
  ) {
    throw invalidEpochTransition(
      'Every carried-forward item must retain its exact source digest in the next manifest.',
    );
  }
  if (
    manifest.excluded.some(
      ({ identity }) =>
        nextDigests.get(identity) === sourceDigests.get(identity),
    )
  ) {
    throw invalidEpochTransition(
      'An excluded source item cannot remain unchanged in the next manifest.',
    );
  }
}

export function validateEpochTransitionReceipt(
  value: unknown,
): asserts value is EpochTransitionReceipt {
  const commonKeys = [
    'schemaVersion',
    'kind',
    'workflowId',
    'fromEpoch',
    'toEpoch',
    'fromContractVersion',
    'toContractVersion',
    'reason',
    'restartFrom',
    'carriedForward',
    'invalidated',
    'previousContextDigest',
    'newContextDigest',
    'verification',
    'createdAt',
  ];
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !hasExactKeys(value, [...commonKeys, 'carryForwardManifest']) ||
    value.kind !== 'epoch-transition'
  ) {
    throw invalidEpochTransition('Transition receipt has an invalid shape.');
  }
  assertIdentity(value.workflowId, invalidEpochTransition, 'workflow ID');
  assertPositiveInteger(value.fromEpoch, invalidEpochTransition, 'from epoch');
  if (value.toEpoch !== (value.fromEpoch as number) + 1) {
    throw invalidEpochTransition(
      'Transition receipt must advance exactly one epoch.',
    );
  }
  assertPositiveInteger(
    value.fromContractVersion,
    invalidEpochTransition,
    'from contract version',
  );
  assertPositiveInteger(
    value.toContractVersion,
    invalidEpochTransition,
    'to contract version',
  );
  assertReason(value.reason, invalidEpochTransition, 'rollover reason');
  assertIdentity(
    value.restartFrom,
    invalidEpochTransition,
    'restart checkpoint',
  );
  sortedUniqueIdentities(
    value.carriedForward,
    invalidEpochTransition,
    'carried-forward identity',
    true,
  );
  const manifest = validateEpochCarryForwardManifest(
    value.carryForwardManifest,
  );
  if (
    manifest.sourceWorkflow !== value.workflowId ||
    manifest.sourceEpoch !== value.fromEpoch ||
    canonicalJson(manifest.carriedForward.map(({ identity }) => identity)) !==
      canonicalJson(value.carriedForward)
  ) {
    throw invalidEpochTransition(
      'Transition carry-forward decisions do not match the receipt summary.',
    );
  }
  sortedUniqueIdentities(
    value.invalidated,
    invalidEpochTransition,
    'invalidated stage',
    true,
  );
  assertDigest(
    value.previousContextDigest,
    invalidEpochTransition,
    'previous context digest',
  );
  assertDigest(
    value.newContextDigest,
    invalidEpochTransition,
    'new context digest',
  );
  if (value.previousContextDigest === value.newContextDigest) {
    throw invalidEpochTransition(
      'Epoch rollover must change the context digest.',
    );
  }
  validateEpochVerification(value.verification);
  assertTimestamp(value.createdAt, invalidEpochTransition, 'createdAt');
}

function validateEpochVerification(
  value: unknown,
): EpochTransitionVerification | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasKeysEither(value, [
      ['check', 'result'],
      ['check', 'result', 'reportDigest'],
    ]) ||
    typeof value.check !== 'string' ||
    !IDENTITY.test(value.check) ||
    (value.result !== 'passed' && value.result !== 'failed') ||
    (value.reportDigest !== undefined &&
      !SHA256.test(String(value.reportDigest)))
  ) {
    throw invalidEpochTransition('Transition verification is malformed.');
  }
  return {
    check: value.check,
    result: value.result,
    ...(value.reportDigest === undefined
      ? {}
      : { reportDigest: value.reportDigest as string }),
  };
}

function rejectedResult(reasonCode: string): AttemptResultEligibility {
  return {
    eligible: false,
    classification: 'rejected',
    reasonCode,
    doNotMerge: true,
  };
}

function staleResult(reasonCode: string): AttemptResultEligibility {
  return {
    eligible: false,
    classification: 'stale',
    reasonCode,
    doNotMerge: true,
  };
}

export function invalidContextManifest(message: string): WorkflowError {
  return workflowError('CONTEXT_MANIFEST_INVALID', message, ExitCode.usage);
}

export function invalidEpochTransition(message: string): WorkflowError {
  return workflowError('EPOCH_TRANSITION_INVALID', message, ExitCode.usage);
}
