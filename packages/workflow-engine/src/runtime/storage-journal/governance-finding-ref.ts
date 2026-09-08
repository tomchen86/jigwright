/**
 * Persist immutable Finding records in a Git branch received by ordinary clones.
 *
 * Invariants:
 * - Records merge by exact bytes; competing writes never overwrite a record.
 * - Publication uses ref CAS and leaves the task branch, worktree and index alone.
 * - Readers use pinned local and remote-tracking commits without fetching or writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit, runGitBuffer } from '../repository-transaction/git.ts';
import {
  GOVERNANCE_FINDING_REF,
  isFindingRefRecordPath,
  isFindingRefDirectoryPath,
  findingRefUnsafe,
} from '../../modules/governance-intake/governance-finding-ref.ts';

const REMOTE_SUFFIX = '/jigwright/findings';

type FindingRefSnapshot = Readonly<{
  gitDirectory: string | null;
  localHead: string | null;
  heads: readonly string[];
  records: ReadonlyMap<string, Buffer>;
}>;

export function readFindingRef(runtimeRoot: string): FindingRefSnapshot {
  const gitDirectory = findingGitDirectory(runtimeRoot);
  if (gitDirectory === null)
    return { gitDirectory, localHead: null, heads: [], records: new Map() };
  const refs = runGit(gitDirectory, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    GOVERNANCE_FINDING_REF,
    'refs/remotes/',
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ') as [string, string])
    .filter(
      ([ref]) =>
        ref === GOVERNANCE_FINDING_REF ||
        (ref.startsWith('refs/remotes/') && ref.endsWith(REMOTE_SUFFIX)),
    );
  const heads = [...new Set(refs.map(([, oid]) => oid))];
  const records = new Map<string, Buffer>();
  for (const head of heads) {
    const entries = runGitBuffer(gitDirectory, ['ls-tree', '-rzt', head])
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    for (const entry of entries) {
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t(.+)$/.exec(
        entry,
      );
      if (match === null) throw findingRefUnsafe(entry);
      const [, mode = '', type = '', oid = '', recordPath = ''] = match;
      if (
        type === 'tree' &&
        mode === '040000' &&
        isFindingRefDirectoryPath(recordPath)
      )
        continue;
      if (
        type !== 'blob' ||
        mode !== '100644' ||
        !isFindingRefRecordPath(recordPath)
      )
        throw findingRefUnsafe(recordPath);
      const bytes = runGitBuffer(gitDirectory, ['cat-file', 'blob', oid]);
      const existing = records.get(recordPath);
      if (existing !== undefined && !existing.equals(bytes))
        throw findingRefCollision(recordPath);
      records.set(recordPath, bytes);
    }
  }
  return {
    gitDirectory,
    heads,
    localHead:
      refs.find(([ref]) => ref === GOVERNANCE_FINDING_REF)?.[1] ?? null,
    records,
  };
}

export function publishFindingRefRecord(
  runtimeRoot: string,
  recordPath: string,
  bytes: Buffer,
): boolean {
  if (!isFindingRefRecordPath(recordPath)) throw findingRefUnsafe(recordPath);
  for (;;) {
    const before = readFindingRef(runtimeRoot);
    const { gitDirectory } = before;
    if (gitDirectory === null) {
      throw workflowError(
        'GOVERNANCE_FINDING_REPOSITORY_REQUIRED',
        'Finding storage requires a runtime rooted in the repository Git directory.',
        ExitCode.unsafeEnvironment,
      );
    }
    const existing = before.records.get(recordPath);
    if (existing !== undefined) {
      if (existing.equals(bytes)) return false;
      throw findingRefCollision(recordPath);
    }
    const records = new Map(before.records).set(recordPath, bytes);
    const tree = writeFindingTree(gitDirectory, records);
    const commit = runGit(gitDirectory, [
      '-c',
      'user.name=Jigwright',
      '-c',
      'user.email=jigwright@localhost',
      'commit-tree',
      tree,
      ...before.heads.flatMap((head) => ['-p', head]),
      '-m',
      `Record ${recordPath}`,
    ]).trim();
    try {
      runGit(gitDirectory, [
        '-c',
        'core.filesRefLockTimeout=5000',
        'update-ref',
        GOVERNANCE_FINDING_REF,
        commit,
        before.localHead ?? '0'.repeat(commit.length),
      ]);
      return true;
    } catch (error) {
      const current =
        runGit(
          gitDirectory,
          ['rev-parse', '--verify', '--quiet', GOVERNANCE_FINDING_REF],
          true,
        ).trim() || null;
      if (current === before.localHead) throw error;
    }
  }
}

function writeFindingTree(
  gitDirectory: string,
  records: ReadonlyMap<string, Buffer>,
): string {
  const sessions = new Map<string, string[]>();
  for (const [recordPath, bytes] of records) {
    const [, session, name] = recordPath.split('/') as [string, string, string];
    const oid = runGitBuffer(gitDirectory, ['hash-object', '-w', '--stdin'], {
      input: bytes,
    })
      .toString('utf8')
      .trim();
    const entries = sessions.get(session) ?? [];
    entries.push(`100644 blob ${oid}\t${name}\0`);
    sessions.set(session, entries);
  }
  const tree = (entries: string[]) =>
    runGitBuffer(gitDirectory, ['mktree', '-z'], {
      input: Buffer.from(entries.sort().join('')),
    })
      .toString('utf8')
      .trim();
  const findings = tree(
    [...sessions].map(
      ([session, entries]) => `040000 tree ${tree(entries)}\t${session}\0`,
    ),
  );
  return tree([`040000 tree ${findings}\tfindings\0`]);
}

function findingGitDirectory(runtimeRoot: string): string | null {
  let directory = path.resolve(runtimeRoot);
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return (
    runGit(
      directory,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      true,
    ).trim() || null
  );
}

function findingRefCollision(recordPath: string) {
  return workflowError(
    recordPath.endsWith('.disposition.json')
      ? 'GOVERNANCE_FINDING_DISPOSITION_COLLISION'
      : 'GOVERNANCE_FINDING_COLLISION',
    'Finding Git records disagree; the existing records were preserved.',
    ExitCode.conflict,
    { details: { ref: GOVERNANCE_FINDING_REF, path: recordPath } },
  );
}
