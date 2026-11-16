/** Reads the exact production diff and byte identities used by reconciliation. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { runGit } from '../repository-transaction/git.ts';
import {
  parsePathRoleRegistry,
  type PathRoleRegistry,
} from '../../modules/source/path-role-registry.ts';
import type { ChangedRange } from '../../modules/why-knowledge/semantic-reconciliation.ts';
import {
  canonicalChangedRanges,
  productionSourcePath,
  sha256,
  reconciliationInvalid,
  deepFreeze,
} from '../../modules/why-knowledge/implementation-reconciliation.ts';
type ImplementationTargetInput = Readonly<{
  repositoryRoot: string;
  baseline: Readonly<{ head: string; tree: string }>;
  changedPaths: readonly string[];
}>;
export function deriveImplementationTarget(
  inspection: ImplementationTargetInput,
): {
  digest: string;
  changedRanges: readonly ChangedRange[];
  productionPaths: readonly string[];
} {
  const registry = readBaselinePathRoleRegistry(inspection);
  const productionPaths = inspection.changedPaths.filter((candidatePath) =>
    productionSourcePath(candidatePath, registry),
  );
  const changedRanges = canonicalChangedRanges(
    productionPaths.flatMap((candidatePath) =>
      changedRangesForPath(
        inspection.repositoryRoot,
        inspection.baseline.head,
        candidatePath,
      ),
    ),
  );
  const fileBindings = productionPaths.map((candidatePath) =>
    currentPathBinding(inspection.repositoryRoot, candidatePath),
  );
  return deepFreeze({
    digest: sha256(
      canonicalJson({
        schema: 'implementation-target.v1',
        baseline: inspection.baseline,
        paths: productionPaths,
        files: fileBindings,
        changedRanges,
      }),
    ),
    changedRanges,
    productionPaths,
  });
}

function changedRangesForPath(
  repositoryRoot: string,
  baselineHead: string,
  candidatePath: string,
): ChangedRange[] {
  const baselineExists =
    runGit(
      repositoryRoot,
      ['ls-tree', '-z', baselineHead, '--', candidatePath],
      true,
    ) !== '';
  const currentStats = fs.lstatSync(path.join(repositoryRoot, candidatePath), {
    throwIfNoEntry: false,
  });
  if (!baselineExists && currentStats !== undefined) {
    return [
      {
        path: candidatePath,
        startLine: 1,
        endLine: lineCountForCurrentPath(
          path.join(repositoryRoot, candidatePath),
        ),
      },
    ];
  }
  const diff = runGit(repositoryRoot, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--unified=0',
    baselineHead,
    '--',
    candidatePath,
  ]);
  const ranges: ChangedRange[] = [];
  for (const line of diff.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    const startLine = newCount > 0 ? newStart : oldStart;
    const count = newCount > 0 ? newCount : oldCount;
    ranges.push({
      path: candidatePath,
      startLine: Math.max(1, startLine),
      endLine: Math.max(1, startLine + Math.max(1, count) - 1),
    });
  }
  if (ranges.length === 0 && (baselineExists || currentStats !== undefined)) {
    // Binary changes do not emit textual hunk headers. They remain one exact
    // accountable range rather than silently leaving semantic coverage.
    ranges.push({ path: candidatePath, startLine: 1, endLine: 1 });
  }
  return ranges;
}

function readBaselinePathRoleRegistry(
  inspection: ImplementationTargetInput,
): PathRoleRegistry | null {
  const content = runGit(
    inspection.repositoryRoot,
    ['show', `${inspection.baseline.head}:workflow/path-roles.json`],
    true,
  );
  if (content === '') return null;
  try {
    return parsePathRoleRegistry(JSON.parse(content));
  } catch {
    throw reconciliationInvalid(
      'The task baseline path-role registry is unavailable or malformed.',
    );
  }
}

function currentPathBinding(repositoryRoot: string, candidatePath: string) {
  const absolutePath = path.join(repositoryRoot, candidatePath);
  const before = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (before === undefined) {
    return { path: candidatePath, state: 'deleted' as const };
  }
  if (before.isSymbolicLink()) {
    const target = fs.readlinkSync(absolutePath);
    const after = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (
      after === undefined ||
      !after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw reconciliationInvalid(
        `Implementation path ${candidatePath} changed while it was inspected.`,
      );
    }
    return {
      path: candidatePath,
      state: 'present' as const,
      mode: '120000',
      contentSha256: sha256(target),
    };
  }
  if (!before.isFile()) {
    throw reconciliationInvalid(
      `Implementation path ${candidatePath} is not a regular file or symlink.`,
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw reconciliationInvalid(
        `Implementation path ${candidatePath} changed while it was opened.`,
      );
    }
    const content = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (
      !afterDescriptor.isFile() ||
      afterPath === undefined ||
      !afterPath.isFile() ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw reconciliationInvalid(
        `Implementation path ${candidatePath} changed while it was read.`,
      );
    }
    return {
      path: candidatePath,
      state: 'present' as const,
      mode: (opened.mode & 0o111) === 0 ? '100644' : '100755',
      contentSha256: sha256(content),
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function lineCountForCurrentPath(absolutePath: string): number {
  const stats = fs.lstatSync(absolutePath);
  if (stats.isSymbolicLink()) return 1;
  if (!stats.isFile()) return 1;
  const content = fs.readFileSync(absolutePath);
  if (content.includes(0)) return 1;
  const text = content.toString('utf8');
  if (text.length === 0) return 1;
  return Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
}
