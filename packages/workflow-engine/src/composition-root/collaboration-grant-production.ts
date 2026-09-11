import { taskMandateOperations } from './task-mandate-production.ts';
/**
 * Issues Collaboration Grants with protected-task continuation context when
 * one is required.
 *
 * Invariants:
 * - A protected-task continuation is re-derived under the lifecycle lock
 *   before its available Grant is stored.
 */
import {
  issueCollaborationGrant,
  prepareCollaborationGrantIssue,
} from '../runtime/grants/collaboration-grant-issuance.ts';
import {
  type CollaborationGrantIssueOptions,
  type CollaborationGrantRequest,
} from '../modules/authority/collaboration-grant-codec.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { deriveProtectedTaskApplyTaskDiffGrantContinuation } from './task-diff-review-production.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { collaborationGrantStorePaths } from '../runtime/storage-journal/collaboration-grant-private-files.ts';
import { storeAvailableCollaborationGrantUnderLifecycleLock } from '../runtime/storage-journal/collaboration-grant-reservation.ts';
import { withRepositoryLifecycleOperation } from '../runtime/session-workspace/session-store.ts';

export function issueProductionCollaborationGrant(
  cwd: string,
  request: CollaborationGrantRequest,
  options: CollaborationGrantIssueOptions = {},
) {
  const parent = deriveProtectedTaskApplyTaskDiffGrantContinuation(
    cwd,
    request,
  );
  if (parent === null) return issueCollaborationGrant(cwd, request, options);

  const repository = discoverRepository(cwd);
  const store = collaborationGrantStorePaths(repository.gitCommonDirectory);
  const prepared = prepareCollaborationGrantIssue(cwd, request, options);
  const availableEnvelopePath = withRepositoryLifecycleOperation(
    store.runtime,
    (assertOwned) => {
      assertOwned();
      const current = deriveProtectedTaskApplyTaskDiffGrantContinuation(
        cwd,
        request,
      );
      if (canonicalJson(current) !== canonicalJson(parent)) {
        throw workflowError(
          'PROTECTED_TASK_APPLY_REVIEW_AUTHORIZATION_INVALID',
          'Protected TaskDiffReview Grant continuation changed before persistence.',
          ExitCode.staleState,
        );
      }
      return storeAvailableCollaborationGrantUnderLifecycleLock(
        repository.gitCommonDirectory,
        prepared.envelope,
        assertOwned,
      );
    },
    { allowGrantChallengeIds: [parent.parentChallengeId] },
  );
  return { ...prepared, availableEnvelopePath };
}

import { createCollaborationGrantRevoker } from '../application/control-plane/collaboration-grant-revocation.ts';
import { authorizeHumanRevocation } from './human-revocation-production.ts';
import { collaborationGrantCodec } from '../runtime/grants/grant-services.ts';
import { withCollaborationRevocationStore } from '../runtime/storage-journal/collaboration-grant-revocation-store.ts';
export const revokeCollaborationGrant = createCollaborationGrantRevoker({
  now: () => new Date(),
  discoverRepository,
  taskMandate: taskMandateOperations,
  authorizeHumanRevocation,
  collaborationGrants: collaborationGrantCodec,
  withStoreLock: withCollaborationRevocationStore,
});
