import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseGitHubArchiveAdapterConfig,
  type GitHubArchiveAdapterConfigV1,
  type GitHubArchiveRulesetObservationV1,
  type GitHubArchiveRulesetObserverPortV1,
} from '@jigwright/github-adapter';

import type {
  ExactArchiveBranchPublicationReceiptV1,
  ExactArchiveBranchPublicationRequestV1,
  ExactArchiveBranchPublisherPortV1,
} from '../application/archive/archive-pr-orchestration.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  assertArchivePublicationTarget,
  type ArchivePullRequestPublicationTargetV1,
} from '../modules/authority/archive-pr-grant.ts';
import { loadMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_RULESET_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACTIVE_RULESETS = 32;
const OBSERVATION_TTL_MS = 4 * 60_000;

type ArchiveGitRunner = (
  cwd: string,
  args: string[],
  allowFailure?: boolean,
) => string;

export function createGitExactArchiveBranchPublisher(
  options: Readonly<{
    runGit?: ArchiveGitRunner;
    expectedCanonicalOrigin?: string;
  }> = {},
): ExactArchiveBranchPublisherPortV1 {
  const git = options.runGit ?? runGit;
  return Object.freeze({
    contractVersion: 'exact-archive-branch-publisher.v1' as const,
    async publish(
      request: ExactArchiveBranchPublicationRequestV1,
    ): Promise<ExactArchiveBranchPublicationReceiptV1> {
      assertPublicationRequest(request);
      const remoteTarget = resolveCanonicalRemoteIdentity(
        request,
        git,
        options.expectedCanonicalOrigin,
      );
      assertLocalPublicationSource(request, git);
      const before = observeExactRemoteRefs(request, git, remoteTarget, false);
      assertProtectedBaseCurrent(request, before.protectedBaseCommit);
      let disposition: 'created' | 'confirmed';
      if (before.archiveHead === request.archiveHead) {
        disposition = 'confirmed';
      } else if (before.archiveHead !== null) {
        throw branchCollision();
      } else {
        try {
          git(request.repositoryRoot, [
            'push',
            '--porcelain',
            `--force-with-lease=${request.archiveRef}:`,
            '--',
            remoteTarget,
            `${request.archiveHead}:${request.archiveRef}`,
          ]);
          disposition = 'created';
        } catch {
          const recovered = observeExactRemoteRefs(
            request,
            git,
            remoteTarget,
            true,
          );
          assertProtectedBaseCurrent(request, recovered.protectedBaseCommit);
          if (recovered.archiveHead === request.archiveHead) {
            disposition = 'confirmed';
          } else if (recovered.archiveHead !== null) {
            throw branchCollision();
          } else {
            throw workflowError(
              'ARCHIVE_PR_BRANCH_PUBLICATION_FAILED',
              'The create-only archive branch publication was not observed after Git rejected the absent-ref lease.',
              ExitCode.staleState,
            );
          }
        }
      }

      const after = observeExactRemoteRefs(request, git, remoteTarget, true);
      assertProtectedBaseCurrent(request, after.protectedBaseCommit);
      if (after.archiveHead !== request.archiveHead) {
        throw workflowError(
          'ARCHIVE_PR_BRANCH_PUBLICATION_UNKNOWN_EFFECT',
          'The archive branch dispatch completed without one exact observable remote result; manual reconciliation is required.',
          ExitCode.verification,
        );
      }
      const body = Object.freeze({
        schemaVersion: 1 as const,
        kind: 'exact-archive-branch-publication-receipt.v1' as const,
        requestDigest: digest(canonicalJson(request)),
        observedProtectedBaseCommit: request.protectedBaseCommit,
        observedArchiveHead: request.archiveHead,
        disposition,
        force: false as const,
      });
      return Object.freeze({
        ...body,
        receiptDigest: digest(canonicalJson(body)),
      });
    },
  });
}

export function resolveArchivePullRequestPublicationTarget(
  cwd: string,
  configValue: unknown,
): ArchivePullRequestPublicationTargetV1 {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const policy = loadMaintainerPolicy(repositoryRoot);
  const config = parseGitHubArchiveAdapterConfig(configValue);
  const identity =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/u.exec(
      policy.repository.origin,
    );
  if (
    identity === null ||
    config.owner !== identity[1] ||
    config.repository !== identity[2]
  ) {
    throw rulesetError(
      'ARCHIVE_PR_GITHUB_CONFIG_TARGET_MISMATCH',
      'GitHub archive adapter configuration must match the canonical repository origin exactly.',
      ExitCode.guard,
    );
  }
  return assertArchivePublicationTarget({
    schemaVersion: 1,
    kind: 'archive-pr-publication-target.v1',
    repositoryId: policy.repository.id,
    canonicalOrigin: policy.repository.origin,
    remoteName: 'origin',
    apiBaseUrl: config.apiBaseUrl,
    owner: config.owner,
    repository: config.repository,
    adapterConfigDigest: digest(canonicalJson(config)),
  });
}

export function createGitHubApiArchiveRulesetObserver(
  input: Readonly<{
    config: GitHubArchiveAdapterConfigV1;
    environment: NodeJS.ProcessEnv;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
  }>,
): GitHubArchiveRulesetObserverPortV1 {
  const config = parseGitHubArchiveAdapterConfig(input.config);
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw rulesetError(
      'ARCHIVE_PR_GITHUB_HTTP_UNAVAILABLE',
      'Authenticated GitHub ruleset observation requires a platform fetch implementation.',
      ExitCode.unsafeEnvironment,
    );
  }
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    contractVersion: 'github-archive-ruleset-observer.v1' as const,
    async observe(
      observationInput,
    ): Promise<GitHubArchiveRulesetObservationV1> {
      assertObservationInput(config, observationInput);
      const token = input.environment[config.tokenEnvironmentVariable];
      if (
        typeof token !== 'string' ||
        token.length < 16 ||
        token.length > 4096 ||
        /[\r\n\0]/u.test(token)
      ) {
        throw rulesetError(
          'ARCHIVE_PR_GITHUB_CREDENTIAL_UNAVAILABLE',
          'A bounded short-lived GitHub App token is required for authenticated ruleset observation.',
          ExitCode.unsafeEnvironment,
        );
      }
      const repositoryUrl = `${config.apiBaseUrl}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
      const request = (url: string) =>
        readGitHubJson(fetchImplementation, token, url);
      const repository = await request(repositoryUrl);
      const defaultBranch = readDefaultBranch(repository);
      const listed = await request(
        `${repositoryUrl}/rulesets?includes_parents=true&targets=branch&per_page=100`,
      );
      const ids = readActiveBranchRulesetIds(listed);
      const applicable: number[] = [];
      const requiredChecks = new Set<string>();
      let bypassActorCount = 0;
      for (const id of ids) {
        const ruleset = await request(`${repositoryUrl}/rulesets/${id}`);
        if (
          !rulesetAppliesToBranch(
            ruleset,
            id,
            observationInput.protectedBase.branch,
            defaultBranch,
          )
        ) {
          continue;
        }
        applicable.push(id);
        bypassActorCount += readBypassActorCount(ruleset);
        for (const check of readRequiredStatusChecks(ruleset)) {
          requiredChecks.add(check);
        }
      }
      const checks = [...requiredChecks].sort();
      if (
        applicable.length < 1 ||
        bypassActorCount !== 0 ||
        !checks.includes('workflow-assurance')
      ) {
        throw rulesetError(
          'ARCHIVE_PR_RULESET_REQUIREMENTS_UNSATISFIED',
          'Archive publication requires an active protected-base ruleset with workflow-assurance and no bypass actors.',
          ExitCode.verification,
        );
      }
      const observedAt = exactDate(now());
      const payload = Object.freeze({
        schemaVersion: 1 as const,
        kind: 'github-archive-ruleset-observation.v1' as const,
        authenticationReceiptDigest: digest(
          canonicalJson({
            schemaVersion: 1,
            kind: 'github-ruleset-authentication-receipt.v1',
            repository: observationInput.repository,
            tokenDigest: digest(token),
          }),
        ),
        repository: Object.freeze({ ...observationInput.repository }),
        protectedBase: Object.freeze({ ...observationInput.protectedBase }),
        activeRulesetIds: Object.freeze(applicable.sort((a, b) => a - b)),
        requiredStatusChecks: Object.freeze(checks),
        bypassActorCount: 0 as const,
        authentication: 'github-app-token' as const,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(
          observedAt.getTime() + OBSERVATION_TTL_MS,
        ).toISOString(),
      });
      return Object.freeze({
        ...payload,
        observationDigest: digest(canonicalJson(payload)),
      });
    },
  });
}

function assertPublicationRequest(
  request: ExactArchiveBranchPublicationRequestV1,
): void {
  if (
    !isRecord(request) ||
    !hasExactKeys(request, [
      'schemaVersion',
      'kind',
      'preparationIdentity',
      'repositoryRoot',
      'remoteName',
      'protectedBaseRef',
      'protectedBaseCommit',
      'archiveRef',
      'archiveHead',
      'expectedArchiveRemoteHead',
    ]) ||
    request.schemaVersion !== 1 ||
    request.kind !== 'exact-archive-branch-publication-request.v1' ||
    typeof request.preparationIdentity !== 'string' ||
    !SHA256.test(request.preparationIdentity) ||
    typeof request.repositoryRoot !== 'string' ||
    request.remoteName !== 'origin' ||
    typeof request.protectedBaseRef !== 'string' ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(
      request.protectedBaseRef,
    ) ||
    typeof request.protectedBaseCommit !== 'string' ||
    !COMMIT_OID.test(request.protectedBaseCommit) ||
    typeof request.archiveRef !== 'string' ||
    !/^refs\/heads\/work\/archive-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(
      request.archiveRef,
    ) ||
    typeof request.archiveHead !== 'string' ||
    !COMMIT_OID.test(request.archiveHead) ||
    request.expectedArchiveRemoteHead !== null
  ) {
    throw rulesetError(
      'ARCHIVE_PR_BRANCH_PUBLICATION_REQUEST_INVALID',
      'The exact archive branch publication request is malformed.',
      ExitCode.guard,
    );
  }
}

function assertLocalPublicationSource(
  request: ExactArchiveBranchPublicationRequestV1,
  git: ArchiveGitRunner,
): void {
  const repository = discoverRepository(request.repositoryRoot);
  if (
    repository.repositoryRoot !== request.repositoryRoot ||
    repository.branch !== request.archiveRef.slice('refs/heads/'.length) ||
    repository.head !== request.archiveHead ||
    repository.statusEntries.length !== 0 ||
    git(request.repositoryRoot, [
      'rev-parse',
      '--verify',
      `${request.archiveRef}^{commit}`,
    ]).trim() !== request.archiveHead
  ) {
    throw rulesetError(
      'ARCHIVE_PR_BRANCH_PUBLICATION_STALE',
      'The local archive branch no longer matches its exact immutable preparation.',
      ExitCode.staleState,
    );
  }
}

function resolveCanonicalRemoteIdentity(
  request: ExactArchiveBranchPublicationRequestV1,
  git: ArchiveGitRunner,
  injectedExpectedOrigin: string | undefined,
): string {
  const expected =
    injectedExpectedOrigin ??
    loadMaintainerPolicy(request.repositoryRoot).repository.origin;
  let fetchUrl: string;
  let pushUrl: string;
  try {
    fetchUrl = git(request.repositoryRoot, [
      'remote',
      'get-url',
      request.remoteName,
    ]).trim();
    pushUrl = git(request.repositoryRoot, [
      'remote',
      'get-url',
      '--push',
      request.remoteName,
    ]).trim();
  } catch {
    throw rulesetError(
      'ARCHIVE_PR_REMOTE_IDENTITY_UNAVAILABLE',
      'The archive publication remote identity could not be read.',
      ExitCode.unsafeEnvironment,
    );
  }
  let canonicalExpected: string;
  let canonicalFetch: string;
  let canonicalPush: string;
  try {
    canonicalExpected = canonicalRemoteIdentity(
      request.repositoryRoot,
      expected,
    );
    canonicalFetch = canonicalRemoteIdentity(request.repositoryRoot, fetchUrl);
    canonicalPush = canonicalRemoteIdentity(request.repositoryRoot, pushUrl);
  } catch {
    throw rulesetError(
      'ARCHIVE_PR_REMOTE_IDENTITY_INVALID',
      'Archive publication remote URLs are malformed or cannot be resolved to one canonical identity.',
      ExitCode.verification,
    );
  }
  if (
    canonicalFetch !== canonicalExpected ||
    canonicalPush !== canonicalExpected
  ) {
    throw rulesetError(
      'ARCHIVE_PR_REMOTE_IDENTITY_MISMATCH',
      'Archive publication fetch and push URLs must both match the maintainer-policy canonical origin.',
      ExitCode.staleState,
    );
  }
  return pushUrl;
}

function canonicalRemoteIdentity(
  repositoryRoot: string,
  value: string,
): string {
  const ssh =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+\.git)$/u.exec(value);
  if (ssh !== null) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const sshUrl =
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+\.git)$/u.exec(
      value,
    );
  if (sshUrl !== null) return `https://github.com/${sshUrl[1]}/${sshUrl[2]}`;
  if (
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(
      value,
    )
  ) {
    return value;
  }
  const resolved = path.resolve(repositoryRoot, value);
  return fs.realpathSync(resolved);
}

function observeExactRemoteRefs(
  request: ExactArchiveBranchPublicationRequestV1,
  git: ArchiveGitRunner,
  remoteTarget: string,
  afterDispatch: boolean,
): Readonly<{
  protectedBaseCommit: string | null;
  archiveHead: string | null;
}> {
  let output: string;
  try {
    output = git(request.repositoryRoot, [
      'ls-remote',
      '--refs',
      remoteTarget,
      request.protectedBaseRef,
      request.archiveRef,
    ]);
  } catch {
    throw rulesetError(
      afterDispatch
        ? 'ARCHIVE_PR_BRANCH_PUBLICATION_UNKNOWN_EFFECT'
        : 'ARCHIVE_PR_REMOTE_OBSERVATION_FAILED',
      afterDispatch
        ? 'The archive branch may have been dispatched, but its exact remote result is unavailable; manual reconciliation is required.'
        : 'The exact archive publication remote refs could not be observed.',
      afterDispatch ? ExitCode.verification : ExitCode.unsafeEnvironment,
    );
  }
  const observed = new Map<string, string>();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const fields = line.split('\t');
    if (
      fields.length !== 2 ||
      !COMMIT_OID.test(fields[0]!) ||
      ![request.protectedBaseRef, request.archiveRef].includes(fields[1]!) ||
      observed.has(fields[1]!)
    ) {
      throw rulesetError(
        'ARCHIVE_PR_REMOTE_OBSERVATION_INVALID',
        'The exact archive publication remote observation is malformed or ambiguous.',
        ExitCode.verification,
      );
    }
    observed.set(fields[1]!, fields[0]!);
  }
  return Object.freeze({
    protectedBaseCommit: observed.get(request.protectedBaseRef) ?? null,
    archiveHead: observed.get(request.archiveRef) ?? null,
  });
}

function assertProtectedBaseCurrent(
  request: ExactArchiveBranchPublicationRequestV1,
  observed: string | null,
): void {
  if (observed !== request.protectedBaseCommit) {
    throw rulesetError(
      'ARCHIVE_PR_PROTECTED_BASE_CHANGED',
      'The protected base changed after local archive preparation.',
      ExitCode.staleState,
    );
  }
}

function branchCollision() {
  return rulesetError(
    'ARCHIVE_PR_BRANCH_PUBLICATION_COLLISION',
    'The remote archive branch already exists with a different commit and will not be overwritten.',
    ExitCode.conflict,
  );
}

async function readGitHubJson(
  fetchImplementation: typeof globalThis.fetch,
  token: string,
  url: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch {
    throw rulesetError(
      'ARCHIVE_PR_RULESET_OBSERVATION_FAILED',
      'The authenticated GitHub ruleset request failed.',
      ExitCode.unsafeEnvironment,
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    response.status !== 200 ||
    (Number.isFinite(declaredLength) &&
      declaredLength > MAX_RULESET_RESPONSE_BYTES)
  ) {
    throw rulesetError(
      'ARCHIVE_PR_RULESET_OBSERVATION_FAILED',
      'GitHub did not return one bounded authenticated ruleset response.',
      ExitCode.verification,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RULESET_RESPONSE_BYTES) {
    throw rulesetError(
      'ARCHIVE_PR_RULESET_OBSERVATION_FAILED',
      'The authenticated GitHub ruleset response exceeded its byte budget.',
      ExitCode.verification,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw rulesetError(
      'ARCHIVE_PR_RULESET_OBSERVATION_FAILED',
      'The authenticated GitHub ruleset response is not valid JSON.',
      ExitCode.verification,
    );
  }
}

function readDefaultBranch(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.default_branch !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(value.default_branch)
  ) {
    throw rulesetInvalid();
  }
  return value.default_branch;
}

function readActiveBranchRulesetIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > 100) throw rulesetInvalid();
  const ids = value
    .filter(
      (entry) =>
        isRecord(entry) &&
        entry.target === 'branch' &&
        entry.enforcement === 'active',
    )
    .map((entry) => entry.id);
  if (
    ids.length > MAX_ACTIVE_RULESETS ||
    ids.some((id) => !Number.isSafeInteger(id) || Number(id) < 1) ||
    new Set(ids).size !== ids.length
  ) {
    throw rulesetInvalid();
  }
  return Object.freeze(ids as number[]);
}

function rulesetAppliesToBranch(
  value: unknown,
  id: number,
  branch: string,
  defaultBranch: string,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.id !== id ||
    value.target !== 'branch' ||
    value.enforcement !== 'active' ||
    !isRecord(value.conditions) ||
    !isRecord(value.conditions.ref_name) ||
    !Array.isArray(value.conditions.ref_name.include) ||
    !Array.isArray(value.conditions.ref_name.exclude) ||
    !value.conditions.ref_name.include.every(
      (entry) => typeof entry === 'string',
    ) ||
    !value.conditions.ref_name.exclude.every(
      (entry) => typeof entry === 'string',
    )
  ) {
    throw rulesetInvalid();
  }
  const ref = `refs/heads/${branch}`;
  const include = value.conditions.ref_name.include.some((pattern) =>
    matchesGitHubRefPattern(pattern as string, ref, branch === defaultBranch),
  );
  const exclude = value.conditions.ref_name.exclude.some((pattern) =>
    matchesGitHubRefPattern(pattern as string, ref, branch === defaultBranch),
  );
  return include && !exclude;
}

function matchesGitHubRefPattern(
  pattern: string,
  ref: string,
  isDefaultBranch: boolean,
): boolean {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return isDefaultBranch;
  if (pattern.length < 1 || pattern.length > 512 || /[\r\n\0]/u.test(pattern)) {
    throw rulesetInvalid();
  }
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u').test(ref);
}

function readBypassActorCount(value: Record<string, unknown>): number {
  if (!Array.isArray(value.bypass_actors) || value.bypass_actors.length > 100) {
    throw rulesetInvalid();
  }
  return value.bypass_actors.length;
}

function readRequiredStatusChecks(
  value: Record<string, unknown>,
): readonly string[] {
  if (!Array.isArray(value.rules) || value.rules.length > 100) {
    throw rulesetInvalid();
  }
  const checks: string[] = [];
  for (const rule of value.rules) {
    if (!isRecord(rule) || typeof rule.type !== 'string') {
      throw rulesetInvalid();
    }
    if (rule.type !== 'required_status_checks') continue;
    if (
      !isRecord(rule.parameters) ||
      !Array.isArray(rule.parameters.required_status_checks)
    ) {
      throw rulesetInvalid();
    }
    for (const check of rule.parameters.required_status_checks) {
      if (
        !isRecord(check) ||
        typeof check.context !== 'string' ||
        check.context.length < 1 ||
        check.context.length > 128
      ) {
        throw rulesetInvalid();
      }
      checks.push(check.context);
    }
  }
  return Object.freeze(checks);
}

function assertObservationInput(
  config: GitHubArchiveAdapterConfigV1,
  value: Readonly<{
    repository: Readonly<{ owner: string; name: string }>;
    protectedBase: Readonly<{ branch: string; commit: string }>;
  }>,
): void {
  if (
    value.repository.owner !== config.owner ||
    value.repository.name !== config.repository ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(value.protectedBase.branch) ||
    !COMMIT_OID.test(value.protectedBase.commit)
  ) {
    throw rulesetInvalid();
  }
}

function exactDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw rulesetError(
      'ARCHIVE_PR_RULESET_CLOCK_INVALID',
      'Authenticated ruleset observation requires a valid current clock.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(value.getTime());
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function rulesetInvalid() {
  return rulesetError(
    'ARCHIVE_PR_RULESET_OBSERVATION_INVALID',
    'The authenticated GitHub ruleset response is malformed or ambiguous.',
    ExitCode.verification,
  );
}

function rulesetError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
