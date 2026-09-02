import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  authenticateGitHubAppTokenLease,
  createGitHubAppTokenMintRequest,
  createGitHubArchivePullRequestRemote,
  createFakeArchivePullRequestRemote,
  deriveArchivePullRequestCandidateIdentity,
  deriveArchivePullRequestPublicationIdentity,
  parseGitHubArchiveAdapterConfig,
  prepareGitHubArchivePullRequest,
  type ArchivePullRequestCandidateV1,
  type ArchivePullRequestPublicationV1,
} from '../src/archive-pull-request.ts';

test('GitHub App token lease is exact, repository-scoped, short-lived, and receipt-bound', () => {
  const now = new Date('2026-08-24T00:00:00.000Z');
  const request = fixtureTokenRequest(now);
  const token = 'local-test-installation-token';
  const receipt = tokenReceipt(request, token, now, 5 * 60_000);

  assert.deepEqual(
    authenticateGitHubAppTokenLease(request, { token, receipt }, now),
    { token, receipt },
  );
  assert.equal(JSON.stringify(receipt).includes(token), false);
  assert.throws(
    () =>
      authenticateGitHubAppTokenLease(
        request,
        {
          token,
          receipt: { ...receipt, repository: { owner: 'other', name: 'repo' } },
        },
        now,
      ),
    /GITHUB_APP_TOKEN_LEASE_INVALID/,
  );
  assert.throws(
    () =>
      authenticateGitHubAppTokenLease(
        request,
        {
          token,
          receipt: tokenReceipt(request, token, now, 30_000),
        },
        now,
      ),
    /GITHUB_APP_TOKEN_LEASE_INVALID/,
  );
});

test('fake remote prepares and opens only one completed Grant-bound publication identity', () => {
  const remote = createFakeArchivePullRequestRemote();
  const publication = fixturePublication();

  const first = remote.open(remote.prepare(publication));
  const second = remote.open(remote.prepare(publication));

  assert.deepEqual(second, first);
  assert.equal(first.number, 1);
  assert.equal(first.publicationIdentity, publication.publicationIdentity);
  assert.equal(remote.requests().length, 1);
  assert.throws(
    () => remote.prepare(publication.candidate as never),
    /archive publication/i,
  );
});

test('candidate replay accepts strengthened ordinary and exact R-007 assurance', () => {
  const current = fixtureCandidate();
  const { kind: _kind, identity: _identity, ...base } = current;
  for (const planReview of [
    {
      ...current.planReview,
      roleResultForm: 'ordinary-provider' as const,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
      degradationAuthorized: false,
    },
    {
      ...current.planReview,
      roleResultForm: 'granted-role-context-sharing' as const,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'session-independent' as const,
      degradationAuthorized: true,
    },
  ]) {
    const facts = { ...base, planReview };
    const candidate: ArchivePullRequestCandidateV1 = {
      ...facts,
      kind: 'archive-pull-request-candidate',
      identity: deriveArchivePullRequestCandidateIdentity(facts),
    };
    assert.doesNotThrow(() =>
      createFakeArchivePullRequestRemote().prepare(
        fixturePublication(candidate),
      ),
    );
  }
});

test('prepares a credential-free least-privilege GitHub request', () => {
  const config = fixtureConfig();
  const prepared = prepareGitHubArchivePullRequest(
    fixturePublication(),
    config,
  );

  assert.equal(prepared.repository.owner, 'example');
  assert.equal(prepared.repository.name, 'fixture');
  assert.equal(prepared.branch, 'work/archive-demo-change');
  assert.equal(prepared.base, 'main');
  assert.equal(prepared.headCommit, '1'.repeat(40));
  assert.equal(JSON.stringify(prepared).includes('secret-token'), false);
  assert.deepEqual(config.permissions, {
    contents: 'write',
    pullRequests: 'write',
    metadata: 'read',
  });
});

test('real GitHub adapter creates a branch and PR once, then recovers by lookup', async () => {
  const token = 'secret-token-for-local-double';
  const calls: Array<{
    method: string;
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  let pullCreated = false;
  const fetchDouble: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    if (url.includes('/git/ref/heads/')) {
      return response(200, { object: { sha: '1'.repeat(40) } });
    }
    if (url.includes('/pulls?')) {
      return response(
        200,
        pullCreated
          ? [
              {
                number: 17,
                html_url: 'https://github.com/example/fixture/pull/17',
                state: 'open',
                head: { sha: '1'.repeat(40), ref: 'work/archive-demo-change' },
                base: { ref: 'main' },
              },
            ]
          : [],
      );
    }
    if (url.endsWith('/pulls') && method === 'POST') {
      pullCreated = true;
      return response(201, {
        number: 17,
        html_url: 'https://github.com/example/fixture/pull/17',
        state: 'open',
        head: { sha: '1'.repeat(40), ref: 'work/archive-demo-change' },
        base: { ref: 'main' },
      });
    }
    return response(500, {});
  };
  const remote = createGitHubArchivePullRequestRemote({
    config: fixtureConfig(),
    fetch: fetchDouble,
    token: () => token,
  });
  const prepared = remote.prepare(fixturePublication());

  const first = await remote.open(prepared);
  const second = await remote.open(prepared);

  assert.deepEqual(second, first);
  assert.equal(first.number, 17);
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 1);
  assert.equal(
    calls.some(({ url }) => url.endsWith('/git/refs')),
    false,
  );
  assert.ok(
    calls.every(({ authorization }) => authorization === `Bearer ${token}`),
  );
  assert.ok(
    calls.every(
      ({ url, body }) => !`${url}${JSON.stringify(body)}`.includes(token),
    ),
  );
  assert.deepEqual(remote.capabilities, {
    observeRuleset: true,
    prepare: true,
    open: true,
    approve: false,
    bypass: false,
    merge: false,
    forcePush: false,
  });
});

test('ruleset observation is injected, authenticated, exact, and current', async () => {
  const expected = fixtureRulesetObservation();
  const remote = createGitHubArchivePullRequestRemote({
    config: fixtureConfig(),
    token: () => 'secret-token-for-ruleset-observation',
    rulesetObserver: {
      contractVersion: 'github-archive-ruleset-observer.v1',
      async observe(input) {
        assert.deepEqual(input, {
          repository: { owner: 'example', name: 'fixture' },
          protectedBase: { branch: 'main', commit: 'b'.repeat(40) },
        });
        return expected;
      },
    },
  });

  assert.deepEqual(
    await remote.observeRuleset({
      base: 'main',
      baseCommit: 'b'.repeat(40),
    }),
    expected,
  );
});

test('ruleset observation fails closed when disabled, stale, replayed, or unauthenticated', async () => {
  const disabled = createGitHubArchivePullRequestRemote({
    config: fixtureConfig(),
    token: () => 'secret-token-for-disabled-observer',
  });
  await assert.rejects(
    disabled.observeRuleset({ base: 'main', baseCommit: 'b'.repeat(40) }),
    /GITHUB_ARCHIVE_RULESET_OBSERVER_DISABLED/,
  );

  for (const mutation of [
    { protectedBase: { branch: 'other', commit: 'b'.repeat(40) } },
    { authenticationReceiptDigest: 'invalid' },
    {
      observedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:05:00.000Z',
    },
  ]) {
    const remote = createGitHubArchivePullRequestRemote({
      config: fixtureConfig(),
      token: () => 'secret-token-for-invalid-observation',
      rulesetObserver: {
        contractVersion: 'github-archive-ruleset-observer.v1',
        async observe() {
          return { ...fixtureRulesetObservation(), ...mutation } as never;
        },
      },
    });
    await assert.rejects(
      remote.observeRuleset({ base: 'main', baseCommit: 'b'.repeat(40) }),
      /GITHUB_ARCHIVE_RULESET_OBSERVATION_INVALID/,
    );
  }
});

test('real GitHub adapter fails closed on a divergent branch without leaking credentials', async () => {
  const token = 'secret-token-for-collision';
  const remote = createGitHubArchivePullRequestRemote({
    config: fixtureConfig(),
    token: () => token,
    fetch: async () => response(200, { object: { sha: '9'.repeat(40) } }),
  });

  await assert.rejects(
    remote.open(remote.prepare(fixturePublication())),
    (error: unknown) => {
      assert.equal(String(error).includes(token), false);
      assert.match(String(error), /GITHUB_ARCHIVE_BRANCH_COLLISION/);
      return true;
    },
  );
});

test('real GitHub adapter refuses API ref creation when the exact branch was not published', async () => {
  const remote = createGitHubArchivePullRequestRemote({
    config: fixtureConfig(),
    token: () => 'secret-token-for-unpublished-branch',
    fetch: async () => response(404, {}),
  });

  await assert.rejects(
    remote.open(remote.prepare(fixturePublication())),
    /GITHUB_ARCHIVE_BRANCH_UNPUBLISHED/,
  );
});

test('config rejects credentials and any broader or weaker permission declaration', () => {
  assert.throws(
    () =>
      parseGitHubArchiveAdapterConfig({
        ...fixtureConfig(),
        token: 'must-not-be-tracked',
      }),
    /GITHUB_ARCHIVE_CONFIG_INVALID/,
  );
  assert.throws(
    () =>
      parseGitHubArchiveAdapterConfig({
        ...fixtureConfig(),
        apiBaseUrl: 'https://credentials.example.invalid',
      }),
    /GITHUB_ARCHIVE_CONFIG_INVALID/,
  );
  assert.throws(
    () =>
      parseGitHubArchiveAdapterConfig({
        ...fixtureConfig(),
        permissions: {
          contents: 'admin',
          pullRequests: 'write',
          metadata: 'read',
        },
      }),
    /GITHUB_ARCHIVE_CONFIG_INVALID/,
  );
});

function fixtureCandidate(): ArchivePullRequestCandidateV1 {
  const facts = {
    schemaVersion: 1,
    repositoryId: 'portable-fixture',
    changeId: 'demo-change',
    base: {
      branch: 'main',
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      remote: {
        name: 'origin',
        trackingRef: 'refs/remotes/origin/main',
        commit: 'b'.repeat(40),
        tree: 'c'.repeat(40),
      },
    },
    manifest: {
      schemaVersion: 3,
      digest: 'd'.repeat(64),
      investigationTargetDigest: 'e'.repeat(64),
    },
    planReview: {
      nodeId: 'f'.repeat(64),
      resultDigest: '0'.repeat(64),
      advisoryVerdict: 'advisory-approve',
      roleResultForm: 'ordinary-provider',
      requiredIndependence: 'session-independent',
      achievedIndependence: 'provider-independent',
      degradationAuthorized: false,
    },
  } as const;
  return {
    ...facts,
    kind: 'archive-pull-request-candidate',
    identity: deriveArchivePullRequestCandidateIdentity(facts),
  };
}

function fixturePublication(
  candidate: ArchivePullRequestCandidateV1 = fixtureCandidate(),
): ArchivePullRequestPublicationV1 {
  const facts = {
    schemaVersion: 1,
    kind: 'archive-pull-request-publication',
    candidate,
    archive: {
      branch: 'work/archive-demo-change',
      baseCommit: 'b'.repeat(40),
      headCommit: '1'.repeat(40),
      reportId: '3'.repeat(64),
    },
    assurance: {
      status: 'passed',
      baseCommit: 'b'.repeat(40),
      headCommit: '1'.repeat(40),
      reportIdentity: '4'.repeat(64),
    },
    authorization: {
      centralGrantRecord: {
        contractVersion: 'central-grant-completed-authority-ref.v1',
        challengeId: '00000000-0000-4000-8000-000000000001',
        challengeDigest: `sha256:${'5'.repeat(64)}`,
        transitionId: 'github.archive-pr.publish',
        operationId: '00000000-0000-4000-8000-000000000002',
        terminalOutcomeDigest: `sha256:${'6'.repeat(64)}`,
      },
      rulesetObservation: {
        observationDigest: `sha256:${'7'.repeat(64)}`,
        authenticationReceiptDigest: `sha256:${'8'.repeat(64)}`,
        observedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      },
    },
  } as const;
  return {
    ...facts,
    publicationIdentity: deriveArchivePullRequestPublicationIdentity(facts),
  };
}

function fixtureRulesetObservation() {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'github-archive-ruleset-observation.v1' as const,
    authenticationReceiptDigest: `sha256:${'8'.repeat(64)}` as const,
    repository: { owner: 'example', name: 'fixture' },
    protectedBase: { branch: 'main', commit: 'b'.repeat(40) },
    activeRulesetIds: [17],
    requiredStatusChecks: ['workflow-assurance'],
    bypassActorCount: 0 as const,
    authentication: 'github-app-token' as const,
    observedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
  };
  return {
    ...payload,
    observationDigest: `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(payload))
      .digest('hex')}` as const,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function fixtureConfig() {
  return parseGitHubArchiveAdapterConfig({
    schemaVersion: 1,
    apiBaseUrl: 'https://api.github.com',
    owner: 'example',
    repository: 'fixture',
    tokenEnvironmentVariable: 'JIGWRIGHT_GITHUB_APP_TOKEN',
    permissions: {
      contents: 'write',
      pullRequests: 'write',
      metadata: 'read',
    },
  });
}

function fixtureTokenRequest(now: Date) {
  return createGitHubAppTokenMintRequest({
    appId: '101',
    installationId: '202',
    repository: { owner: 'example', name: 'fixture' },
    permissions: {
      contents: 'write',
      pullRequests: 'write',
      metadata: 'read',
    },
    requestedAt: now.toISOString(),
    expiresNoLaterThan: new Date(now.getTime() + 10 * 60_000).toISOString(),
  });
}

function tokenReceipt(
  request: ReturnType<typeof fixtureTokenRequest>,
  token: string,
  now: Date,
  ttl: number,
) {
  const body = {
    schemaVersion: 1 as const,
    kind: 'github-app-token-mint-receipt.v1' as const,
    requestDigest: request.requestDigest,
    repository: request.repository,
    permissions: request.permissions,
    tokenDigest: digest(token),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  return { ...body, receiptDigest: digest(canonicalJson(body)) };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
