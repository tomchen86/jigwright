/** Actual patch tree projection and worktree effects; task admission stays in application. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeChangedPath } from '../../foundation/repository-path/repository-path.ts';
import { runGit, runGitBuffer, runGitWithEnvironment } from './git.ts';
import type { TaskStrategyPatchEntry } from '../../modules/assurance/task-strategy-evidence.ts';

export function createBinaryPatch(
  repositoryRoot: string,
  sourceTree: string,
  candidateTree: string,
): Buffer {
  return runGitBuffer(repositoryRoot, [
    'diff',
    '--binary',
    '--full-index',
    '--no-renames',
    '--diff-algorithm=myers',
    sourceTree,
    candidateTree,
    '--',
  ]);
}
export function applyPatchToWorktree(
  repositoryRoot: string,
  patchBytes: Buffer,
  reverse = false,
): void {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-task-patch-import-'),
  );
  const patchPath = path.join(temporaryDirectory, 'candidate.patch');
  try {
    fs.writeFileSync(patchPath, patchBytes, { flag: 'wx', mode: 0o600 });
    try {
      runGit(repositoryRoot, [
        'apply',
        ...(reverse ? ['--reverse'] : []),
        '--binary',
        '--whitespace=error-all',
        '--recount',
        '--',
        patchPath,
      ]);
    } catch {
      throw workflowError(
        'TASK_STRATEGY_PATCH_IMPORT_FAILED',
        reverse
          ? 'The exact current implementation patch could not be restored to its sealed RED source tree.'
          : 'The validated implementation patch could not be applied to the exact RED worktree.',
        ExitCode.staleState,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function applyPatchToIsolatedTree(
  repositoryRoot: string,
  sourceTree: string,
  patchBytes: Buffer,
): {
  candidateTree: string;
  changedPaths: string[];
} {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-task-patch-'),
  );
  const indexEnvironment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  const patchPath = path.join(temporaryDirectory, 'candidate.patch');
  try {
    fs.writeFileSync(patchPath, patchBytes, { flag: 'wx', mode: 0o600 });
    runGitWithEnvironment(
      repositoryRoot,
      ['read-tree', sourceTree],
      indexEnvironment,
    );
    try {
      runGitWithEnvironment(
        repositoryRoot,
        [
          'apply',
          '--cached',
          '--binary',
          '--whitespace=error-all',
          '--recount',
          '--',
          patchPath,
        ],
        indexEnvironment,
      );
    } catch {
      throw workflowError(
        'TASK_STRATEGY_PATCH_INVALID',
        'The implementation patch does not apply exactly to the sealed RED tree.',
        ExitCode.verification,
      );
    }
    const candidateTree = runGitWithEnvironment(
      repositoryRoot,
      ['write-tree'],
      indexEnvironment,
    ).trim();
    const changedPaths = runGitWithEnvironment(
      repositoryRoot,
      [
        'diff',
        '--cached',
        '--name-only',
        '--no-renames',
        '-z',
        sourceTree,
        '--',
      ],
      indexEnvironment,
    )
      .split('\0')
      .filter(Boolean)
      .map(normalizeChangedPath)
      .sort();
    if (new Set(changedPaths).size !== changedPaths.length) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_INVALID',
        'The derived implementation path set is not canonical.',
        ExitCode.verification,
      );
    }
    return { candidateTree, changedPaths };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function readRegularTreeEntry(
  repositoryRoot: string,
  tree: string,
  candidatePath: string,
): TaskStrategyPatchEntry | null {
  const output = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    tree,
    '--',
    `:(literal)${candidatePath}`,
  ]);
  if (output === '') return null;
  const match =
    /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_MODE_INVALID',
      'The implementation patch creates an unsupported file mode, symlink, or submodule.',
      ExitCode.verification,
      { details: { path: candidatePath } },
    );
  }
  return Object.freeze({
    mode: match[1] as '100644' | '100755',
    objectId: match[2]!,
  });
}
