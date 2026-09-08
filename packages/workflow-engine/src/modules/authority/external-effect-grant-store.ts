import fs from 'node:fs';

import path from 'node:path';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import crypto from 'node:crypto';

import type {
  ExternalEffectGrantStoreBindings,
  ExternalEffectGrantStoreTypes,
} from './external-effect-grant.ts';

type Sha256Digest = ExternalEffectGrantStoreTypes['Sha256Digest'];

type IdempotencyRecord = ExternalEffectGrantStoreTypes['IdempotencyRecord'];

export function createExternalEffectGrantStore({
  externalEffectStorePaths,
  ensurePlainDirectory,
  unsafeStore,
  parseIdempotencyRecord,
  sha256,
  assertUuid,
}: ExternalEffectGrantStoreBindings) {
  function ensureStore(
    paths: ReturnType<typeof externalEffectStorePaths>,
  ): void {
    for (const directory of storeDirectories(paths)) {
      ensurePlainDirectory(directory);
      fs.chmodSync(directory, 0o700);
    }
    assertStore(paths);
  }

  function assertStore(
    paths: ReturnType<typeof externalEffectStorePaths>,
  ): void {
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
  }

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

  function assertIdempotencyAvailable(
    paths: ReturnType<typeof externalEffectStorePaths>,
    idempotencyKey: string,
    grantId: string,
    grantDigest: Sha256Digest,
  ): void {
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
  }

  function createIdempotencyIndex(
    paths: ReturnType<typeof externalEffectStorePaths>,
    idempotencyKey: string,
    grantId: string,
    grantDigest: Sha256Digest,
  ): void {
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
  }

  function idempotencyPath(
    paths: ReturnType<typeof externalEffectStorePaths>,
    idempotencyKey: string,
  ): string {
    return path.join(
      paths.idempotency,
      `${sha256(idempotencyKey).slice('sha256:'.length)}.json`,
    );
  }

  function assertGrantAbsent(
    paths: ReturnType<typeof externalEffectStorePaths>,
    grantId: string,
  ): void {
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
  }

  function grantPath(directory: string, grantId: string): string {
    return path.join(directory, `${assertUuid(grantId)}.json`);
  }

  function reconciliationPath(
    paths: ReturnType<typeof externalEffectStorePaths>,
    grantId: string,
  ): string {
    return path.join(
      paths.terminal,
      `${assertUuid(grantId)}.reconciliation.json`,
    );
  }

  function createPrivateFileAtomic(filePath: string, content: string): void {
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
  }

  function replacePrivateFileAtomic(filePath: string, content: string): void {
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
  }

  function readOptionalPrivateFile(filePath: string): string | null {
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
  }

  function unlinkIfExact(filePath: string, expected: string): void {
    const raw = readOptionalPrivateFile(filePath);
    if (raw === null) return;
    if (raw !== expected) throw unsafeStore();
    fs.unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
  }

  function fsyncDirectory(directory: string): void {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  return {
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
}
