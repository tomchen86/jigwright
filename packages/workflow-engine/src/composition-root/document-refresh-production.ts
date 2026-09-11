/** Binds document refresh use cases to the repository configuration and filesystem store. */
import * as refresh from '../application/documents/document-refresh.ts';
import { assertReviewInput } from '../modules/projection/document-refresh-policy.ts';
import { loadWorkflowConfig } from '../runtime/repository-observation/workflow-configuration.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';
import { createDocumentRefreshStorage } from '../runtime/managed-documents/transaction/document-refresh.ts';

function storage(cwd: string) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return createDocumentRefreshStorage(
    git.repositoryRoot,
    git.gitCommonDirectory,
    runtime.root,
  );
}

export function proposeDocumentRefresh(
  cwd: string,
  requestedTarget: string,
  section: string,
  replacement: string,
) {
  return refresh.proposeDocumentRefresh(
    storage(cwd),
    requestedTarget,
    section,
    replacement,
  );
}

export function reviewDocumentRefresh(
  cwd: string,
  proposalId: string,
  decision: 'approve' | 'reject',
  reviewer: string,
) {
  // Preserve input refusal before repository discovery or runtime directory creation.
  assertReviewInput(decision, reviewer);
  return refresh.reviewDocumentRefresh(
    storage(cwd),
    proposalId,
    decision,
    reviewer,
  );
}

export function inspectDocumentRefreshProposal(
  cwd: string,
  proposalId: string,
) {
  return refresh.inspectDocumentRefreshProposal(storage(cwd), proposalId);
}

export function applyDocumentRefresh(
  cwd: string,
  proposalId: string,
  reviewId: string,
) {
  return refresh.applyDocumentRefresh(storage(cwd), proposalId, reviewId);
}
