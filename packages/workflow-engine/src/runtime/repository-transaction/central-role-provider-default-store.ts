/**
 * Reads pinned provider defaults and safely replaces their current
 * configuration.
 *
 * Invariants:
 * - Pinned defaults require a full commit object identity.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
  assertCentralRoleProviderDefaultSnapshotV1,
  createCentralRoleProviderDefaultSnapshotV1,
  parseCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
  type CentralRoleProviderDefaultSnapshotV1,
  type CentralRoleProviderDefaultV1,
} from '../../modules/provider-orchestration/central-role-provider-default.ts';
import { runGitBuffer } from './git.ts';
import { readBlobBytes } from './git-command.ts';

export { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH };

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TREE_ENTRY = /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type CurrentConfigurationSnapshot = Readonly<{
  filePath: string;
  parentPath: string;
  identity: FileIdentity;
  bytes: Buffer;
  configuration: CentralRoleProviderDefaultV1;
}>;

export type CentralRoleProviderDefaultReplacement = Readonly<{
  path: typeof CENTRAL_ROLE_PROVIDER_DEFAULT_PATH;
  previousConfigurationDigest: string;
  configurationDigest: string;
}>;

/** Read the canonical worktree candidate. Runtime authority must use the pinned reader. */
export function readCurrentCentralRoleProviderDefault(
  repositoryRoot: string,
): CentralRoleProviderDefaultV1 {
  return readCurrentSnapshot(repositoryRoot).configuration;
}

/** Read the exact 100644 configuration blob from one full commit object ID. */
export function readPinnedCentralRoleProviderDefault(
  repositoryRoot: string,
  commit: string,
): CentralRoleProviderDefaultV1 {
  return readPinnedCentralRoleProviderDefaultSnapshot(repositoryRoot, commit)
    .configuration;
}

/**
 * Read and bind the exact tracked 100644 blob from one full commit object ID.
 * The returned modules-owned DTO carries no execution or Grant authority.
 */
export function readPinnedCentralRoleProviderDefaultSnapshot(
  repositoryRoot: string,
  commit: string,
): CentralRoleProviderDefaultSnapshotV1 {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw storeError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
      'Pinned central role/provider defaults require one full commit object ID.',
      ExitCode.verification,
    );
  }
  const root = canonicalRepositoryRoot(repositoryRoot);
  let objectType: Buffer;
  try {
    objectType = runGitBuffer(root, ['cat-file', '-t', commit]);
  } catch {
    throw pinnedSnapshotMismatch();
  }
  if (!objectType.equals(Buffer.from('commit\n', 'utf8'))) {
    throw pinnedSnapshotMismatch();
  }
  const entryBytes = runGitBuffer(root, [
    'ls-tree',
    '-z',
    '--full-tree',
    commit,
    '--',
    `:(literal)${CENTRAL_ROLE_PROVIDER_DEFAULT_PATH}`,
  ]);
  let entry: RegExpExecArray | null;
  try {
    entry = TREE_ENTRY.exec(UTF8.decode(entryBytes));
  } catch {
    entry = null;
  }
  if (entry === null || entry[3] !== CENTRAL_ROLE_PROVIDER_DEFAULT_PATH) {
    throw storeError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
      'Pinned central role/provider default must be one exact 100644 blob.',
      ExitCode.verification,
    );
  }
  const bytes = readBlobBytes(root, entry[2]!);
  if (bytes.length === 0 || bytes.length > MAX_CONFIGURATION_BYTES) {
    throw storeError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
      'Pinned central role/provider default exceeds its bounded canonical form.',
      ExitCode.verification,
    );
  }
  const configuration = parseConfigurationBytes(
    bytes,
    'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
  );
  try {
    return createCentralRoleProviderDefaultSnapshotV1({
      pinnedCommit: commit,
      blobObjectId: entry[2]!,
      configuration,
    });
  } catch {
    throw storeError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
      'Pinned central role/provider default does not match its tracked blob identity.',
      ExitCode.verification,
    );
  }
}

/** Re-read the exact commit tree/blob and reject any caller-rebound DTO. */
export function assertPinnedCentralRoleProviderDefaultSnapshot(
  repositoryRoot: string,
  snapshot: CentralRoleProviderDefaultSnapshotV1,
): CentralRoleProviderDefaultSnapshotV1 {
  let admitted: CentralRoleProviderDefaultSnapshotV1;
  try {
    admitted = assertCentralRoleProviderDefaultSnapshotV1(snapshot);
  } catch {
    throw pinnedSnapshotMismatch();
  }
  const pinned = readPinnedCentralRoleProviderDefaultSnapshot(
    repositoryRoot,
    admitted.pinnedCommit,
  );
  if (canonicalJson(pinned) !== canonicalJson(admitted)) {
    throw pinnedSnapshotMismatch();
  }
  return pinned;
}

/**
 * Atomically replace the current worktree candidate only while its exact
 * admitted digest and stable file identity remain current.
 */
export function replaceCurrentCentralRoleProviderDefault(
  repositoryRoot: string,
  expectedConfigurationDigest: string,
  nextConfiguration: CentralRoleProviderDefaultV1,
): CentralRoleProviderDefaultReplacement {
  if (!DIGEST.test(expectedConfigurationDigest)) {
    throw staleConfiguration();
  }
  const before = readCurrentSnapshot(repositoryRoot);
  if (
    before.configuration.configurationDigest !== expectedConfigurationDigest
  ) {
    throw staleConfiguration();
  }
  const rendered = renderCentralRoleProviderDefault(nextConfiguration);
  if (
    Buffer.byteLength(rendered) === 0 ||
    Buffer.byteLength(rendered) > MAX_CONFIGURATION_BYTES
  ) {
    throw unsafeConfiguration();
  }

  const temporaryPath = `${before.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW,
      Number(before.identity.mode & 0o777n),
    );
    temporaryExists = true;
    fs.fchmodSync(descriptor, Number(before.identity.mode & 0o777n));
    fs.writeFileSync(descriptor, rendered, 'utf8');
    fs.fsyncSync(descriptor);
    assertTemporaryFile(temporaryPath, descriptor);

    const immediatelyBeforeRename = readCurrentSnapshot(repositoryRoot);
    if (
      !sameIdentity(before.identity, immediatelyBeforeRename.identity) ||
      !before.bytes.equals(immediatelyBeforeRename.bytes) ||
      immediatelyBeforeRename.configuration.configurationDigest !==
        expectedConfigurationDigest
    ) {
      throw staleConfiguration();
    }

    fs.renameSync(temporaryPath, before.filePath);
    temporaryExists = false;
    fs.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(before.parentPath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryExists) fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  const admitted = readCurrentSnapshot(repositoryRoot).configuration;
  if (admitted.configurationDigest !== nextConfiguration.configurationDigest) {
    throw unsafeConfiguration();
  }
  return Object.freeze({
    path: CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
    previousConfigurationDigest: expectedConfigurationDigest,
    configurationDigest: admitted.configurationDigest,
  });
}

function readCurrentSnapshot(
  repositoryRoot: string,
): CurrentConfigurationSnapshot {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const parentPath = path.join(root, 'workflow');
  const parent = fs.lstatSync(parentPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    parent === undefined ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    fs.realpathSync(parentPath) !== parentPath
  ) {
    throw unsafeConfiguration();
  }
  const filePath = path.join(root, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH);
  const before = fs.lstatSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (before === undefined) {
    throw storeError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_UNAVAILABLE',
      'Central role/provider default is unavailable.',
      ExitCode.verification,
    );
  }
  assertSafeConfigurationStats(before);

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertSafeConfigurationStats(opened);
    if (!sameFile(before, opened)) throw unsafeConfiguration();
    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      current === undefined ||
      BigInt(bytes.length) !== opened.size ||
      !sameStableStats(opened, afterRead) ||
      !sameStableStats(opened, current) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      throw unsafeConfiguration();
    }
    return Object.freeze({
      filePath,
      parentPath,
      identity: identityFromStats(opened),
      bytes,
      configuration: parseConfigurationBytes(
        bytes,
        'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID',
      ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('CENTRAL_ROLE_PROVIDER_DEFAULT_')
    ) {
      throw error;
    }
    throw unsafeConfiguration();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function canonicalRepositoryRoot(repositoryRoot: string): string {
  try {
    const absolute = path.resolve(repositoryRoot);
    const root = fs.realpathSync(absolute);
    const stats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw unsafeConfiguration();
    }
    return root;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'CENTRAL_ROLE_PROVIDER_DEFAULT_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeConfiguration();
  }
}

function parseConfigurationBytes(
  bytes: Uint8Array,
  code:
    | 'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID'
    | 'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
): CentralRoleProviderDefaultV1 {
  let source: string;
  try {
    source = UTF8.decode(bytes);
    return parseCentralRoleProviderDefault(source);
  } catch {
    throw storeError(
      code,
      'Central role/provider default is not canonical UTF-8 JSON.',
      ExitCode.verification,
    );
  }
}

function assertSafeConfigurationStats(stats: fs.BigIntStats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    (stats.mode & 0o111n) !== 0n ||
    (process.platform !== 'win32' && (stats.mode & 0o777n) !== 0o644n) ||
    stats.size < 1n ||
    stats.size > BigInt(MAX_CONFIGURATION_BYTES)
  ) {
    throw unsafeConfiguration();
  }
}

function assertTemporaryFile(filePath: string, descriptor: number): void {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const current = fs.lstatSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    current === undefined ||
    !sameStableStats(opened, current) ||
    opened.nlink !== 1n ||
    (opened.mode & 0o111n) !== 0n
  ) {
    throw unsafeConfiguration();
  }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableStats(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function identityFromStats(stats: fs.BigIntStats): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
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

function staleConfiguration() {
  return storeError(
    'CENTRAL_ROLE_PROVIDER_DEFAULT_STALE',
    'Central role/provider default changed before its atomic replacement.',
    ExitCode.conflict,
  );
}

function pinnedSnapshotMismatch() {
  return storeError(
    'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID',
    'Pinned central role/provider snapshot does not match its exact commit tree and blob.',
    ExitCode.verification,
  );
}

function unsafeConfiguration() {
  return storeError(
    'CENTRAL_ROLE_PROVIDER_DEFAULT_UNSAFE',
    'Central role/provider default storage is unsafe.',
    ExitCode.verification,
  );
}

function storeError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}
