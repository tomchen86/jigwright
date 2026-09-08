/**
 * Appends and reads durable supervisor history with recoverable prepared-record publication.
 *
 * Invariants:
 * - Append relation and inventory are checked before prepared bytes become final history.
 * - Crash recovery preserves the exact link, unlink, and directory fsync sequence.
 *
 * Depends on: history contracts, chain verification, and private history file readers.
 * Failure modes: supervisor recovery accepts forked history or exposes a partial append as committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { verifyControlPlaneSupervisorHistoryProgress } from './control-plane-history-chain.ts';
import {
  type ControlPlaneSupervisorHistoryAppendHooks,
  type ControlPlaneSupervisorHistoryAppendResult,
  type ControlPlaneSupervisorHistoryRecord,
  type VerifiedControlPlaneSupervisorHistory,
  type VerifiedControlPlaneSupervisorHistoryProgress,
  verifyControlPlaneSupervisorHistoryRecord,
} from './control-plane-history-contract.ts';
import {
  assertPrivateDirectory,
  assertPrivateRecordBytes,
  assertStorageRoot,
  controlPlaneSupervisorHistoryDirectory,
  controlPlaneSupervisorHistoryPendingPath,
  controlPlaneSupervisorHistoryRecordPath,
  ensureHistoryDirectory,
  fsyncDirectory,
  readPrivateRecordText,
} from './control-plane-history-files.ts';
import {
  deepFreeze,
  historyFork,
  historyGap,
  isNodeError,
  PRIVATE_FILE_MODE,
  RECORD_FILE,
  recordInvalid,
  storageUnsafe,
} from './control-plane-history-values.ts';

export {
  createControlPlaneSupervisorHistoryAnchor,
  createControlPlaneSupervisorHistoryTerminal,
  createControlPlaneSupervisorHistoryTransition,
  verifyControlPlaneSupervisorHistory,
  verifyControlPlaneSupervisorHistoryProgress,
} from './control-plane-history-chain.ts';
export {
  controlPlaneSupervisorHistoryRecordDigest,
  verifyControlPlaneSupervisorHistoryRecord,
} from './control-plane-history-contract.ts';
export type {
  ControlPlaneSupervisorHistoryAnchor,
  ControlPlaneSupervisorHistoryAnchorAuthority,
  ControlPlaneSupervisorHistoryAppendHooks,
  ControlPlaneSupervisorHistoryAppendResult,
  ControlPlaneSupervisorHistoryArtifactSelection,
  ControlPlaneSupervisorHistoryDigest,
  ControlPlaneSupervisorHistoryRecord,
  ControlPlaneSupervisorHistoryTerminal,
  ControlPlaneSupervisorHistoryTransition,
  VerifiedControlPlaneSupervisorHistory,
  VerifiedControlPlaneSupervisorHistoryProgress,
} from './control-plane-history-contract.ts';
export {
  controlPlaneSupervisorHistoryDirectory,
  controlPlaneSupervisorHistoryPendingPath,
  controlPlaneSupervisorHistoryRecordPath,
} from './control-plane-history-files.ts';

export function readControlPlaneSupervisorHistoryProgress(
  storageRoot: string,
): VerifiedControlPlaneSupervisorHistoryProgress {
  const root = assertStorageRoot(storageRoot);
  const directory = controlPlaneSupervisorHistoryDirectory(root);
  assertPrivateDirectory(directory);
  return verifyControlPlaneSupervisorHistoryProgress(
    readHistoryRecords(directory),
  );
}

export function readControlPlaneSupervisorHistory(
  storageRoot: string,
): VerifiedControlPlaneSupervisorHistory {
  const progress = readControlPlaneSupervisorHistoryProgress(storageRoot);
  if (!progress.terminal) {
    throw workflowError(
      'CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL',
      'Supervisor history leaf is an incomplete transition.',
      ExitCode.conflict,
    );
  }
  return progress as VerifiedControlPlaneSupervisorHistory;
}

export function appendControlPlaneSupervisorHistoryRecord(
  storageRoot: string,
  recordValue: ControlPlaneSupervisorHistoryRecord,
  hooks: ControlPlaneSupervisorHistoryAppendHooks = {},
): ControlPlaneSupervisorHistoryAppendResult {
  const record = verifyControlPlaneSupervisorHistoryRecord(recordValue);
  const root = assertStorageRoot(storageRoot);
  const directory = ensureHistoryDirectory(root);
  const target = controlPlaneSupervisorHistoryRecordPath(
    root,
    record.recordDigest,
  );
  const pending = controlPlaneSupervisorHistoryPendingPath(
    root,
    record.recordDigest,
  );
  assertAppendInventory(directory, path.basename(pending));
  const content = `${canonicalJson(record)}\n`;
  const targetBefore = fs.lstatSync(target, { throwIfNoEntry: false });
  const pendingBefore = fs.lstatSync(pending, { throwIfNoEntry: false });
  const replayed = targetBefore !== undefined || pendingBefore !== undefined;

  if (targetBefore === undefined && pendingBefore === undefined) {
    const existing = readHistoryRecords(directory);
    verifyAppendRelation(existing, record);
    createPreparedRecord(pending, content);
    fsyncDirectory(directory);
    hooks.testAfterDurablePhase?.('PREPARED');
  } else if (targetBefore === undefined) {
    const existing = readHistoryRecords(directory, path.basename(pending));
    verifyAppendRelation(existing, record);
  } else if (pendingBefore !== undefined) {
    const existing = readHistoryRecords(
      directory,
      path.basename(pending),
      path.basename(target),
    );
    verifyAppendRelation(existing, record);
  }

  reconcilePreparedRecord(directory, pending, target, content, hooks);
  const history = verifyControlPlaneSupervisorHistoryProgress(
    readHistoryRecords(directory),
  );
  if (
    !history.records.some(
      ({ recordDigest }) => recordDigest === record.recordDigest,
    )
  ) {
    throw storageUnsafe(
      'Published history record is absent after reconciliation.',
    );
  }
  return deepFreeze({ replayed, history });
}

function verifyAppendRelation(
  existing: readonly ControlPlaneSupervisorHistoryRecord[],
  record: ControlPlaneSupervisorHistoryRecord,
): void {
  if (existing.length === 0) {
    if (record.kind !== 'control-plane-supervisor-history-anchor.v1') {
      throw historyGap(
        'The first supervisor history record must be an anchor.',
      );
    }
    verifyControlPlaneSupervisorHistoryProgress([record]);
    return;
  }
  const current = verifyControlPlaneSupervisorHistoryProgress(existing);
  if (
    record.sequence !== current.leaf.sequence + 1 ||
    record.previousRecordDigest !== current.leaf.recordDigest
  ) {
    throw historyFork('Append does not extend the unique history leaf.');
  }
  verifyControlPlaneSupervisorHistoryProgress([...current.records, record]);
}

function reconcilePreparedRecord(
  directory: string,
  pending: string,
  target: string,
  content: string,
  hooks: ControlPlaneSupervisorHistoryAppendHooks,
): void {
  let pendingStats = fs.lstatSync(pending, { throwIfNoEntry: false });
  let targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (pendingStats === undefined && targetStats === undefined) {
    throw storageUnsafe('Prepared history record disappeared before publish.');
  }
  if (pendingStats !== undefined && targetStats === undefined) {
    assertPrivateRecordBytes(pending, content, 1);
    try {
      fs.linkSync(pending, target);
      fsyncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
    pendingStats = fs.lstatSync(pending, { throwIfNoEntry: false });
    targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
    assertPreparedLinkPair(pending, target, content, pendingStats, targetStats);
    hooks.testAfterDurablePhase?.('HARD_LINKED');
  }
  if (pendingStats !== undefined && targetStats !== undefined) {
    assertPreparedLinkPair(pending, target, content, pendingStats, targetStats);
    fs.unlinkSync(pending);
    fsyncDirectory(directory);
  }
  assertPrivateRecordBytes(target, content, 1);
}

function assertPreparedLinkPair(
  pending: string,
  target: string,
  content: string,
  pendingStats = fs.lstatSync(pending, { throwIfNoEntry: false }),
  targetStats = fs.lstatSync(target, { throwIfNoEntry: false }),
): void {
  if (
    pendingStats === undefined ||
    targetStats === undefined ||
    !pendingStats.isFile() ||
    pendingStats.isSymbolicLink() ||
    !targetStats.isFile() ||
    targetStats.isSymbolicLink() ||
    pendingStats.dev !== targetStats.dev ||
    pendingStats.ino !== targetStats.ino ||
    pendingStats.nlink !== 2 ||
    targetStats.nlink !== 2
  ) {
    throw storageUnsafe(
      'Prepared and published history paths are not one exact hard-link pair.',
    );
  }
  assertPrivateRecordBytes(pending, content, 2);
  assertPrivateRecordBytes(target, content, 2);
}

function createPreparedRecord(filePath: string, content: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readHistoryRecords(
  directory: string,
  allowedPendingName?: string,
  allowedLinkedTargetName?: string,
): ControlPlaneSupervisorHistoryRecord[] {
  const records: ControlPlaneSupervisorHistoryRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === allowedPendingName ||
      entry.name === allowedLinkedTargetName
    ) {
      continue;
    }
    if (
      !RECORD_FILE.test(entry.name) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_HISTORY_UNKNOWN_RESIDUE',
        'Supervisor history directory contains an unknown or indirect entry.',
        ExitCode.unsafeEnvironment,
      );
    }
    const filePath = path.join(directory, entry.name);
    const raw = readPrivateRecordText(filePath, 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw recordInvalid('Supervisor history file is not JSON.');
    }
    if (`${canonicalJson(value)}\n` !== raw) {
      throw recordInvalid('Supervisor history file is not canonical JSON.');
    }
    const record = verifyControlPlaneSupervisorHistoryRecord(value);
    if (`${record.recordDigest.slice('sha256:'.length)}.json` !== entry.name) {
      throw recordInvalid(
        'Supervisor history filename does not match its digest.',
      );
    }
    records.push(record);
  }
  return records;
}

function assertAppendInventory(
  directory: string,
  allowedPendingName: string,
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === allowedPendingName) continue;
    if (
      !RECORD_FILE.test(entry.name) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_HISTORY_UNKNOWN_RESIDUE',
        'Supervisor history directory contains residue unrelated to this append.',
        ExitCode.unsafeEnvironment,
      );
    }
  }
}
