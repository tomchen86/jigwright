/** Private open-task journal persistence, including interrupted-publication repair. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import {
  type OpenTaskJournal,
  parseOpenTaskJournal,
  openTaskUnsafe,
} from '../../modules/lifecycle/open-task-journal.ts';

const MAX_JOURNAL_BYTES = 128 * 1024;

export function readOpenTaskJournalAtRoot(
  root: string,
  changeId: string,
  taskId: string,
): OpenTaskJournal | null {
  const filePath = journalPath(root, changeId, taskId);
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    const directory = path.dirname(filePath);
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
      assertPrivateDirectory(directory);
    }
    return null;
  }
  return parseOpenTaskJournal(readPrivateCanonicalFile(filePath));
}

export function listOpenTaskJournalsAtRoot(root: string): OpenTaskJournal[] {
  const directory = path.join(root, 'open-task', 'transactions');
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  assertPrivateDirectory(directory);
  const canonicalEntries = fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const journals = canonicalEntries.map((entry) => {
    const journal = parseOpenTaskJournal(
      readPrivateCanonicalFile(path.join(directory, entry)),
    );
    if (
      path.basename(journalPath(root, journal.changeId, journal.taskId)) !==
      entry
    ) {
      throw openTaskUnsafe('Open-task journal pathname is not canonical.');
    }
    return journal;
  });
  const expectedEntries = journals
    .map((journal) =>
      path.basename(journalPath(root, journal.changeId, journal.taskId)),
    )
    .sort();
  if (
    canonicalJson(fs.readdirSync(directory).sort()) !==
    canonicalJson(expectedEntries)
  ) {
    throw openTaskUnsafe('Open-task journal inventory is not exact.');
  }
  return journals;
}

export function publishPreparedJournal(
  root: string,
  journal: OpenTaskJournal,
): void {
  const filePath = journalPath(root, journal.changeId, journal.taskId);
  ensureJournalDirectory(filePath);
  const content = `${canonicalJson(journal)}\n`;
  const temporary = writePrivateTemporary(filePath, content);
  try {
    fs.linkSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(filePath));
    if (readPrivateCanonicalFile(filePath) !== content) {
      throw openTaskUnsafe('Prepared open-task journal publication changed.');
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (isNodeError(error) && error.code === 'EEXIST') {
      const existing = parseOpenTaskJournal(readPrivateCanonicalFile(filePath));
      if (canonicalJson(existing) === canonicalJson(journal)) return;
      throw workflowError(
        'OPEN_TASK_TRANSACTION_CONFLICT',
        'A different durable open-task transaction already exists.',
        ExitCode.conflict,
      );
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function replaceJournal(
  root: string,
  previous: OpenTaskJournal,
  next: OpenTaskJournal,
): void {
  const filePath = journalPath(root, previous.changeId, previous.taskId);
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const observed = parseOpenTaskJournal(readPrivateCanonicalFile(filePath));
  const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before ||
    !current ||
    before.dev !== current.dev ||
    before.ino !== current.ino ||
    canonicalJson(observed) !== canonicalJson(previous)
  ) {
    throw openTaskUnsafe('Open-task journal changed before phase advancement.');
  }
  const content = `${canonicalJson(next)}\n`;
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const beforeRename = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !beforeRename ||
      before.dev !== beforeRename.dev ||
      before.ino !== beforeRename.ino
    ) {
      throw openTaskUnsafe('Open-task journal pathname changed.');
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    if (readPrivateCanonicalFile(filePath) !== content) {
      throw openTaskUnsafe('Completed open-task journal publication changed.');
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readPrivateCanonicalFile(filePath: string): string {
  const parent = path.dirname(filePath);
  assertPrivateDirectory(parent);
  reconcilePublishedJournalAlias(filePath);
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > MAX_JOURNAL_BYTES
  ) {
    throw openTaskUnsafe('Open-task journal file is unsafe.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !current ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      Buffer.byteLength(content) > MAX_JOURNAL_BYTES
    ) {
      throw openTaskUnsafe('Open-task journal changed while being read.');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw openTaskUnsafe('Open-task journal is not JSON.');
    }
    if (`${canonicalJson(value)}\n` !== content) {
      throw openTaskUnsafe('Open-task journal bytes are not canonical.');
    }
    return content;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function journalPath(root: string, changeId: string, taskId: string): string {
  return path.join(
    root,
    'open-task',
    'transactions',
    `${changeId}.${taskId}.json`,
  );
}

function ensureJournalDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  ensurePlainDirectory(path.dirname(directory));
  ensurePlainDirectory(directory);
  fs.chmodSync(path.dirname(directory), 0o700);
  fs.chmodSync(directory, 0o700);
  assertPrivateDirectory(directory);
}

function reconcilePublishedJournalAlias(filePath: string): void {
  const target = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!target || target.nlink === 1) return;
  if (
    !target.isFile() ||
    target.isSymbolicLink() ||
    target.nlink !== 2 ||
    (target.mode & 0o777) !== 0o600
  ) {
    throw openTaskUnsafe('Open-task journal publication residue is unsafe.');
  }
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const aliases = fs
    .readdirSync(directory)
    .filter(
      (entry) =>
        entry !== basename &&
        entry.startsWith(`${basename}.`) &&
        entry.endsWith('.tmp'),
    )
    .map((entry) => path.join(directory, entry))
    .filter((candidate) => {
      const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
      return (
        stats?.isFile() === true &&
        !stats.isSymbolicLink() &&
        stats.dev === target.dev &&
        stats.ino === target.ino &&
        stats.nlink === 2 &&
        (stats.mode & 0o777) === 0o600
      );
    });
  if (aliases.length !== 1) {
    throw openTaskUnsafe('Open-task journal publication residue is ambiguous.');
  }
  fs.unlinkSync(aliases[0]!);
  fsyncDirectory(directory);
  const reconciled = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !reconciled?.isFile() ||
    reconciled.isSymbolicLink() ||
    reconciled.nlink !== 1 ||
    reconciled.dev !== target.dev ||
    reconciled.ino !== target.ino
  ) {
    throw openTaskUnsafe('Open-task journal publication did not reconcile.');
  }
}

function assertPrivateDirectory(directory: string): void {
  for (const candidate of [path.dirname(directory), directory]) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(candidate) !== path.resolve(candidate) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw openTaskUnsafe('Open-task runtime directory is unsafe.');
    }
  }
}

function writePrivateTemporary(filePath: string, content: string): string {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
