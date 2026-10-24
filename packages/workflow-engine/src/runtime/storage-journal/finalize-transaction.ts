/** Persists exact finalize transactions with compare-before-write phase advancement. */
import fs from 'node:fs';
import path from 'node:path';
import type { FinalizeTransaction } from '../../modules/lifecycle/finalize-transaction.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  assertPlainDirectory,
  ensurePlainDirectory,
} from '../repository-transaction/filesystem-safety.ts';
import {
  invalidFinalizeTransaction,
  parseFinalizeTransaction,
  advanceFinalizeTransactionRecord,
} from '../../modules/lifecycle/finalize-transaction.ts';
import { writeJsonAtomic } from '../session-workspace/session-store.ts';

export function readFinalizeTransaction(
  runtimeRoot: string,
  requestedSessionId: string,
): FinalizeTransaction | null {
  const sessionId = assertSessionId(requestedSessionId);
  const directory = finalizeTransactionDirectory(runtimeRoot);
  const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStats) return null;
  try {
    assertPlainDirectory(directory);
  } catch {
    throw invalidFinalizeTransaction(
      'Finalize transaction directory is unsafe.',
    );
  }
  const filePath = finalizeTransactionPath(runtimeRoot, sessionId);
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) return null;
  if (!isPrivateFile(before)) {
    throw invalidFinalizeTransaction('Finalize transaction file is unsafe.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !isPrivateFile(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw invalidFinalizeTransaction('Finalize transaction file changed.');
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isPrivateFile(afterDescriptor) ||
      !afterPath ||
      !isPrivateFile(afterPath) ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw invalidFinalizeTransaction('Finalize transaction file changed.');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw invalidFinalizeTransaction('Finalize transaction is not JSON.');
    }
    const transaction = parseFinalizeTransaction(value);
    if (
      transaction.sessionId !== sessionId ||
      content !== `${JSON.stringify(transaction, null, 2)}\n`
    ) {
      throw invalidFinalizeTransaction(
        'Finalize transaction bytes are not canonical.',
      );
    }
    return transaction;
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw invalidFinalizeTransaction('Finalize transaction is unreadable.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function publishFinalizeTransaction(
  runtimeRoot: string,
  transaction: FinalizeTransaction,
): FinalizeTransaction {
  const normalized = parseFinalizeTransaction(transaction);
  const existing = readFinalizeTransaction(runtimeRoot, transaction.sessionId);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw invalidFinalizeTransaction(
        'A different finalize transaction already owns this session.',
      );
    }
    return existing;
  }
  const directory = finalizeTransactionDirectory(runtimeRoot);
  try {
    ensurePlainDirectory(directory);
  } catch {
    throw invalidFinalizeTransaction(
      'Finalize transaction directory is unsafe.',
    );
  }
  writeJsonAtomic(
    finalizeTransactionPath(runtimeRoot, normalized.sessionId),
    normalized,
  );
  const published = readFinalizeTransaction(runtimeRoot, normalized.sessionId);
  if (
    published === null ||
    JSON.stringify(published) !== JSON.stringify(normalized)
  ) {
    throw invalidFinalizeTransaction(
      'Finalize transaction publication did not persist exact bytes.',
    );
  }
  return published;
}

export function advanceFinalizeTransaction(
  runtimeRoot: string,
  current: FinalizeTransaction,
  next: FinalizeTransaction,
): FinalizeTransaction {
  const observed = readFinalizeTransaction(runtimeRoot, current.sessionId);
  if (
    observed === null ||
    JSON.stringify(observed) !== JSON.stringify(current)
  ) {
    throw invalidFinalizeTransaction(
      'Finalize transaction changed before phase advancement.',
    );
  }
  const normalized = advanceFinalizeTransactionRecord(current, next);
  writeJsonAtomic(
    finalizeTransactionPath(runtimeRoot, current.sessionId),
    normalized,
  );
  const advanced = readFinalizeTransaction(runtimeRoot, current.sessionId);
  if (
    advanced === null ||
    JSON.stringify(advanced) !== JSON.stringify(normalized)
  ) {
    throw invalidFinalizeTransaction(
      'Finalize transaction phase did not persist exact bytes.',
    );
  }
  return advanced;
}

export function removeFinalizeTransaction(
  runtimeRoot: string,
  expected: FinalizeTransaction,
): void {
  const observed = readFinalizeTransaction(runtimeRoot, expected.sessionId);
  if (
    observed === null ||
    JSON.stringify(observed) !== JSON.stringify(expected)
  ) {
    throw invalidFinalizeTransaction(
      'Finalize transaction changed before exact cleanup.',
    );
  }
  const filePath = finalizeTransactionPath(runtimeRoot, expected.sessionId);
  fs.unlinkSync(filePath);
  fsyncDirectory(path.dirname(filePath));
}

export function finalizeTransactionPath(
  runtimeRoot: string,
  requestedSessionId: string,
): string {
  return path.join(
    finalizeTransactionDirectory(runtimeRoot),
    `${assertSessionId(requestedSessionId)}.json`,
  );
}

function finalizeTransactionDirectory(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'finalize-transactions');
}

function isPrivateFile(stats: fs.Stats): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (stats.mode & 0o777) === 0o600
  );
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
