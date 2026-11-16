import { parseDocumentationClosureFromCommitMessage } from '../../modules/assurance/documentation-closure.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';

import {
  completePreMergeAssurance,
  createPlanningGenerationCurrentnessProof,
  createPreMergeCoverageEntry,
  createRequiredPreMergeCoverage,
  preparePreMergeAssurance,
  resolvePreMergeAssurance,
  type ExistingPreMergeCoverageReference,
  type IntegrationDeltaReviewRequest,
  type IntegrationDeltaReviewSubmission,
  type PlanningGenerationCurrentnessProof,
  type PreMergeAssuranceNode,
  type PreMergeCoverageEntry,
  type PreparedPreMergeAssurance,
} from '../../modules/assurance/pre-merge-assurance.ts';
import type {
  PullRequestVerifier,
  PullRequestVerification,
} from './pull-request-verification.ts';
import type { PreMergeVerificationServices } from '../../modules/assurance/pre-merge-verification.ts';
import {
  groupTaskCommits,
  implementationCoverageFromClosure,
  uniquePaths,
  uniqueDigests,
  sha256,
  planningStale,
  preMergeInvalid,
  preMergeUnavailable,
} from '../../modules/assurance/pre-merge-verification.ts';

export type PreparedPullRequestPreMergeAssurance = Readonly<{
  verification: PullRequestVerification;
  prepared: PreparedPreMergeAssurance | null;
}>;
export type VerifiedPullRequestWithPreMergeAssurance = PullRequestVerification &
  Readonly<{ preMergeAssurance: PreMergeAssuranceNode }>;
export function createPreMergeVerifier(
  services: PreMergeVerificationServices & PullRequestVerifier,
) {
  const {
    verifyPullRequest,
    discoverRepository,
    loadWorkflowConfig,
    currentRepositorySchemaName,
    listRangeCommits,
    loadCommittedChangeContract,
    productionPlanningAssurance,
    productionConsumedPlanReviewReplayPort,
    committedPlanningGeneration,
    commitFacts,
    commitChangedPaths,
    latestPlanCommit,
    commitsChangingPath,
    resolveAncestorMergeBase,
    storePreMergeAssuranceForRepository,
    readPreMergeAssuranceForRepository,
  } = services;
  function preparePullRequestPreMergeAssurance(
    cwd: string,
    requestedBase: string,
    requestedHead: string,
    environment: NodeJS.ProcessEnv = process.env,
    evaluatedAt: Date = new Date(),
  ): PreparedPullRequestPreMergeAssurance {
    const verification = verifyPullRequest(
      cwd,
      requestedBase,
      requestedHead,
      environment,
      evaluatedAt,
    );
    return {
      verification,
      prepared: derivePreMergeAssurancePreparation(cwd, verification),
    };
  }

  async function verifyPullRequestWithPreMergeAssurance(
    cwd: string,
    requestedBase: string,
    requestedHead: string,
    options: Readonly<{
      invokeIntegrationReview: (
        request: IntegrationDeltaReviewRequest,
      ) => Promise<IntegrationDeltaReviewSubmission>;
      environment?: NodeJS.ProcessEnv;
      evaluatedAt?: Date;
    }>,
  ): Promise<VerifiedPullRequestWithPreMergeAssurance> {
    const { verification, prepared } = preparePullRequestPreMergeAssurance(
      cwd,
      requestedBase,
      requestedHead,
      options.environment,
      options.evaluatedAt,
    );
    if (prepared === null) {
      throw preMergeUnavailable(
        'The pull-request range contains no reviewed v2 task transition.',
      );
    }
    const replay = readCurrentPreMergeAssurance(cwd, prepared);
    if (replay !== null) {
      return { ...verification, preMergeAssurance: replay };
    }
    const preMergeAssurance = await resolvePreMergeAssurance({
      requiredCoverage: prepared.requiredCoverage,
      planningCurrentness: prepared.planningCurrentness,
      existingCoverage: prepared.existingCoverage,
      invokeIntegrationReview: options.invokeIntegrationReview,
    });
    storePreMergeAssuranceForRepository(cwd, preMergeAssurance);
    return { ...verification, preMergeAssurance };
  }

  function completePreparedPullRequestPreMergeAssurance(
    prepared: PreparedPullRequestPreMergeAssurance,
    submission: IntegrationDeltaReviewSubmission | null,
    cwd?: string,
  ): VerifiedPullRequestWithPreMergeAssurance {
    if (prepared.prepared === null) {
      throw preMergeUnavailable(
        'The pull-request range contains no reviewed v2 task transition.',
      );
    }
    if (submission === null && cwd !== undefined) {
      const replay = readCurrentPreMergeAssurance(cwd, prepared.prepared);
      if (replay !== null) {
        return {
          ...prepared.verification,
          preMergeAssurance: replay,
        };
      }
    }
    const preMergeAssurance = completePreMergeAssurance(
      prepared.prepared,
      submission,
    );
    if (cwd !== undefined) {
      storePreMergeAssuranceForRepository(cwd, preMergeAssurance);
    }
    return {
      ...prepared.verification,
      preMergeAssurance,
    };
  }

  function readCurrentPreMergeAssurance(
    cwd: string,
    prepared: PreparedPreMergeAssurance,
  ): PreMergeAssuranceNode | null {
    const stored = readPreMergeAssuranceForRepository(
      cwd,
      prepared.requiredCoverage.baseCommit,
      prepared.requiredCoverage.headCommit,
    );
    if (stored === null) return null;
    if (
      canonicalJson(stored.requiredCoverage) !==
        canonicalJson(prepared.requiredCoverage) ||
      canonicalJson(stored.planningCurrentness) !==
        canonicalJson(prepared.planningCurrentness) ||
      canonicalJson(stored.existingCoverage) !==
        canonicalJson(prepared.existingCoverage) ||
      canonicalJson(stored.uncoveredEntryDigests) !==
        canonicalJson(prepared.uncoveredEntryDigests)
    ) {
      throw preMergeInvalid(
        'Stored pre-merge assurance conflicts with the current exact coverage preparation.',
      );
    }
    return stored;
  }

  function derivePreMergeAssurancePreparation(
    cwd: string,
    verification: PullRequestVerification,
  ): PreparedPreMergeAssurance | null {
    const git = discoverRepository(cwd);
    const config = loadWorkflowConfig(git.repositoryRoot);
    const currentSchemaName = currentRepositorySchemaName(git.repositoryRoot);
    const commits = listRangeCommits(
      git.repositoryRoot,
      verification.mergeBase,
      verification.head,
    );
    const taskCommitsByChange = groupTaskCommits(commits);
    const changeIds = [...taskCommitsByChange.keys()].sort();
    const entries: PreMergeCoverageEntry[] = [];
    const planningCurrentness: PlanningGenerationCurrentnessProof[] = [];
    const existingCoverage: ExistingPreMergeCoverageReference[] = [];
    const integrationReasons: unknown[] = [];
    let reviewedChangeCount = 0;

    for (const changeId of changeIds) {
      const contract = loadCommittedChangeContract(
        git.repositoryRoot,
        verification.head,
        changeId,
      );
      if (contract.schemaName !== currentSchemaName) continue;
      reviewedChangeCount += 1;
      const taskCommits = taskCommitsByChange.get(changeId)!;
      const readiness = productionPlanningAssurance.validateReadiness(
        git.repositoryRoot,
        contract,
        productionConsumedPlanReviewReplayPort,
      );
      const planningEntry = createPreMergeCoverageEntry({
        category: 'planning',
        changeId,
        subjectDigest: readiness.subject.subjectDigest,
        paths: uniquePaths(readiness.target.components.map(({ path }) => path)),
        contextDigests: uniqueDigests([
          readiness.generation.planningGenerationId,
          readiness.target.targetDigest,
          readiness.subject.reviewPolicyDigest,
          readiness.summary.reviewResultDigest,
        ]),
      });
      entries.push(planningEntry);
      existingCoverage.push({
        source: 'plan-review',
        nodeId: readiness.summary.reviewNodeId,
        resultDigest: readiness.summary.reviewResultDigest,
        coveredEntryDigests: [planningEntry.entryDigest],
      });

      const planCommit = currentReviewedPlanCommit(
        git.repositoryRoot,
        verification.head,
        config.changeRoot,
        changeId,
        readiness.generation.planningGenerationId,
      );
      const supersedingPlanCommits = commitsChangingPath(
        git.repositoryRoot,
        planCommit,
        verification.head,
        `${config.changeRoot}/${changeId}/plan-review.json`,
      );
      const taskBindings = taskCommits.map((commit) => {
        const generation = committedPlanningGeneration(
          git.repositoryRoot,
          commit.hash,
          config.changeRoot,
          changeId,
        );
        if (generation === null) {
          throw planningStale(
            `Task ${changeId}/${commit.trailers!.taskId} does not name a reviewed planning generation.`,
          );
        }
        assertAncestor(git.repositoryRoot, planCommit, commit.hash);
        return {
          taskId: commit.trailers!.taskId,
          taskCommit: commit.hash,
          planningGenerationId: generation,
        };
      });
      planningCurrentness.push(
        createPlanningGenerationCurrentnessProof({
          changeId,
          planningGenerationId: readiness.generation.planningGenerationId,
          planCommit,
          taskBindings,
          supersedingPlanCommits,
          ancestorPairs: taskCommits.map(({ hash }) => ({
            ancestor: planCommit,
            descendant: hash,
          })),
        }),
      );

      const closures = taskCommits.flatMap((commit) => {
        const closure = parseDocumentationClosureFromCommitMessage(
          commitFacts(git.repositoryRoot, commit.hash).message,
        );
        return closure === null ? [] : [{ commit, closure }];
      });
      if (closures.length > 1) {
        throw preMergeInvalid(
          `Change ${changeId} contains more than one terminal task review commitment.`,
        );
      }
      if (closures.length === 1) {
        const { closure } = closures[0]!;
        const implementationEntry = implementationCoverageFromClosure(closure);
        entries.push(implementationEntry);
        existingCoverage.push({
          source: 'task-diff-review',
          nodeId: closure.reviewSubjectDigest,
          resultDigest: closure.reviewRecordDigest,
          coveredEntryDigests: [implementationEntry.entryDigest],
        });
        // The immutable PlanReview covers merge-base → plan commit. The terminal
        // whole-change TaskDiffReview intentionally starts at that reviewed plan
        // commit, so this boundary is compositional rather than base drift.
        if (closure.requirement.changeBaseCommit !== planCommit) {
          entries.push(
            createPreMergeCoverageEntry({
              category: 'base-context',
              changeId,
              subjectDigest: sha256(
                canonicalJson({
                  schemaVersion: 1,
                  kind: 'pre-merge-base-context.v1',
                  requestedBase: planCommit,
                  reviewedBase: closure.requirement.changeBaseCommit,
                  head: verification.head,
                  paths: closure.requirement.changedPaths,
                }),
              ),
              paths: closure.requirement.changedPaths,
              contextDigests: [
                sha256(planCommit),
                sha256(closure.requirement.changeBaseCommit),
                sha256(closure.requirement.changeBaseTree),
              ],
            }),
          );
          integrationReasons.push({
            changeId,
            kind: 'base-context-drift',
            reviewedBase: closure.requirement.changeBaseCommit,
          });
        }
      } else {
        for (const commit of taskCommits) {
          const paths = uniquePaths(
            commitChangedPaths(git.repositoryRoot, commit.hash).filter(
              (candidate) =>
                candidate !== `${config.changeRoot}/${changeId}/tasks.md`,
            ),
          );
          if (paths.length === 0) continue;
          entries.push(
            createPreMergeCoverageEntry({
              category: 'implementation',
              changeId,
              subjectDigest: sha256(
                canonicalJson({
                  schemaVersion: 1,
                  kind: 'unreviewed-task-implementation.v1',
                  changeId,
                  taskId: commit.trailers!.taskId,
                  commit: commit.hash,
                  paths,
                }),
              ),
              paths,
              contextDigests: [
                sha256(commit.hash),
                sha256(canonicalJson(commit.parents)),
              ],
            }),
          );
        }
        integrationReasons.push({ changeId, kind: 'missing-task-review' });
      }
      if (taskCommits.length > 1) {
        integrationReasons.push({
          changeId,
          kind: 'cross-task-integration',
          taskCommits: taskCommits.map(({ hash }) => hash),
        });
      }
    }

    if (reviewedChangeCount === 0) return null;
    if (reviewedChangeCount > 1) {
      integrationReasons.push({
        kind: 'cross-change-integration',
        changeIds: changeIds.filter((changeId) =>
          planningCurrentness.some((proof) => proof.changeId === changeId),
        ),
      });
    }
    const integrationSubjectDigest =
      integrationReasons.length === 0
        ? null
        : sha256(
            canonicalJson({
              schemaVersion: 1,
              kind: 'pre-merge-integration-subject.v1',
              baseCommit: verification.mergeBase,
              headCommit: verification.head,
              reasons: integrationReasons,
              aggregateCheckDigest: sha256(canonicalJson(verification.checks)),
            }),
          );
    return preparePreMergeAssurance({
      requiredCoverage: createRequiredPreMergeCoverage({
        baseCommit: verification.mergeBase,
        headCommit: verification.head,
        entries,
        integrationSubjectDigest,
      }),
      planningCurrentness,
      existingCoverage,
    });
  }

  function currentReviewedPlanCommit(
    repositoryRoot: string,
    head: string,
    changeRoot: string,
    changeId: string,
    planningGenerationId: string,
  ): string {
    const artifactPath = `${changeRoot}/${changeId}/plan-review.json`;
    const planCommit = latestPlanCommit(repositoryRoot, head, artifactPath);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(planCommit)) {
      throw planningStale(
        `Change ${changeId} has no immutable reviewed plan commit.`,
      );
    }
    let trailers;
    try {
      trailers = parseManagedTrailers(
        commitFacts(repositoryRoot, planCommit).message,
      );
    } catch (error) {
      if (error instanceof ManagedTrailerSyntaxError) {
        throw planningStale(
          `Change ${changeId} has malformed plan provenance.`,
        );
      }
      throw error;
    }
    if (
      trailers === undefined ||
      (trailers.kind !== 'plan' && trailers.kind !== 'amend-plan') ||
      trailers.changeId !== changeId ||
      committedPlanningGeneration(
        repositoryRoot,
        planCommit,
        changeRoot,
        changeId,
      ) !== planningGenerationId
    ) {
      throw planningStale(
        `Change ${changeId} does not bind its current PlanReview to one managed plan commit.`,
      );
    }
    return planCommit;
  }

  function assertAncestor(
    repositoryRoot: string,
    ancestor: string,
    descendant: string,
  ): void {
    const mergeBase = resolveAncestorMergeBase(
      repositoryRoot,
      ancestor,
      descendant,
    );
    if (mergeBase !== ancestor) {
      throw planningStale(
        'The reviewed plan commit is not an ancestor of every included task commit.',
      );
    }
  }
  return {
    preparePullRequestPreMergeAssurance,
    verifyPullRequestWithPreMergeAssurance,
    completePreparedPullRequestPreMergeAssurance,
    storePreMergeAssuranceForRepository,
    readPreMergeAssuranceForRepository,
  };
}
export type PreMergeVerifier = ReturnType<typeof createPreMergeVerifier>;
