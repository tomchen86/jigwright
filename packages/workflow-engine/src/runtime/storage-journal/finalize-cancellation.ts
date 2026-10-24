/** Publishes and reconciles durable finalize cancellation records. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FinalizeCancellation } from '../../modules/lifecycle/finalize-cancellation.ts';
import {
  parseFinalizeCancellation,
  assertSameCancellation,
  invalidCancellation,
  prepareFinalizeProjectionRestored,
  prepareFinalizeCancellationCompletion,
  assertTransactionId,
  assertSameCancellationRequest,
  sealCancellation,
} from '../../modules/lifecycle/finalize-cancellation.ts';
import {
  ensurePlainDirectory,
  assertPlainDirectory,
} from '../repository-transaction/filesystem-safety.ts';
import { writeJsonAtomic } from '../session-workspace/session-store.ts';

const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export function publishFinalizeCancellation(
  runtimeRoot: string,
  cancellation: FinalizeCancellation,
): FinalizeCancellation {
  const normalized = parseFinalizeCancellation(cancellation);
  const existing = readFinalizeCancellation(
    runtimeRoot,
    normalized.transactionId,
  );
  if (existing !== null) return assertSameCancellation(existing, normalized);
  const directory = cancellationDirectory(runtimeRoot);
  try {
    ensurePlainDirectory(directory);
  } catch {
    throw invalidCancellation('Finalize cancellation directory is unsafe.');
  }
  const prepared = publishCancellationPreparation(runtimeRoot, normalized);
  const filePath = cancellationPath(runtimeRoot, normalized.transactionId);
  const preparedPath = cancellationPreparationPath(
    runtimeRoot,
    normalized.transactionId,
  );
  try {
    fs.linkSync(preparedPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  const published = readFinalizeCancellation(
    runtimeRoot,
    normalized.transactionId,
  );
  if (published === null) {
    throw invalidCancellation('Finalize cancellation was not persisted.');
  }
  return assertSameCancellation(published, prepared);
}

export function markFinalizeProjectionRestored(
  runtimeRoot: string,
  current: FinalizeCancellation,
): FinalizeCancellation {
  return advanceCancellation(
    runtimeRoot,
    current,
    prepareFinalizeProjectionRestored(current),
  );
}

export function completeFinalizeCancellation(
  runtimeRoot: string,
  current: FinalizeCancellation,
  cancelledAt: string,
): FinalizeCancellation {
  return advanceCancellation(
    runtimeRoot,
    current,
    prepareFinalizeCancellationCompletion(current, cancelledAt),
  );
}

export function readFinalizeCancellation(
  runtimeRoot: string,
  transactionId: string,
): FinalizeCancellation | null {
  const normalizedId = assertTransactionId(transactionId);
  const directory = cancellationDirectory(runtimeRoot);
  const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStats) return null;
  try {
    assertPlainDirectory(directory);
  } catch {
    throw invalidCancellation('Finalize cancellation directory is unsafe.');
  }
  const filePath = cancellationPath(runtimeRoot, normalizedId);
  return readCancellationFile(filePath, normalizedId, () =>
    cancellationPreparationPath(runtimeRoot, normalizedId),
  );
}

export function readProtectedFinalizeCancellation(
  runtimeRoot: string,
  sessionId: string,
  parentChallengeId: string,
): FinalizeCancellation | null {
  const directory = cancellationDirectory(runtimeRoot);
  const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStats) return null;
  try {
    assertPlainDirectory(directory);
  } catch {
    throw invalidCancellation('Finalize cancellation directory is unsafe.');
  }
  const matches = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /^[0-9a-f]{64}\.json$/u.test(entry.name),
    )
    .map((entry) =>
      readFinalizeCancellation(
        runtimeRoot,
        entry.name.slice(0, -'.json'.length),
      ),
    )
    .filter(
      (entry): entry is FinalizeCancellation =>
        entry !== null &&
        entry.sessionId === sessionId &&
        entry.transaction.protectedApply?.challengeId === parentChallengeId,
    );
  if (matches.length > 1) {
    throw invalidCancellation(
      'More than one finalize cancellation matches the protected Apply Grant.',
    );
  }
  return matches[0] ?? null;
}

function readCancellationFile(
  filePath: string,
  normalizedId: string,
  publicationAlias?: (stats: fs.Stats) => string | null,
): FinalizeCancellation | null {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) return null;
  if (
    !isPrivateFile(before, publicationAlias ? [1, 2] : [1]) ||
    before.size > MAX_RECORD_BYTES
  ) {
    throw invalidCancellation('Finalize cancellation file is unsafe.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !isPrivateFile(opened, publicationAlias ? [1, 2] : [1]) ||
      opened.size > MAX_RECORD_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw invalidCancellation('Finalize cancellation file changed.');
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isPrivateFile(afterDescriptor, publicationAlias ? [1, 2] : [1]) ||
      !afterPath ||
      !isPrivateFile(afterPath, publicationAlias ? [1, 2] : [1]) ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw invalidCancellation('Finalize cancellation file changed.');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw invalidCancellation('Finalize cancellation is not JSON.');
    }
    const cancellation = parseFinalizeCancellation(value);
    if (
      cancellation.transactionId !== normalizedId ||
      content !== `${JSON.stringify(cancellation, null, 2)}\n`
    ) {
      throw invalidCancellation(
        'Finalize cancellation bytes are not canonical.',
      );
    }
    if (afterDescriptor.nlink === 2) {
      const publicationAliasPath = publicationAlias?.(afterDescriptor) ?? null;
      if (
        publicationAliasPath === null ||
        !isExactAlias(publicationAliasPath, afterDescriptor)
      ) {
        throw invalidCancellation(
          'Finalize cancellation has an unsafe hard-link alias.',
        );
      }
      fs.unlinkSync(publicationAliasPath);
      fsyncDirectory(path.dirname(filePath));
      const reconciled = fs.fstatSync(descriptor);
      const reconciledPath = fs.lstatSync(filePath, {
        throwIfNoEntry: false,
      });
      if (
        !isPrivateFile(reconciled, [1]) ||
        !reconciledPath ||
        !isPrivateFile(reconciledPath, [1]) ||
        reconciled.dev !== opened.dev ||
        reconciled.ino !== opened.ino ||
        reconciledPath.dev !== opened.dev ||
        reconciledPath.ino !== opened.ino
      ) {
        throw invalidCancellation(
          'Finalize cancellation publication did not reconcile.',
        );
      }
    }
    return cancellation;
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw invalidCancellation('Finalize cancellation is unreadable.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishCancellationPreparation(
  runtimeRoot: string,
  requested: FinalizeCancellation,
): FinalizeCancellation {
  const existing = readCancellationPreparation(
    runtimeRoot,
    requested.transactionId,
  );
  if (existing !== null) {
    return assertSameCancellationRequest(existing, requested);
  }
  const directory = cancellationDirectory(runtimeRoot);
  const preparationPath = cancellationPreparationPath(
    runtimeRoot,
    requested.transactionId,
  );
  const scratchPath = `${preparationPath}.${crypto.randomUUID()}.scratch`;
  const content = `${JSON.stringify(requested, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      scratchPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    const owned = fs.fstatSync(descriptor);
    const scratch = fs.lstatSync(scratchPath, { throwIfNoEntry: false });
    if (
      !isPrivateFile(owned, [1]) ||
      !scratch ||
      !isPrivateFile(scratch, [1]) ||
      owned.dev !== scratch.dev ||
      owned.ino !== scratch.ino ||
      owned.size !== Buffer.byteLength(content)
    ) {
      throw invalidCancellation(
        'Finalize cancellation preparation changed before publication.',
      );
    }
    try {
      fs.linkSync(scratchPath, preparationPath);
      fsyncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      const owned = fs.fstatSync(descriptor);
      const scratch = fs.lstatSync(scratchPath, { throwIfNoEntry: false });
      if (scratch && scratch.dev === owned.dev && scratch.ino === owned.ino) {
        fs.unlinkSync(scratchPath);
        fsyncDirectory(directory);
      }
      fs.closeSync(descriptor);
    }
  }
  const prepared = readCancellationPreparation(
    runtimeRoot,
    requested.transactionId,
  );
  if (prepared === null) {
    throw invalidCancellation(
      'Finalize cancellation preparation was not persisted.',
    );
  }
  return assertSameCancellationRequest(prepared, requested);
}

function readCancellationPreparation(
  runtimeRoot: string,
  transactionId: string,
): FinalizeCancellation | null {
  const normalizedId = assertTransactionId(transactionId);
  return readCancellationFile(
    cancellationPreparationPath(runtimeRoot, normalizedId),
    normalizedId,
    (stats) => preparationScratchAlias(runtimeRoot, normalizedId, stats),
  );
}

function preparationScratchAlias(
  runtimeRoot: string,
  transactionId: string,
  stats: fs.Stats,
): string | null {
  const directory = cancellationDirectory(runtimeRoot);
  const prefix = `${transactionId}.prepare.json.`;
  const aliases = fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.scratch'))
    .map((entry) => path.join(directory, entry))
    .filter((entryPath) => isExactAlias(entryPath, stats));
  return aliases.length === 1 ? aliases[0]! : null;
}

function advanceCancellation(
  runtimeRoot: string,
  current: FinalizeCancellation,
  next: Omit<FinalizeCancellation, 'recordDigest'> | FinalizeCancellation,
): FinalizeCancellation {
  const observed = readFinalizeCancellation(runtimeRoot, current.transactionId);
  if (
    observed === null ||
    JSON.stringify(observed) !== JSON.stringify(current)
  ) {
    throw invalidCancellation(
      'Finalize cancellation changed before phase advancement.',
    );
  }
  const normalized = sealCancellation(next);
  writeJsonAtomic(
    cancellationPath(runtimeRoot, current.transactionId),
    normalized,
  );
  const advanced = readFinalizeCancellation(runtimeRoot, current.transactionId);
  if (
    advanced === null ||
    JSON.stringify(advanced) !== JSON.stringify(normalized)
  ) {
    throw invalidCancellation(
      'Finalize cancellation phase did not persist exact bytes.',
    );
  }
  return advanced;
}

function cancellationDirectory(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'finalize-transaction-history');
}

function cancellationPath(runtimeRoot: string, transactionId: string): string {
  return path.join(
    cancellationDirectory(runtimeRoot),
    `${assertTransactionId(transactionId)}.json`,
  );
}

function cancellationPreparationPath(
  runtimeRoot: string,
  transactionId: string,
): string {
  return path.join(
    cancellationDirectory(runtimeRoot),
    `${assertTransactionId(transactionId)}.prepare.json`,
  );
}

function isPrivateFile(
  stats: fs.Stats,
  allowedLinks: readonly number[],
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    allowedLinks.includes(stats.nlink) &&
    (stats.mode & 0o777) === 0o600
  );
}

function isExactAlias(aliasPath: string, stats: fs.Stats): boolean {
  const alias = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
  return (
    !!alias &&
    isPrivateFile(alias, [2]) &&
    alias.dev === stats.dev &&
    alias.ino === stats.ino
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
