/**
 * Builds and validates digest-bound correction reservation, result, and import records.
 *
 * Invariants:
 * - Canonical bodies retain their byte order and original digest fields.
 * - Snapshot links and contiguous lineage checks preserve the exact failed candidate and patch head.
 */
import {
  readTaskStrategyGreenFailureRecord,
  parseTaskStrategyCorrectionPolicy,
} from './task-strategy-correction-store.ts';
import type {
  TaskStrategyPatchHead,
  TaskStrategyCorrectionPolicy,
  TaskStrategyGreenFailureRecord,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
import type { TaskStrategyPatchImplementer } from './task-strategy-patch-store.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertDigest,
  sha256,
  correctionRoundStateInvalid,
  isRecord,
  hasExactKeys,
  isDigest,
  isPositiveInteger,
  isGitObjectId,
  isCanonicalTimestamp,
  deepFreeze,
  correctionRoundSequenceInvalid,
} from './task-strategy-correction-round-values.ts';
import {
  parseReservationAuthority,
  parseResultAuthority,
  assertResultAuthorityMatchesReservation,
  resultAuthorityMatchesReservation,
} from './task-strategy-correction-round-authority.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';

export type TaskStrategyCorrectionFailureIdentity = Readonly<{
  recordDigest: string;
  subjectDigest: string;
  candidateTree: string;
  failureFingerprint: string;
  currentRedTransactionDigest: string;
  currentPatchHead: TaskStrategyPatchHead;
}>;

export type TaskStrategyCorrectionProviderRequestIdentity = Readonly<{
  ownerInvestigationId: string;
  invocationId: string;
  requestDigest: string;
}>;

export type TaskStrategyCorrectionProviderReservationIdentity = Readonly<{
  reservationDigest: string;
  authorizationNodeId: string;
  reservationNodeId: string;
}>;

export type TaskStrategyCorrectionProviderResultIdentity = Readonly<{
  bindingDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
}>;

export type TaskStrategyCorrectionProviderAttemptIdentity = Readonly<{
  attempt: number;
  attemptReservationDigest: string;
  invocationId: string;
  requestDigest: string;
}>;

export type TaskStrategyCorrectionCallerReservationIdentity = Readonly<{
  reservationDigest: string;
  grantId: string;
  transitionDigest: string;
  submissionNodeId: string;
  submissionResultDigest: string;
}>;

export type TaskStrategyCorrectionCallerResultIdentity = Readonly<{
  bindingDigest: string;
  resultNodeId: string;
  resultDigest: string;
  roleResultDigest: string;
  grantUseDigest: string;
}>;

/** The exact source-scoped transition from the failed candidate to this round. */
export type TaskStrategyCorrectionPatchResult = Readonly<{
  sourceTree: string;
  targetCandidateTree: string;
  patchRecordDigest: string;
  patchDigest: string;
}>;

export type TaskStrategyCorrectionReservationAuthority =
  | Readonly<{
      kind: 'provider';
      providerRequest: TaskStrategyCorrectionProviderRequestIdentity;
      providerReservation: TaskStrategyCorrectionProviderReservationIdentity;
    }>
  | Readonly<{
      kind: 'sealed-local';
      author: TaskStrategyPatchImplementer;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      callerReservation: TaskStrategyCorrectionCallerReservationIdentity;
    }>;

export type TaskStrategyCorrectionResultAuthority =
  | Readonly<{
      kind: 'provider';
      providerRequest: TaskStrategyCorrectionProviderRequestIdentity;
      providerReservation: TaskStrategyCorrectionProviderReservationIdentity;
      providerAttempt: TaskStrategyCorrectionProviderAttemptIdentity;
      providerResult: TaskStrategyCorrectionProviderResultIdentity;
    }>
  | Readonly<{
      kind: 'sealed-local';
      author: TaskStrategyPatchImplementer;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      callerReservation: TaskStrategyCorrectionCallerReservationIdentity;
      callerResult: TaskStrategyCorrectionCallerResultIdentity;
    }>;

export type TaskStrategyCorrectionImportReceiptIdentity = Readonly<{
  patchRecordDigest: string;
  patchDigest: string;
  receiptDigest: string;
  candidateTree: string;
}>;

export type TaskStrategyCorrectionRoundReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  round: number;
  policy: TaskStrategyCorrectionPolicy;
  policyDigest: string;
  predecessorFailure: TaskStrategyCorrectionFailureIdentity;
  correctionSubjectDigest: string;
  redSourceTree: string;
  authority: TaskStrategyCorrectionReservationAuthority;
  createdAt: string;
}>;

export type TaskStrategyCorrectionRoundResult = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-result.v1';
  resultDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  createdAt: string;
}>;

export type TaskStrategyCorrectionRoundImport = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-import.v1';
  importDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  importReceipt: TaskStrategyCorrectionImportReceiptIdentity;
  currentPatchHead: TaskStrategyPatchHead;
  importedAt: string;
}>;

export type TaskStrategyCorrectionRound = Readonly<{
  reservation: TaskStrategyCorrectionRoundReservation;
  result: TaskStrategyCorrectionRoundResult | null;
  importRecord: TaskStrategyCorrectionRoundImport | null;
}>;

export type TaskStrategyCorrectionState =
  | Readonly<{
      state: 'correction-required';
      round: number;
      nextAction: 'reserve';
    }>
  | Readonly<{
      state: 'correction-required';
      round: number;
      nextAction: 'publish-result' | 'publish-import-receipt';
      correctionSubjectDigest: string;
    }>
  | Readonly<{
      state: 'correction-exhausted';
      completedRounds: number;
      reason: 'max-repair-attempts' | 'same-failure-fingerprint';
      failureRecordDigest: string;
    }>;

export type ReserveTaskStrategyCorrectionRoundInput = Readonly<{
  sessionId: string;
  round: number;
  policy: TaskStrategyCorrectionPolicy;
  predecessorFailure: TaskStrategyGreenFailureRecord;
  /** Exact digest minted by createTaskStrategyCorrectionSubject. */
  correctionSubjectDigest: string;
  redSourceTree: string;
  authority: TaskStrategyCorrectionReservationAuthority;
  createdAt: string;
}>;

export type PublishTaskStrategyCorrectionRoundResultInput = Readonly<{
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  createdAt: string;
}>;

export type PublishTaskStrategyCorrectionRoundImportInput = Readonly<{
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  importReceipt: TaskStrategyCorrectionImportReceiptIdentity;
  currentPatchHead: TaskStrategyPatchHead;
  importedAt: string;
}>;

export function prepareReservation(
  input: ReserveTaskStrategyCorrectionRoundInput & {
    policy: TaskStrategyCorrectionPolicy;
    predecessorFailure: TaskStrategyGreenFailureRecord;
  },
): TaskStrategyCorrectionRoundReservation {
  const predecessorFailure = failureIdentity(input.predecessorFailure);
  const digestOfPolicy = policyDigest(input.policy);
  const correctionSubjectDigest = assertDigest(input.correctionSubjectDigest);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-reservation.v1' as const,
    sessionId: input.sessionId,
    round: input.round,
    policy: input.policy,
    policyDigest: digestOfPolicy,
    predecessorFailure,
    correctionSubjectDigest,
    redSourceTree: input.redSourceTree,
    authority: parseReservationAuthority(input.authority),
    createdAt: input.createdAt,
  };
  return parseReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
}

export function prepareResult(
  reservation: TaskStrategyCorrectionRoundReservation,
  input: PublishTaskStrategyCorrectionRoundResultInput,
): TaskStrategyCorrectionRoundResult {
  if (
    input.sessionId !== reservation.sessionId ||
    input.currentRedTransactionDigest !==
      reservation.predecessorFailure.currentRedTransactionDigest ||
    input.round !== reservation.round ||
    input.correctionSubjectDigest !== reservation.correctionSubjectDigest ||
    input.patchResult.sourceTree !==
      reservation.predecessorFailure.candidateTree ||
    input.patchResult.targetCandidateTree ===
      reservation.predecessorFailure.candidateTree
  ) {
    throw correctionRoundStateInvalid();
  }
  const authority = parseResultAuthority(input.authority);
  assertResultAuthorityMatchesReservation(authority, reservation.authority);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-result.v1' as const,
    sessionId: input.sessionId,
    currentRedTransactionDigest: input.currentRedTransactionDigest,
    round: input.round,
    correctionSubjectDigest: input.correctionSubjectDigest,
    authority,
    patchResult: input.patchResult,
    createdAt: input.createdAt,
  };
  return parseResult({
    ...body,
    resultDigest: sha256(canonicalJson(body)),
  });
}

export function prepareImport(
  reservation: TaskStrategyCorrectionRoundReservation,
  result: TaskStrategyCorrectionRoundResult,
  input: PublishTaskStrategyCorrectionRoundImportInput,
): TaskStrategyCorrectionRoundImport {
  if (
    input.sessionId !== reservation.sessionId ||
    input.currentRedTransactionDigest !==
      reservation.predecessorFailure.currentRedTransactionDigest ||
    input.round !== reservation.round ||
    input.correctionSubjectDigest !== reservation.correctionSubjectDigest ||
    canonicalJson(input.importReceipt) !==
      canonicalJson({
        patchRecordDigest: result.patchResult.patchRecordDigest,
        patchDigest: result.patchResult.patchDigest,
        receiptDigest: input.currentPatchHead.receiptDigest,
        candidateTree: result.patchResult.targetCandidateTree,
      }) ||
    input.currentPatchHead.recordDigest !==
      result.patchResult.patchRecordDigest ||
    input.currentPatchHead.patchDigest !== result.patchResult.patchDigest
  ) {
    throw correctionRoundStateInvalid();
  }
  const authority = parseResultAuthority(input.authority);
  if (canonicalJson(authority) !== canonicalJson(result.authority)) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-import.v1' as const,
    sessionId: input.sessionId,
    currentRedTransactionDigest: input.currentRedTransactionDigest,
    round: input.round,
    correctionSubjectDigest: input.correctionSubjectDigest,
    authority,
    patchResult: result.patchResult,
    importReceipt: input.importReceipt,
    currentPatchHead: input.currentPatchHead,
    importedAt: input.importedAt,
  };
  return parseImport({
    ...body,
    importDigest: sha256(canonicalJson(body)),
  });
}

export function parseReservation(
  value: unknown,
): TaskStrategyCorrectionRoundReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'sessionId',
      'round',
      'policy',
      'policyDigest',
      'predecessorFailure',
      'correctionSubjectDigest',
      'redSourceTree',
      'authority',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-correction-round-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isPositiveInteger(value.round) ||
    !isDigest(value.policyDigest) ||
    !isDigest(value.correctionSubjectDigest) ||
    !isGitObjectId(value.redSourceTree) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw correctionRoundStateInvalid();
  }
  const policy = parsePolicyForStore(value.policy);
  const predecessorFailure = parseFailureIdentity(value.predecessorFailure);
  const authority = parseReservationAuthority(value.authority);
  if (
    value.round > policy.maxRepairAttempts ||
    value.policyDigest !== policyDigest(policy) ||
    predecessorFailure.currentRedTransactionDigest.length !== 64
  ) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-reservation.v1' as const,
    sessionId: value.sessionId,
    round: value.round,
    policy,
    policyDigest: value.policyDigest,
    predecessorFailure,
    correctionSubjectDigest: value.correctionSubjectDigest,
    redSourceTree: value.redSourceTree,
    authority,
    createdAt: value.createdAt,
  };
  if (value.reservationDigest !== sha256(canonicalJson(body))) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({ ...body, reservationDigest: value.reservationDigest });
}

export function parseResult(value: unknown): TaskStrategyCorrectionRoundResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'resultDigest',
      'sessionId',
      'currentRedTransactionDigest',
      'round',
      'correctionSubjectDigest',
      'authority',
      'patchResult',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-correction-round-result.v1' ||
    !isDigest(value.resultDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isDigest(value.currentRedTransactionDigest) ||
    !isPositiveInteger(value.round) ||
    !isDigest(value.correctionSubjectDigest) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-result.v1' as const,
    sessionId: value.sessionId,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    round: value.round,
    correctionSubjectDigest: value.correctionSubjectDigest,
    authority: parseResultAuthority(value.authority),
    patchResult: parsePatchResult(value.patchResult),
    createdAt: value.createdAt,
  };
  if (value.resultDigest !== sha256(canonicalJson(body))) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({ ...body, resultDigest: value.resultDigest });
}

export function parseImport(value: unknown): TaskStrategyCorrectionRoundImport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'importDigest',
      'sessionId',
      'currentRedTransactionDigest',
      'round',
      'correctionSubjectDigest',
      'authority',
      'patchResult',
      'importReceipt',
      'currentPatchHead',
      'importedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-correction-round-import.v1' ||
    !isDigest(value.importDigest) ||
    typeof value.sessionId !== 'string' ||
    !/^session-[a-zA-Z0-9-]+$/u.test(value.sessionId) ||
    !isDigest(value.currentRedTransactionDigest) ||
    !isPositiveInteger(value.round) ||
    !isDigest(value.correctionSubjectDigest) ||
    !isCanonicalTimestamp(value.importedAt)
  ) {
    throw correctionRoundStateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-correction-round-import.v1' as const,
    sessionId: value.sessionId,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    round: value.round,
    correctionSubjectDigest: value.correctionSubjectDigest,
    authority: parseResultAuthority(value.authority),
    patchResult: parsePatchResult(value.patchResult),
    importReceipt: parseImportReceipt(value.importReceipt),
    currentPatchHead: parsePatchHead(value.currentPatchHead),
    importedAt: value.importedAt,
  };
  if (value.importDigest !== sha256(canonicalJson(body))) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({ ...body, importDigest: value.importDigest });
}

export function assertSnapshotLinks(
  snapshot: TaskStrategyCorrectionRound,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): void {
  const { reservation, result, importRecord } = snapshot;
  if (
    reservation.sessionId !== sessionId ||
    reservation.round !== round ||
    reservation.predecessorFailure.currentRedTransactionDigest !==
      redTransactionDigest
  ) {
    throw correctionRoundStateInvalid();
  }
  if (
    result !== null &&
    (result.sessionId !== sessionId ||
      result.currentRedTransactionDigest !== redTransactionDigest ||
      result.round !== round ||
      result.correctionSubjectDigest !== reservation.correctionSubjectDigest ||
      !resultAuthorityMatchesReservation(
        result.authority,
        reservation.authority,
      ) ||
      result.patchResult.sourceTree !==
        reservation.predecessorFailure.candidateTree ||
      result.patchResult.targetCandidateTree ===
        reservation.predecessorFailure.candidateTree)
  ) {
    throw correctionRoundStateInvalid();
  }
  if (importRecord !== null && result === null) {
    throw correctionRoundStateInvalid();
  }
  if (
    importRecord !== null &&
    result !== null &&
    (importRecord.sessionId !== sessionId ||
      importRecord.currentRedTransactionDigest !== redTransactionDigest ||
      importRecord.round !== round ||
      importRecord.correctionSubjectDigest !==
        reservation.correctionSubjectDigest ||
      canonicalJson(importRecord.authority) !==
        canonicalJson(result.authority) ||
      canonicalJson(importRecord.patchResult) !==
        canonicalJson(result.patchResult) ||
      importRecord.importReceipt.patchRecordDigest !==
        result.patchResult.patchRecordDigest ||
      importRecord.importReceipt.patchDigest !==
        result.patchResult.patchDigest ||
      importRecord.importReceipt.candidateTree !==
        result.patchResult.targetCandidateTree ||
      importRecord.currentPatchHead.recordDigest !==
        result.patchResult.patchRecordDigest ||
      importRecord.currentPatchHead.patchDigest !==
        result.patchResult.patchDigest ||
      importRecord.currentPatchHead.receiptDigest !==
        importRecord.importReceipt.receiptDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
}

export function assertContiguousRoundLineage(
  rounds: readonly TaskStrategyCorrectionRound[],
): void {
  for (let index = 0; index < rounds.length; index += 1) {
    const current = rounds[index]!;
    if (current.reservation.round !== index + 1) {
      throw correctionRoundStateInvalid();
    }
    if (index === 0) continue;
    const previous = rounds[index - 1]!;
    if (
      previous.importRecord === null ||
      current.reservation.policyDigest !==
        rounds[0]!.reservation.policyDigest ||
      current.reservation.redSourceTree !==
        rounds[0]!.reservation.redSourceTree ||
      current.reservation.predecessorFailure.candidateTree !==
        previous.importRecord.patchResult.targetCandidateTree ||
      canonicalJson(current.reservation.predecessorFailure.currentPatchHead) !==
        canonicalJson(previous.importRecord.currentPatchHead)
    ) {
      throw correctionRoundStateInvalid();
    }
  }
}

export function assertRoundCanFollow(
  rounds: readonly TaskStrategyCorrectionRound[],
  prepared: TaskStrategyCorrectionRoundReservation,
): void {
  if (rounds.length === 0) return;
  const first = rounds[0]!.reservation;
  const previous = rounds.at(-1)!;
  if (
    previous.importRecord === null ||
    prepared.policyDigest !== first.policyDigest ||
    prepared.redSourceTree !== first.redSourceTree ||
    prepared.predecessorFailure.candidateTree !==
      previous.importRecord.patchResult.targetCandidateTree ||
    canonicalJson(prepared.predecessorFailure.currentPatchHead) !==
      canonicalJson(previous.importRecord.currentPatchHead)
  ) {
    throw correctionRoundSequenceInvalid();
  }
}

export function assertStoredFailure(
  paths: InvestigationRuntimePaths,
  failure: TaskStrategyGreenFailureRecord,
): void {
  const stored = readTaskStrategyGreenFailureRecord(
    paths,
    failure.sessionId,
    failure.candidateTree,
  );
  if (stored === null || stored.recordDigest !== failure.recordDigest) {
    throw correctionRoundStateInvalid();
  }
}

function failureIdentity(
  failure: TaskStrategyGreenFailureRecord,
): TaskStrategyCorrectionFailureIdentity {
  return deepFreeze({
    recordDigest: failure.recordDigest,
    subjectDigest: failure.subjectDigest,
    candidateTree: failure.candidateTree,
    failureFingerprint: failure.failingCheck.failureFingerprint,
    currentRedTransactionDigest: failure.currentRedTransactionDigest,
    currentPatchHead: failure.currentPatchHead,
  });
}

export function failureIdentityMatches(
  identity: TaskStrategyCorrectionFailureIdentity,
  failure: TaskStrategyGreenFailureRecord,
): boolean {
  return canonicalJson(identity) === canonicalJson(failureIdentity(failure));
}

function parseFailureIdentity(
  value: unknown,
): TaskStrategyCorrectionFailureIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'recordDigest',
      'subjectDigest',
      'candidateTree',
      'failureFingerprint',
      'currentRedTransactionDigest',
      'currentPatchHead',
    ]) ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.subjectDigest) ||
    !isGitObjectId(value.candidateTree) ||
    !isDigest(value.failureFingerprint) ||
    !isDigest(value.currentRedTransactionDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    recordDigest: value.recordDigest,
    subjectDigest: value.subjectDigest,
    candidateTree: value.candidateTree,
    failureFingerprint: value.failureFingerprint,
    currentRedTransactionDigest: value.currentRedTransactionDigest,
    currentPatchHead: parsePatchHead(value.currentPatchHead),
  });
}

function parsePatchResult(value: unknown): TaskStrategyCorrectionPatchResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceTree',
      'targetCandidateTree',
      'patchRecordDigest',
      'patchDigest',
    ]) ||
    !isGitObjectId(value.sourceTree) ||
    !isGitObjectId(value.targetCandidateTree) ||
    value.sourceTree === value.targetCandidateTree ||
    !isDigest(value.patchRecordDigest) ||
    !isDigest(value.patchDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    sourceTree: value.sourceTree,
    targetCandidateTree: value.targetCandidateTree,
    patchRecordDigest: value.patchRecordDigest,
    patchDigest: value.patchDigest,
  });
}

function parseImportReceipt(
  value: unknown,
): TaskStrategyCorrectionImportReceiptIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'patchRecordDigest',
      'patchDigest',
      'receiptDigest',
      'candidateTree',
    ]) ||
    !isDigest(value.patchRecordDigest) ||
    !isDigest(value.patchDigest) ||
    !isDigest(value.receiptDigest) ||
    !isGitObjectId(value.candidateTree)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    patchRecordDigest: value.patchRecordDigest,
    patchDigest: value.patchDigest,
    receiptDigest: value.receiptDigest,
    candidateTree: value.candidateTree,
  });
}

function parsePatchHead(value: unknown): TaskStrategyPatchHead {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bindingDigest',
      'recordDigest',
      'patchDigest',
      'receiptDigest',
    ]) ||
    !isDigest(value.bindingDigest) ||
    !isDigest(value.recordDigest) ||
    !isDigest(value.patchDigest) ||
    !isDigest(value.receiptDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    bindingDigest: value.bindingDigest,
    recordDigest: value.recordDigest,
    patchDigest: value.patchDigest,
    receiptDigest: value.receiptDigest,
  });
}

function parsePolicyForStore(value: unknown): TaskStrategyCorrectionPolicy {
  try {
    return parseTaskStrategyCorrectionPolicy(value);
  } catch {
    throw correctionRoundStateInvalid();
  }
}

export function policyDigest(policy: TaskStrategyCorrectionPolicy): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'task-strategy-correction-policy.v1',
      policy,
    }),
  );
}
