import { preparePullRequestPreMergeAssurance } from './ci-verification-production.ts';
import { planningTransitionExecution as productionPlanningExecution } from './planning-execution-epoch-production.ts';
import { archiveEligibilityReplayServices } from './ci-replay-production.ts';
import { productionPlanningArchiveSourcePolicy } from './planning-archive-projection-production.ts';
import { collaborationGrantCodec as productionArchiveGrantCodec } from '../runtime/grants/grant-services.ts';
import { reconcileArchivedWorkItems as productionArchivedWorkItemReconciler } from './work-registry-production.ts';
import { renderHandoffFromTrackedFacts as productionTrackedHandoffRenderer } from './handoff-production.ts';
const preparePostMergeArchivePullRequest =
  preparePostMergeArchivePullRequestWithHandoff.bind(
    undefined,
    preparePullRequestPreMergeAssurance,
    productionPlanningExecution,
    productionPlanningArchiveSourcePolicy,
    archiveEligibilityReplayServices,
    productionArchiveGrantCodec,
    productionTrackedHandoffRenderer,
    productionArchivedWorkItemReconciler,
  );
/**
 * Assembles archive CLI discovery, preparation, authorization and
 * publication dependencies.
 *
 * Invariants:
 * - The GitHub adapter is loaded on demand through the dependency bundle.
 */
import {
  discoverArchivePullRequestCandidates,
  inspectArchivePublicationPreparation,
  preparePostMergeArchivePullRequest as preparePostMergeArchivePullRequestWithHandoff,
  publishPostMergeArchivePullRequest as publishWithArchiveGrant,
  type GitHubArchiveAdapterModuleV1,
  type ExactArchiveBranchPublisherPortV1,
} from '../application/archive/archive-pr-orchestration.ts';
import type {
  GitHubArchiveAdapterConfigV1,
  GitHubArchiveRulesetObserverPortV1,
} from '@jigwright/github-adapter';
import {
  resolveArchivePullRequestPublicationTarget,
  createGitHubApiArchiveRulesetObserver,
  createGitExactArchiveBranchPublisher,
} from './archive-pr-publication-production.ts';

export type ArchivePullRequestCliDependencies = Readonly<{
  discover: typeof discoverArchivePullRequestCandidates;
  inspect: typeof inspectArchivePublicationPreparation;
  prepare: typeof preparePostMergeArchivePullRequest;
  requestGrant: WorkflowGrantServices['requestArchivePullRequestPublicationGrant'];
  publish: typeof publishPostMergeArchivePullRequest;
  loadAdapter(): Promise<GitHubArchiveAdapterModuleV1>;
  createRulesetObserver(
    input: Readonly<{
      config: GitHubArchiveAdapterConfigV1;
      environment: NodeJS.ProcessEnv;
      fetch?: typeof globalThis.fetch;
    }>,
  ): GitHubArchiveRulesetObserverPortV1;
  createBranchPublisher(): ExactArchiveBranchPublisherPortV1;
  resolvePublicationTarget(
    cwd: string,
    configValue: unknown,
  ): ReturnType<typeof resolveArchivePullRequestPublicationTarget>;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}>;

export function createArchivePullRequestCliDependencies(
  requestArchivePullRequestPublicationGrant: WorkflowGrantServices['requestArchivePullRequestPublicationGrant'],
): ArchivePullRequestCliDependencies {
  return Object.freeze({
    discover: discoverArchivePullRequestCandidates,
    inspect: inspectArchivePublicationPreparation,
    prepare: preparePostMergeArchivePullRequest,
    requestGrant: requestArchivePullRequestPublicationGrant,
    publish: publishPostMergeArchivePullRequest,
    async loadAdapter() {
      return (await import('@jigwright/github-adapter')) as GitHubArchiveAdapterModuleV1;
    },
    createRulesetObserver: createGitHubApiArchiveRulesetObserver,
    createBranchPublisher: createGitExactArchiveBranchPublisher,
    resolvePublicationTarget: resolveArchivePullRequestPublicationTarget,
  });
}
import type { WorkflowGrantServices } from './grant-production.ts';

import { authenticateCompletedArchivePullRequestGrant } from './archive-pr-grant-production.ts';
export const publishPostMergeArchivePullRequest = publishWithArchiveGrant.bind(
  undefined,
  authenticateCompletedArchivePullRequestGrant,
);
