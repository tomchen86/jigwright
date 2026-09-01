import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ArchivePullRequestCandidateV1,
  ArchivePullRequestPublicationV1,
  ArchivePullRequestRemotePortV1,
  GitHubArchiveAdapterConfigV1,
  GitHubArchiveRulesetObservationV1,
  GitHubArchiveRulesetObserverPortV1,
  OpenedArchivePullRequestV1,
  OpenedGitHubArchivePullRequestV1,
} from '@jigwright/github-adapter';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  protectedBranchRef,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  commitArchiveTransition,
  readVerifiedArchiveTransitionEvidence,
  type ArchiveTransitionResult,
  type ArchiveTransitionTestHooks,
} from './archive-transition.ts';
import { preparePullRequestPreMergeAssurance } from '../../entrypoints/ci/pre-merge-assurance-git.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import {
  createArchivePublicationPreparation,
  persistArchivePublicationPreparation,
  readArchivePublicationPreparation,
  type ArchivePublicationPreparationV1,
} from '../../runtime/storage-journal/archive-publication-store.ts';
import {
  assertArchivePublicationTarget,
  authenticateCompletedArchivePullRequestGrant,
  type ArchivePullRequestPublicationTargetV1,
  type CompletedArchivePullRequestGrantReferenceV1,
} from '../../modules/authority/archive-pr-grant.ts';
import { grantStorePaths } from '../../runtime/storage-journal/grant-store.ts';
import { repositoryPlanningConfiguration } from '../../modules/repository-consumer/repository-consumer-config.ts';

export type ArchivePullRequestCandidateProjectionInput = Readonly<{
  repositoryId: string;
  changeId: string;
  branch: string;
  head: string;
  tree: string;
  remoteName: 'origin';
  remoteTrackingRef: string;
  remoteHead: string;
  remoteTree: string;
  manifestSchemaVersion: number;
  manifestDigest: string;
  investigationTargetDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  advisoryVerdict: 'advisory-approve' | 'advisory-reject';
  requiredIndependence: 'provider-independent';
  achievedIndependence:
    | 'provider-independent'
    | 'principal-independent'
    | 'session-independent'
    | 'none';
}>;

export type ArchivePullRequestAuthorizationFactsV1 = Readonly<{
  centralGrantRecord: CompletedArchivePullRequestGrantReferenceV1;
  rulesetObservation: Readonly<{
    observationDigest: string;
    authenticationReceiptDigest: string;
    observedAt: string;
    expiresAt: string;
  }>;
}>;

export type LocalArchivePullRequestAssuranceV1 = Readonly<{
  status: 'passed';
  baseCommit: string;
  headCommit: string;
  reportIdentity: string;
}>;

export type PreparedPostMergeArchivePullRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'prepared-post-merge-archive-pull-request';
  candidate: ArchivePullRequestCandidateV1;
  worktreePath: string;
  archiveBranch: string;
  archive: ArchiveTransitionResult;
  archiveReplay: ArchiveTransitionResult;
  assurance: LocalArchivePullRequestAssuranceV1;
  preparation: ArchivePublicationPreparationV1;
  preparationRecordPath: string;
}>;

export type ArchivePublicationPreparationStatusV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-publication-preparation-status.v1';
  authority: 'diagnostic';
  state: 'local-preparation-current';
  preparationIdentity: `sha256:${string}`;
  changeId: string;
  protectedBase: ArchivePublicationPreparationV1['protectedBase'];
  archive: Readonly<
    ArchivePublicationPreparationV1['archive'] & { archivePath: string }
  >;
  recordedAssurance: ArchivePublicationPreparationV1['assurance'];
  publicationBoundary: Readonly<{
    remoteState: 'not-observed-by-local-status';
    operationalGate: 'pending';
  }>;
  replayCommand: string;
}>;

export type PreparePostMergeArchivePullRequestOptions = Readonly<{
  workspaceParent?: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  assure?: (
    cwd: string,
    baseCommit: string,
    headCommit: string,
  ) => LocalArchivePullRequestAssuranceV1;
  archiveHooks?: Omit<ArchiveTransitionTestHooks, 'expectedRemoteBase'>;
}>;

export type GitHubArchiveAdapterModuleV1 = Readonly<{
  parseGitHubArchiveAdapterConfig(value: unknown): GitHubArchiveAdapterConfigV1;
  createGitHubArchivePullRequestRemote(
    options: Readonly<{
      config: GitHubArchiveAdapterConfigV1;
      token(): string;
      fetch?: typeof globalThis.fetch;
      rulesetObserver?: GitHubArchiveRulesetObserverPortV1;
    }>,
  ): Readonly<{
    observeRuleset(
      input: Readonly<{
        base: string;
        baseCommit: string;
      }>,
    ): Promise<GitHubArchiveRulesetObservationV1>;
    prepare(
      publication: ArchivePullRequestPublicationV1,
    ): import('@jigwright/github-adapter').PreparedGitHubArchivePullRequestV1;
    open(
      prepared: import('@jigwright/github-adapter').PreparedGitHubArchivePullRequestV1,
    ): Promise<OpenedGitHubArchivePullRequestV1>;
  }>;
}>;

export type PublishPostMergeArchivePullRequestOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  loadAdapter?: () => Promise<GitHubArchiveAdapterModuleV1>;
  grantChallengeId: string;
  publicationTarget: ArchivePullRequestPublicationTargetV1;
  rulesetObserver: GitHubArchiveRulesetObserverPortV1;
  branchPublisher: ExactArchiveBranchPublisherPortV1;
}>;

export type ExactArchiveBranchPublicationRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'exact-archive-branch-publication-request.v1';
  preparationIdentity: `sha256:${string}`;
  repositoryRoot: string;
  remoteName: 'origin';
  protectedBaseRef: string;
  protectedBaseCommit: string;
  archiveRef: string;
  archiveHead: string;
  expectedArchiveRemoteHead: null;
}>;

export type ExactArchiveBranchPublicationReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: 'exact-archive-branch-publication-receipt.v1';
  requestDigest: `sha256:${string}`;
  observedProtectedBaseCommit: string;
  observedArchiveHead: string;
  disposition: 'created' | 'confirmed';
  force: false;
  receiptDigest: `sha256:${string}`;
}>;

export type ExactArchiveBranchPublisherPortV1 = Readonly<{
  contractVersion: 'exact-archive-branch-publisher.v1';
  publish(
    request: ExactArchiveBranchPublicationRequestV1,
  ):
    | ExactArchiveBranchPublicationReceiptV1
    | Promise<ExactArchiveBranchPublicationReceiptV1>;
}>;

export type ArchivePullRequestCandidateInventoryV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-pull-request-candidate-inventory';
  base: string;
  items: readonly (
    | Readonly<{
        changeId: string;
        state: 'eligible';
        candidate: ArchivePullRequestCandidateV1;
        blocker: null;
        nextSafeCommand: string;
      }>
    | Readonly<{
        changeId: string;
        state: 'blocked';
        candidate: null;
        blocker: Readonly<{ code: string; message: string }>;
        nextSafeCommand: null;
      }>
    | Readonly<{
        changeId: string;
        state: 'already-archived';
        candidate: null;
        blocker: null;
        archivePath: string;
        nextSafeCommand: null;
      }>
  )[];
}>;

export type PublishedPostMergeArchivePullRequestV1 = Readonly<{
  publication: ArchivePullRequestPublicationV1;
  publicationRecordPath: string;
  rulesetObservation: GitHubArchiveRulesetObservationV1;
  branchPublication: ExactArchiveBranchPublicationReceiptV1;
  prepared: import('@jigwright/github-adapter').PreparedGitHubArchivePullRequestV1;
  opened: OpenedGitHubArchivePullRequestV1;
  receiptPath: string;
}>;

/**
 * Discover a completed, current-authority archive candidate without acquiring
 * a transition lock, writing runtime state, creating a branch, or contacting a
 * remote. The shared contract loader replays the tracked Manifest v3 and its
 * exact PlanReview binding before this projection is admitted.
 */
export function discoverArchivePullRequestCandidate(
  cwd: string,
  requestedChangeId: string,
): ArchivePullRequestCandidateV1 {
  const before = discoverRepository(cwd);
  if (before.statusEntries.length > 0 || before.branch === null) {
    throw archivePrError(
      'ARCHIVE_PR_CLEAN_BASE_REQUIRED',
      'Archive PR discovery requires one attached clean base branch.',
    );
  }
  const stable = loadStableValidatedChangeContract(before, requestedChangeId);
  const { contract, git } = stable;
  const currentSchemaName = repositoryPlanningConfiguration(
    git.repositoryRoot,
  ).currentSchemaName;
  const protectedBase = contract.config.protectedBranches[0];
  if (protectedBase === undefined || git.branch !== protectedBase) {
    throw archivePrError(
      'ARCHIVE_PR_PROTECTED_BASE_REQUIRED',
      'Archive PR discovery runs only from the configured protected base.',
    );
  }
  if (
    contract.schemaName !== currentSchemaName ||
    contract.investigation === undefined ||
    contract.planningAssurance === null ||
    contract.tasks.some(({ completed }) => !completed)
  ) {
    throw archivePrError(
      'ARCHIVE_PR_CURRENT_ASSURANCE_REQUIRED',
      'Archive PR discovery requires a completed current Manifest v3 change with PlanReview assurance.',
    );
  }
  const remote = resolveExactProtectedRemoteBase(
    git.repositoryRoot,
    protectedBase,
  );
  if (git.head !== remote.head || git.tree !== remote.tree) {
    throw archivePrError(
      'ARCHIVE_PR_REMOTE_BASE_MISMATCH',
      'Archive PR discovery requires the local protected base to equal its exact remote-tracking identity.',
    );
  }
  const current = discoverRepository(git.repositoryRoot);
  const currentRemote = resolveExactProtectedRemoteBase(
    current.repositoryRoot,
    protectedBase,
  );
  if (
    current.head !== git.head ||
    current.tree !== git.tree ||
    current.branch !== git.branch ||
    currentRemote.head !== remote.head ||
    currentRemote.tree !== remote.tree
  ) {
    throw archivePrError(
      'ARCHIVE_PR_REMOTE_BASE_CHANGED',
      'The protected local or remote-tracking base changed during candidate discovery.',
    );
  }
  return projectArchivePullRequestCandidate({
    repositoryId: contract.config.repositoryName,
    changeId: contract.changeId,
    branch: git.branch,
    head: git.head,
    tree: git.tree,
    remoteName: 'origin',
    remoteTrackingRef: remote.ref,
    remoteHead: remote.head,
    remoteTree: remote.tree,
    manifestSchemaVersion: contract.investigation.manifest.schemaVersion,
    manifestDigest: contract.investigation.validation.manifestDigest,
    investigationTargetDigest:
      contract.investigation.validation.investigationTargetDigest,
    reviewNodeId: contract.planningAssurance.reviewNodeId,
    reviewResultDigest: contract.planningAssurance.reviewResultDigest,
    advisoryVerdict: contract.planningAssurance.advisoryVerdict,
    requiredIndependence: contract.planningAssurance.requiredIndependence,
    achievedIndependence: contract.planningAssurance.achievedIndependence,
  });
}

export function discoverArchivePullRequestCandidates(
  cwd: string,
  requestedBase: string,
): ArchivePullRequestCandidateInventoryV1 {
  const context = loadInvestigationRuntimeContext(cwd);
  const repository = context.git;
  const config = context.config;
  const protectedBranch = config.protectedBranches[0];
  const expectedBase =
    protectedBranch === undefined ? null : `origin/${protectedBranch}`;
  if (expectedBase === null || requestedBase !== expectedBase) {
    throw archivePrError(
      'ARCHIVE_PR_BASE_INVALID',
      'Archive candidate discovery requires the exact configured protected remote base.',
    );
  }
  const changeRoot = path.join(repository.repositoryRoot, config.changeRoot);
  const activeIds = fs
    .readdirSync(changeRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'archive' &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name),
    )
    .map(({ name }) => name)
    .sort();
  const activeItems: ArchivePullRequestCandidateInventoryV1['items'][number][] =
    activeIds.map((changeId) => {
      try {
        const candidate = discoverArchivePullRequestCandidate(
          repository.repositoryRoot,
          changeId,
        );
        return Object.freeze({
          changeId,
          state: 'eligible' as const,
          candidate,
          blocker: null,
          nextSafeCommand: `jigwright after-merge ${changeId} --json`,
        });
      } catch (error) {
        const code =
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'ARCHIVE_PR_CANDIDATE_BLOCKED';
        return Object.freeze({
          changeId,
          state: 'blocked' as const,
          candidate: null,
          blocker: Object.freeze({
            code,
            message:
              error instanceof Error
                ? error.message
                : 'Archive candidate validation failed.',
          }),
          nextSafeCommand: null,
        });
      }
    });
  const archiveRoot = path.join(changeRoot, 'archive');
  const archivedItems: ArchivePullRequestCandidateInventoryV1['items'][number][] =
    fs.lstatSync(archiveRoot, { throwIfNoEntry: false })?.isDirectory()
      ? fs
          .readdirSync(archiveRoot, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() &&
              /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name),
          )
          .map(({ name }) => {
            const changeId = name.slice('0000-00-00-'.length);
            return Object.freeze({
              changeId,
              state: 'already-archived' as const,
              candidate: null,
              blocker: null,
              archivePath: `${config.changeRoot}/archive/${name}`,
              nextSafeCommand: null,
            });
          })
      : [];
  return Object.freeze({
    schemaVersion: 1,
    kind: 'archive-pull-request-candidate-inventory',
    base: requestedBase,
    items: Object.freeze(
      [...activeItems, ...archivedItems].sort((left, right) =>
        left.changeId.localeCompare(right.changeId),
      ),
    ),
  });
}

export function projectArchivePullRequestCandidate(
  input: ArchivePullRequestCandidateProjectionInput,
): ArchivePullRequestCandidateV1 {
  if (
    input.manifestSchemaVersion !== 3 ||
    input.advisoryVerdict !== 'advisory-approve' ||
    input.requiredIndependence !== 'provider-independent' ||
    input.achievedIndependence !== 'provider-independent'
  ) {
    throw archivePrError(
      'ARCHIVE_PR_CURRENT_ASSURANCE_REQUIRED',
      'Archive PR candidates require current Manifest v3 authority and a provider-independent approving PlanReview.',
    );
  }
  const identityFacts = {
    schemaVersion: 1,
    repositoryId: input.repositoryId,
    changeId: input.changeId,
    base: {
      branch: input.branch,
      commit: input.head,
      tree: input.tree,
      remote: {
        name: input.remoteName,
        trackingRef: input.remoteTrackingRef,
        commit: input.remoteHead,
        tree: input.remoteTree,
      },
    },
    manifest: {
      schemaVersion: 3,
      digest: input.manifestDigest,
      investigationTargetDigest: input.investigationTargetDigest,
    },
    planReview: {
      nodeId: input.reviewNodeId,
      resultDigest: input.reviewResultDigest,
      advisoryVerdict: input.advisoryVerdict,
      requiredIndependence: input.requiredIndependence,
      achievedIndependence: input.achievedIndependence,
    },
  } as const;
  return Object.freeze({
    ...identityFacts,
    kind: 'archive-pull-request-candidate' as const,
    identity: crypto
      .createHash('sha256')
      .update('archive-pull-request-candidate/v1\0')
      .update(canonicalJson(identityFacts))
      .digest('hex'),
  });
}

export function openArchivePullRequest(
  publication: ArchivePullRequestPublicationV1,
  remote: ArchivePullRequestRemotePortV1,
): OpenedArchivePullRequestV1 {
  if (
    remote.capabilities.approve ||
    remote.capabilities.bypass ||
    remote.capabilities.merge
  ) {
    throw archivePrError(
      'ARCHIVE_PR_REMOTE_AUTHORITY_FORBIDDEN',
      'Archive PR automation may prepare and open but never approve, bypass, or merge.',
    );
  }
  return remote.open(remote.prepare(publication));
}

/**
 * Execute the Stage-2 local path on an isolated canonical branch. The caller's
 * protected-base worktree is never checked out or mutated, and publication is
 * deliberately a later explicit operation.
 */
export function preparePostMergeArchivePullRequest(
  cwd: string,
  requestedChangeId: string,
  options: PreparePostMergeArchivePullRequestOptions,
): PreparedPostMergeArchivePullRequestV1 {
  const candidate = discoverArchivePullRequestCandidate(cwd, requestedChangeId);
  const repository = discoverRepository(cwd);
  const archiveBranch = `work/archive-${candidate.changeId}`;
  const worktreePath = prepareArchiveWorktree(
    repository,
    candidate,
    archiveBranch,
    options.workspaceParent,
  );
  materializeArchiveWorkspaceDependencies(
    repository.repositoryRoot,
    worktreePath,
  );
  const archive = commitArchiveTransition(
    worktreePath,
    candidate.changeId,
    options.environment ?? process.env,
    {
      ...options.archiveHooks,
      ...(options.now === undefined ? {} : { now: () => options.now! }),
      expectedRemoteBase: candidate.base.remote,
    },
  );
  const archiveReplay = commitArchiveTransition(
    worktreePath,
    candidate.changeId,
    options.environment ?? process.env,
    {
      ...options.archiveHooks,
      ...(options.now === undefined ? {} : { now: () => options.now! }),
      expectedRemoteBase: candidate.base.remote,
    },
  );
  if (
    archiveReplay.status !== 'already-archived' ||
    archiveReplay.commitHash !== archive.commitHash ||
    archiveReplay.reportId !== archive.reportId ||
    archiveReplay.archivePath !== archive.archivePath ||
    canonicalJson(archiveReplay.changedPaths) !==
      canonicalJson(archive.changedPaths)
  ) {
    throw archivePrError(
      'ARCHIVE_PR_IDEMPOTENCY_MISMATCH',
      'Local archive replay did not return the same exact archive identity.',
    );
  }
  const assure = options.assure ?? runLocalArchivePullRequestAssurance;
  const assurance = assure(
    worktreePath,
    candidate.base.commit,
    archive.commitHash,
  );
  assertLocalAssurance(assurance, candidate.base.commit, archive.commitHash);
  const preparation = createArchivePublicationPreparation({
    repositoryId: candidate.repositoryId,
    changeId: candidate.changeId,
    candidateIdentity: candidate.identity,
    protectedBase: {
      branch: candidate.base.branch,
      remoteName: candidate.base.remote.name,
      trackingRef: candidate.base.remote.trackingRef,
      commit: candidate.base.remote.commit,
      tree: candidate.base.remote.tree,
    },
    archive: {
      branch: archiveBranch,
      headCommit: archive.commitHash,
      reportId: archive.reportId,
    },
    assurance: {
      reportIdentity: assurance.reportIdentity,
      baseCommit: assurance.baseCommit,
      headCommit: assurance.headCommit,
    },
  });
  const preparationRecordPath = persistArchivePublicationPreparation(
    loadInvestigationRuntimeContext(repository.repositoryRoot).lifecycleRuntime
      .root,
    preparation,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'prepared-post-merge-archive-pull-request',
    candidate,
    worktreePath,
    archiveBranch,
    archive,
    archiveReplay,
    assurance,
    preparation,
    preparationRecordPath,
  });
}

/**
 * Replay one durable local archive preparation without loading a remote
 * adapter, contacting a network, creating a worktree, or mutating Git/runtime
 * state. This is diagnostic evidence only; publication revalidates its own
 * Grant and remote boundary separately.
 */
export function inspectArchivePublicationPreparation(
  cwd: string,
  preparationIdentity: string,
): ArchivePublicationPreparationStatusV1 {
  const context = loadInvestigationRuntimeContext(cwd);
  const repositoryRoot = context.git.repositoryRoot;
  const preparation = readArchivePublicationPreparation(
    context.lifecycleRuntime.root,
    preparationIdentity,
  );
  const configuredProtectedBranch = context.config.protectedBranches[0];
  const protectedLocal = readCommitRef(
    repositoryRoot,
    `refs/heads/${preparation.protectedBase.branch}`,
  );
  const protectedRemote = readCommitRef(
    repositoryRoot,
    preparation.protectedBase.trackingRef,
  );
  const archiveRef = readCommitRef(
    repositoryRoot,
    `refs/heads/${preparation.archive.branch}`,
  );
  if (
    preparation.repositoryId !== context.config.repositoryName ||
    configuredProtectedBranch !== preparation.protectedBase.branch ||
    protectedLocal?.commit !== preparation.protectedBase.commit ||
    protectedLocal.tree !== preparation.protectedBase.tree ||
    protectedRemote?.commit !== preparation.protectedBase.commit ||
    protectedRemote.tree !== preparation.protectedBase.tree ||
    archiveRef?.commit !== preparation.archive.headCommit ||
    preparation.assurance.baseCommit !== preparation.protectedBase.commit ||
    preparation.assurance.headCommit !== preparation.archive.headCommit
  ) {
    throw archivePreparationStale();
  }

  let report: ReturnType<
    typeof readVerifiedArchiveTransitionEvidence
  >['report'];
  try {
    report = readVerifiedArchiveTransitionEvidence(repositoryRoot, {
      changeId: preparation.changeId,
      parentCommit: preparation.protectedBase.commit,
      commitHash: preparation.archive.headCommit,
      reportId: preparation.archive.reportId,
    }).report;
  } catch {
    throw archivePreparationStale();
  }
  if (archiveRef.tree !== report.tree) {
    throw archivePreparationStale();
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: 'archive-publication-preparation-status.v1',
    authority: 'diagnostic',
    state: 'local-preparation-current',
    preparationIdentity: preparation.preparationIdentity,
    changeId: preparation.changeId,
    protectedBase: preparation.protectedBase,
    archive: Object.freeze({
      ...preparation.archive,
      archivePath: report.archivePath,
    }),
    recordedAssurance: preparation.assurance,
    publicationBoundary: Object.freeze({
      remoteState: 'not-observed-by-local-status',
      operationalGate: 'pending',
    }),
    replayCommand: `pnpm workflow after-merge ${preparation.changeId} --json`,
  });
}

export function projectArchivePullRequestPublication(
  input: Readonly<{
    candidate: ArchivePullRequestCandidateV1;
    archiveBranch: string;
    archive: ArchiveTransitionResult;
    assurance: LocalArchivePullRequestAssuranceV1;
    authorization: ArchivePullRequestAuthorizationFactsV1;
  }>,
): ArchivePullRequestPublicationV1 {
  if (
    input.archiveBranch !== `work/archive-${input.candidate.changeId}` ||
    input.archive.changeId !== input.candidate.changeId ||
    input.archive.status === undefined ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.archive.commitHash) ||
    !/^[0-9a-f]{64}$/.test(input.archive.reportId)
  ) {
    throw archivePrError(
      'ARCHIVE_PR_LOCAL_ARCHIVE_INVALID',
      'Local archive identity does not match the discovered candidate.',
    );
  }
  assertLocalAssurance(
    input.assurance,
    input.candidate.base.commit,
    input.archive.commitHash,
  );
  assertAuthorizationFacts(input.authorization);
  const identityFacts = {
    schemaVersion: 1 as const,
    kind: 'archive-pull-request-publication' as const,
    candidate: input.candidate,
    archive: {
      branch: input.archiveBranch,
      baseCommit: input.candidate.base.commit,
      headCommit: input.archive.commitHash,
      reportId: input.archive.reportId,
    },
    assurance: input.assurance,
    authorization: input.authorization,
  };
  return Object.freeze({
    ...identityFacts,
    publicationIdentity: crypto
      .createHash('sha256')
      .update('archive-pull-request-publication/v1\0')
      .update(canonicalJson(identityFacts))
      .digest('hex'),
  });
}

/**
 * Explicit Stage-3 publication caller. Loading the optional adapter, reading
 * the short-lived token, and contacting GitHub happen only in this function;
 * candidate discovery and local preparation never cross the network boundary.
 */
export async function publishPostMergeArchivePullRequest(
  cwd: string,
  local: PreparedPostMergeArchivePullRequestV1,
  configValue: unknown,
  options: PublishPostMergeArchivePullRequestOptions,
): Promise<PublishedPostMergeArchivePullRequestV1> {
  const loadAdapter =
    options.loadAdapter ??
    (async () =>
      (await import('@jigwright/github-adapter')) as GitHubArchiveAdapterModuleV1);
  let adapter: GitHubArchiveAdapterModuleV1;
  try {
    adapter = await loadAdapter();
  } catch {
    throw archivePrError(
      'ARCHIVE_PR_GITHUB_ADAPTER_UNAVAILABLE',
      'Remote archive publication requires the optional @jigwright/github-adapter package.',
    );
  }
  let config: GitHubArchiveAdapterConfigV1;
  try {
    config = adapter.parseGitHubArchiveAdapterConfig(configValue);
  } catch {
    throw archivePrError(
      'ARCHIVE_PR_GITHUB_CONFIG_INVALID',
      'Remote archive publication configuration is invalid or contains forbidden credential material.',
    );
  }
  assertPublicationTargetMatchesConfig(options.publicationTarget, config);
  const runtimeRoot =
    loadInvestigationRuntimeContext(cwd).lifecycleRuntime.root;
  const centralGrantRecord = authenticateCompletedArchivePullRequestGrant(
    grantStorePaths(runtimeRoot),
    runtimeRoot,
    options.grantChallengeId,
    local.preparation.preparationIdentity,
    options.publicationTarget,
  );
  const environment = options.environment ?? process.env;
  const remote = adapter.createGitHubArchivePullRequestRemote({
    config,
    token: () => environment[config.tokenEnvironmentVariable] ?? '',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    rulesetObserver: options.rulesetObserver,
  });
  const rulesetObservation = await remote.observeRuleset({
    base: local.candidate.base.branch,
    baseCommit: local.candidate.base.commit,
  });
  const authorization = Object.freeze({
    centralGrantRecord,
    rulesetObservation: Object.freeze({
      observationDigest: rulesetObservation.observationDigest,
      authenticationReceiptDigest:
        rulesetObservation.authenticationReceiptDigest,
      observedAt: rulesetObservation.observedAt,
      expiresAt: rulesetObservation.expiresAt,
    }),
  });
  const publication = projectArchivePullRequestPublication({
    candidate: local.candidate,
    archiveBranch: local.archiveBranch,
    archive: local.archive,
    assurance: local.assurance,
    authorization,
  });
  const publicationRecordPath = persistArchivePublication(
    discoverRepository(cwd),
    publication,
  );
  const prepared = remote.prepare(publication);
  const publicationRequest = exactArchiveBranchPublicationRequest(local);
  const branchPublication =
    await options.branchPublisher.publish(publicationRequest);
  assertExactArchiveBranchPublicationReceipt(
    publicationRequest,
    branchPublication,
  );
  let opened: OpenedGitHubArchivePullRequestV1;
  try {
    opened = await remote.open(prepared);
  } catch {
    throw archivePrError(
      'ARCHIVE_PR_GITHUB_REMOTE_FAILED',
      'Remote archive publication failed closed; retry will revalidate the exact branch and pull request identities.',
    );
  }
  const receiptPath = persistOpenedArchivePullRequest(
    discoverRepository(cwd),
    opened,
  );
  return Object.freeze({
    publication,
    publicationRecordPath,
    rulesetObservation,
    branchPublication,
    prepared,
    opened,
    receiptPath,
  });
}

function assertPublicationTargetMatchesConfig(
  targetValue: ArchivePullRequestPublicationTargetV1,
  config: GitHubArchiveAdapterConfigV1,
): void {
  const target = assertArchivePublicationTarget(targetValue);
  if (
    target.apiBaseUrl !== config.apiBaseUrl ||
    target.owner !== config.owner ||
    target.repository !== config.repository ||
    target.adapterConfigDigest !== digestWithPrefix(canonicalJson(config))
  ) {
    throw archivePrError(
      'ARCHIVE_PR_PUBLICATION_TARGET_CHANGED',
      'The GitHub adapter target changed after the exact archive publication Grant was created.',
    );
  }
}

function prepareArchiveWorktree(
  repository: ReturnType<typeof discoverRepository>,
  candidate: ArchivePullRequestCandidateV1,
  branch: string,
  requestedParent?: string,
): string {
  const requestedParentPath = path.resolve(
    requestedParent ??
      path.join(
        path.dirname(repository.repositoryRealPath),
        `${path.basename(repository.repositoryRealPath)}-archive-worktrees`,
      ),
  );
  const parent = path.join(
    fs.realpathSync(path.dirname(requestedParentPath)),
    path.basename(requestedParentPath),
  );
  if (
    !path.isAbsolute(parent) ||
    pathIsInside(parent, repository.repositoryRealPath) ||
    pathIsInside(parent, repository.gitCommonDirectory)
  ) {
    throw archivePrError(
      'ARCHIVE_PR_WORKTREE_PATH_INVALID',
      'Archive worktree parent must be an absolute path outside repository authority roots.',
    );
  }
  const branchOid = runGit(
    repository.repositoryRoot,
    ['show-ref', '--verify', '--hash', `refs/heads/${branch}`],
    true,
  ).trim();
  if (branchOid !== '') {
    assertReusableArchiveBranchIdentity(repository, candidate, branchOid);
  }
  const canonicalParent = ensureArchiveWorkspaceParent(parent);
  const worktreePath = path.join(canonicalParent, candidate.changeId);
  const registrations = listWorktrees(repository.repositoryRoot);
  const exact = registrations.find(
    (registration) => registration.worktreePath === worktreePath,
  );
  const branchRegistration = registrations.find(
    (registration) => registration.branch === branch,
  );
  if (exact !== undefined) {
    if (exact.branch !== branch || branchRegistration !== exact) {
      throw archivePrError(
        'ARCHIVE_PR_WORKTREE_COLLISION',
        'Archive worktree path or branch is already owned by another registration.',
      );
    }
    assertReusableArchiveWorktree(
      worktreePath,
      repository.gitCommonDirectory,
      branch,
      candidate.base.commit,
    );
    return worktreePath;
  }
  if (fs.lstatSync(worktreePath, { throwIfNoEntry: false }) !== undefined) {
    throw archivePrError(
      'ARCHIVE_PR_WORKTREE_COLLISION',
      'Archive worktree path already exists without exact Git ownership.',
    );
  }
  if (branchRegistration !== undefined) {
    throw archivePrError(
      'ARCHIVE_PR_WORKTREE_COLLISION',
      'Canonical archive branch is checked out by another worktree.',
    );
  }
  if (branchOid === '') {
    runGit(repository.repositoryRoot, [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      candidate.base.commit,
    ]);
  } else {
    runGit(repository.repositoryRoot, [
      'worktree',
      'add',
      worktreePath,
      branch,
    ]);
  }
  assertReusableArchiveWorktree(
    worktreePath,
    repository.gitCommonDirectory,
    branch,
    candidate.base.commit,
  );
  return worktreePath;
}

function assertReusableArchiveBranchIdentity(
  repository: ReturnType<typeof discoverRepository>,
  candidate: ArchivePullRequestCandidateV1,
  branchOid: string,
): void {
  if (branchOid === candidate.base.commit) return;
  let currentArchiveIdentity = false;
  try {
    const context = loadInvestigationRuntimeContext(repository.repositoryRoot);
    const report = readVerifiedArchiveTransitionEvidence(
      repository.repositoryRoot,
      {
        changeId: candidate.changeId,
        parentCommit: candidate.base.commit,
        commitHash: branchOid,
      },
    ).report;
    const archivePrefix = `${context.config.changeRoot}/archive/`;
    const archiveName = report.archivePath.startsWith(archivePrefix)
      ? report.archivePath.slice(archivePrefix.length)
      : '';
    currentArchiveIdentity =
      archiveName ===
        `${archiveName.slice(0, '0000-00-00'.length)}-${candidate.changeId}` &&
      /^\d{4}-\d{2}-\d{2}-/.test(archiveName);
  } catch {
    currentArchiveIdentity = false;
  }
  if (!currentArchiveIdentity) {
    throw archivePrError(
      'ARCHIVE_PR_BRANCH_COLLISION',
      'Existing canonical archive branch is neither the exact protected base nor one current report-backed archive commit.',
    );
  }
}

function assertReusableArchiveWorktree(
  worktreePath: string,
  expectedGitCommonDirectory: string,
  expectedBranch: string,
  expectedBase: string,
): void {
  const observed = discoverRepository(worktreePath);
  if (
    observed.gitCommonDirectory !== expectedGitCommonDirectory ||
    observed.repositoryRealPath !== fs.realpathSync(worktreePath) ||
    observed.branch !== expectedBranch ||
    observed.statusEntries.length > 0 ||
    runGit(
      worktreePath,
      ['merge-base', expectedBase, observed.head],
      true,
    ).trim() !== expectedBase
  ) {
    throw archivePrError(
      'ARCHIVE_PR_WORKTREE_COLLISION',
      'Archive worktree does not match its exact repository, branch, base, and clean-state identity.',
    );
  }
}

function materializeArchiveWorkspaceDependencies(
  sourceRepositoryRoot: string,
  worktreePath: string,
): void {
  const source = path.join(sourceRepositoryRoot, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats !== undefined) {
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
      throw archivePrError(
        'ARCHIVE_PR_WORKSPACE_DEPENDENCIES_INVALID',
        'Archive workspace dependency root is not one plain directory.',
      );
    }
    return;
  }
  const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
  if (
    sourceStats === undefined ||
    !sourceStats.isDirectory() ||
    sourceStats.isSymbolicLink()
  ) {
    throw archivePrError(
      'ARCHIVE_PR_WORKSPACE_DEPENDENCIES_UNAVAILABLE',
      'Local archive orchestration requires the source worktree frozen dependencies to be installed.',
    );
  }
  try {
    fs.cpSync(source, target, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  } catch {
    throw archivePrError(
      'ARCHIVE_PR_WORKSPACE_DEPENDENCIES_INVALID',
      'Frozen dependencies could not be materialized in the isolated archive worktree.',
    );
  }
}

function runLocalArchivePullRequestAssurance(
  cwd: string,
  baseCommit: string,
  headCommit: string,
): LocalArchivePullRequestAssuranceV1 {
  const prepared = preparePullRequestPreMergeAssurance(
    cwd,
    baseCommit,
    headCommit,
  );
  if (prepared.prepared !== null) {
    throw archivePrError(
      'ARCHIVE_PR_INTEGRATION_REVIEW_REQUIRED',
      'Archive PR assurance found uncovered integration review and must be completed through the normal CI review path.',
    );
  }
  return Object.freeze({
    status: 'passed',
    baseCommit,
    headCommit,
    reportIdentity: crypto
      .createHash('sha256')
      .update('archive-pull-request-local-assurance/v1\0')
      .update(canonicalJson(prepared.verification))
      .digest('hex'),
  });
}

function persistArchivePublication(
  repository: ReturnType<typeof discoverRepository>,
  publication: ArchivePullRequestPublicationV1,
): string {
  const directory = path.join(
    loadInvestigationRuntimeContext(repository.repositoryRoot).lifecycleRuntime
      .root,
    'archive-publications',
  );
  ensurePlainDirectory(directory);
  const filePath = path.join(
    directory,
    `${publication.publicationIdentity}.json`,
  );
  const content = `${canonicalJson(publication)}\n`;
  try {
    fs.writeFileSync(filePath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    const observed = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isNodeError(error) ||
      error.code !== 'EEXIST' ||
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1 ||
      (observed.mode & 0o777) !== 0o600 ||
      fs.realpathSync(filePath) !== filePath ||
      fs.readFileSync(filePath, 'utf8') !== content
    ) {
      throw archivePrError(
        'ARCHIVE_PR_PUBLICATION_RECORD_INVALID',
        'Archive publication record is missing, unsafe, or conflicts with the exact retry identity.',
      );
    }
  }
  return filePath;
}

function persistOpenedArchivePullRequest(
  repository: ReturnType<typeof discoverRepository>,
  opened: OpenedGitHubArchivePullRequestV1,
): string {
  const directory = path.join(
    loadInvestigationRuntimeContext(repository.repositoryRoot).lifecycleRuntime
      .root,
    'archive-publication-receipts',
  );
  ensurePlainDirectory(directory);
  const filePath = path.join(directory, `${opened.requestIdentity}.json`);
  const content = `${canonicalJson(opened)}\n`;
  try {
    fs.writeFileSync(filePath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    const observed = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isNodeError(error) ||
      error.code !== 'EEXIST' ||
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1 ||
      (observed.mode & 0o777) !== 0o600 ||
      fs.realpathSync(filePath) !== filePath ||
      fs.readFileSync(filePath, 'utf8') !== content
    ) {
      throw archivePrError(
        'ARCHIVE_PR_PUBLICATION_RECEIPT_INVALID',
        'Archive publication receipt conflicts with the exact idempotency identity.',
      );
    }
  }
  return filePath;
}

function assertAuthorizationFacts(
  facts: ArchivePullRequestAuthorizationFactsV1,
): void {
  const grant = facts.centralGrantRecord;
  const observation = facts.rulesetObservation;
  const observedAt = Date.parse(observation.observedAt);
  const expiresAt = Date.parse(observation.expiresAt);
  const now = Date.now();
  if (
    !isRecord(grant) ||
    !hasExactKeys(grant, [
      'contractVersion',
      'challengeId',
      'challengeDigest',
      'transitionId',
      'operationId',
      'terminalOutcomeDigest',
    ]) ||
    grant.contractVersion !== 'central-grant-completed-authority-ref.v1' ||
    !/^[0-9a-f-]{36}$/.test(grant.challengeId) ||
    !/^sha256:[0-9a-f]{64}$/.test(grant.challengeDigest) ||
    grant.transitionId !== 'github.archive-pr.publish' ||
    !/^[0-9a-f-]{36}$/.test(grant.operationId) ||
    !/^sha256:[0-9a-f]{64}$/.test(grant.terminalOutcomeDigest) ||
    !isRecord(observation) ||
    !hasExactKeys(observation, [
      'observationDigest',
      'authenticationReceiptDigest',
      'observedAt',
      'expiresAt',
    ]) ||
    !/^sha256:[0-9a-f]{64}$/.test(observation.observationDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(observation.authenticationReceiptDigest) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(observedAt).toISOString() !== observation.observedAt ||
    new Date(expiresAt).toISOString() !== observation.expiresAt ||
    expiresAt <= observedAt ||
    expiresAt - observedAt > 5 * 60_000 ||
    observedAt > now + 30_000 ||
    expiresAt < now
  ) {
    throw archivePrError(
      'ARCHIVE_PR_AUTHORIZATION_FACTS_INVALID',
      'Archive publication requires one current authenticated ruleset observation and the exact completed Central Grant record.',
    );
  }
}

function exactArchiveBranchPublicationRequest(
  local: PreparedPostMergeArchivePullRequestV1,
): ExactArchiveBranchPublicationRequestV1 {
  const repository = discoverRepository(local.worktreePath);
  if (
    repository.branch !== local.archiveBranch ||
    repository.head !== local.archive.commitHash ||
    repository.statusEntries.length > 0
  ) {
    throw archivePrError(
      'ARCHIVE_PR_BRANCH_PUBLICATION_STALE',
      'The isolated archive branch no longer matches its exact preparation.',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'exact-archive-branch-publication-request.v1',
    preparationIdentity: local.preparation.preparationIdentity,
    repositoryRoot: repository.repositoryRoot,
    remoteName: local.candidate.base.remote.name,
    protectedBaseRef: `refs/heads/${local.candidate.base.branch}`,
    protectedBaseCommit: local.candidate.base.remote.commit,
    archiveRef: `refs/heads/${local.archiveBranch}`,
    archiveHead: local.archive.commitHash,
    expectedArchiveRemoteHead: null,
  });
}

function assertExactArchiveBranchPublicationReceipt(
  request: ExactArchiveBranchPublicationRequestV1,
  receipt: ExactArchiveBranchPublicationReceiptV1,
): void {
  const requestDigest = digestWithPrefix(canonicalJson(request));
  if (
    !isRecord(receipt) ||
    !hasExactKeys(receipt, [
      'schemaVersion',
      'kind',
      'requestDigest',
      'observedProtectedBaseCommit',
      'observedArchiveHead',
      'disposition',
      'force',
      'receiptDigest',
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'exact-archive-branch-publication-receipt.v1' ||
    receipt.requestDigest !== requestDigest ||
    receipt.observedProtectedBaseCommit !== request.protectedBaseCommit ||
    receipt.observedArchiveHead !== request.archiveHead ||
    !['created', 'confirmed'].includes(receipt.disposition) ||
    receipt.force !== false
  ) {
    throw archivePrError(
      'ARCHIVE_PR_BRANCH_PUBLICATION_RECEIPT_INVALID',
      'Exact branch publication did not return a current non-force CAS receipt.',
    );
  }
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== digestWithPrefix(canonicalJson(body))) {
    throw archivePrError(
      'ARCHIVE_PR_BRANCH_PUBLICATION_RECEIPT_INVALID',
      'Exact branch publication receipt does not match its canonical digest.',
    );
  }
}

function digestWithPrefix(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertLocalAssurance(
  assurance: LocalArchivePullRequestAssuranceV1,
  baseCommit: string,
  headCommit: string,
): void {
  if (
    assurance.status !== 'passed' ||
    assurance.baseCommit !== baseCommit ||
    assurance.headCommit !== headCommit ||
    !/^[0-9a-f]{64}$/.test(assurance.reportIdentity)
  ) {
    throw archivePrError(
      'ARCHIVE_PR_LOCAL_ASSURANCE_INVALID',
      'Local archive PR assurance must bind the exact protected base and archive head.',
    );
  }
}

function listWorktrees(repositoryRoot: string): Array<{
  worktreePath: string;
  branch: string | null;
}> {
  const fields = runGit(repositoryRoot, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]).split('\0');
  const result: Array<{ worktreePath: string; branch: string | null }> = [];
  let currentPath: string | undefined;
  let currentBranch: string | null = null;
  for (const field of fields) {
    if (field === '') {
      if (currentPath !== undefined) {
        result.push({
          worktreePath: fs.realpathSync(currentPath),
          branch: currentBranch,
        });
      }
      currentPath = undefined;
      currentBranch = null;
    } else if (field.startsWith('worktree ')) {
      currentPath = field.slice('worktree '.length);
    } else if (field.startsWith('branch refs/heads/')) {
      currentBranch = field.slice('branch refs/heads/'.length);
    }
  }
  return result;
}

function pathIsInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function ensureArchiveWorkspaceParent(parent: string): string {
  const existing = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (existing === undefined) {
    try {
      fs.mkdirSync(parent, { mode: 0o700 });
    } catch {
      throw archivePrError(
        'ARCHIVE_PR_WORKTREE_PATH_INVALID',
        'Archive worktree parent could not be created as one private directory.',
      );
    }
  }
  const observed = fs.lstatSync(parent);
  if (
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    (observed.mode & 0o022) !== 0 ||
    fs.realpathSync(parent) !== parent
  ) {
    throw archivePrError(
      'ARCHIVE_PR_WORKTREE_PATH_INVALID',
      'Archive worktree parent must be one canonical non-writable-by-others directory.',
    );
  }
  return parent;
}

function resolveExactProtectedRemoteBase(
  repositoryRoot: string,
  protectedBranch: string,
): Readonly<{ ref: string; head: string; tree: string }> {
  const ref = protectedBranchRef(protectedBranch);
  const head = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${ref}^{commit}`],
    true,
  ).trim();
  const tree = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${ref}^{tree}`],
    true,
  ).trim();
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)
  ) {
    throw archivePrError(
      'ARCHIVE_PR_REMOTE_BASE_UNRESOLVABLE',
      'The configured protected remote-tracking base is unavailable.',
    );
  }
  return Object.freeze({ ref, head, tree });
}

function readCommitRef(
  repositoryRoot: string,
  ref: string,
): Readonly<{ commit: string; tree: string }> | null {
  const commit = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${ref}^{commit}`],
    true,
  ).trim();
  const tree = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${ref}^{tree}`],
    true,
  ).trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)
    ? Object.freeze({ commit, tree })
    : null;
}

function archivePreparationStale() {
  return archivePrError(
    'ARCHIVE_PR_PREPARATION_STALE',
    'The durable archive preparation no longer matches exact local Git and archive-report truth.',
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function archivePrError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
