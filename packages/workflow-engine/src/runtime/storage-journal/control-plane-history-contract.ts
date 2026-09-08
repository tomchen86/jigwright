/**
 * Defines and validates supervisor history anchors, transitions, and terminal records.
 *
 * Invariants:
 * - Each record retains exact keys, artifact and authority shapes, and self-digest validation.
 * - Record construction and verification preserve the current canonical identities.
 *
 * Depends on: history value checks and canonical JSON.
 * Failure modes: malformed or tampered history records are treated as valid supervisor evidence.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertDigest,
  assertGitOid,
  assertIso,
  assertNonEmpty,
  deepFreeze,
  hasExactKeys,
  isPositiveSafeInteger,
  isRecord,
  recordInvalid,
} from './control-plane-history-values.ts';

export type ControlPlaneSupervisorHistoryDigest = `sha256:${string}`;

export interface ControlPlaneSupervisorHistoryArtifactSelection {
  artifactId: ControlPlaneSupervisorHistoryDigest;
  executableDigest: ControlPlaneSupervisorHistoryDigest;
  closureDigest: ControlPlaneSupervisorHistoryDigest;
}

export interface ControlPlaneSupervisorHistoryAnchorAuthority {
  kind: 'initial-bootstrap-anchor.v1';
  initialBootstrapPublishedDigest: ControlPlaneSupervisorHistoryDigest;
}

export interface ControlPlaneSupervisorHistoryAnchor {
  kind: 'control-plane-supervisor-history-anchor.v1';
  sequence: 0;
  previousRecordDigest: null;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  authority: ControlPlaneSupervisorHistoryAnchorAuthority;
  recordedAt: string;
  recordDigest: ControlPlaneSupervisorHistoryDigest;
}

export interface ControlPlaneSupervisorHistoryTransition {
  kind: 'control-plane-supervisor-history-transition.v1';
  sequence: number;
  previousRecordDigest: ControlPlaneSupervisorHistoryDigest;
  repositoryId: string;
  phase: 'candidate-selected' | 'rollback-restored';
  fromGeneration: number;
  toGeneration: number;
  fromSupervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
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
  recordDigest: ControlPlaneSupervisorHistoryDigest;
}

export interface ControlPlaneSupervisorHistoryTerminal {
  kind: 'control-plane-supervisor-history-terminal.v1';
  sequence: number;
  previousRecordDigest: ControlPlaneSupervisorHistoryDigest;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  terminalState: 'FINALIZED' | 'ROLLED_BACK';
  grantId: string;
  txId: string;
  updateRecordDigest: ControlPlaneSupervisorHistoryDigest;
  transactionJournalDigest: ControlPlaneSupervisorHistoryDigest;
  grantEnvelopeDigest: ControlPlaneSupervisorHistoryDigest;
  promotionBundleDigest: ControlPlaneSupervisorHistoryDigest;
  recordedAt: string;
  recordDigest: ControlPlaneSupervisorHistoryDigest;
}

export type ControlPlaneSupervisorHistoryRecord =
  | ControlPlaneSupervisorHistoryAnchor
  | ControlPlaneSupervisorHistoryTransition
  | ControlPlaneSupervisorHistoryTerminal;

export interface VerifiedControlPlaneSupervisorHistoryProgress {
  records: ControlPlaneSupervisorHistoryRecord[];
  anchor: ControlPlaneSupervisorHistoryAnchor;
  leaf: ControlPlaneSupervisorHistoryRecord;
  generation: number;
  supervisorRecordDigest: ControlPlaneSupervisorHistoryDigest;
  activeArtifact: ControlPlaneSupervisorHistoryArtifactSelection;
  activeTrustCommit: string;
  terminal: boolean;
}

export interface VerifiedControlPlaneSupervisorHistory extends VerifiedControlPlaneSupervisorHistoryProgress {
  leaf:
    ControlPlaneSupervisorHistoryAnchor | ControlPlaneSupervisorHistoryTerminal;
  terminal: true;
}

export interface ControlPlaneSupervisorHistoryAppendHooks {
  /** Test-only hard-crash seam; production callers omit it. */
  testAfterDurablePhase?: (phase: 'PREPARED' | 'HARD_LINKED') => void;
}

export interface ControlPlaneSupervisorHistoryAppendResult {
  replayed: boolean;
  history: VerifiedControlPlaneSupervisorHistoryProgress;
}

export type HistoryPredecessor = ControlPlaneSupervisorHistoryRecord;

export function controlPlaneSupervisorHistoryRecordDigest(
  payload: unknown,
): ControlPlaneSupervisorHistoryDigest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex')}`;
}

export function verifyControlPlaneSupervisorHistoryRecord(
  value: unknown,
): ControlPlaneSupervisorHistoryRecord {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw recordInvalid('Supervisor history record is not an object.');
  }
  switch (value.kind) {
    case 'control-plane-supervisor-history-anchor.v1':
      return verifyAnchor(value);
    case 'control-plane-supervisor-history-transition.v1':
      return verifyTransition(value);
    case 'control-plane-supervisor-history-terminal.v1':
      return verifyTerminal(value);
    default:
      throw recordInvalid('Unknown supervisor history record kind.');
  }
}

function verifyAnchor(
  value: Record<string, unknown>,
): ControlPlaneSupervisorHistoryAnchor {
  if (
    !hasExactKeys(value, [
      'activeArtifact',
      'activeTrustCommit',
      'authority',
      'generation',
      'kind',
      'previousRecordDigest',
      'recordDigest',
      'recordedAt',
      'repositoryId',
      'sequence',
      'supervisorRecordDigest',
    ]) ||
    value.sequence !== 0 ||
    value.previousRecordDigest !== null ||
    !isPositiveSafeInteger(value.generation)
  ) {
    throw recordInvalid('Supervisor history anchor schema is invalid.');
  }
  assertNonEmpty(value.repositoryId);
  assertDigest(value.supervisorRecordDigest);
  const activeArtifact = verifyArtifactSelection(value.activeArtifact);
  assertGitOid(value.activeTrustCommit);
  const authority = verifyAnchorAuthority(value.authority);
  assertIso(value.recordedAt);
  verifySelfDigest(value);
  return deepFreeze({
    ...(structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryAnchor),
    activeArtifact,
    authority,
  });
}

function verifyTransition(
  value: Record<string, unknown>,
): ControlPlaneSupervisorHistoryTransition {
  if (
    !hasExactKeys(value, [
      'activeArtifact',
      'activeTrustCommit',
      'fromGeneration',
      'fromSupervisorRecordDigest',
      'grantEnvelopeDigest',
      'grantId',
      'kind',
      'phase',
      'previousRecordDigest',
      'promotionBundleDigest',
      'promotionLineageDigest',
      'recordDigest',
      'recordedAt',
      'repositoryId',
      'sequence',
      'sourceJournalDigest',
      'sourceTransactionState',
      'toGeneration',
      'toSupervisorRecordDigest',
      'txId',
    ]) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isPositiveSafeInteger(value.fromGeneration) ||
    !isPositiveSafeInteger(value.toGeneration) ||
    value.toGeneration !== Number(value.fromGeneration) + 1 ||
    (value.phase !== 'candidate-selected' &&
      value.phase !== 'rollback-restored') ||
    (value.sourceTransactionState !== 'RECOVERY_VERIFIED' &&
      value.sourceTransactionState !== 'ROLLBACK_REQUIRED')
  ) {
    throw recordInvalid('Supervisor history transition schema is invalid.');
  }
  for (const field of [value.repositoryId, value.grantId, value.txId]) {
    assertNonEmpty(field);
  }
  for (const field of [
    value.previousRecordDigest,
    value.fromSupervisorRecordDigest,
    value.toSupervisorRecordDigest,
    value.grantEnvelopeDigest,
    value.promotionBundleDigest,
    value.promotionLineageDigest,
    value.sourceJournalDigest,
  ]) {
    assertDigest(field);
  }
  const activeArtifact = verifyArtifactSelection(value.activeArtifact);
  assertGitOid(value.activeTrustCommit);
  assertIso(value.recordedAt);
  verifySelfDigest(value);
  return deepFreeze({
    ...(structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryTransition),
    activeArtifact,
  });
}

function verifyTerminal(
  value: Record<string, unknown>,
): ControlPlaneSupervisorHistoryTerminal {
  if (
    !hasExactKeys(value, [
      'activeArtifact',
      'activeTrustCommit',
      'generation',
      'grantEnvelopeDigest',
      'grantId',
      'kind',
      'previousRecordDigest',
      'promotionBundleDigest',
      'recordDigest',
      'recordedAt',
      'repositoryId',
      'sequence',
      'supervisorRecordDigest',
      'terminalState',
      'transactionJournalDigest',
      'txId',
      'updateRecordDigest',
    ]) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isPositiveSafeInteger(value.generation) ||
    (value.terminalState !== 'FINALIZED' &&
      value.terminalState !== 'ROLLED_BACK')
  ) {
    throw recordInvalid('Supervisor history terminal schema is invalid.');
  }
  for (const field of [value.repositoryId, value.grantId, value.txId]) {
    assertNonEmpty(field);
  }
  for (const field of [
    value.previousRecordDigest,
    value.supervisorRecordDigest,
    value.updateRecordDigest,
    value.transactionJournalDigest,
    value.grantEnvelopeDigest,
    value.promotionBundleDigest,
  ]) {
    assertDigest(field);
  }
  const activeArtifact = verifyArtifactSelection(value.activeArtifact);
  assertGitOid(value.activeTrustCommit);
  assertIso(value.recordedAt);
  verifySelfDigest(value);
  return deepFreeze({
    ...(structuredClone(
      value,
    ) as unknown as ControlPlaneSupervisorHistoryTerminal),
    activeArtifact,
  });
}

function verifyArtifactSelection(
  value: unknown,
): ControlPlaneSupervisorHistoryArtifactSelection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['artifactId', 'closureDigest', 'executableDigest'])
  ) {
    throw recordInvalid('Supervisor history artifact selection is invalid.');
  }
  assertDigest(value.artifactId);
  assertDigest(value.executableDigest);
  assertDigest(value.closureDigest);
  return deepFreeze({
    artifactId: value.artifactId,
    executableDigest: value.executableDigest,
    closureDigest: value.closureDigest,
  });
}

function verifyAnchorAuthority(
  value: unknown,
): ControlPlaneSupervisorHistoryAnchorAuthority {
  if (!isRecord(value)) {
    throw recordInvalid('Supervisor history anchor authority is invalid.');
  }
  if (
    value.kind !== 'initial-bootstrap-anchor.v1' ||
    !hasExactKeys(value, ['initialBootstrapPublishedDigest', 'kind'])
  ) {
    throw recordInvalid('Initial supervisor history authority is invalid.');
  }
  assertDigest(value.initialBootstrapPublishedDigest);
  return deepFreeze({
    kind: value.kind,
    initialBootstrapPublishedDigest: value.initialBootstrapPublishedDigest,
  });
}

function verifySelfDigest(value: Record<string, unknown>): void {
  assertDigest(value.recordDigest);
  const { recordDigest, ...payload } = value;
  if (recordDigest !== controlPlaneSupervisorHistoryRecordDigest(payload)) {
    throw recordInvalid(
      'Supervisor history self-digest does not match its canonical bytes.',
    );
  }
}
