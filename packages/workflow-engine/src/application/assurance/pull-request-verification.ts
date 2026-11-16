/** Orchestrates deterministic pull-request verification with required repository capabilities. */
import type { PullRequestVerificationServices } from '../../modules/assurance/ci-verification.ts';
import {
  uniqueRoleContextSharingTerminalUses,
  assertChangesPreserved,
  assertHistoricalChecksCurrent as assertCurrentHistoricalChecks,
  ciError,
} from '../../modules/assurance/ci-verification.ts';
import type { ChangeContract } from '../../modules/planning-provider/change-contract.ts';
import type { CompletedTask } from '../../modules/assurance/commit-replay/ci-task-state.ts';
export function createPullRequestVerifier(
  services: PullRequestVerificationServices,
) {
  const {
    discoverRepository,
    assertCiCommit,
    findMergeBase,
    listRangeCommits,
    verifyBaseAuthorityAttestations,
    validateRepositoryStateAtCommit,
    validateWorkflowIntegrationAssets,
    loadCommittedChangeContract,
    currentRepositorySchemaName,
    listChangesAtCommit,
    loadWorkflowConfig,
    collectHistoricalCollaborationGrantUses,
    replayCommitSequence,
    assertRoleContextSharingTerminalReceiptUseBijection,
    listRangePaths,
    loadChecksConfig,
    runCiChecksAtCommit,
    readFileAtCommit,
    readCurrentFile,
  } = services;
  function verifyPullRequest(
    cwd: string,
    requestedBase: string,
    requestedHead: string,
    environment: NodeJS.ProcessEnv = process.env,
    evaluatedAt: Date = new Date(),
  ) {
    const git = discoverRepository(cwd);
    const base = assertCiCommit(git.repositoryRoot, requestedBase);
    const head = assertCiCommit(git.repositoryRoot, requestedHead);
    if (git.head !== head) {
      throw ciError(
        'CI_HEAD_MISMATCH',
        'CI head is not the checked out commit.',
      );
    }
    if (git.statusEntries.length > 0) {
      throw ciError('CI_WORKTREE_DIRTY', 'CI requires a clean checkout.');
    }
    const mergeBase = findMergeBase(git.repositoryRoot, base, head);
    if (mergeBase !== base) {
      throw ciError(
        'CI_BASE_NOT_ANCESTOR',
        'PR head must include the exact current base before assurance runs.',
      );
    }
    const commits = listRangeCommits(git.repositoryRoot, mergeBase, head);
    const attestations = verifyBaseAuthorityAttestations(
      git.repositoryRoot,
      mergeBase,
      evaluatedAt,
    );
    const validated = validateRepositoryStateAtCommit(git.repositoryRoot, head);
    validateWorkflowIntegrationAssets(git.repositoryRoot, {
      regeneratePlanningAssets: true,
    });
    const contracts = new Map(
      validated.changes.map((changeId) => [
        changeId,
        loadCommittedChangeContract(git.repositoryRoot, head, changeId),
      ]),
    );
    const currentSchemaName = currentRepositorySchemaName(git.repositoryRoot);
    const legacyChangeIds = [...contracts]
      .filter(([, contract]) => contract.schemaName !== currentSchemaName)
      .map(([changeId]) => changeId)
      .sort();
    if (legacyChangeIds.length > 0) {
      throw ciError(
        'OPENSPEC_LEGACY_SCHEMA_FORBIDDEN',
        `Active changes must use the configured current schema ${currentSchemaName} with a v3 investigation Manifest.`,
        { legacyChangeIds },
      );
    }
    assertChangesPreserved(
      listChangesAtCommit(
        git.repositoryRoot,
        mergeBase,
        loadWorkflowConfig(git.repositoryRoot).changeRoot,
      ),
      contracts,
      new Set(
        commits.flatMap((commit) =>
          commit.trailers?.kind === 'archive' ? [commit.trailers.changeId] : [],
        ),
      ),
    );
    assertPoliciesAnchored(git.repositoryRoot, mergeBase);
    const plannedChangeIds = [
      ...new Set(
        commits.flatMap((commit) =>
          commit.trailers?.kind === 'plan' ? [commit.trailers.changeId] : [],
        ),
      ),
    ].sort();
    const priorCollaborationGrantUses = plannedChangeIds.flatMap((changeId) =>
      collectHistoricalCollaborationGrantUses(
        git.repositoryRoot,
        mergeBase,
        changeId,
        loadWorkflowConfig(git.repositoryRoot).changeRoot,
      ),
    );
    const replay = replayCommitSequence(
      git.repositoryRoot,
      commits,
      contracts,
      evaluatedAt,
      priorCollaborationGrantUses,
    );
    const receiptChangeIds = [
      ...new Set(
        attestations.roleContextSharingTerminalReceipts.map(
          ({ envelope }) =>
            envelope.payload.terminalRecord.expectedBinding!.changeId,
        ),
      ),
    ];
    const historicalReceiptUses = receiptChangeIds.flatMap((changeId) =>
      collectHistoricalCollaborationGrantUses(
        git.repositoryRoot,
        head,
        changeId,
        loadWorkflowConfig(git.repositoryRoot).changeRoot,
      ),
    );
    assertRoleContextSharingTerminalReceiptUseBijection(
      attestations.roleContextSharingTerminalReceipts,
      uniqueRoleContextSharingTerminalUses([
        ...historicalReceiptUses,
        ...replay.collaborationGrantUses,
      ]),
    );
    const completedTasks = replay.completedTasks;
    const changedPaths = listRangePaths(git.repositoryRoot, mergeBase, head);
    const checkIds = assertHistoricalChecksCurrent(
      git.repositoryRoot,
      contracts,
      completedTasks,
      replay.requiredCheckDefinitions,
      new Set(replay.archivedChanges),
    );
    const checks = runCiChecksAtCommit(
      git.repositoryRoot,
      head,
      checkIds,
      environment,
    );
    return {
      base,
      head,
      mergeBase,
      commits: commits.map(({ hash }) => hash),
      completedTasks,
      archivedChanges: replay.archivedChanges,
      authorityGrants: replay.authorityGrants,
      attestedAuthorities: attestations.attestedAuthorities,
      directAuthorities: attestations.directAuthorities,
      changedPaths,
      checks,
      managedDocuments: validated.documents,
      runtimeReportsTrusted: false,
    };
  }
  function assertPoliciesAnchored(repositoryRoot: string, base: string): void {
    for (const policyPath of [
      'workflow/config.json',
      'workflow/document-policy.json',
    ]) {
      const basePolicy = readFileAtCommit(repositoryRoot, base, policyPath);
      if (
        basePolicy !== undefined &&
        basePolicy !== readCurrentFile(repositoryRoot, policyPath)
      ) {
        throw ciError(
          'CI_POLICY_CHANGED',
          `Existing CI authority policy changed in ${policyPath}.`,
        );
      }
    }
  }
  function assertHistoricalChecksCurrent(
    repositoryRoot: string,
    contracts: Map<string, ChangeContract>,
    completedTasks: CompletedTask[],
    historicalDefinitions: Record<string, string>,
    archivedChanges: Set<string>,
  ): string[] {
    const current = loadChecksConfig(repositoryRoot);
    return assertCurrentHistoricalChecks(
      current,
      contracts,
      completedTasks,
      historicalDefinitions,
      archivedChanges,
    );
  }
  return { verifyPullRequest };
}
export type PullRequestVerifier = ReturnType<typeof createPullRequestVerifier>;
export type PullRequestVerification = ReturnType<
  PullRequestVerifier['verifyPullRequest']
>;
