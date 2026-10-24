/** Exact clean checkout and ordinary Git blob projection admission. */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizePolicyPath } from '../../foundation/repository-path/repository-path.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  runGitBuffer,
} from '../repository-transaction/git.ts';
import {
  canonicalRepositoryRoot,
  logicalGitFileMode,
  repositoryRelativePath,
  sameArtifactIdentity,
  type CanonicalRepository,
} from './contract-artifact-observation.ts';
import { readBlobBytes } from '../repository-transaction/git-command.ts';

export type ExactCleanCommittedCheckout = Readonly<{
  repositoryRoot: string;
  commit: string;
  fingerprint: string;
}>;

export function captureExactCleanCommittedCheckout(
  repositoryRootInput: string,
  commit: string,
): ExactCleanCommittedCheckout {
  try {
    const before = discoverRepository(repositoryRootInput);
    if (before.head !== commit || before.statusEntries.length > 0) {
      throw new Error('checkout does not match');
    }
    const fingerprint = fingerprintWorkingState(
      before.repositoryRoot,
      commit,
      before.statusEntries,
    );
    const after = discoverRepository(before.repositoryRoot);
    if (
      after.head !== commit ||
      after.statusEntries.length > 0 ||
      fingerprintWorkingState(
        after.repositoryRoot,
        commit,
        after.statusEntries,
      ) !== fingerprint
    ) {
      throw new Error('checkout changed during observation');
    }
    return Object.freeze({
      repositoryRoot: before.repositoryRoot,
      commit,
      fingerprint,
    });
  } catch {
    throw committedCheckoutInvalid();
  }
}

export function assertCommittedCheckoutUnchanged(
  expected: ExactCleanCommittedCheckout,
): void {
  const observed = captureExactCleanCommittedCheckout(
    expected.repositoryRoot,
    expected.commit,
  );
  if (observed.fingerprint !== expected.fingerprint) {
    throw committedCheckoutInvalid();
  }
}

type CommittedProjectionTreeEntry = Readonly<{
  path: string;
  blob: string;
}>;

export function assertCommittedProjectionMatchesCheckout(
  checkout: ExactCleanCommittedCheckout,
  directoryPaths: string[],
): void {
  assertCommittedCheckoutDirectoryProjection({
    repositoryRoot: checkout.repositoryRoot,
    commit: checkout.commit,
    directoryPaths,
  });
}

export function assertCommittedCheckoutDirectoryProjection(input: {
  repositoryRoot: string;
  commit: string;
  directoryPaths: readonly string[];
}): void {
  try {
    const repository = canonicalRepositoryRoot(input.repositoryRoot);
    const directories = input.directoryPaths.map((directoryPath) => {
      const normalized = normalizePolicyPath(directoryPath);
      if (
        normalized !== directoryPath ||
        directoryPath.endsWith('/') ||
        repositoryRelativePath(
          repository,
          path.join(repository.lexicalRoot, directoryPath),
        ) !== directoryPath
      ) {
        throw new Error('noncanonical projection directory');
      }
      return directoryPath;
    });
    if (
      directories.length === 0 ||
      new Set(directories).size !== directories.length
    ) {
      throw new Error('invalid projection directory set');
    }

    const treeEntries = readCommittedProjectionTree(
      input.repositoryRoot,
      input.commit,
      directories,
    );
    const checkoutEntries = readCheckoutProjection(repository, directories);
    if (
      treeEntries.size !== checkoutEntries.size ||
      [...treeEntries.keys()].some(
        (entryPath) => !checkoutEntries.has(entryPath),
      )
    ) {
      throw new Error('checkout path set differs from commit projection');
    }
    for (const [entryPath, entry] of treeEntries) {
      const checkoutBytes = checkoutEntries.get(entryPath);
      if (checkoutBytes === undefined) {
        throw new Error('committed projection file is absent from checkout');
      }
      const committedBytes = readBlobBytes(input.repositoryRoot, entry.blob);
      if (!checkoutBytes.equals(committedBytes)) {
        throw new Error('checkout bytes differ from committed blob');
      }
    }
  } catch {
    throw committedCheckoutInvalid();
  }
}

function readCommittedProjectionTree(
  repositoryRoot: string,
  commit: string,
  directories: string[],
): Map<string, CommittedProjectionTreeEntry> {
  const output = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
    '--',
    ...directories.map((directory) => `:(literal)${directory}`),
  ]);
  if (output.length === 0 || output.at(-1) !== 0) {
    throw new Error('committed projection tree is empty or malformed');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  const entries = new Map<string, CommittedProjectionTreeEntry>();
  const coveredDirectories = new Set<string>();
  for (const record of text.slice(0, -1).split('\0')) {
    const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/u.exec(
      record,
    );
    if (match === null) {
      throw new Error('committed projection contains a non-100644 blob');
    }
    const entryPath = match[2]!;
    const directory = directories.find((candidate) =>
      entryPath.startsWith(`${candidate}/`),
    );
    if (directory === undefined || entries.has(entryPath)) {
      throw new Error('committed projection path is outside its directory');
    }
    coveredDirectories.add(directory);
    entries.set(entryPath, { path: entryPath, blob: match[1]! });
  }
  if (coveredDirectories.size !== directories.length) {
    throw new Error('committed projection directory is absent or empty');
  }
  return entries;
}

function readCheckoutProjection(
  repository: CanonicalRepository,
  directories: string[],
): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (const directory of directories) {
    const absoluteDirectory = path.join(repository.lexicalRoot, directory);
    const directoryStats = fs.lstatSync(absoluteDirectory, { bigint: true });
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      fs.realpathSync(absoluteDirectory) !==
        path.join(repository.canonicalRoot, directory)
    ) {
      throw new Error('checkout projection directory is not canonical');
    }
    readCheckoutProjectionDirectory(repository, absoluteDirectory, entries);
  }
  return entries;
}

function readCheckoutProjectionDirectory(
  repository: CanonicalRepository,
  directory: string,
  entries: Map<string, Buffer>,
): void {
  for (const directoryEntry of fs.readdirSync(directory, {
    withFileTypes: true,
  })) {
    const absolutePath = path.join(directory, directoryEntry.name);
    const stats = fs.lstatSync(absolutePath, { bigint: true });
    const entryPath = repositoryRelativePath(repository, absolutePath);
    if (entryPath === undefined || stats.isSymbolicLink()) {
      throw new Error('checkout projection entry is not canonical');
    }
    if (stats.isDirectory()) {
      if (
        fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, entryPath)
      ) {
        throw new Error('checkout projection directory aliases another path');
      }
      readCheckoutProjectionDirectory(repository, absolutePath, entries);
      continue;
    }
    if (!stats.isFile() || logicalGitFileMode(stats.mode) !== '100644') {
      throw new Error('checkout projection entry is not a plain 100644 file');
    }
    if (entries.has(entryPath)) {
      throw new Error('checkout projection contains a duplicate path');
    }
    entries.set(
      entryPath,
      readStableCheckoutProjectionFile(
        repository,
        absolutePath,
        entryPath,
        stats,
      ),
    );
  }
}

function readStableCheckoutProjectionFile(
  repository: CanonicalRepository,
  absolutePath: string,
  entryPath: string,
  before: fs.BigIntStats,
): Buffer {
  let descriptor: number | undefined;
  try {
    if (
      fs.realpathSync(absolutePath) !==
      path.join(repository.canonicalRoot, entryPath)
    ) {
      throw new Error('checkout projection file aliases another path');
    }
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
      throw new Error('checkout projection file changed before reading');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !sameArtifactIdentity(opened, after) ||
      !sameArtifactIdentity(before, pathAfter) ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, entryPath)
    ) {
      throw new Error('checkout projection file changed while reading');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function committedCheckoutInvalid(): ReturnType<typeof workflowError> {
  return workflowError(
    'CI_COMMITTED_CHECKOUT_INVALID',
    'Committed change replay requires one exact clean checkout that remains unchanged.',
    ExitCode.staleState,
  );
}
