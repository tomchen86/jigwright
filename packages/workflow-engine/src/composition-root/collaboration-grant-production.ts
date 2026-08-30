import {
  issueCollaborationGrant,
  prepareCollaborationGrantIssue,
  type CollaborationGrantIssueOptions,
  type CollaborationGrantRequest,
} from '../modules/authority/collaboration-grant.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { deriveProtectedTaskApplyTaskDiffGrantContinuation } from '../application/finalize/task-diff-review-lifecycle.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  collaborationGrantStorePaths,
  storeAvailableCollaborationGrantUnderLifecycleLock,
} from '../runtime/storage-journal/collaboration-grant-store.ts';
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
    { allowGrantChallengeId: parent.parentChallengeId },
  );
  return { ...prepared, availableEnvelopePath };
}
