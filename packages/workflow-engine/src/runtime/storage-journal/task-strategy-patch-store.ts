/** Persists source-scoped patch authority with exact publication and stored-record checks. */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import type {
  TaskStrategyPatchRecord,
  TaskStrategyPatchImportReceipt,
  TaskStrategyPatchReservation,
  TaskStrategyPatchCurrentBinding,
} from '../../modules/assurance/task-strategy-evidence.ts';
export type {
  TaskStrategyPatchEntry,
  TaskStrategyPatchChange,
  TaskStrategyPatchImplementer,
  TaskStrategyPatchRecord,
  TaskStrategyPatchImportReceipt,
  TaskStrategyPatchReservation,
  TaskStrategyPatchCurrentBinding,
} from '../../modules/assurance/task-strategy-evidence.ts';
import {
  prepareTaskStrategyPatchRecord,
  parsePatchRecord,
  parseImportReceipt,
  parseCurrentBinding,
  parseReservation,
  assertObjectId,
  assertDigest,
  sha256,
  stateCorrupt,
} from '../../modules/assurance/task-strategy-patch-record.ts';
export { prepareTaskStrategyPatchRecord } from '../../modules/assurance/task-strategy-patch-record.ts';
export function createTaskStrategyPatchRecord(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchRecord,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): TaskStrategyPatchRecord {
  return persistTaskStrategyPatchRecord(
    paths,
    prepareTaskStrategyPatchRecord(input),
  );
}

export function persistTaskStrategyPatchRecord(
  paths: InvestigationRuntimePaths,
  value: TaskStrategyPatchRecord,
): TaskStrategyPatchRecord {
  const record = parsePatchRecord(value);
  const target = sourcePatchRecordPath(
    paths,
    record.sessionId,
    record.sourceTree,
    record.patchDigest,
  );
  createPrivateCanonicalJson(
    paths,
    target,
    record,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_RECORD_CONFLICT',
  );
  return readTaskStrategyPatchRecord(
    paths,
    record.sessionId,
    record.patchDigest,
    record.sourceTree,
  )!;
}

export function readTaskStrategyPatchRecord(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedPatchDigest: string,
  expectedSourceTree: string,
): TaskStrategyPatchRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const patchDigest = assertDigest(requestedPatchDigest);
  const sourceTree = assertObjectId(expectedSourceTree);
  const scoped = readPatchRecordAt(
    paths,
    sourcePatchRecordPath(paths, sessionId, sourceTree, patchDigest),
  );
  if (
    scoped !== null &&
    (scoped.sessionId !== sessionId ||
      scoped.patchDigest !== patchDigest ||
      scoped.sourceTree !== sourceTree)
  ) {
    throw stateCorrupt();
  }
  return scoped;
}

export function createTaskStrategyPatchImportReceipt(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchImportReceipt,
    'schemaVersion' | 'kind' | 'receiptDigest'
  >,
  expectedSourceTree: string,
): TaskStrategyPatchImportReceipt {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-import-receipt.v1' as const,
    ...input,
  };
  const receipt = parseImportReceipt({
    ...body,
    receiptDigest: sha256(canonicalJson(body)),
  });
  const sourceTree = assertObjectId(expectedSourceTree);
  const record = readTaskStrategyPatchRecord(
    paths,
    receipt.sessionId,
    receipt.patchDigest,
    sourceTree,
  );
  if (
    record === null ||
    record.recordDigest !== receipt.recordDigest ||
    record.candidateTree !== receipt.candidateTree
  ) {
    throw stateCorrupt();
  }
  const target = sourcePatchReceiptPath(
    paths,
    receipt.sessionId,
    sourceTree,
    receipt.patchDigest,
  );
  createPrivateCanonicalJson(
    paths,
    target,
    receipt,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_RECEIPT_CONFLICT',
  );
  return readTaskStrategyPatchImportReceipt(
    paths,
    receipt.sessionId,
    receipt.patchDigest,
    sourceTree,
  )!;
}

export function readTaskStrategyPatchImportReceipt(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedPatchDigest: string,
  expectedSourceTree: string,
): TaskStrategyPatchImportReceipt | null {
  const sessionId = assertSessionId(requestedSessionId);
  const patchDigest = assertDigest(requestedPatchDigest);
  const sourceTree = assertObjectId(expectedSourceTree);
  const scoped = readPatchReceiptAt(
    paths,
    sourcePatchReceiptPath(paths, sessionId, sourceTree, patchDigest),
  );
  if (
    scoped !== null &&
    (scoped.sessionId !== sessionId ||
      scoped.patchDigest !== patchDigest ||
      receiptSourceTree(paths, scoped, sourceTree) !== sourceTree)
  ) {
    throw stateCorrupt();
  }
  return scoped;
}

export function createTaskStrategyPatchReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchReservation,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskStrategyPatchReservation {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-reservation.v1' as const,
    ...input,
  };
  const reservation = parseReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  const target = sourceReservationPath(
    paths,
    reservation.sessionId,
    reservation.sourceTree,
  );
  createPrivateCanonicalJson(
    paths,
    target,
    reservation,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_RESERVATION_CONFLICT',
  );
  const stored = readReservationAt(paths, target);
  if (
    stored === null ||
    stored.sessionId !== reservation.sessionId ||
    stored.sourceTree !== reservation.sourceTree
  ) {
    throw stateCorrupt();
  }
  return stored;
}

export function readTaskStrategyPatchReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSourceTree: string,
): TaskStrategyPatchReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  const sourceTree = assertObjectId(expectedSourceTree);
  const scoped = readReservationAt(
    paths,
    sourceReservationPath(paths, sessionId, sourceTree),
  );
  if (
    scoped !== null &&
    (scoped.sessionId !== sessionId || scoped.sourceTree !== sourceTree)
  ) {
    throw stateCorrupt();
  }
  return scoped;
}

export function createTaskStrategyPatchCurrentBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyPatchCurrentBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
  expectedSourceTree: string,
): TaskStrategyPatchCurrentBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-current.v1' as const,
    ...input,
  };
  const binding = parseCurrentBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  const boundSourceTree = assertObjectId(expectedSourceTree);
  if (
    currentBindingSourceTree(paths, binding, boundSourceTree) !==
    boundSourceTree
  ) {
    throw stateCorrupt();
  }
  const target = sourceCurrentBindingPath(
    paths,
    binding.sessionId,
    boundSourceTree,
  );
  createPrivateCanonicalJson(
    paths,
    target,
    binding,
    stateCorrupt,
    'TASK_STRATEGY_PATCH_CURRENT_CONFLICT',
  );
  const stored = readCurrentBindingAt(paths, target);
  if (stored === null || stored.sessionId !== binding.sessionId) {
    throw stateCorrupt();
  }
  if (
    currentBindingSourceTree(paths, stored, boundSourceTree) !== boundSourceTree
  ) {
    throw stateCorrupt();
  }
  return stored;
}

export function readTaskStrategyPatchCurrentBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSourceTree: string,
): TaskStrategyPatchCurrentBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const sourceTree = assertObjectId(expectedSourceTree);
  const scoped = readCurrentBindingAt(
    paths,
    sourceCurrentBindingPath(paths, sessionId, sourceTree),
  );
  if (
    scoped !== null &&
    (scoped.sessionId !== sessionId ||
      currentBindingSourceTree(paths, scoped, sourceTree) !== sourceTree)
  ) {
    throw stateCorrupt();
  }
  return scoped;
}

function sourcePatchRecordPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  sourceTree: string,
  patchDigest: string,
): string {
  return sourceScopedPath(
    paths,
    sessionId,
    sourceTree,
    `${assertDigest(patchDigest)}.json`,
  );
}

function sourcePatchReceiptPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  sourceTree: string,
  patchDigest: string,
): string {
  return sourceScopedPath(
    paths,
    sessionId,
    sourceTree,
    `${assertDigest(patchDigest)}.imported.json`,
  );
}

function sourceReservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  sourceTree: string,
): string {
  return sourceScopedPath(paths, sessionId, sourceTree, 'reservation.json');
}

function sourceCurrentBindingPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  sourceTree: string,
): string {
  return sourceScopedPath(paths, sessionId, sourceTree, 'current.json');
}

function sourceScopedPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  sourceTree: string,
  filename: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-patches',
    sessionId,
    'sources',
    assertObjectId(sourceTree),
    filename,
  );
}

function readReservationAt(
  paths: InvestigationRuntimePaths,
  target: string,
): TaskStrategyPatchReservation | null {
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  return parseReservation(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
}

function readPatchRecordAt(
  paths: InvestigationRuntimePaths,
  target: string,
): TaskStrategyPatchRecord | null {
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  return parsePatchRecord(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
}

function readPatchReceiptAt(
  paths: InvestigationRuntimePaths,
  target: string,
): TaskStrategyPatchImportReceipt | null {
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  return parseImportReceipt(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
}

function receiptSourceTree(
  paths: InvestigationRuntimePaths,
  receipt: TaskStrategyPatchImportReceipt,
  expectedSourceTree: string,
): string {
  const record = readTaskStrategyPatchRecord(
    paths,
    receipt.sessionId,
    receipt.patchDigest,
    expectedSourceTree,
  );
  if (
    record === null ||
    record.recordDigest !== receipt.recordDigest ||
    record.candidateTree !== receipt.candidateTree
  ) {
    throw stateCorrupt();
  }
  return record.sourceTree;
}

function readCurrentBindingAt(
  paths: InvestigationRuntimePaths,
  target: string,
): TaskStrategyPatchCurrentBinding | null {
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  return parseCurrentBinding(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
}

function currentBindingSourceTree(
  paths: InvestigationRuntimePaths,
  binding: TaskStrategyPatchCurrentBinding,
  expectedSourceTree: string,
): string {
  const record = readTaskStrategyPatchRecord(
    paths,
    binding.sessionId,
    binding.patchDigest,
    expectedSourceTree,
  );
  if (
    record === null ||
    record.recordDigest !== binding.recordDigest ||
    record.candidateTree !== binding.candidateTree
  ) {
    throw stateCorrupt();
  }
  return record.sourceTree;
}
export type {
  CurrentTaskStrategyPatchHead,
  TaskStrategyCorrectionProjection,
} from '../../modules/assurance/task-strategy-correction-round-record.ts';
