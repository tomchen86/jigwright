import path from 'node:path';
import fs from 'node:fs';
import {
  type ChangeRoutingAuthorityPort,
  type ChangeRoutingContinuationGrantPort,
  changeLifecycleRelativePath,
  parseChangeRoutingReview,
  type ChangeRoutingReview,
  digestObservedRepositoryFacts,
  synthesizeSource,
  applyIntent,
  digestSource,
  routingWorksetDigest,
  prettyJson,
} from '../../modules/lifecycle/change-routing.ts';
import { discoverRepository } from '../repository-transaction/git.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
  listActiveWorkflowSessionIds,
} from '../session-workspace/session-store.ts';
import {
  readSourceSnapshot,
  observeChanges,
  authorizeContinuation,
  requiredRoutingAuthorityFacts,
} from './routing-observation.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';

export function applyChangeRoutingReview(
  repositoryRoot: string,
  rawReview: unknown,
  authorityPort: ChangeRoutingAuthorityPort,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): Readonly<{
  sourceDigest: string;
  relativePath: typeof changeLifecycleRelativePath;
  replayed: boolean;
}> {
  const review = parseChangeRoutingReview(rawReview);
  const git = discoverRepository(repositoryRoot);
  const config = loadWorkflowConfig(repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return withRepositoryLifecycleOperation(runtime, () =>
    applyChangeRoutingReviewUnderLifecycleLock(
      repositoryRoot,
      review,
      authorityPort,
      continuationGrantPort,
    ),
  );
}

export function applyChangeRoutingReviewUnderLifecycleLock(
  repositoryRoot: string,
  review: ChangeRoutingReview,
  authorityPort: ChangeRoutingAuthorityPort,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): Readonly<{
  sourceDigest: string;
  relativePath: typeof changeLifecycleRelativePath;
  replayed: boolean;
}> {
  const snapshot = readSourceSnapshot(repositoryRoot);
  if (snapshot.digest === review.nextSourceDigest) {
    return {
      sourceDigest: review.nextSourceDigest,
      relativePath: changeLifecycleRelativePath,
      replayed: true,
    };
  }
  if (snapshot.digest !== review.expectedSourceDigest) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_STALE',
      'The reviewed routing transition no longer matches the controlled lifecycle source.',
      ExitCode.staleState,
    );
  }
  const observed = observeChanges(repositoryRoot, authorityPort);
  if (
    digestObservedRepositoryFacts(observed) !==
    review.expectedRepositoryFactsDigest
  ) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_STALE',
      'The reviewed routing transition no longer matches current task and authority facts.',
      ExitCode.staleState,
    );
  }
  const current = snapshot.source ?? synthesizeSource(observed);
  const continuationAuthority = authorizeContinuation(
    repositoryRoot,
    current,
    snapshot.digest,
    review.intent,
    observed,
    continuationGrantPort,
  );
  const recomputed = applyIntent(current, review.intent, observed);
  const authorityFacts = requiredRoutingAuthorityFacts(
    repositoryRoot,
    review.intent,
    recomputed,
    observed,
    authorityPort,
  );
  if (
    canonicalJson(recomputed) !== canonicalJson(review.nextSource) ||
    digestSource(recomputed) !== review.nextSourceDigest ||
    canonicalJson(authorityFacts) !== canonicalJson(review.authorityFacts) ||
    canonicalJson(continuationAuthority) !==
      canonicalJson(review.continuationAuthority)
  ) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_INVALID',
      'The reviewed routing result cannot be reproduced from current repository facts.',
      ExitCode.verification,
    );
  }
  if (
    routingWorksetDigest(
      current.primaryChangeId,
      current.concurrentChangeIds,
    ) !==
    routingWorksetDigest(
      recomputed.primaryChangeId,
      recomputed.concurrentChangeIds,
    )
  ) {
    const git = discoverRepository(repositoryRoot);
    const config = loadWorkflowConfig(repositoryRoot);
    const activeSessionIds = listActiveWorkflowSessionIds(
      runtimePaths(git.gitCommonDirectory, config.runtimeDirectory),
    );
    if (activeSessionIds.length > 0) {
      throw workflowError(
        'CHANGE_ROUTING_WORKSET_BUSY',
        'The managed writer workset cannot change while a task session is active.',
        ExitCode.conflict,
        { details: { activeSessionIds } },
      );
    }
  }
  const sourcePath = path.join(repositoryRoot, changeLifecycleRelativePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  replaceTextAtomic(sourcePath, prettyJson(recomputed), {
    allowCreate: true,
    defaultMode: 0o644,
  });
  return {
    sourceDigest: review.nextSourceDigest,
    relativePath: changeLifecycleRelativePath,
    replayed: false,
  };
}
