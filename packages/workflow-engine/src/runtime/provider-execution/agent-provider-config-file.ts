import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  parseAgentProviderConfigToml,
  type AgentProviderConfigSnapshot,
} from '@jigwright/agent-runtime';

const MAX_CONFIG_BYTES = 1_048_576;
type ConfigFileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  uid: bigint;
  gid: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

const loadedAgentProviderConfigFiles = new WeakMap<
  object,
  Readonly<{
    platform: NodeJS.Platform;
    sourcePath: string;
    sourceDigest: string;
    snapshot: AgentProviderConfigSnapshot;
    identity: ConfigFileIdentity;
  }>
>();

export type LoadedAgentProviderConfigFile = Readonly<{
  schemaVersion: 1;
  kind: 'loaded-agent-provider-config-file';
  sourcePath: string;
  sourceDigest: string;
  snapshot: AgentProviderConfigSnapshot;
}>;

export type AgentProviderConfigFileErrorCode =
  | 'AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE'
  | 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE'
  | 'AGENT_PROVIDER_CONFIG_FILE_STALE';

export class AgentProviderConfigFileError extends Error {
  readonly code: AgentProviderConfigFileErrorCode;

  constructor(code: AgentProviderConfigFileErrorCode) {
    super(
      code === 'AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE'
        ? 'Agent provider configuration file is unavailable.'
        : code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE'
          ? 'Agent provider configuration file is unsafe.'
          : 'Agent provider configuration file is stale.',
    );
    this.name = 'AgentProviderConfigFileError';
    this.code = code;
  }
}

/**
 * Read one host-owned provider configuration through a no-follow descriptor and
 * retain the exact source bytes behind an opaque currentness capability.
 */
export function loadAgentProviderConfigFile(
  configPath: string,
  options: Readonly<{ platform: NodeJS.Platform }>,
): LoadedAgentProviderConfigFile {
  const sourcePath = assertCanonicalAbsolutePath(configPath);
  assertSafeConfigParent(sourcePath);
  const source = readSafeConfigSource(sourcePath);
  let document: string;
  try {
    document = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
  } catch {
    throw unsafeConfig();
  }
  const snapshot = parseAgentProviderConfigToml(document, {
    platform: options?.platform,
  });
  const sourceDigest = sha256(source.bytes);
  const loaded = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'loaded-agent-provider-config-file' as const,
    sourcePath,
    sourceDigest,
    snapshot,
  });
  loadedAgentProviderConfigFiles.set(
    loaded,
    Object.freeze({
      platform: options.platform,
      sourcePath,
      sourceDigest,
      snapshot,
      identity: source.identity,
    }),
  );
  return loaded;
}

/**
 * Re-read the exact source before a composition consumer uses the immutable
 * snapshot. Structural clones cannot recover this module-owned capability.
 */
export function assertAgentProviderConfigFileCurrent(
  loaded: LoadedAgentProviderConfigFile,
): AgentProviderConfigSnapshot {
  const binding = loadedAgentProviderConfigFiles.get(loaded);
  if (
    binding === undefined ||
    loaded.sourcePath !== binding.sourcePath ||
    loaded.sourceDigest !== binding.sourceDigest ||
    loaded.snapshot !== binding.snapshot
  ) {
    throw staleConfig();
  }
  const observed = loadAgentProviderConfigFile(binding.sourcePath, {
    platform: binding.platform,
  });
  if (
    observed.sourceDigest !== binding.sourceDigest ||
    observed.snapshot.configDigest !== binding.snapshot.configDigest ||
    !sameIdentity(
      loadedAgentProviderConfigFiles.get(observed)!.identity,
      binding.identity,
    )
  ) {
    throw staleConfig();
  }
  return binding.snapshot;
}

function readSafeConfigSource(sourcePath: string): Readonly<{
  bytes: Buffer;
  identity: ConfigFileIdentity;
}> {
  const before = fs.lstatSync(sourcePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (before === undefined) throw unavailableConfig();
  assertSafeConfigStats(before);
  let realPath: string;
  try {
    realPath = fs.realpathSync(sourcePath);
  } catch {
    throw unavailableConfig();
  }
  if (realPath !== sourcePath) throw unsafeConfig();

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      sourcePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertSafeConfigStats(opened);
    if (!sameFile(before, opened)) throw unsafeConfig();
    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(sourcePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      BigInt(bytes.byteLength) !== opened.size ||
      current === undefined ||
      !sameStableFile(opened, afterRead) ||
      !sameStableFile(opened, current) ||
      fs.realpathSync(sourcePath) !== sourcePath
    ) {
      throw unsafeConfig();
    }
    return Object.freeze({ bytes, identity: identityFromStats(opened) });
  } catch (error) {
    if (error instanceof AgentProviderConfigFileError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw unavailableConfig();
    }
    throw unsafeConfig();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSafeConfigParent(sourcePath: string): void {
  const parent = path.dirname(sourcePath);
  const stats = fs.lstatSync(parent, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    stats === undefined ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent ||
    (process.platform !== 'win32' && (stats.mode & 0o022n) !== 0n) ||
    (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      stats.uid !== BigInt(process.getuid()))
  ) {
    throw unsafeConfig();
  }
}

function assertCanonicalAbsolutePath(candidate: unknown): string {
  if (
    typeof candidate !== 'string' ||
    !path.isAbsolute(candidate) ||
    path.resolve(candidate) !== candidate ||
    candidate.includes('\0')
  ) {
    throw unsafeConfig();
  }
  return candidate;
}

function assertSafeConfigStats(stats: fs.BigIntStats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.size < 1n ||
    stats.size > BigInt(MAX_CONFIG_BYTES) ||
    (process.platform !== 'win32' && (stats.mode & 0o022n) !== 0n) ||
    (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      stats.uid !== BigInt(process.getuid()))
  ) {
    throw unsafeConfig();
  }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function identityFromStats(stats: fs.BigIntStats): ConfigFileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  });
}

function sameIdentity(
  left: ConfigFileIdentity,
  right: ConfigFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function unavailableConfig(): AgentProviderConfigFileError {
  return new AgentProviderConfigFileError(
    'AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE',
  );
}

function unsafeConfig(): AgentProviderConfigFileError {
  return new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_UNSAFE');
}

function staleConfig(): AgentProviderConfigFileError {
  return new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_STALE');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
