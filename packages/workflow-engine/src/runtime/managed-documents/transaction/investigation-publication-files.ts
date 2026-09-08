/**
 * Reads and replaces publication files through stable directory and descriptor identities.
 *
 * Invariants:
 * - No-follow reads and anchored writes retain inode, directory, and repository containment checks.
 * - Replacement compensation, temporary cleanup, and fsync keep their original order.
 *
 * Depends on: publication path contracts, Node filesystem operations, and repository discovery.
 * Failure modes: path aliases trusted, concurrent replacements overwritten, or incomplete durable publication.
 */
import crypto from 'node:crypto';
import {
  digest,
  isCanonicalPublicationRelativePath,
  publicationFailure,
  UUID_V4,
  PublicationFailure,
} from './investigation-publication-values.ts';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';

export function publicationRefDigest(
  repositoryRoot: string,
  relativePath: string,
): string {
  const observed = readStablePublicationFile(repositoryRoot, relativePath);
  if (observed === null) {
    return digest({
      schema: 'investigation-publication-ref-state.v1',
      exists: false,
    });
  }
  return digest({
    schema: 'investigation-publication-ref-state.v1',
    exists: true,
    contentSha256: crypto.createHash('sha256').update(observed).digest('hex'),
  });
}

export function resolveRelative(
  repositoryRoot: string,
  relativePath: string,
): string {
  if (!isCanonicalPublicationRelativePath(relativePath)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path must be repository-relative.',
    );
  }
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path escapes the repository.',
    );
  }
  assertPlainPublicationDirectoryChain(root, path.dirname(absolute), true);
  return absolute;
}

export function removeAbandonedCandidateTemporaries(
  repositoryRoot: string,
  candidatePath: string,
): void {
  const directory = path.dirname(candidatePath);
  assertPlainPublicationDirectoryChain(repositoryRoot, directory, false);
  const prefix = `${path.basename(candidatePath)}.`;
  let removed = false;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const segments = suffix.split('.');
    if (
      segments.length !== 3 ||
      !/^[1-9][0-9]*$/.test(segments[0]!) ||
      !UUID_V4.test(segments[1]!) ||
      segments[2] !== 'tmp'
    ) {
      continue;
    }
    const temporary = path.join(directory, name);
    const observed = fs.lstatSync(temporary, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (observed === undefined) continue;
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1n
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Abandoned publication temporary is not a plain single-link file.',
      );
    }
    fs.unlinkSync(temporary);
    removed = true;
  }
  if (removed) fsyncDirectory(directory);
}

export function writeCanonical(
  filePath: string,
  value: unknown,
  storageRoot: string = publicationRepositoryRoot(filePath),
  mode = 0o600,
): void {
  const repositoryRoot = fs.realpathSync(path.resolve(storageRoot));
  const directory = path.dirname(filePath);
  ensurePlainPublicationDirectoryChain(repositoryRoot, directory);
  const parentIdentity = assertPlainPublicationDirectoryChain(
    repositoryRoot,
    directory,
    false,
  );
  const targetName = path.basename(filePath);
  const temporaryName = `${targetName}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let installedIdentity: fs.BigIntStats | null = null;
  try {
    withAnchoredPublicationDirectory(
      repositoryRoot,
      directory,
      parentIdentity,
      () => {
        let descriptor: number | null = null;
        let temporaryIdentity: fs.BigIntStats | null = null;
        let replacementIdentity: fs.BigIntStats | null = null;
        let replacementInstalled = false;
        let previous: PublicationFilePreimage | null = null;
        try {
          descriptor = fs.openSync(
            temporaryName,
            fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_RDWR |
              (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
            mode,
          );
          temporaryIdentity = fs.fstatSync(descriptor, { bigint: true });
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);

          const bytes = Buffer.from(`${canonicalJson(value)}\n`);
          fs.writeFileSync(descriptor, bytes);
          fs.fsyncSync(descriptor);
          const afterWrite = fs.fstatSync(descriptor, { bigint: true });
          if (
            temporaryIdentity.dev !== afterWrite.dev ||
            temporaryIdentity.ino !== afterWrite.ino ||
            !afterWrite.isFile() ||
            afterWrite.nlink !== 1n ||
            afterWrite.size !== BigInt(bytes.length) ||
            Number(afterWrite.mode & 0o777n) !== mode
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication temporary file changed while it was written.',
            );
          }
          const existing = fs.lstatSync(targetName, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            existing !== undefined &&
            (!existing.isFile() ||
              existing.isSymbolicLink() ||
              existing.nlink !== 1n)
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication target is not a plain file.',
            );
          }
          previous =
            existing === undefined
              ? null
              : readAnchoredPublicationPreimage(targetName, existing);

          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          fs.renameSync(temporaryName, targetName);
          replacementInstalled = true;
          replacementIdentity = afterWrite;
          const installed = fs.lstatSync(targetName, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            installed === undefined ||
            installed.dev !== afterWrite.dev ||
            installed.ino !== afterWrite.ino
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication target changed during atomic replacement.',
            );
          }
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          fsyncDirectory('.');
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          installedIdentity = installed;
        } catch (error) {
          if (descriptor !== null) {
            fs.closeSync(descriptor);
            descriptor = null;
          }
          if (replacementInstalled && replacementIdentity !== null) {
            compensateAnchoredPublicationReplacement(
              targetName,
              replacementIdentity,
              previous,
            );
          } else if (temporaryIdentity !== null) {
            unlinkAnchoredPublicationFile(temporaryName, temporaryIdentity);
          }
          throw error;
        } finally {
          if (descriptor !== null) fs.closeSync(descriptor);
        }
      },
    );
    const installed = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const afterRename = assertPlainPublicationDirectoryChain(
      repositoryRoot,
      directory,
      false,
    );
    if (
      installedIdentity === null ||
      installed === undefined ||
      !samePublicationFileIdentity(installedIdentity, installed) ||
      !samePublicationDirectoryChain(parentIdentity, afterRename)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication target or parent changed during atomic replacement.',
      );
    }
  } catch (error) {
    if (error instanceof PublicationFailure) throw error;
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      error instanceof Error
        ? `Publication write failed safely: ${error.message}`
        : 'Publication write failed safely.',
    );
  }
}

function ensurePlainPublicationDirectoryChain(
  repositoryRoot: string,
  directory: string,
): void {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication directory escapes the repository.',
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = fs.lstatSync(current, { throwIfNoEntry: false });
    if (existing === undefined) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const observed = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      observed === undefined ||
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-plain ancestor directory.',
      );
    }
  }
}

function unlinkAnchoredPublicationFile(
  name: string,
  expected: fs.BigIntStats,
): void {
  try {
    const observed = fs.lstatSync(name, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      observed !== undefined &&
      observed.isFile() &&
      !observed.isSymbolicLink() &&
      observed.dev === expected.dev &&
      observed.ino === expected.ino
    ) {
      fs.unlinkSync(name);
    }
  } catch {
    // A changed pathname is never followed or removed.
  }
}

type PublicationFilePreimage = Readonly<{
  bytes: Buffer;
  mode: number;
}>;

export function readAnchoredPublicationPreimage(
  name: string,
  expected: fs.BigIntStats,
): PublicationFilePreimage {
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !samePublicationFileIdentity(expected, before) ||
      !samePublicationFileIdentity(before, after)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication target changed while its recovery preimage was read.',
      );
    }
    return {
      bytes,
      mode: Number(expected.mode & 0o777n),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function compensateAnchoredPublicationReplacement(
  targetName: string,
  installed: fs.BigIntStats,
  previous: PublicationFilePreimage | null,
): void {
  const observed = fs.lstatSync(targetName, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    observed === undefined ||
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.dev !== installed.dev ||
    observed.ino !== installed.ino
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication replacement could not be identified for compensation.',
    );
  }
  if (previous === null) {
    fs.unlinkSync(targetName);
    fsyncDirectory('.');
    return;
  }

  const recoveryName = `${targetName}.${process.pid}.${crypto.randomUUID()}.restore`;
  let descriptor: number | null = null;
  let recoveryIdentity: fs.BigIntStats | null = null;
  try {
    descriptor = fs.openSync(
      recoveryName,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_RDWR |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      previous.mode,
    );
    fs.fchmodSync(descriptor, previous.mode);
    fs.writeFileSync(descriptor, previous.bytes);
    fs.fsyncSync(descriptor);
    recoveryIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (
      !recoveryIdentity.isFile() ||
      recoveryIdentity.nlink !== 1n ||
      recoveryIdentity.size !== BigInt(previous.bytes.length) ||
      Number(recoveryIdentity.mode & 0o777n) !== previous.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage could not be materialized safely.',
      );
    }
    fs.renameSync(recoveryName, targetName);
    const restoredStats = fs.lstatSync(targetName, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      restoredStats === undefined ||
      !restoredStats.isFile() ||
      restoredStats.isSymbolicLink() ||
      Number(restoredStats.mode & 0o777n) !== previous.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage mode was not restored exactly.',
      );
    }
    const restored = readAnchoredPublicationPreimage(targetName, restoredStats);
    if (!restored.bytes.equals(previous.bytes)) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage was not restored exactly.',
      );
    }
    recoveryIdentity = null;
    fsyncDirectory('.');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (recoveryIdentity !== null) {
      unlinkAnchoredPublicationFile(recoveryName, recoveryIdentity);
    }
  }
}

export function withAnchoredPublicationDirectory<T>(
  repositoryRoot: string,
  directory: string,
  expected: readonly PublicationDirectoryIdentity[],
  operation: () => T,
): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    const anchored = fs.lstatSync('.', { bigint: true });
    const parent = expected.at(-1);
    if (
      parent === undefined ||
      !anchored.isDirectory() ||
      anchored.isSymbolicLink() ||
      anchored.dev !== parent.dev ||
      anchored.ino !== parent.ino ||
      anchored.mode !== parent.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication parent directory could not be anchored safely.',
      );
    }
    assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
    const result = operation();
    assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
    return result;
  } finally {
    process.chdir(previous);
  }
}

export function assertAnchoredPublicationDirectoryInsideRepository(
  repositoryRoot: string,
): void {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const anchored = fs.realpathSync('.');
  if (anchored !== root && !anchored.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication parent directory moved outside the repository.',
    );
  }
}

export function readJson(
  filePath: string,
  storageRoot = publicationRepositoryRoot(filePath),
): unknown {
  const repositoryRoot = fs.realpathSync(path.resolve(storageRoot));
  const relativePath = path.relative(repositoryRoot, filePath);
  let bytes: Buffer | null;
  try {
    bytes = readStablePublicationFile(repositoryRoot, relativePath);
  } catch {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  if (bytes === null) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  const text = bytes.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact is not JSON.',
    );
  }
  if (text !== `${canonicalJson(value)}\n`) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact is not canonical JSON.',
    );
  }
  return value;
}

type PublicationDirectoryIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
}>;

export function readStablePublicationFile(
  repositoryRoot: string,
  relativePath: string,
): Buffer | null {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const absolute = resolveRelative(root, relativePath);
  const pathBefore = fs.lstatSync(absolute, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (pathBefore === undefined) return null;
  const parentBefore = assertPlainPublicationDirectoryChain(
    root,
    path.dirname(absolute),
    false,
  );
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1n
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact path is unsafe.',
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact could not be opened safely.',
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const parentAfter = assertPlainPublicationDirectoryChain(
      root,
      path.dirname(absolute),
      false,
    );
    if (
      pathAfter === undefined ||
      !samePublicationFileIdentity(pathBefore, before) ||
      !samePublicationFileIdentity(before, after) ||
      !samePublicationFileIdentity(after, pathAfter) ||
      !samePublicationDirectoryChain(parentBefore, parentAfter)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication artifact changed while it was observed.',
      );
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertPlainPublicationDirectoryChain(
  repositoryRoot: string,
  directory: string,
  allowMissing: boolean,
): readonly PublicationDirectoryIdentity[] {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  if (root !== path.resolve(repositoryRoot)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication repository root is not canonical.',
    );
  }
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication directory escapes the repository.',
    );
  }
  const identities: PublicationDirectoryIdentity[] = [];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (stats === undefined) {
      if (allowMissing) break;
      throw publicationFailure(
        'REPLAY_INPUT_MISSING',
        'Publication artifact directory is absent.',
      );
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-plain ancestor directory.',
      );
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(current);
    } catch {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication directory could not be resolved safely.',
      );
    }
    if (canonical !== current) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-canonical ancestor directory.',
      );
    }
    identities.push({
      path: current,
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
    });
  }
  return identities;
}

export function samePublicationFileIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.isFile() &&
    observed.isFile() &&
    !observed.isSymbolicLink() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

export function samePublicationDirectoryChain(
  expected: readonly PublicationDirectoryIdentity[],
  observed: readonly PublicationDirectoryIdentity[],
): boolean {
  return (
    expected.length === observed.length &&
    expected.every((entry, index) => {
      const current = observed[index];
      return (
        current !== undefined &&
        entry.path === current.path &&
        entry.dev === current.dev &&
        entry.ino === current.ino &&
        entry.mode === current.mode
      );
    })
  );
}

export function publicationRepositoryRoot(filePath: string): string {
  let current = path.resolve(path.dirname(filePath));
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  throw publicationFailure(
    'MANIFEST_UNREPRESENTABLE',
    'Publication artifact is not inside a repository.',
  );
}

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
