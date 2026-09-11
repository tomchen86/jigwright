import type { RepositoryValidation } from '../repository-consumer/repository-validation.ts';

import type { ChecksConfig } from '../source/check-command.ts';
import type {
  CommittedChangeContractReader,
  ChangeContract,
} from '../planning-provider/change-contract.ts';
import type { CheckEvidence } from './check-evidence.ts';

import type { CiPlanningReplayOperations } from './commit-replay/ci-planning.ts';
import type { CiSequenceReplayOperations } from './commit-replay/ci-sequence.ts';
import type { CompletedTask } from './commit-replay/ci-task-state.ts';
import type { CiAttestationResult } from './ci-attestation.ts';
import type {
  VerifiedRoleContextSharingTerminalReceiptV1,
  RoleContextSharingTerminalUseIdentityV1,
} from '../authority/role-context-sharing-grant-lifecycle-port.ts';
import { canonicalCheckDefinition } from './commit-replay/ci-historical-contract.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type PullRequestVerificationServices = Pick<
  CiRepositoryObservations,
  | 'discoverRepository'
  | 'assertCiCommit'
  | 'findMergeBase'
  | 'listRangeCommits'
  | 'listRangePaths'
  | 'listChangesAtCommit'
  | 'readFileAtCommit'
  | 'readCurrentFile'
  | 'loadWorkflowConfig'
  | 'loadChecksConfig'
  | 'currentRepositorySchemaName'
> &
  Pick<CiPlanningReplayOperations, 'collectHistoricalCollaborationGrantUses'> &
  Pick<CiSequenceReplayOperations, 'replayCommitSequence'> & {
    verifyBaseAuthorityAttestations(
      repositoryRoot: string,
      base: string,
      evaluatedAt?: Date,
    ): CiAttestationResult;
    validateRepositoryStateAtCommit(
      repositoryRoot: string,
      head: string,
    ): RepositoryValidation;
    validateWorkflowIntegrationAssets(
      repositoryRoot: string,
      options: { regeneratePlanningAssets?: boolean },
    ): void;
    loadCommittedChangeContract: CommittedChangeContractReader;
    assertRoleContextSharingTerminalReceiptUseBijection(
      receipts: readonly VerifiedRoleContextSharingTerminalReceiptV1[],
      uses: readonly RoleContextSharingTerminalUseIdentityV1[],
    ): void;
    runCiChecksAtCommit(
      repositoryRoot: string,
      head: string,
      checkIds: string[],
      environment: NodeJS.ProcessEnv,
    ): CheckEvidence[];
  };

export function uniqueRoleContextSharingTerminalUses(
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

export function assertChangesPreserved(
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

export function ciError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
export function assertHistoricalChecksCurrent(
  current: ChecksConfig,
  contracts: Map<string, ChangeContract>,
  completedTasks: CompletedTask[],
  historicalDefinitions: Record<string, string>,
  archivedChanges: Set<string>,
): string[] {
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

import type { CiRepositoryObservations } from './commit-replay/ci-git.ts';
