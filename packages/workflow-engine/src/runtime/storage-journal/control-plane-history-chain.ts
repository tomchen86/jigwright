/**
 * Constructs and verifies ordered supervisor history progression.
 *
 * Invariants:
 * - Every successor binds its predecessor, generation, active artifact, and trust commit.
 * - Terminal records close only the exact active transition with no gaps or forks.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type ControlPlaneSupervisorHistoryAnchor,
  type ControlPlaneSupervisorHistoryAnchorAuthority,
  type ControlPlaneSupervisorHistoryArtifactSelection,
  type ControlPlaneSupervisorHistoryDigest,
  type ControlPlaneSupervisorHistoryRecord,
  controlPlaneSupervisorHistoryRecordDigest,
  type ControlPlaneSupervisorHistoryTerminal,
  type ControlPlaneSupervisorHistoryTransition,
  type HistoryPredecessor,
  type VerifiedControlPlaneSupervisorHistory,
  type VerifiedControlPlaneSupervisorHistoryProgress,
  verifyControlPlaneSupervisorHistoryRecord,
} from './control-plane-history-contract.ts';
import {
  deepFreeze,
  historyFork,
  historyGap,
  transitionInvalid,
} from './control-plane-history-values.ts';

export function createControlPlaneSupervisorHistoryAnchor(input: {
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  authority: ControlPlaneSupervisorHistoryAnchorAuthority;
  recordedAt: string;
}): ControlPlaneSupervisorHistoryAnchor {
  const payload = {
    kind: 'control-plane-supervisor-history-anchor.v1' as const,
    sequence: 0 as const,
    previousRecordDigest: null,
    repositoryId: input.repositoryId,
    generation: input.generation,
    supervisorRecordDigest: input.supervisorRecordDigest,
    activeArtifact: structuredClone(input.activeArtifact),
    activeTrustCommit: input.activeTrustCommit,
    authority: structuredClone(input.authority),
    recordedAt: input.recordedAt,
  };
  return verifyControlPlaneSupervisorHistoryRecord({
    ...payload,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  }) as ControlPlaneSupervisorHistoryAnchor;
}

export function createControlPlaneSupervisorHistoryTransition(input: {
  previous: HistoryPredecessor;
  phase: 'candidate-selected' | 'rollback-restored';
  toSupervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: ControlPlaneSupervisorHistoryDigest;
  promotionBundleDigest: ControlPlaneSupervisorHistoryDigest;
  promotionLineageDigest: ControlPlaneSupervisorHistoryDigest;
  sourceTransactionState: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED';
  sourceJournalDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
}): ControlPlaneSupervisorHistoryTransition {
  const previous = verifyControlPlaneSupervisorHistoryRecord(input.previous);
  const fromGeneration = recordGeneration(previous);
  const payload = {
    kind: 'control-plane-supervisor-history-transition.v1' as const,
    sequence: previous.sequence + 1,
    previousRecordDigest: previous.recordDigest,
    repositoryId: previous.repositoryId,
    phase: input.phase,
    fromGeneration,
    toGeneration: fromGeneration + 1,
    fromSupervisorRecordDigest: recordSupervisorDigest(previous),
    toSupervisorRecordDigest: input.toSupervisorRecordDigest,
    activeArtifact: structuredClone(input.activeArtifact),
    activeTrustCommit: input.activeTrustCommit,
    grantId: input.grantId,
    txId: input.txId,
    grantEnvelopeDigest: input.grantEnvelopeDigest,
    promotionBundleDigest: input.promotionBundleDigest,
    promotionLineageDigest: input.promotionLineageDigest,
    sourceTransactionState: input.sourceTransactionState,
    sourceJournalDigest: input.sourceJournalDigest,
    recordedAt: input.recordedAt,
  };
  const record = verifyControlPlaneSupervisorHistoryRecord({
    ...payload,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  });
  assertTransitionFollows(
    previous,
    record as ControlPlaneSupervisorHistoryTransition,
  );
  return record as ControlPlaneSupervisorHistoryTransition;
}

export function createControlPlaneSupervisorHistoryTerminal(input: {
  previous: ControlPlaneSupervisorHistoryTransition;
  terminalState: 'FINALIZED' | 'ROLLED_BACK';
  updateRecordDigest: ControlPlaneSupervisorHistoryDigest;
  transactionJournalDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
}): ControlPlaneSupervisorHistoryTerminal {
  const previous = verifyControlPlaneSupervisorHistoryRecord(input.previous);
  if (previous.kind !== 'control-plane-supervisor-history-transition.v1') {
    throw transitionInvalid(
      'A terminal seal must follow a supervisor transition.',
    );
  }
  const payload = {
    kind: 'control-plane-supervisor-history-terminal.v1' as const,
    sequence: previous.sequence + 1,
    previousRecordDigest: previous.recordDigest,
    repositoryId: previous.repositoryId,
    generation: previous.toGeneration,
    supervisorRecordDigest: previous.toSupervisorRecordDigest,
    activeArtifact: structuredClone(previous.activeArtifact),
    activeTrustCommit: previous.activeTrustCommit,
    terminalState: input.terminalState,
    grantId: previous.grantId,
    txId: previous.txId,
    updateRecordDigest: input.updateRecordDigest,
    transactionJournalDigest: input.transactionJournalDigest,
    grantEnvelopeDigest: previous.grantEnvelopeDigest,
    promotionBundleDigest: previous.promotionBundleDigest,
    recordedAt: input.recordedAt,
  };
  const record = verifyControlPlaneSupervisorHistoryRecord({
    ...payload,
    recordDigest: controlPlaneSupervisorHistoryRecordDigest(payload),
  });
  assertTerminalFollows(
    previous,
    record as ControlPlaneSupervisorHistoryTerminal,
  );
  return record as ControlPlaneSupervisorHistoryTerminal;
}

export function verifyControlPlaneSupervisorHistoryProgress(
  values: readonly unknown[],
): VerifiedControlPlaneSupervisorHistoryProgress {
  if (!Array.isArray(values) || values.length === 0) {
    throw historyGap('Supervisor history has no anchor.');
  }
  const records = values.map(verifyControlPlaneSupervisorHistoryRecord);
  const digests = new Set<string>();
  const children = new Map<string, number>();
  for (const record of records) {
    if (digests.has(record.recordDigest)) {
      throw historyFork('Supervisor history repeats a record digest.');
    }
    digests.add(record.recordDigest);
    if (record.previousRecordDigest !== null) {
      children.set(
        record.previousRecordDigest,
        (children.get(record.previousRecordDigest) ?? 0) + 1,
      );
    }
  }
  if ([...children.values()].some((count) => count !== 1)) {
    throw historyFork('Supervisor history contains more than one child.');
  }
  const ordered = [...records].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.sequence !== index) {
      throw historyGap('Supervisor history sequences are not contiguous.');
    }
  }
  const anchor = ordered[0]!;
  if (anchor.kind !== 'control-plane-supervisor-history-anchor.v1') {
    throw historyGap('Supervisor history does not begin with an anchor.');
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.previousRecordDigest !== previous.recordDigest) {
      throw historyGap(
        'Supervisor history previous digests are discontinuous.',
      );
    }
    if (current.repositoryId !== anchor.repositoryId) {
      throw transitionInvalid(
        'Supervisor history crosses repository identities.',
      );
    }
    if (Date.parse(current.recordedAt) < Date.parse(previous.recordedAt)) {
      throw transitionInvalid(
        'Supervisor history timestamps are not monotonic.',
      );
    }
    if (current.kind === 'control-plane-supervisor-history-transition.v1') {
      assertTransitionFollows(previous, current);
      if (current.phase === 'rollback-restored') {
        const restored = ordered[index - 2];
        if (
          restored === undefined ||
          canonicalJson(current.activeArtifact) !==
            canonicalJson(recordActiveArtifact(restored)) ||
          current.activeTrustCommit !== recordActiveTrustCommit(restored)
        ) {
          throw transitionInvalid(
            'Rollback does not restore the exact pre-candidate selection.',
          );
        }
      }
    } else if (
      current.kind === 'control-plane-supervisor-history-terminal.v1'
    ) {
      assertTerminalFollows(previous, current);
    } else {
      throw transitionInvalid('A second history anchor is forbidden.');
    }
  }
  const leaf = ordered.at(-1)!;
  const progress = {
    records: ordered.map((record) => structuredClone(record)),
    anchor: structuredClone(anchor),
    leaf: structuredClone(leaf),
    generation: recordGeneration(leaf),
    supervisorRecordDigest: recordSupervisorDigest(leaf),
    activeArtifact: structuredClone(recordActiveArtifact(leaf)),
    activeTrustCommit: recordActiveTrustCommit(leaf),
    terminal:
      leaf.kind === 'control-plane-supervisor-history-anchor.v1' ||
      leaf.kind === 'control-plane-supervisor-history-terminal.v1',
  };
  return deepFreeze(progress);
}

export function verifyControlPlaneSupervisorHistory(
  values: readonly unknown[],
): VerifiedControlPlaneSupervisorHistory {
  const progress = verifyControlPlaneSupervisorHistoryProgress(values);
  if (!progress.terminal) {
    throw workflowError(
      'CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL',
      'Supervisor history leaf is an incomplete transition.',
      ExitCode.conflict,
    );
  }
  return progress as VerifiedControlPlaneSupervisorHistory;
}

function assertTransitionFollows(
  previous: ControlPlaneSupervisorHistoryRecord,
  current: ControlPlaneSupervisorHistoryTransition,
): void {
  if (
    current.previousRecordDigest !== previous.recordDigest ||
    current.sequence !== previous.sequence + 1 ||
    current.repositoryId !== previous.repositoryId ||
    current.fromGeneration !== recordGeneration(previous) ||
    current.toGeneration !== current.fromGeneration + 1 ||
    current.fromSupervisorRecordDigest !== recordSupervisorDigest(previous)
  ) {
    throw transitionInvalid(
      'Supervisor transition does not extend its exact predecessor.',
    );
  }
  if (current.phase === 'candidate-selected') {
    if (
      (previous.kind !== 'control-plane-supervisor-history-anchor.v1' &&
        previous.kind !== 'control-plane-supervisor-history-terminal.v1') ||
      current.sourceTransactionState !== 'RECOVERY_VERIFIED'
    ) {
      throw transitionInvalid(
        'Candidate selection must extend a terminal history leaf.',
      );
    }
    return;
  }
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    previous.phase !== 'candidate-selected' ||
    current.sourceTransactionState !== 'ROLLBACK_REQUIRED' ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    current.promotionLineageDigest !== previous.promotionLineageDigest
  ) {
    throw transitionInvalid(
      'Rollback must extend the exact candidate selection transaction.',
    );
  }
}

function assertTerminalFollows(
  previous: ControlPlaneSupervisorHistoryRecord,
  current: ControlPlaneSupervisorHistoryTerminal,
): void {
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    current.previousRecordDigest !== previous.recordDigest ||
    current.sequence !== previous.sequence + 1 ||
    current.repositoryId !== previous.repositoryId ||
    current.generation !== previous.toGeneration ||
    current.supervisorRecordDigest !== previous.toSupervisorRecordDigest ||
    canonicalJson(current.activeArtifact) !==
      canonicalJson(previous.activeArtifact) ||
    current.activeTrustCommit !== previous.activeTrustCommit ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    (current.terminalState === 'FINALIZED' &&
      previous.phase !== 'candidate-selected') ||
    (current.terminalState === 'ROLLED_BACK' &&
      previous.phase !== 'rollback-restored')
  ) {
    throw transitionInvalid(
      'Terminal seal does not match its exact supervisor transition.',
    );
  }
}

function recordGeneration(record: ControlPlaneSupervisorHistoryRecord): number {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toGeneration
    : record.generation;
}

function recordSupervisorDigest(
  record: ControlPlaneSupervisorHistoryRecord,
): ControlPlaneSupervisorHistoryDigest {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toSupervisorRecordDigest
    : record.supervisorRecordDigest;
}

function recordActiveArtifact(
  record: ControlPlaneSupervisorHistoryRecord,
): ControlPlaneSupervisorHistoryArtifactSelection {
  return record.activeArtifact;
}

function recordActiveTrustCommit(
  record: ControlPlaneSupervisorHistoryRecord,
): string {
  return record.activeTrustCommit;
}
