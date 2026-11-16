import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import { readFileAtRevision } from '../runtime/repository-transaction/git-command.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { readCollaborationGrantInspection } from '../runtime/storage-journal/collaboration-grant-records.ts';
import {
  createConsumedCollaborationGrantReplayVerifier,
  createCurrentAuthoritativeCollaborationGrantVerifier,
  createCurrentAuthoritativeRoleContextSharingGrantVerifier,
} from './grant-verifier-composition.ts';
import { productionRoleContextSharingGrantLifecyclePort } from './role-context-sharing-grant-lifecycle-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';

/**
 * Assembles production authority dependencies and grant replay verifiers
 * for the CLI.
 *
 * Invariants:
 * - External review reconciliation requires the exact durably consumed
 *   Grant.
 */

export function currentCollaborationGrantSelection(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      readFileAtRevision(
        repository.repositoryRoot,
        repository.head,
        'workflow/maintainer-policy.json',
      ),
    ),
  );
  return Object.freeze({
    grantId,
    verifier: createCurrentAuthoritativeCollaborationGrantVerifier(policy),
  });
}

export function currentRoleContextSharingGrantSelection(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      readFileAtRevision(
        repository.repositoryRoot,
        repository.head,
        'workflow/maintainer-policy.json',
      ),
    ),
  );
  return Object.freeze({
    grantId,
    lifecycle: productionRoleContextSharingGrantLifecyclePort,
    verifier: createCurrentAuthoritativeRoleContextSharingGrantVerifier(policy),
  });
}

function maintainerPolicyAtCommit(repositoryRoot: string, commit: string) {
  return parseMaintainerPolicy(
    JSON.parse(
      readFileAtRevision(
        repositoryRoot,
        commit,
        'workflow/maintainer-policy.json',
      ),
    ),
  );
}

export function taskDiffCollaborationGrantSelection(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const inspection = readCollaborationGrantInspection(
    repository.gitCommonDirectory,
    grantId,
  );
  if (inspection?.state === 'consumed') {
    if (inspection.use === undefined) {
      throw workflowError(
        'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
        'The terminal-only Collaboration Grant replay verifier is unavailable.',
        ExitCode.guard,
      );
    }
    const historicalPolicy = maintainerPolicyAtCommit(
      repository.repositoryRoot,
      inspection.use.envelope.payload.baselineCommit,
    );
    return Object.freeze({
      grantId,
      consumedReplayVerifier:
        createConsumedCollaborationGrantReplayVerifier(historicalPolicy),
    });
  }
  const currentPolicy = parseMaintainerPolicy(
    JSON.parse(
      readFileAtRevision(
        repository.repositoryRoot,
        repository.head,
        'workflow/maintainer-policy.json',
      ),
    ),
  );
  return Object.freeze({
    grantId,
    verifier:
      createCurrentAuthoritativeCollaborationGrantVerifier(currentPolicy),
    consumedReplayVerifier:
      createConsumedCollaborationGrantReplayVerifier(currentPolicy),
  });
}

export function taskDiffConsumedCollaborationGrantReplayVerifier(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const inspection = readCollaborationGrantInspection(
    repository.gitCommonDirectory,
    grantId,
  );
  if (inspection?.state !== 'consumed' || inspection.use === undefined) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_RECONCILIATION_GRANT_NOT_CONSUMED',
      'External TaskDiffReview reconciliation currently requires the exact Grant to have reached its durable consumed state.',
      ExitCode.guard,
    );
  }
  const historicalPolicy = maintainerPolicyAtCommit(
    repository.repositoryRoot,
    inspection.use.envelope.payload.baselineCommit,
  );
  return createConsumedCollaborationGrantReplayVerifier(historicalPolicy);
}

const { inspectActiveTaskMandateBinding } = taskMandateOperations;
