/**
 * Prepares and publishes exact staging transactions while preserving unrelated index state.
 *
 * Invariants:
 * - Prospective and real index trees retain their expected-path and pinned-tree checks.
 * - Partial staging and rollback preserve unstaged changes and exact previous index state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeChangedPath } from '../../foundation/repository-path/repository-path.ts';
import { splitNull } from './git-transition-values.ts';
import { listChangedPaths, runGit, runGitWithEnvironment } from './git.ts';

export type ExactStagingPin = {
  expectedTree: string;
  expectedPreviousIndexTree: string;
};

export type PartialStagingPreparation = Readonly<{
  stagedPaths: string[];
  preservedUnstagedPaths: string[];
  tree: string;
  previousIndexTree: string;
}>;

/**
 * Compute the prospective checked tree and the current real index tree using an
 * isolated temporary index, enforcing the same expected-changed-path and
 * empty-index preconditions as {@link stageExactPaths} without mutating the real
 * index. Callers pin these values to detect same-path byte drift before staging.
 */
export function previewExactStaging(
  repositoryRoot: string,
  baselineHead: string,
  expectedPaths: string[],
): { tree: string; previousIndexTree: string } {
  const plan = planExactStaging(repositoryRoot, baselineHead, expectedPaths);
  return {
    tree: plan.workflowIndexTree,
    previousIndexTree: plan.previousIndexTree,
  };
}

function planExactStaging(
  repositoryRoot: string,
  baselineHead: string,
  expectedPaths: string[],
): {
  expected: string[];
  literalPaths: string[];
  previousIndexTree: string;
  workflowIndexTree: string;
} {
  if (expectedPaths.length === 0) {
    throw workflowError(
      'EMPTY_FINISH_DIFF',
      'A managed finish requires at least the task checkbox projection.',
      ExitCode.verification,
    );
  }
  const expected = [...expectedPaths].sort();
  const changedBefore = listChangedPaths(repositoryRoot, baselineHead);
  const stagedBefore = listStagedPaths(repositoryRoot, baselineHead);
  if (JSON.stringify(changedBefore) !== JSON.stringify(expected)) {
    throw workflowError(
      'FINISH_PATHS_CHANGED',
      'Changed paths no longer match the verified task paths.',
      ExitCode.staleState,
      { details: { expectedPaths: expected, changedPaths: changedBefore } },
    );
  }
  if (stagedBefore.length > 0) {
    throw workflowError(
      'STAGING_ALREADY_PRESENT',
      'Only workflow finish may create the managed staging projection.',
      ExitCode.staleState,
      { details: { stagedPaths: stagedBefore } },
    );
  }

  const previousIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
  const literalPaths = expected.map((entry) => `:(literal)${entry}`);
  const workflowIndexTree = predictIndexTree(
    repositoryRoot,
    baselineHead,
    previousIndexTree,
    literalPaths,
    expected,
  );
  return { expected, literalPaths, previousIndexTree, workflowIndexTree };
}

export function stageExactPaths(
  repositoryRoot: string,
  baselineHead: string,
  expectedPaths: string[],
  pin?: ExactStagingPin,
): {
  stagedPaths: string[];
  tree: string;
  previousIndexTree: string;
} {
  const { expected, literalPaths, previousIndexTree, workflowIndexTree } =
    planExactStaging(repositoryRoot, baselineHead, expectedPaths);
  if (
    pin &&
    (workflowIndexTree !== pin.expectedTree ||
      previousIndexTree !== pin.expectedPreviousIndexTree)
  ) {
    throw workflowError(
      'FINALIZE_PROJECTION_CHANGED',
      'The prospective checked tree changed after the single verification pass; the real index was left unchanged.',
      ExitCode.staleState,
      {
        details: {
          expectedTree: pin.expectedTree,
          actualTree: workflowIndexTree,
          expectedPreviousIndexTree: pin.expectedPreviousIndexTree,
          actualPreviousIndexTree: previousIndexTree,
        },
      },
    );
  }
  try {
    if (runGit(repositoryRoot, ['write-tree']).trim() !== previousIndexTree) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index changed before workflow staging; foreign staging was preserved.',
        ExitCode.staleState,
      );
    }
    runGit(repositoryRoot, ['add', '-A', '--', ...literalPaths]);
    if (runGit(repositoryRoot, ['write-tree']).trim() !== workflowIndexTree) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index differs from the isolated workflow projection; foreign staging was preserved.',
        ExitCode.staleState,
      );
    }
    const changedPaths = listChangedPaths(repositoryRoot, baselineHead);
    const stagedPaths = listStagedPaths(repositoryRoot, baselineHead);
    if (
      JSON.stringify(changedPaths) !== JSON.stringify(expected) ||
      JSON.stringify(stagedPaths) !== JSON.stringify(expected)
    ) {
      throw workflowError(
        'STAGED_PATHS_MISMATCH',
        'Staged paths do not exactly match the verified task paths.',
        ExitCode.staleState,
        { details: { expectedPaths: expected, changedPaths, stagedPaths } },
      );
    }
    const unstagedPaths = splitNull(
      runGit(repositoryRoot, ['diff', '--name-only', '-z', '--']),
    )
      .map(normalizeChangedPath)
      .sort();
    if (unstagedPaths.length > 0) {
      throw workflowError(
        'WORKTREE_INDEX_MISMATCH',
        'The worktree changed while the managed index was being staged.',
        ExitCode.staleState,
        { details: { unstagedPaths } },
      );
    }
    return {
      stagedPaths,
      tree: workflowIndexTree,
      previousIndexTree,
    };
  } catch (error) {
    const currentIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
    if (
      currentIndexTree !== previousIndexTree &&
      currentIndexTree !== workflowIndexTree
    ) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index changed during workflow staging; foreign staging was preserved.',
        ExitCode.staleState,
        {
          details: {
            causeCode: error instanceof Error ? error.name : String(error),
          },
        },
      );
    }
    if (currentIndexTree === workflowIndexTree) {
      runGit(repositoryRoot, ['read-tree', previousIndexTree]);
    }
    throw error;
  }
}

export function rollbackExactStaging(
  repositoryRoot: string,
  previousIndexTree: string,
  workflowStagedTree: string,
  cause: unknown,
): void {
  const currentIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (currentIndexTree !== workflowStagedTree) {
    throw workflowError(
      'STAGING_INDEX_DIVERGED',
      'The Git index changed after workflow staging; foreign staging was preserved.',
      ExitCode.staleState,
      {
        details: {
          causeCode:
            cause instanceof Error && 'code' in cause
              ? String(cause.code)
              : undefined,
        },
      },
    );
  }
  runGit(repositoryRoot, ['read-tree', previousIndexTree]);
}

function predictIndexTree(
  repositoryRoot: string,
  baselineHead: string,
  previousIndexTree: string,
  literalPaths: string[],
  expectedPaths: string[],
  expectedUnstagedPaths: string[] = [],
): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-index-'),
  );
  const indexEnvironment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  try {
    runGitWithEnvironment(
      repositoryRoot,
      ['read-tree', previousIndexTree],
      indexEnvironment,
    );
    runGitWithEnvironment(
      repositoryRoot,
      ['add', '-A', '--', ...literalPaths],
      indexEnvironment,
    );
    const tree = runGitWithEnvironment(
      repositoryRoot,
      ['write-tree'],
      indexEnvironment,
    ).trim();
    const stagedPaths = splitNull(
      runGitWithEnvironment(
        repositoryRoot,
        [
          'diff',
          '--cached',
          '--name-only',
          '--no-renames',
          '-z',
          baselineHead,
          '--',
        ],
        indexEnvironment,
      ),
    )
      .map(normalizeChangedPath)
      .sort();
    const unstagedPaths = splitNull(
      runGitWithEnvironment(
        repositoryRoot,
        ['diff', '--name-only', '--no-renames', '-z', '--'],
        indexEnvironment,
      ),
    )
      .map(normalizeChangedPath)
      .sort();
    if (
      JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths) ||
      unstagedPaths.some(
        (candidate) => !expectedUnstagedPaths.includes(candidate),
      )
    ) {
      throw workflowError(
        'STAGED_PATHS_MISMATCH',
        'The isolated staging projection did not match the verified paths.',
        ExitCode.staleState,
      );
    }
    return tree;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Stage one exact path set while preserving another exact path set as
 * unstaged worktree bytes. Task-plan revision uses this projection so a plan
 * commit can advance HEAD without ever staging, stashing, or rewriting the
 * implementation that caused the revision.
 */
export function stageExactPathsPreservingUnstaged(
  repositoryRoot: string,
  baselineHead: string,
  expectedStagedPaths: string[],
  expectedUnstagedPaths: string[],
  beforeMutation?: (preparation: PartialStagingPreparation) => void,
): {
  stagedPaths: string[];
  tree: string;
  previousIndexTree: string;
} {
  const staged = canonicalPathSet(expectedStagedPaths);
  const unstaged = canonicalPathSet(expectedUnstagedPaths);
  if (staged.length === 0 || staged.some((entry) => unstaged.includes(entry))) {
    throw workflowError(
      'PARTIAL_STAGING_PATHS_INVALID',
      'The workflow partial staging projection requires disjoint non-empty staged paths.',
      ExitCode.guard,
    );
  }
  const expectedChanged = [...staged, ...unstaged].sort();
  if (
    JSON.stringify(listChangedPaths(repositoryRoot, baselineHead)) !==
      JSON.stringify(expectedChanged) ||
    listStagedPaths(repositoryRoot, baselineHead).length > 0
  ) {
    throw workflowError(
      'PARTIAL_STAGING_STATE_CHANGED',
      'Changed or staged paths no longer match the verified partial staging projection.',
      ExitCode.staleState,
    );
  }
  const previousIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
  const literalPaths = staged.map((entry) => `:(literal)${entry}`);
  const tree = predictIndexTree(
    repositoryRoot,
    baselineHead,
    previousIndexTree,
    literalPaths,
    staged,
    unstaged,
  );
  const preparation = Object.freeze({
    stagedPaths: [...staged],
    preservedUnstagedPaths: [...unstaged],
    tree,
    previousIndexTree,
  });
  beforeMutation?.(preparation);
  try {
    if (runGit(repositoryRoot, ['write-tree']).trim() !== previousIndexTree) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index changed before workflow partial staging; foreign staging was preserved.',
        ExitCode.staleState,
      );
    }
    runGit(repositoryRoot, ['add', '-A', '--', ...literalPaths]);
    const observedTree = runGit(repositoryRoot, ['write-tree']).trim();
    const observedChanged = listChangedPaths(repositoryRoot, baselineHead);
    const observedStaged = listStagedPaths(repositoryRoot, baselineHead);
    const trackedUnstaged = splitNull(
      runGit(repositoryRoot, [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        '--',
      ]),
    )
      .map(normalizeChangedPath)
      .sort();
    const observedUnstaged = observedChanged.filter(
      (candidate) => !observedStaged.includes(candidate),
    );
    if (
      observedTree !== tree ||
      JSON.stringify(observedChanged) !== JSON.stringify(expectedChanged) ||
      JSON.stringify(observedStaged) !== JSON.stringify(staged) ||
      JSON.stringify(observedUnstaged) !== JSON.stringify(unstaged) ||
      trackedUnstaged.some((candidate) => !unstaged.includes(candidate))
    ) {
      throw workflowError(
        'PARTIAL_STAGING_STATE_CHANGED',
        'The real partial staging projection differs from its isolated prediction.',
        ExitCode.staleState,
      );
    }
    return { stagedPaths: observedStaged, tree, previousIndexTree };
  } catch (error) {
    const currentIndexTree = runGit(repositoryRoot, ['write-tree']).trim();
    if (currentIndexTree === tree) {
      runGit(repositoryRoot, ['read-tree', previousIndexTree]);
    } else if (currentIndexTree !== previousIndexTree) {
      throw workflowError(
        'STAGING_INDEX_DIVERGED',
        'The Git index changed during workflow partial staging; foreign staging was preserved.',
        ExitCode.staleState,
        {
          details: {
            causeCode: error instanceof Error ? error.name : String(error),
          },
        },
      );
    }
    throw error;
  }
}

function canonicalPathSet(paths: readonly string[]): string[] {
  const normalized = paths.map(normalizeChangedPath).sort();
  if (
    new Set(normalized).size !== normalized.length ||
    JSON.stringify(normalized) !== JSON.stringify([...paths].sort())
  ) {
    throw workflowError(
      'PARTIAL_STAGING_PATHS_INVALID',
      'The workflow partial staging paths are not canonical and unique.',
      ExitCode.guard,
    );
  }
  return normalized;
}

export function listStagedPaths(
  repositoryRoot: string,
  baselineHead: string,
): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'diff',
      '--cached',
      '--ita-visible-in-index',
      '--name-only',
      '--no-renames',
      '-z',
      baselineHead,
      '--',
    ]),
  )
    .map(normalizeChangedPath)
    .sort();
}
