/**
 * Prepares archive pull requests and publishes them through a restricted
 * GitHub remote port.
 *
 * Invariants:
 * - Opening a request first verifies that the published branch points to
 *   the exact prepared head commit.
 */
import crypto from 'node:crypto';

export {
  authenticateGitHubAppTokenLease,
  createGitHubAppTokenMintRequest,
} from './github-app-token.ts';
export type {
  GitHubAppTokenLeaseV1,
  GitHubAppTokenMinterPortV1,
  GitHubAppTokenMintReceiptV1,
  GitHubAppTokenMintRequestV1,
} from './github-app-token.ts';

export type ArchivePullRequestCandidateV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-pull-request-candidate';
  identity: string;
  repositoryId: string;
  changeId: string;
  base: Readonly<{
    branch: string;
    commit: string;
    tree: string;
    remote: Readonly<{
      name: 'origin';
      trackingRef: string;
      commit: string;
      tree: string;
    }>;
  }>;
  manifest: Readonly<{
    schemaVersion: 3;
    digest: string;
    investigationTargetDigest: string;
  }>;
  planReview: Readonly<{
    nodeId: string;
    resultDigest: string;
    advisoryVerdict: 'advisory-approve';
    roleResultForm:
      | 'ordinary-provider'
      | 'granted-same-provider'
      | 'granted-role-context-sharing'
      | 'granted-caller-supplied'
      | 'direct-human-attestation';
    requiredIndependence: 'provider-independent' | 'session-independent';
    achievedIndependence:
      'provider-independent' | 'session-independent' | 'none';
    degradationAuthorized: boolean;
  }>;
}>;

export type PreparedArchivePullRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'prepared-archive-pull-request';
  requestIdentity: string;
  publication: ArchivePullRequestPublicationV1;
  branch: string;
  title: string;
}>;

export type OpenedArchivePullRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'opened-archive-pull-request';
  requestIdentity: string;
  publicationIdentity: string;
  number: number;
  url: string;
  state: 'open';
}>;

/**
 * Least-privilege remote boundary. Approval, ruleset bypass, and merge are
 * deliberately absent operations rather than caller-controlled flags.
 */
export type ArchivePullRequestRemotePortV1 = Readonly<{
  capabilities: Readonly<{
    prepare: true;
    open: true;
    approve: false;
    bypass: false;
    merge: false;
  }>;
  prepare(
    publication: ArchivePullRequestPublicationV1,
  ): PreparedArchivePullRequestV1;
  open(prepared: PreparedArchivePullRequestV1): OpenedArchivePullRequestV1;
}>;

export type FakeArchivePullRequestRemoteV1 = ArchivePullRequestRemotePortV1 &
  Readonly<{
    requests(): readonly OpenedArchivePullRequestV1[];
  }>;

export type ArchivePullRequestPublicationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-pull-request-publication';
  publicationIdentity: string;
  candidate: ArchivePullRequestCandidateV1;
  archive: Readonly<{
    branch: string;
    baseCommit: string;
    headCommit: string;
    reportId: string;
  }>;
  assurance: Readonly<{
    status: 'passed';
    baseCommit: string;
    headCommit: string;
    reportIdentity: string;
  }>;
  authorization: Readonly<{
    centralGrantRecord: Readonly<{
      contractVersion: 'central-grant-completed-authority-ref.v1';
      challengeId: string;
      challengeDigest: string;
      transitionId: 'github.archive-pr.publish';
      operationId: string;
      terminalOutcomeDigest: string;
    }>;
    rulesetObservation: Readonly<{
      observationDigest: string;
      authenticationReceiptDigest: string;
      observedAt: string;
      expiresAt: string;
    }>;
  }>;
}>;

export type GitHubArchiveRulesetObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'github-archive-ruleset-observation.v1';
  observationDigest: `sha256:${string}`;
  authenticationReceiptDigest: `sha256:${string}`;
  repository: Readonly<{ owner: string; name: string }>;
  protectedBase: Readonly<{ branch: string; commit: string }>;
  activeRulesetIds: readonly number[];
  requiredStatusChecks: readonly string[];
  bypassActorCount: 0;
  authentication: 'github-app-token';
  observedAt: string;
  expiresAt: string;
}>;

export type GitHubArchiveRulesetObserverPortV1 = Readonly<{
  contractVersion: 'github-archive-ruleset-observer.v1';
  observe(
    input: Readonly<{
      repository: Readonly<{ owner: string; name: string }>;
      protectedBase: Readonly<{ branch: string; commit: string }>;
    }>,
  ): Promise<GitHubArchiveRulesetObservationV1>;
}>;

export type GitHubArchiveAdapterConfigV1 = Readonly<{
  schemaVersion: 1;
  apiBaseUrl: string;
  owner: string;
  repository: string;
  tokenEnvironmentVariable: string;
  permissions: Readonly<{
    contents: 'write';
    pullRequests: 'write';
    metadata: 'read';
  }>;
}>;

export type PreparedGitHubArchivePullRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'prepared-github-archive-pull-request';
  requestIdentity: string;
  publicationIdentity: string;
  repository: Readonly<{ owner: string; name: string }>;
  apiBaseUrl: string;
  branch: string;
  base: string;
  headCommit: string;
  title: string;
  body: string;
}>;

export type OpenedGitHubArchivePullRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'opened-github-archive-pull-request';
  requestIdentity: string;
  publicationIdentity: string;
  number: number;
  url: string;
  state: 'open';
  disposition: 'confirmed';
}>;

export type GitHubArchivePullRequestRemoteV1 = Readonly<{
  capabilities: Readonly<{
    observeRuleset: true;
    prepare: true;
    open: true;
    approve: false;
    bypass: false;
    merge: false;
    forcePush: false;
  }>;
  observeRuleset(
    input: Readonly<{
      base: string;
      baseCommit: string;
    }>,
  ): Promise<GitHubArchiveRulesetObservationV1>;
  prepare(
    publication: ArchivePullRequestPublicationV1,
  ): PreparedGitHubArchivePullRequestV1;
  open(
    prepared: PreparedGitHubArchivePullRequestV1,
  ): Promise<OpenedGitHubArchivePullRequestV1>;
}>;

export type GitHubArchivePullRequestRemoteOptions = Readonly<{
  config: GitHubArchiveAdapterConfigV1;
  token(): string;
  fetch?: typeof globalThis.fetch;
  rulesetObserver?: GitHubArchiveRulesetObserverPortV1;
}>;

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;

export function deriveArchivePullRequestCandidateIdentity(
  facts: Omit<ArchivePullRequestCandidateV1, 'kind' | 'identity'>,
): string {
  return crypto
    .createHash('sha256')
    .update('archive-pull-request-candidate/v1\0')
    .update(canonicalJson(facts))
    .digest('hex');
}

export function deriveArchivePullRequestPublicationIdentity(
  facts: Omit<ArchivePullRequestPublicationV1, 'publicationIdentity'>,
): string {
  return crypto
    .createHash('sha256')
    .update('archive-pull-request-publication/v1\0')
    .update(canonicalJson(facts))
    .digest('hex');
}

/**
 * Parse tracked operational facts only. Credentials are deliberately
 * impossible to represent in this contract; callers provide a short-lived
 * token through the named environment/host boundary at execution time.
 */
export function parseGitHubArchiveAdapterConfig(
  value: unknown,
): GitHubArchiveAdapterConfigV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'apiBaseUrl',
      'owner',
      'repository',
      'tokenEnvironmentVariable',
      'permissions',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.apiBaseUrl !== 'string' ||
    typeof value.owner !== 'string' ||
    !GITHUB_OWNER.test(value.owner) ||
    typeof value.repository !== 'string' ||
    !GITHUB_REPOSITORY.test(value.repository) ||
    typeof value.tokenEnvironmentVariable !== 'string' ||
    !ENVIRONMENT_VARIABLE.test(value.tokenEnvironmentVariable) ||
    !isRecord(value.permissions) ||
    !hasExactKeys(value.permissions, [
      'contents',
      'pullRequests',
      'metadata',
    ]) ||
    value.permissions.contents !== 'write' ||
    value.permissions.pullRequests !== 'write' ||
    value.permissions.metadata !== 'read'
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_CONFIG_INVALID',
      'GitHub archive configuration must contain only the least-privilege non-secret contract.',
    );
  }
  let apiBase: URL;
  try {
    apiBase = new URL(value.apiBaseUrl);
  } catch {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_CONFIG_INVALID',
      'GitHub archive API base URL is invalid.',
    );
  }
  if (
    apiBase.protocol !== 'https:' ||
    apiBase.origin !== 'https://api.github.com' ||
    apiBase.pathname !== '/' ||
    apiBase.username !== '' ||
    apiBase.password !== '' ||
    apiBase.search !== '' ||
    apiBase.hash !== ''
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_CONFIG_INVALID',
      'GitHub archive API base URL must be credential-free HTTPS.',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    apiBaseUrl: apiBase.href.replace(/\/$/, ''),
    owner: value.owner,
    repository: value.repository,
    tokenEnvironmentVariable: value.tokenEnvironmentVariable,
    permissions: Object.freeze({
      contents: 'write' as const,
      pullRequests: 'write' as const,
      metadata: 'read' as const,
    }),
  });
}

export function prepareGitHubArchivePullRequest(
  publication: ArchivePullRequestPublicationV1,
  configValue: GitHubArchiveAdapterConfigV1,
): PreparedGitHubArchivePullRequestV1 {
  assertPublication(publication);
  const config = parseGitHubArchiveAdapterConfig(configValue);
  const facts = {
    schemaVersion: 1,
    kind: 'prepared-github-archive-pull-request',
    publicationIdentity: publication.publicationIdentity,
    repository: Object.freeze({ owner: config.owner, name: config.repository }),
    apiBaseUrl: config.apiBaseUrl,
    branch: publication.archive.branch,
    base: publication.candidate.base.branch,
    headCommit: publication.archive.headCommit,
    title: `Archive ${publication.candidate.changeId}`,
    body: [
      `Automated archive projection for \`${publication.candidate.changeId}\`.`,
      '',
      `Publication identity: \`${publication.publicationIdentity}\``,
      `Archive commit: \`${publication.archive.headCommit}\``,
      `Local assurance: \`${publication.assurance.reportIdentity}\``,
      '',
      'This automation cannot approve, bypass, merge, delete, or force-update the branch.',
    ].join('\n'),
  } as const;
  return Object.freeze({
    ...facts,
    requestIdentity: preparedGitHubRequestIdentity(facts),
  });
}

export function createGitHubArchivePullRequestRemote(
  options: GitHubArchivePullRequestRemoteOptions,
): GitHubArchivePullRequestRemoteV1 {
  const config = parseGitHubArchiveAdapterConfig(options.config);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_HTTP_UNAVAILABLE',
      'GitHub archive publication requires an injected or platform fetch client.',
    );
  }
  return Object.freeze({
    capabilities: Object.freeze({
      observeRuleset: true as const,
      prepare: true as const,
      open: true as const,
      approve: false as const,
      bypass: false as const,
      merge: false as const,
      forcePush: false as const,
    }),
    prepare(publication: ArchivePullRequestPublicationV1) {
      return prepareGitHubArchivePullRequest(publication, config);
    },
    async observeRuleset(input) {
      if (options.rulesetObserver === undefined) {
        throw githubArchiveError(
          'GITHUB_ARCHIVE_RULESET_OBSERVER_DISABLED',
          'Authenticated ruleset observation is not enabled in this composition.',
        );
      }
      const observation = await options.rulesetObserver.observe({
        repository: Object.freeze({
          owner: config.owner,
          name: config.repository,
        }),
        protectedBase: Object.freeze({
          branch: input.base,
          commit: input.baseCommit,
        }),
      });
      return assertRulesetObservation(observation, config, input);
    },
    async open(prepared: PreparedGitHubArchivePullRequestV1) {
      assertPreparedGitHub(prepared, config);
      const token = options.token();
      if (
        typeof token !== 'string' ||
        token.length < 16 ||
        token.length > 4096 ||
        /[\r\n\0]/.test(token)
      ) {
        throw githubArchiveError(
          'GITHUB_ARCHIVE_CREDENTIAL_UNAVAILABLE',
          'A bounded short-lived GitHub App token is required.',
        );
      }
      const request = (method: 'GET' | 'POST', url: string, body?: unknown) =>
        githubRequest(fetchImplementation, token, method, url, body);
      const repositoryUrl = `${config.apiBaseUrl}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
      const branchPath = prepared.branch
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const refUrl = `${repositoryUrl}/git/ref/heads/${branchPath}`;
      const observedRef = await request('GET', refUrl);
      if (
        observedRef.status !== 200 ||
        readRefSha(observedRef.body) !== prepared.headCommit
      ) {
        throw githubArchiveRemoteFailure(
          observedRef.status === 404
            ? 'GITHUB_ARCHIVE_BRANCH_UNPUBLISHED'
            : observedRef.status === 200
              ? 'GITHUB_ARCHIVE_BRANCH_COLLISION'
              : 'GITHUB_ARCHIVE_BRANCH_LOOKUP_FAILED',
          observedRef.status,
          prepared.requestIdentity,
        );
      }

      const query = new URLSearchParams({
        state: 'open',
        head: `${config.owner}:${prepared.branch}`,
        base: prepared.base,
        per_page: '100',
      });
      const listed = await request('GET', `${repositoryUrl}/pulls?${query}`);
      if (listed.status !== 200 || !Array.isArray(listed.body)) {
        throw githubArchiveRemoteFailure(
          'GITHUB_ARCHIVE_PULL_REQUEST_LOOKUP_FAILED',
          listed.status,
          prepared.requestIdentity,
        );
      }
      const matches = listed.body.filter((value) =>
        isExactOpenPull(value, prepared),
      );
      if (
        matches.length > 1 ||
        (listed.body.length > 0 && matches.length !== 1)
      ) {
        throw githubArchiveRemoteFailure(
          'GITHUB_ARCHIVE_PULL_REQUEST_COLLISION',
          listed.status,
          prepared.requestIdentity,
        );
      }
      if (matches.length === 1) {
        return openedFromResponse(prepared, matches[0]);
      }
      const created = await request('POST', `${repositoryUrl}/pulls`, {
        title: prepared.title,
        body: prepared.body,
        head: prepared.branch,
        base: prepared.base,
        draft: false,
      });
      if (created.status !== 201 || !isExactOpenPull(created.body, prepared)) {
        throw githubArchiveRemoteFailure(
          'GITHUB_ARCHIVE_PULL_REQUEST_CREATE_FAILED',
          created.status,
          prepared.requestIdentity,
        );
      }
      return openedFromResponse(prepared, created.body);
    },
  });
}

export function createFakeArchivePullRequestRemote(): FakeArchivePullRequestRemoteV1 {
  const openedByIdentity = new Map<string, OpenedArchivePullRequestV1>();
  const capabilities = Object.freeze({
    prepare: true as const,
    open: true as const,
    approve: false as const,
    bypass: false as const,
    merge: false as const,
  });

  return Object.freeze({
    capabilities,
    prepare(publication: ArchivePullRequestPublicationV1) {
      assertPublication(publication);
      const requestIdentity = digest(
        `archive-pull-request-publication/v1\0${publication.publicationIdentity}`,
      );
      return Object.freeze({
        schemaVersion: 1 as const,
        kind: 'prepared-archive-pull-request' as const,
        requestIdentity,
        publication,
        branch: publication.archive.branch,
        title: `Archive ${publication.candidate.changeId}`,
      });
    },
    open(prepared: PreparedArchivePullRequestV1) {
      assertPrepared(prepared);
      const existing = openedByIdentity.get(prepared.requestIdentity);
      if (existing) return existing;
      const opened = Object.freeze({
        schemaVersion: 1 as const,
        kind: 'opened-archive-pull-request' as const,
        requestIdentity: prepared.requestIdentity,
        publicationIdentity: prepared.publication.publicationIdentity,
        number: openedByIdentity.size + 1,
        url: `https://fake.invalid/pulls/${openedByIdentity.size + 1}`,
        state: 'open' as const,
      });
      openedByIdentity.set(prepared.requestIdentity, opened);
      return opened;
    },
    requests() {
      return Object.freeze([...openedByIdentity.values()]);
    },
  });
}

function assertCandidate(
  candidate: unknown,
): asserts candidate is ArchivePullRequestCandidateV1 {
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, [
      'schemaVersion',
      'kind',
      'identity',
      'repositoryId',
      'changeId',
      'base',
      'manifest',
      'planReview',
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'archive-pull-request-candidate' ||
    typeof candidate.identity !== 'string' ||
    !DIGEST.test(candidate.identity) ||
    typeof candidate.repositoryId !== 'string' ||
    !/^[A-Za-z0-9_.:/-]{1,200}$/.test(candidate.repositoryId) ||
    typeof candidate.changeId !== 'string' ||
    !CHANGE_ID.test(candidate.changeId) ||
    !isRecord(candidate.base) ||
    !hasExactKeys(candidate.base, ['branch', 'commit', 'tree', 'remote']) ||
    typeof candidate.base.branch !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,255}$/.test(candidate.base.branch) ||
    typeof candidate.base.commit !== 'string' ||
    !COMMIT_OID.test(candidate.base.commit) ||
    typeof candidate.base.tree !== 'string' ||
    !COMMIT_OID.test(candidate.base.tree) ||
    !isRecord(candidate.base.remote) ||
    !hasExactKeys(candidate.base.remote, [
      'name',
      'trackingRef',
      'commit',
      'tree',
    ]) ||
    candidate.base.remote.name !== 'origin' ||
    candidate.base.remote.trackingRef !==
      `refs/remotes/origin/${candidate.base.branch}` ||
    candidate.base.remote.commit !== candidate.base.commit ||
    candidate.base.remote.tree !== candidate.base.tree ||
    !isRecord(candidate.manifest) ||
    !hasExactKeys(candidate.manifest, [
      'schemaVersion',
      'digest',
      'investigationTargetDigest',
    ]) ||
    candidate.manifest.schemaVersion !== 3 ||
    typeof candidate.manifest.digest !== 'string' ||
    !DIGEST.test(candidate.manifest.digest) ||
    typeof candidate.manifest.investigationTargetDigest !== 'string' ||
    !DIGEST.test(candidate.manifest.investigationTargetDigest) ||
    !isRecord(candidate.planReview) ||
    !hasExactKeys(candidate.planReview, [
      'nodeId',
      'resultDigest',
      'advisoryVerdict',
      'roleResultForm',
      'requiredIndependence',
      'achievedIndependence',
      'degradationAuthorized',
    ]) ||
    typeof candidate.planReview.nodeId !== 'string' ||
    !DIGEST.test(candidate.planReview.nodeId) ||
    typeof candidate.planReview.resultDigest !== 'string' ||
    !DIGEST.test(candidate.planReview.resultDigest) ||
    candidate.planReview.advisoryVerdict !== 'advisory-approve' ||
    !isCurrentPlanReviewAssurance(candidate.planReview)
  ) {
    throw new TypeError('Archive pull request candidate is invalid.');
  }
  const typedCandidate = candidate as ArchivePullRequestCandidateV1;
  const { kind: _kind, identity, ...facts } = typedCandidate;
  if (identity !== deriveArchivePullRequestCandidateIdentity(facts)) {
    throw new TypeError('Archive pull request candidate identity is invalid.');
  }
}

function isCurrentPlanReviewAssurance(value: Record<string, unknown>): boolean {
  if (value.roleResultForm === 'ordinary-provider') {
    return (
      value.degradationAuthorized === false &&
      (value.requiredIndependence === 'provider-independent'
        ? value.achievedIndependence === 'provider-independent'
        : value.requiredIndependence === 'session-independent' &&
          (value.achievedIndependence === 'provider-independent' ||
            value.achievedIndependence === 'session-independent'))
    );
  }
  if (
    value.roleResultForm === 'granted-caller-supplied' ||
    value.roleResultForm === 'direct-human-attestation'
  ) {
    return (
      value.degradationAuthorized === true &&
      value.requiredIndependence === 'provider-independent' &&
      value.achievedIndependence === 'none'
    );
  }
  return (
    (value.roleResultForm === 'granted-same-provider' ||
      value.roleResultForm === 'granted-role-context-sharing') &&
    value.degradationAuthorized === true &&
    value.requiredIndependence === 'provider-independent' &&
    value.achievedIndependence === 'session-independent'
  );
}

function assertPrepared(prepared: PreparedArchivePullRequestV1): void {
  if (
    prepared.schemaVersion !== 1 ||
    prepared.kind !== 'prepared-archive-pull-request' ||
    prepared.requestIdentity !==
      digest(
        `archive-pull-request-publication/v1\0${prepared.publication.publicationIdentity}`,
      ) ||
    prepared.branch !== prepared.publication.archive.branch ||
    prepared.title !== `Archive ${prepared.publication.candidate.changeId}`
  ) {
    throw new TypeError('Prepared archive pull request is invalid.');
  }
  assertPublication(prepared.publication);
}

function assertPublication(publication: ArchivePullRequestPublicationV1): void {
  if (
    !isRecord(publication) ||
    !hasExactKeys(publication, [
      'schemaVersion',
      'kind',
      'publicationIdentity',
      'candidate',
      'archive',
      'assurance',
      'authorization',
    ]) ||
    publication.schemaVersion !== 1 ||
    publication.kind !== 'archive-pull-request-publication' ||
    typeof publication.publicationIdentity !== 'string' ||
    !DIGEST.test(publication.publicationIdentity)
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_PUBLICATION_INVALID',
      'Archive publication must bind one exact archive commit, local assurance, ruleset facts, and completed grant outcome when required.',
    );
  }
  assertCandidate(publication.candidate);
  if (
    !isRecord(publication.archive) ||
    publication.archive.branch !==
      `work/archive-${publication.candidate.changeId}` ||
    !COMMIT_OID.test(publication.archive.baseCommit) ||
    publication.archive.baseCommit !== publication.candidate.base.commit ||
    !COMMIT_OID.test(publication.archive.headCommit) ||
    !DIGEST.test(publication.archive.reportId) ||
    !isRecord(publication.assurance) ||
    publication.assurance.status !== 'passed' ||
    publication.assurance.baseCommit !== publication.archive.baseCommit ||
    publication.assurance.headCommit !== publication.archive.headCommit ||
    !DIGEST.test(publication.assurance.reportIdentity) ||
    !isRecord(publication.authorization) ||
    !isCompletedGrantRecord(publication.authorization.centralGrantRecord) ||
    !isRulesetObservationReference(publication.authorization.rulesetObservation)
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_PUBLICATION_INVALID',
      'Archive publication must bind one exact archive commit, local assurance, ruleset facts, and completed grant outcome when required.',
    );
  }
  const { publicationIdentity, ...facts } = publication;
  if (
    publicationIdentity !== deriveArchivePullRequestPublicationIdentity(facts)
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_PUBLICATION_INVALID',
      'Archive publication identity does not match its exact facts.',
    );
  }
}

function isCompletedGrantRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'contractVersion',
      'challengeId',
      'challengeDigest',
      'transitionId',
      'operationId',
      'terminalOutcomeDigest',
    ]) &&
    value.contractVersion === 'central-grant-completed-authority-ref.v1' &&
    typeof value.challengeId === 'string' &&
    /^[0-9a-f-]{36}$/.test(value.challengeId) &&
    typeof value.challengeDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.challengeDigest) &&
    value.transitionId === 'github.archive-pr.publish' &&
    typeof value.operationId === 'string' &&
    /^[0-9a-f-]{36}$/.test(value.operationId) &&
    typeof value.terminalOutcomeDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.terminalOutcomeDigest)
  );
}

function isRulesetObservationReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'observationDigest',
      'authenticationReceiptDigest',
      'observedAt',
      'expiresAt',
    ]) &&
    typeof value.observationDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.observationDigest) &&
    typeof value.authenticationReceiptDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.authenticationReceiptDigest) &&
    exactObservationWindow(value.observedAt, value.expiresAt)
  );
}

function assertRulesetObservation(
  value: unknown,
  config: GitHubArchiveAdapterConfigV1,
  expected: Readonly<{ base: string; baseCommit: string }>,
): GitHubArchiveRulesetObservationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'observationDigest',
      'authenticationReceiptDigest',
      'repository',
      'protectedBase',
      'activeRulesetIds',
      'requiredStatusChecks',
      'bypassActorCount',
      'authentication',
      'observedAt',
      'expiresAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'github-archive-ruleset-observation.v1' ||
    typeof value.observationDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.observationDigest) ||
    typeof value.authenticationReceiptDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.authenticationReceiptDigest) ||
    !isRecord(value.repository) ||
    value.repository.owner !== config.owner ||
    value.repository.name !== config.repository ||
    !isRecord(value.protectedBase) ||
    value.protectedBase.branch !== expected.base ||
    value.protectedBase.commit !== expected.baseCommit ||
    !Array.isArray(value.activeRulesetIds) ||
    value.activeRulesetIds.length < 1 ||
    !value.activeRulesetIds.every(
      (entry) => Number.isSafeInteger(entry) && Number(entry) > 0,
    ) ||
    !Array.isArray(value.requiredStatusChecks) ||
    !value.requiredStatusChecks.includes('workflow-assurance') ||
    !value.requiredStatusChecks.every(
      (entry) => typeof entry === 'string' && entry.length <= 128,
    ) ||
    value.bypassActorCount !== 0 ||
    value.authentication !== 'github-app-token' ||
    !exactObservationWindow(value.observedAt, value.expiresAt)
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_RULESET_OBSERVATION_INVALID',
      'Authenticated ruleset observation is malformed, stale, or bound to another protected base.',
    );
  }
  const { observationDigest, ...payload } = value;
  if (`sha256:${digest(canonicalJson(payload))}` !== observationDigest) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_RULESET_OBSERVATION_INVALID',
      'Authenticated ruleset observation does not match its canonical digest.',
    );
  }
  return Object.freeze(
    structuredClone(value),
  ) as GitHubArchiveRulesetObservationV1;
}

function exactObservationWindow(observed: unknown, expires: unknown): boolean {
  if (typeof observed !== 'string' || typeof expires !== 'string') return false;
  const observedAt = Date.parse(observed);
  const expiresAt = Date.parse(expires);
  return (
    Number.isFinite(observedAt) &&
    Number.isFinite(expiresAt) &&
    new Date(observedAt).toISOString() === observed &&
    new Date(expiresAt).toISOString() === expires &&
    expiresAt > observedAt &&
    expiresAt - observedAt <= 5 * 60_000
  );
}

function assertPreparedGitHub(
  prepared: PreparedGitHubArchivePullRequestV1,
  config: GitHubArchiveAdapterConfigV1,
): void {
  if (
    !isRecord(prepared) ||
    prepared.schemaVersion !== 1 ||
    prepared.kind !== 'prepared-github-archive-pull-request' ||
    !DIGEST.test(prepared.requestIdentity) ||
    !DIGEST.test(prepared.publicationIdentity) ||
    !isRecord(prepared.repository) ||
    prepared.repository.owner !== config.owner ||
    prepared.repository.name !== config.repository ||
    prepared.apiBaseUrl !== config.apiBaseUrl ||
    !CHANGE_ID.test(prepared.branch.slice('work/archive-'.length)) ||
    !prepared.branch.startsWith('work/archive-') ||
    !/^[A-Za-z0-9._/-]{1,255}$/.test(prepared.base) ||
    !COMMIT_OID.test(prepared.headCommit) ||
    prepared.requestIdentity !== preparedGitHubRequestIdentity(prepared)
  ) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_PREPARED_REQUEST_INVALID',
      'Prepared GitHub archive request no longer matches its exact configuration.',
    );
  }
}

async function githubRequest(
  fetchImplementation: typeof globalThis.fetch,
  token: string,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_HTTP_FAILED',
      'GitHub archive request failed; retry will revalidate the exact remote identities.',
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_RESPONSE_INVALID',
      'GitHub archive response could not be read.',
    );
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_GITHUB_RESPONSE_BYTES) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_RESPONSE_INVALID',
      'GitHub archive response exceeded the bounded response size.',
    );
  }
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw githubArchiveError(
        'GITHUB_ARCHIVE_RESPONSE_INVALID',
        'GitHub archive response was not valid JSON.',
      );
    }
  }
  return Object.freeze({ status: response.status, body: parsed });
}

function readRefSha(value: unknown): string | null {
  return isRecord(value) &&
    isRecord(value.object) &&
    typeof value.object.sha === 'string' &&
    COMMIT_OID.test(value.object.sha)
    ? value.object.sha
    : null;
}

function isExactOpenPull(
  value: unknown,
  prepared: PreparedGitHubArchivePullRequestV1,
): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.number) &&
    Number(value.number) > 0 &&
    typeof value.html_url === 'string' &&
    value.html_url.startsWith('https://') &&
    value.state === 'open' &&
    isRecord(value.head) &&
    value.head.sha === prepared.headCommit &&
    value.head.ref === prepared.branch &&
    isRecord(value.base) &&
    value.base.ref === prepared.base
  );
}

function openedFromResponse(
  prepared: PreparedGitHubArchivePullRequestV1,
  value: unknown,
): OpenedGitHubArchivePullRequestV1 {
  if (!isExactOpenPull(value, prepared) || !isRecord(value)) {
    throw githubArchiveError(
      'GITHUB_ARCHIVE_RESPONSE_INVALID',
      'GitHub archive pull request response did not match the exact request.',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'opened-github-archive-pull-request',
    requestIdentity: prepared.requestIdentity,
    publicationIdentity: prepared.publicationIdentity,
    number: Number(value.number),
    url: String(value.html_url),
    state: 'open',
    disposition: 'confirmed',
  });
}

function githubArchiveRemoteFailure(
  code: string,
  status: number,
  requestIdentity: string,
): Error {
  return githubArchiveError(
    code,
    `GitHub archive request ${requestIdentity} failed closed with HTTP status ${status}.`,
  );
}

function githubArchiveError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  error.name = 'GitHubArchiveAdapterError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

function preparedGitHubRequestIdentity(
  value: Omit<PreparedGitHubArchivePullRequestV1, 'requestIdentity'>,
): string {
  const { requestIdentity: _requestIdentity, ...facts } = value as
    | PreparedGitHubArchivePullRequestV1
    | (Omit<PreparedGitHubArchivePullRequestV1, 'requestIdentity'> & {
        requestIdentity?: never;
      });
  return crypto
    .createHash('sha256')
    .update('github-archive-pull-request/v1\0')
    .update(canonicalJson(facts))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
