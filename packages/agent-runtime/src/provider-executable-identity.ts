import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HASH_CHUNK_BYTES = 64 * 1024;
export const MAX_PROVIDER_EXECUTABLE_BYTES = 1024 * 1024 * 1024;

export type ProviderExecutableIdentity = Readonly<{
  candidatePath: string;
  realPath: string;
  device: string;
  inode: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeNs: string;
  sha256: string;
}>;

export type ProviderExecutableUnsafeReason =
  | 'PATH_INVALID'
  | 'NON_REGULAR_FILE'
  | 'EMPTY_FILE'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'NOT_EXECUTABLE'
  | 'GROUP_OR_WORLD_WRITABLE'
  | 'MULTIPLE_HARD_LINKS'
  | 'OWNER_NOT_ADMITTED'
  | 'UNREADABLE'
  | 'IDENTITY_DRIFT';

export type ProviderExecutableObservation = Readonly<{
  schemaVersion: 1;
  kind: 'provider-executable-observation';
  candidatePath: string;
  state: 'observed' | 'absent' | 'unsafe';
  unsafeReason: ProviderExecutableUnsafeReason | null;
  identity: ProviderExecutableIdentity | null;
}>;

type InspectedExecutable = Readonly<{
  value: ProviderExecutableObservation;
  currentnessFingerprint: string;
}>;

const executableObservationBindings = new WeakMap<
  ProviderExecutableObservation,
  Readonly<{
    candidatePath: string;
    currentnessFingerprint: string;
    identity: ProviderExecutableIdentity | null;
  }>
>();

export class ProviderExecutableObservationError extends Error {
  readonly code = 'PROVIDER_EXECUTABLE_OBSERVATION_STALE';

  constructor() {
    super('Provider executable observation is stale.');
    this.name = 'ProviderExecutableObservationError';
  }
}

/**
 * Inspect exactly one caller-selected absolute candidate without executing it.
 * The descriptor is read in fixed-size chunks and the result retains an opaque
 * currentness capability; the observation itself is not availability evidence.
 */
export function inspectProviderExecutable(
  candidatePath: string,
): ProviderExecutableObservation {
  const inspected = inspectExecutable(candidatePath);
  executableObservationBindings.set(
    inspected.value,
    Object.freeze({
      candidatePath,
      currentnessFingerprint: inspected.currentnessFingerprint,
      identity: inspected.value.identity,
    }),
  );
  return inspected.value;
}

/**
 * Re-observe one module-created observation. A structural clone, atomic path
 * replacement, metadata change, or content change fails closed.
 */
export function assertProviderExecutableObservationCurrent(
  observation: ProviderExecutableObservation,
): ProviderExecutableObservation {
  const binding = executableObservationBindings.get(observation);
  if (
    binding === undefined ||
    observation.candidatePath !== binding.candidatePath ||
    observation.identity !== binding.identity
  ) {
    throw staleObservation();
  }
  const current = inspectExecutable(binding.candidatePath);
  if (
    current.currentnessFingerprint !== binding.currentnessFingerprint ||
    !samePublicObservation(current.value, observation)
  ) {
    throw staleObservation();
  }
  return observation;
}

/** Root-owned package files and files owned by the current process owner. */
export function isProviderExecutableOwnerAdmitted(uid: number): boolean {
  if (process.platform === 'win32') return true;
  if (!Number.isSafeInteger(uid) || uid < 0) return false;
  if (uid === 0) return true;
  return typeof process.getuid === 'function' && uid === process.getuid();
}

function inspectExecutable(candidatePath: string): InspectedExecutable {
  if (!isCanonicalAbsolutePath(candidatePath)) {
    return unsafe(candidatePath, 'PATH_INVALID', `invalid:${candidatePath}`);
  }

  let candidateStats: fs.BigIntStats | undefined;
  try {
    candidateStats = fs.lstatSync(candidatePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
  } catch {
    return unsafe(candidatePath, 'UNREADABLE', `unreadable:${candidatePath}`);
  }
  if (candidateStats === undefined) {
    return absent(candidatePath);
  }
  const candidateFingerprint = statsFingerprint(candidateStats);
  if (!candidateStats.isFile() && !candidateStats.isSymbolicLink()) {
    return unsafe(
      candidatePath,
      'NON_REGULAR_FILE',
      `unsafe:${candidateFingerprint}:NON_REGULAR_FILE`,
    );
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(candidatePath);
  } catch {
    return unsafe(
      candidatePath,
      'IDENTITY_DRIFT',
      `unsafe:${candidateFingerprint}:IDENTITY_DRIFT`,
    );
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      realPath,
      fs.constants.O_RDONLY | noFollowFlag() | nonBlockingFlag(),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const unsafeReason = unsafeStatsReason(opened);
    if (unsafeReason !== null) {
      return unsafe(
        candidatePath,
        unsafeReason,
        `unsafe:${candidateFingerprint}:${realPath}:${statsFingerprint(opened)}:${unsafeReason}`,
      );
    }
    try {
      fs.accessSync(realPath, fs.constants.X_OK);
    } catch {
      return unsafe(
        candidatePath,
        'NOT_EXECUTABLE',
        `unsafe:${candidateFingerprint}:${realPath}:${statsFingerprint(opened)}:NOT_EXECUTABLE`,
      );
    }
    if (
      opened.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      opened.uid > BigInt(Number.MAX_SAFE_INTEGER) ||
      opened.gid > BigInt(Number.MAX_SAFE_INTEGER) ||
      opened.mode > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return unsafe(
        candidatePath,
        'UNREADABLE',
        `unsafe:${candidateFingerprint}:${realPath}:UNREADABLE`,
      );
    }

    const sha256 = hashDescriptorInFixedChunks(descriptor, opened.size);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const currentCandidate = fs.lstatSync(candidatePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const currentTarget = fs.lstatSync(realPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      currentCandidate === undefined ||
      currentTarget === undefined ||
      fs.realpathSync(candidatePath) !== realPath ||
      !sameStableStats(candidateStats, currentCandidate) ||
      !sameStableStats(opened, afterRead) ||
      !sameStableStats(opened, currentTarget)
    ) {
      return unsafe(
        candidatePath,
        'IDENTITY_DRIFT',
        `unsafe:${candidateFingerprint}:${realPath}:IDENTITY_DRIFT`,
      );
    }
    const identity = deepFreeze({
      candidatePath,
      realPath,
      device: String(opened.dev),
      inode: String(opened.ino),
      mode: Number(opened.mode),
      uid: Number(opened.uid),
      gid: Number(opened.gid),
      size: Number(opened.size),
      mtimeNs: String(opened.mtimeNs),
      sha256,
    });
    return Object.freeze({
      value: deepFreeze({
        schemaVersion: 1 as const,
        kind: 'provider-executable-observation' as const,
        candidatePath,
        state: 'observed' as const,
        unsafeReason: null,
        identity,
      }),
      currentnessFingerprint: [
        'observed',
        candidateFingerprint,
        realPath,
        statsFingerprint(opened),
        sha256,
      ].join(':'),
    });
  } catch {
    return unsafe(
      candidatePath,
      'UNREADABLE',
      `unsafe:${candidateFingerprint}:${realPath}:UNREADABLE`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unsafeStatsReason(
  stats: fs.BigIntStats,
): ProviderExecutableUnsafeReason | null {
  if (!stats.isFile() || stats.isSymbolicLink()) return 'NON_REGULAR_FILE';
  if (stats.nlink !== 1n) return 'MULTIPLE_HARD_LINKS';
  if (stats.size === 0n) return 'EMPTY_FILE';
  if (stats.size > BigInt(MAX_PROVIDER_EXECUTABLE_BYTES)) {
    return 'SIZE_LIMIT_EXCEEDED';
  }
  if (process.platform !== 'win32' && (stats.mode & 0o111n) === 0n) {
    return 'NOT_EXECUTABLE';
  }
  if (process.platform !== 'win32' && (stats.mode & 0o022n) !== 0n) {
    return 'GROUP_OR_WORLD_WRITABLE';
  }
  if (!isProviderExecutableOwnerAdmittedBigInt(stats.uid)) {
    return 'OWNER_NOT_ADMITTED';
  }
  return null;
}

function isProviderExecutableOwnerAdmittedBigInt(uid: bigint): boolean {
  if (process.platform === 'win32') return true;
  if (uid === 0n) return true;
  return (
    typeof process.getuid === 'function' && uid === BigInt(process.getuid())
  );
}

function hashDescriptorInFixedChunks(descriptor: number, size: bigint): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let offset = 0n;
  while (offset < size) {
    const remaining = size - offset;
    const requested = Number(
      remaining < BigInt(buffer.byteLength)
        ? remaining
        : BigInt(buffer.byteLength),
    );
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      requested,
      Number(offset),
    );
    if (bytesRead !== requested) throw new Error('short executable read');
    hash.update(buffer.subarray(0, bytesRead));
    offset += BigInt(bytesRead);
  }
  return hash.digest('hex');
}

function absent(candidatePath: string): InspectedExecutable {
  return Object.freeze({
    value: deepFreeze({
      schemaVersion: 1 as const,
      kind: 'provider-executable-observation' as const,
      candidatePath,
      state: 'absent' as const,
      unsafeReason: null,
      identity: null,
    }),
    currentnessFingerprint: `absent:${candidatePath}`,
  });
}

function unsafe(
  candidatePath: string,
  unsafeReason: ProviderExecutableUnsafeReason,
  currentnessFingerprint: string,
): InspectedExecutable {
  return Object.freeze({
    value: deepFreeze({
      schemaVersion: 1 as const,
      kind: 'provider-executable-observation' as const,
      candidatePath,
      state: 'unsafe' as const,
      unsafeReason,
      identity: null,
    }),
    currentnessFingerprint,
  });
}

function samePublicObservation(
  left: ProviderExecutableObservation,
  right: ProviderExecutableObservation,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.candidatePath === right.candidatePath &&
    left.state === right.state &&
    left.unsafeReason === right.unsafeReason &&
    sameIdentity(left.identity, right.identity)
  );
}

function sameIdentity(
  left: ProviderExecutableIdentity | null,
  right: ProviderExecutableIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.candidatePath === right.candidatePath &&
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.sha256 === right.sha256
  );
}

function sameStableStats(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function statsFingerprint(stats: fs.BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.uid,
    stats.gid,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(':');
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function noFollowFlag(): number {
  if (process.platform === 'win32') return 0;
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw new Error('no-follow executable inspection is unavailable');
  }
  return fs.constants.O_NOFOLLOW;
}

function nonBlockingFlag(): number {
  if (process.platform === 'win32') return 0;
  if (typeof fs.constants.O_NONBLOCK !== 'number') {
    throw new Error('non-blocking executable inspection is unavailable');
  }
  return fs.constants.O_NONBLOCK;
}

function staleObservation(): ProviderExecutableObservationError {
  return new ProviderExecutableObservationError();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
