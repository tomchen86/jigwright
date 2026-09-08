/**
 * Captures and compares the ordered categories of a governed provider projection.
 *
 * Invariants:
 * - Category sampling order and total projection digest framing stay unchanged.
 * - A shared bounded budget covers every sampled Git, worktree, planning, and runtime category.
 */
import crypto from 'node:crypto';
import {
  ExitCode,
  workflowError,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  MAX_GOVERNED_PROJECTION_ENTRIES,
  MAX_GOVERNED_PROJECTION_TOTAL_BYTES,
  updateFramed,
  type GovernedProjectionBudget,
} from './git-projection-files.ts';
import {
  digestGovernedRuntimeInputs,
  digestPlanningArtifactsProjection,
} from './governed-artifact-fingerprints.ts';
import {
  digestGitControlProjection,
  digestIgnoredWorktreeProjection,
  digestIndexProjection,
  digestRefsProjection,
  digestTrackedWorktreeProjection,
  digestUntrackedWorktreeProjection,
} from './governed-git-fingerprints.ts';

/**
 * A single engine-owned governed runtime input. The projection binds each input
 * by its stable `id` and exact file bytes/metadata so a provider process that
 * rewrites a governed input is observed as drift rather than silently accepted.
 */
export type GovernedRuntimeInput =
  | { id: string; path: string; kind?: 'file' }
  | {
      id: string;
      path: string;
      kind: 'directory-closure';
      expectedFiles: string[];
      mutableContentPaths: string[];
    };

export type GovernedProviderProjection = {
  categories: Record<string, string>;
  digest: string;
};

export type GovernedProviderProjectionComparison = {
  unchanged: boolean;
  changedCategories: string[];
  beforeDigest: string;
  afterDigest: string;
};

/**
 * The fixed governed-projection category order. Comparison reports drift in this
 * order so callers observe a stable category vocabulary.
 */
const GOVERNED_PROJECTION_CATEGORIES = [
  'refs',
  'git-control',
  'index',
  'tracked-worktree',
  'untracked-worktree',
  'ignored-worktree-manifest',
  'planning-artifacts',
  'governed-runtime-inputs',
] as const;

/**
 * Capture the engine-owned governed projection of a repository before or after a
 * bounded provider process. It binds the current worktree's symbolic HEAD,
 * resolved commit/tree, exact index stages/flags and staged tree, tracked,
 * untracked, and ignored worktree manifests, planning artifacts, and exact
 * governed runtime inputs. Refs not selected by the current worktree live in
 * shared Git-common-directory state and are deliberately outside this
 * invocation projection so unrelated concurrent activity does not stale the
 * bounded result. Equality of two projections establishes only that this
 * observed governed surface did not change; it does not prove shared-ref or
 * same-user process confinement, or global filesystem immutability.
 */
export function captureGovernedProviderProjection(
  repositoryRoot: string,
  runtimeInputs: GovernedRuntimeInput[] = [],
): GovernedProviderProjection {
  try {
    const first = sampleGovernedProviderProjectionCategories(
      repositoryRoot,
      runtimeInputs,
    );
    const categories = sampleGovernedProviderProjectionCategories(
      repositoryRoot,
      runtimeInputs,
    );
    if (
      GOVERNED_PROJECTION_CATEGORIES.some(
        (category) => first[category] !== categories[category],
      )
    ) {
      throw workflowError(
        'GOVERNED_PROJECTION_UNSTABLE',
        'Governed provider projection changed while it was being sampled.',
        ExitCode.staleState,
      );
    }
    const overall = crypto.createHash('sha256');
    for (const category of GOVERNED_PROJECTION_CATEGORIES) {
      updateFramed(overall, category, categories[category] ?? '');
    }
    return { categories, digest: overall.digest('hex') };
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw workflowError(
      'GOVERNED_PROJECTION_FAILED',
      'Unable to capture the governed provider projection safely.',
      ExitCode.staleState,
    );
  }
}

function sampleGovernedProviderProjectionCategories(
  repositoryRoot: string,
  runtimeInputs: GovernedRuntimeInput[],
): Record<(typeof GOVERNED_PROJECTION_CATEGORIES)[number], string> {
  const budget: GovernedProjectionBudget = {
    remainingEntries: MAX_GOVERNED_PROJECTION_ENTRIES,
    remainingBytes: MAX_GOVERNED_PROJECTION_TOTAL_BYTES,
  };
  return {
    refs: digestRefsProjection(repositoryRoot, budget),
    'git-control': digestGitControlProjection(repositoryRoot, budget),
    index: digestIndexProjection(repositoryRoot, budget),
    'tracked-worktree': digestTrackedWorktreeProjection(repositoryRoot, budget),
    'untracked-worktree': digestUntrackedWorktreeProjection(
      repositoryRoot,
      budget,
    ),
    'ignored-worktree-manifest': digestIgnoredWorktreeProjection(
      repositoryRoot,
      budget,
    ),
    'planning-artifacts': digestPlanningArtifactsProjection(
      repositoryRoot,
      budget,
    ),
    'governed-runtime-inputs': digestGovernedRuntimeInputs(
      runtimeInputs,
      budget,
    ),
  };
}

/**
 * Compare two governed projections, naming every category whose digest changed
 * in the fixed category order. `unchanged` is true only when no category and the
 * overall digest are identical.
 */
export function compareGovernedProviderProjections(
  before: GovernedProviderProjection,
  after: GovernedProviderProjection,
): GovernedProviderProjectionComparison {
  const changedCategories = GOVERNED_PROJECTION_CATEGORIES.filter(
    (category) => before.categories[category] !== after.categories[category],
  );
  return {
    unchanged: changedCategories.length === 0 && before.digest === after.digest,
    changedCategories: [...changedCategories],
    beforeDigest: before.digest,
    afterDigest: after.digest,
  };
}
