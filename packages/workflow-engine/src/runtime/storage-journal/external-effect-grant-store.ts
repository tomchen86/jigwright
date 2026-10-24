/** Private atomic external-effect storage and exact idempotency records. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type IdempotencyRecord,
  assertUuid,
  sha256,
  unsafeStore,
} from '../../modules/authority/external-effect-grant.ts';
import { parseIdempotencyRecord } from '../../modules/authority/external-effect-grant-records.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { type ExternalEffectStoreServices } from '../../modules/authority/external-effect-grant-services.ts';
export const externalEffectStorePaths: ExternalEffectStoreServices['externalEffectStorePaths'] =
  function externalEffectStorePaths(gitCommonDirectory) {
    const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
    const root = path.join(runtime.root, 'external-effect-grants');
    return {
      runtime,
      root,
      pending: path.join(root, 'pending'),
      available: path.join(root, 'available'),
      transactions: path.join(root, 'transactions'),
      terminal: path.join(root, 'terminal'),
      idempotency: path.join(root, 'idempotency'),
    };
  };

export const ensureStore: ExternalEffectStoreServices['ensureStore'] =
  function ensureStore(paths) {
    for (const directory of storeDirectories(paths)) {
      ensurePlainDirectory(directory);
      fs.chmodSync(directory, 0o700);
    }
    assertStore(paths);
  };

export const assertStore: ExternalEffectStoreServices['assertStore'] =
  function assertStore(paths) {
    for (const directory of storeDirectories(paths)) {
      const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700 ||
        fs.realpathSync(directory) !== path.resolve(directory)
      ) {
        throw unsafeStore();
      }
    }
  };

function storeDirectories(
  paths: ReturnType<typeof externalEffectStorePaths>,
): string[] {
  return [
    paths.root,
    paths.pending,
    paths.available,
    paths.transactions,
    paths.terminal,
    paths.idempotency,
  ];
}

export const assertIdempotencyAvailable: ExternalEffectStoreServices['assertIdempotencyAvailable'] =
  function assertIdempotencyAvailable(
    paths,
    idempotencyKey,
    grantId,
    grantDigest,
  ) {
    const raw = readOptionalPrivateFile(idempotencyPath(paths, idempotencyKey));
    if (raw === null) return;
    const existing = parseIdempotencyRecord(raw);
    if (
      existing.idempotencyKey !== idempotencyKey ||
      existing.grantId !== grantId ||
      existing.grantDigest !== grantDigest
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT',
        'External effect idempotency key is already bound to another exact grant.',
        ExitCode.conflict,
      );
    }
  };

export const createIdempotencyIndex: ExternalEffectStoreServices['createIdempotencyIndex'] =
  function createIdempotencyIndex(paths, idempotencyKey, grantId, grantDigest) {
    const filePath = idempotencyPath(paths, idempotencyKey);
    const raw = readOptionalPrivateFile(filePath);
    if (raw !== null) {
      assertIdempotencyAvailable(paths, idempotencyKey, grantId, grantDigest);
      return;
    }
    const value = {
      schemaVersion: 1 as const,
      kind: 'external-effect-idempotency' as const,
      idempotencyKey,
      grantId,
      grantDigest,
    };
    const record: IdempotencyRecord = {
      ...value,
      recordDigest: sha256(canonicalJson(value)),
    };
    createPrivateFileAtomic(filePath, `${canonicalJson(record)}\n`);
  };

function idempotencyPath(
  paths: ReturnType<typeof externalEffectStorePaths>,
  idempotencyKey: string,
): string {
  return path.join(
    paths.idempotency,
    `${sha256(idempotencyKey).slice('sha256:'.length)}.json`,
  );
}

export const assertGrantAbsent: ExternalEffectStoreServices['assertGrantAbsent'] =
  function assertGrantAbsent(paths, grantId) {
    if (
      [paths.pending, paths.available, paths.transactions, paths.terminal].some(
        (directory) => fs.existsSync(grantPath(directory, grantId)),
      ) ||
      fs.existsSync(reconciliationPath(paths, grantId))
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_GRANT_EXISTS',
        `External effect grant ${grantId} already exists.`,
        ExitCode.conflict,
      );
    }
  };

export const grantPath: ExternalEffectStoreServices['grantPath'] =
  function grantPath(directory, grantId) {
    return path.join(directory, `${assertUuid(grantId)}.json`);
  };

export const reconciliationPath: ExternalEffectStoreServices['reconciliationPath'] =
  function reconciliationPath(paths, grantId) {
    return path.join(
      paths.terminal,
      `${assertUuid(grantId)}.reconciliation.json`,
    );
  };

export const createPrivateFileAtomic: ExternalEffectStoreServices['createPrivateFileAtomic'] =
  function createPrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
        0o600,
      );
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(temporary, filePath);
      fs.unlinkSync(temporary);
      fsyncDirectory(path.dirname(filePath));
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  };

export const replacePrivateFileAtomic: ExternalEffectStoreServices['replacePrivateFileAtomic'] =
  function replacePrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
        0o600,
      );
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filePath);
      fsyncDirectory(path.dirname(filePath));
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  };

export const readOptionalPrivateFile: ExternalEffectStoreServices['readOptionalPrivateFile'] =
  function readOptionalPrivateFile(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) return null;
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 64 * 1024
    ) {
      throw unsafeStore();
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.dev !== stats.dev ||
        opened.ino !== stats.ino ||
        opened.size > 64 * 1024
      ) {
        throw unsafeStore();
      }
      return fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  };

export const unlinkIfExact: ExternalEffectStoreServices['unlinkIfExact'] =
  function unlinkIfExact(filePath, expected) {
    const raw = readOptionalPrivateFile(filePath);
    if (raw === null) return;
    if (raw !== expected) throw unsafeStore();
    fs.unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
  };

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
export const externalEffectStore: ExternalEffectStoreServices = {
  externalEffectStorePaths,
  ensureStore,
  assertStore,
  assertIdempotencyAvailable,
  createIdempotencyIndex,
  assertGrantAbsent,
  grantPath,
  reconciliationPath,
  createPrivateFileAtomic,
  replacePrivateFileAtomic,
  readOptionalPrivateFile,
  unlinkIfExact,
};
