/**
 * Coordinates pull-request verification against checked-out and historical
 * repository authority.
 *
 * Invariants:
 * - The requested CI head must be the checked-out commit.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  assertRoleContextSharingTerminalReceiptUseBijection,
  type RoleContextSharingTerminalUseIdentityV1,
} from '../../composition-root/role-context-sharing-terminal-receipt-production.ts';
import { verifyBaseAuthorityAttestations } from './ci-attestation.ts';
import { runCiChecksAtCommit } from './ci-checks.ts';
import { canonicalCheckDefinition } from './ci-historical-contract.ts';
import { collectHistoricalCollaborationGrantUses } from './ci-planning.ts';
import { replayCommitSequence } from './ci-sequence.ts';
import {
  assertCiCommit,
  findMergeBase,
  listChangesAtCommit,
  listRangeCommits,
  listRangePaths,
  readFileAtCommit,
} from './ci-git.ts';
import type { CompletedTask } from './ci-task-state.ts';
import {
  loadCommittedChangeContract,
  loadChecksConfig,
  loadWorkflowConfig,
  type ChangeContract,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import { validateWorkflowIntegrationAssets } from '../../adapters/consumer/repository/work-registry/integration-assets.ts';
import { validateRepositoryStateAtCommit } from '../../composition-root/repository-validation.ts';
import { currentRepositorySchemaName } from '../../composition-root/validated-contract-context.ts';

export type { CompletedTask } from './ci-task-state.ts';

export function verifyPullRequest(
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
    throw ciError('CI_HEAD_MISMATCH', 'CI head is not the checked out commit.');
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

function uniqueRoleContextSharingTerminalUses(
  uses: readonly {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
    useProjectionDigest?: string;
    admissionDigest?: string;
  }[],
): RoleContextSharingTerminalUseIdentityV1[] {
  const exact = uses.flatMap((use) =>
    use.useProjectionDigest === undefined || use.admissionDigest === undefined
      ? []
      : [
          {
            grantId: use.grantId,
            signedEnvelopeDigest: use.signedEnvelopeDigest,
            transitionDigest: use.transitionDigest,
            useProjectionDigest: use.useProjectionDigest,
            admissionDigest: use.admissionDigest,
          },
        ],
  );
  return [
    ...new Map(
      exact.map((use) => [
        [
          use.grantId,
          use.signedEnvelopeDigest,
          use.transitionDigest,
          use.useProjectionDigest,
          use.admissionDigest,
        ].join(':'),
        use,
      ]),
    ).values(),
  ];
}

function assertChangesPreserved(
  baseChanges: string[],
  contracts: Map<string, ChangeContract>,
  archiveClaims: Set<string>,
): void {
  const removed = baseChanges.filter(
    (changeId) => !contracts.has(changeId) && !archiveClaims.has(changeId),
  );
  if (removed.length > 0) {
    throw ciError(
      'CI_CHANGE_REMOVED',
      'Active changes may not disappear across the CI merge boundary.',
      { removedChanges: removed },
    );
  }
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
  const required = new Map(Object.entries(historicalDefinitions));
  for (const task of completedTasks) {
    const policy = contracts.get(task.changeId)?.guard.tasks[task.taskId];
    if (!policy) {
      if (
        archivedChanges.has(task.changeId) &&
        Object.keys(historicalDefinitions).length > 0
      ) {
        continue;
      }
      throw ciError(
        'CI_MANAGED_TRAILER_UNKNOWN',
        'A completed task is absent from the current validated contract.',
      );
    }
    for (const checkId of policy.requiredChecks) {
      if (!required.has(checkId)) {
        const definition = current.checks[checkId];
        if (!definition) {
          throw ciError(
            'CI_CHECK_UNKNOWN',
            `CI task policy references unknown check ${checkId}.`,
          );
        }
        required.set(checkId, canonicalCheckDefinition(definition));
      }
    }
  }
  for (const [checkId, expected] of required) {
    const definition = current.checks[checkId];
    if (!definition || canonicalCheckDefinition(definition) !== expected) {
      throw ciError(
        'CI_CHECK_DEFINITION_CHANGED',
        `Required check ${checkId} changed after its task commit.`,
      );
    }
  }
  return [...required.keys()].sort();
}

function readCurrentFile(
  repositoryRoot: string,
  filePath: string,
): string | undefined {
  try {
    return fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8');
  } catch {
    return undefined;
  }
}

function ciError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
