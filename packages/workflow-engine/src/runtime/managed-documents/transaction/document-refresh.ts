/** Filesystem records and atomic target transactions for curated document refreshes. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  readContentRecord,
  writeContentRecord,
} from '../../storage-journal/content-record-store.ts';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import {
  curatedTarget,
  digest,
  refreshError,
} from '../../../modules/projection/document-refresh-policy.ts';
import type { DocumentRefreshStorage } from '../../../modules/projection/document-refresh-storage.ts';

export function createDocumentRefreshStorage(
  repositoryRoot: string,
  gitCommonDirectory: string,
  runtimeRoot: string,
): DocumentRefreshStorage {
  assertSafeRuntimeRoot(gitCommonDirectory, runtimeRoot);
  const proposals = path.join(runtimeRoot, 'document-proposals');
  const reviews = path.join(runtimeRoot, 'document-reviews');
  const locks = path.join(runtimeRoot, 'document-refresh-locks');
  return {
    readRecord(kind, id) {
      return readContentRecord(kind === 'proposal' ? proposals : reviews, id);
    },
    writeRecord(record) {
      return writeContentRecord(
        record.kind === 'document-refresh-proposal' ? proposals : reviews,
        record,
      );
    },
    openTarget(requestedTarget) {
      const target = assertCuratedTarget(repositoryRoot, requestedTarget);
      const targetPath = path.join(repositoryRoot, target);
      return {
        target,
        readPolicy() {
          try {
            return fs.readFileSync(
              path.join(repositoryRoot, 'workflow/document-policy.json'),
              'utf8',
            );
          } catch {
            throw refreshError(
              'DOCUMENT_REFRESH_POLICY_INVALID',
              'Document refresh policy is missing or invalid.',
              ExitCode.guard,
            );
          }
        },
        readText() {
          return fs.readFileSync(targetPath, 'utf8');
        },
        withLock(operation) {
          return withTargetLock(locks, target, () =>
            operation((content) => writeTextAtomic(targetPath, content)),
          );
        },
      };
    },
  };
}

function assertCuratedTarget(repositoryRoot: string, value: string): string {
  const target = curatedTarget(value);
  const targetPath = path.join(repositoryRoot, target);
  assertNoSymlinkSegments(repositoryRoot, target);
  const stats = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw refreshError(
      'DOCUMENT_TARGET_UNSAFE',
      'Refresh target is missing or is not a plain file.',
      ExitCode.guard,
    );
  }
  const relative = path.relative(repositoryRoot, fs.realpathSync(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw refreshError(
      'DOCUMENT_TARGET_UNSAFE',
      'Refresh target escapes the repository.',
      ExitCode.guard,
    );
  }
  return target;
}

function assertNoSymlinkSegments(repositoryRoot: string, target: string): void {
  let candidate = repositoryRoot;
  for (const segment of target.split('/')) {
    candidate = path.join(candidate, segment);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw refreshError(
        'DOCUMENT_TARGET_UNSAFE',
        'Refresh target may not traverse symbolic links.',
        ExitCode.guard,
      );
    }
  }
}

function writeTextAtomic(filePath: string, content: string): void {
  const stats = fs.lstatSync(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', stats.mode & 0o777);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function assertSafeRuntimeRoot(
  gitCommonDirectory: string,
  runtimeRoot: string,
): void {
  const relative = path.relative(gitCommonDirectory, runtimeRoot);
  let candidate = gitCommonDirectory;
  for (const segment of relative.split(path.sep)) {
    candidate = path.join(candidate, segment);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw refreshError(
        'DOCUMENT_RUNTIME_UNSAFE',
        'Document refresh runtime may not traverse symbolic links.',
        ExitCode.unsafeEnvironment,
      );
    }
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const resolved = path.relative(
    fs.realpathSync(gitCommonDirectory),
    fs.realpathSync(runtimeRoot),
  );
  if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
    throw refreshError(
      'DOCUMENT_RUNTIME_UNSAFE',
      'Document refresh runtime escapes the Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function withTargetLock<T>(
  locksDirectory: string,
  target: string,
  operation: () => T,
): T {
  fs.mkdirSync(locksDirectory, { recursive: true });
  const stats = fs.lstatSync(locksDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw refreshError(
      'DOCUMENT_RUNTIME_UNSAFE',
      'Document refresh lock directory is unsafe.',
      ExitCode.unsafeEnvironment,
    );
  }
  const lockPath = path.join(locksDirectory, `${digest(target)}.lock`);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw refreshError(
        'DOCUMENT_REFRESH_CONFLICT',
        'Another refresh is already applying to this document.',
        ExitCode.conflict,
      );
    }
    if (created) {
      fs.rmSync(lockPath, { force: true });
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
