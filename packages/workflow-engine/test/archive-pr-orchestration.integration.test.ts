import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  discoverArchivePullRequestCandidate,
  discoverArchivePullRequestCandidates,
  openArchivePullRequest,
  preparePostMergeArchivePullRequest,
  projectArchivePullRequestCandidate,
  publishPostMergeArchivePullRequest,
  type ExactArchiveBranchPublisherPortV1,
} from '../src/application/archive/archive-pr-orchestration.ts';
import {
  createFakeArchivePullRequestRemote,
  type GitHubArchiveRulesetObservationV1,
  type GitHubArchiveRulesetObserverPortV1,
  type ArchivePullRequestRemotePortV1,
} from '../../github-adapter/src/archive-pull-request.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  createApprovalSubject,
  createGrantChallenge,
} from '../src/modules/authority/grant-core.ts';
import {
  authenticateCompletedArchivePullRequestGrant,
  archivePullRequestGrantTransitionDefinitions,
  createArchivePullRequestGrantRequest,
} from '../src/modules/authority/archive-pr-grant.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  grantStorePaths,
  persistGrantChallenge,
  prepareGrantTransition,
  recordGrantTransitionOutcome,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  createArchivePublicationPreparation,
  persistArchivePublicationPreparation,
} from '../src/runtime/storage-journal/archive-publication-store.ts';
import {
  commitSession,
  finalizeTask,
} from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';

test('discovers one read-only current-v3 independently reviewed archive candidate', () => {
  const repository = completedFixture();
  try {
    const before = repositoryProjection(repository);
    const candidate = discoverArchivePullRequestCandidate(
      repository,
      'demo-change',
    );
    const inventory = discoverArchivePullRequestCandidates(
      repository,
      'origin/main',
    );

    assert.equal(candidate.kind, 'archive-pull-request-candidate');
    assert.equal(candidate.changeId, 'demo-change');
    assert.equal(candidate.manifest.schemaVersion, 3);
    assert.equal(candidate.planReview.advisoryVerdict, 'advisory-approve');
    assert.equal(
      candidate.planReview.achievedIndependence,
      'provider-independent',
    );
    assert.match(candidate.identity, /^[0-9a-f]{64}$/);
    assert.equal(inventory.items.length, 1);
    assert.equal(inventory.items[0]?.state, 'eligible');
    assert.deepEqual(repositoryProjection(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('opens the same fake archive PR identity twice without approval or merge authority', () => {
  const repository = completedFixture();
  try {
    const remote = createFakeArchivePullRequestRemote();
    const first = openArchivePullRequest(
      discoverArchivePullRequestCandidate(repository, 'demo-change'),
      remote,
    );
    const second = openArchivePullRequest(
      discoverArchivePullRequestCandidate(repository, 'demo-change'),
      remote,
    );

    assert.deepEqual(second, first);
    assert.equal(remote.requests().length, 1);
    assert.deepEqual(remote.capabilities, {
      prepare: true,
      open: true,
      approve: false,
      bypass: false,
      merge: false,
    });
    const forbidden = remote as ArchivePullRequestRemotePortV1 & {
      approve?: unknown;
      bypass?: unknown;
      merge?: unknown;
    };
    assert.equal(forbidden.approve, undefined);
    assert.equal(forbidden.bypass, undefined);
    assert.equal(forbidden.merge, undefined);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate projection rejects historical or non-independent assurance', () => {
  assert.throws(
    () =>
      projectArchivePullRequestCandidate({
        repositoryId: 'portable-fixture',
        changeId: 'demo-change',
        branch: 'main',
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        remoteName: 'origin',
        remoteTrackingRef: 'refs/remotes/origin/main',
        remoteHead: 'a'.repeat(40),
        remoteTree: 'b'.repeat(40),
        manifestSchemaVersion: 3,
        manifestDigest: 'c'.repeat(64),
        investigationTargetDigest: 'd'.repeat(64),
        reviewNodeId: 'e'.repeat(64),
        reviewResultDigest: 'f'.repeat(64),
        advisoryVerdict: 'advisory-approve',
        requiredIndependence: 'provider-independent',
        achievedIndependence: 'none',
      }),
    (error) => isWorkflowError(error, 'ARCHIVE_PR_CURRENT_ASSURANCE_REQUIRED'),
  );
});

test('tracked archive manual-dispatch contract is pinned and inert', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const workflowPath = path.join(
    repositoryRoot,
    '.github/workflows/jigwright-archive-orchestration.yml.disabled',
  );
  const harnessPath = path.join(
    repositoryRoot,
    'scripts/run-archive-orchestration-manual.mjs',
  );
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const harness = fs.readFileSync(harnessPath, 'utf8');

  assert.equal(workflowPath.endsWith('.yml.disabled'), true);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: \$\{\{ false \}\}/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /\b(?:push|approve|bypass|merge)\b/i);
  assert.match(harness, /ARCHIVE_MANUAL_HARNESS_DISABLED/);
  assert.doesNotMatch(harness, /https?:|fetch\(|child_process|exec|spawn/);
});

test('production archive publication caller remains fail-closed by default', () => {
  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cli,
      'archive-pr',
      'open',
      'demo-change',
      '--config',
      'must-not-be-read.json',
      '--grant',
      '00000000-0000-4000-8000-000000000001',
      '--json',
    ],
    { cwd: path.dirname(cli), encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(
    (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
    'ARCHIVE_PR_REMOTE_PUBLICATION_DISABLED',
  );
  assert.equal(result.stdout, '');
});

test('candidate discovery fails closed when local protected base differs from remote tracking', () => {
  const repository = completedFixture();
  try {
    fs.writeFileSync(path.join(repository, 'remote-drift.txt'), 'drift\n');
    git(repository, ['add', 'remote-drift.txt']);
    git(repository, ['commit', '-m', 'Advance local protected base']);
    assert.throws(
      () => discoverArchivePullRequestCandidate(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_REMOTE_BASE_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('prepares, publishes, and recovers one exact archive PR identity', async () => {
  const repository = completedFixture();
  const workspaceParent = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-archive-worktrees`,
  );
  let worktreePath: string | undefined;
  try {
    const options = {
      workspaceParent,
      assure: (_cwd: string, baseCommit: string, headCommit: string) => ({
        status: 'passed' as const,
        baseCommit,
        headCommit,
        reportIdentity: '8'.repeat(64),
      }),
    };
    const first = preparePostMergeArchivePullRequest(
      repository,
      'demo-change',
      options,
    );
    worktreePath = first.worktreePath;
    const retry = preparePostMergeArchivePullRequest(
      repository,
      'demo-change',
      options,
    );

    assert.equal(first.archive.status, 'committed');
    assert.equal(first.archiveReplay.status, 'already-archived');
    assert.equal(first.archive.commitHash, first.archiveReplay.commitHash);
    assert.equal(first.archive.reportId, first.archiveReplay.reportId);
    assert.equal(retry.archive.status, 'already-archived');
    assert.equal(retry.archive.commitHash, first.archive.commitHash);
    assert.equal(
      retry.preparation.preparationIdentity,
      first.preparation.preparationIdentity,
    );
    assert.equal(first.preparation.archive.branch, 'work/archive-demo-change');
    assert.equal(first.preparation.assurance.reportIdentity, '8'.repeat(64));
    await assert.rejects(
      publishPostMergeArchivePullRequest(
        repository,
        first,
        {},
        {
          grantChallengeId: '00000000-0000-4000-8000-000000000001',
          rulesetObserver: createRulesetObserver(first),
          branchPublisher: disabledBranchPublisher(),
          loadAdapter: async () => {
            throw new Error('optional package absent');
          },
        },
      ),
      (error) =>
        isWorkflowError(error, 'ARCHIVE_PR_GITHUB_ADAPTER_UNAVAILABLE'),
    );
    let pullCreated = false;
    const fetchDouble: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/git/ref/heads/')) {
        return jsonResponse(200, {
          object: { sha: first.archive.commitHash },
        });
      }
      const pull = {
        number: 23,
        html_url: 'https://github.com/example/fixture/pull/23',
        state: 'open',
        head: {
          sha: first.archive.commitHash,
          ref: 'work/archive-demo-change',
        },
        base: { ref: 'main' },
      };
      if (url.includes('/pulls?')) {
        return jsonResponse(200, pullCreated ? [pull] : []);
      }
      if (url.endsWith('/pulls') && method === 'POST') {
        pullCreated = true;
        return jsonResponse(201, pull);
      }
      return jsonResponse(500, {});
    };
    const adapter =
      await import('../../github-adapter/src/archive-pull-request.ts');
    const grantChallengeId = completePublicationGrant(repository, first);
    const staleGrantChallengeId = completePublicationGrant(repository, first, {
      challengeId: '00000000-0000-4000-8000-000000000002',
      now: new Date(Date.now() - 11 * 60_000),
    });
    const bareRepository = path.join(workspaceParent, 'publication.git');
    execFileSync(
      'git',
      ['clone', '--bare', '--shared', first.worktreePath, bareRepository],
      { stdio: 'ignore' },
    );
    git(bareRepository, [
      'update-ref',
      '-d',
      `refs/heads/${first.archiveBranch}`,
    ]);
    const publishOptions = {
      environment: {
        JIGWRIGHT_GITHUB_APP_TOKEN: 'local-short-lived-token',
      },
      fetch: fetchDouble,
      loadAdapter: async () => adapter,
      grantChallengeId,
      rulesetObserver: createRulesetObserver(first),
      branchPublisher: createBareGitBranchPublisher(bareRepository),
    };
    const config = {
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
    };
    await assert.rejects(
      publishPostMergeArchivePullRequest(repository, first, config, {
        ...publishOptions,
        grantChallengeId: '00000000-0000-4000-8000-000000000099',
      }),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_CENTRAL_GRANT_INVALID'),
    );
    assert.throws(
      () =>
        authenticateCompletedArchivePullRequestGrant(
          grantStorePaths(
            loadInvestigationRuntimeContext(repository).lifecycleRuntime.root,
          ),
          loadInvestigationRuntimeContext(repository).lifecycleRuntime.root,
          staleGrantChallengeId,
          first.preparation.preparationIdentity,
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_CENTRAL_GRANT_INVALID'),
    );
    await assert.rejects(
      publishPostMergeArchivePullRequest(repository, first, config, {
        ...publishOptions,
        rulesetObserver: createRulesetObserver(first, {
          observedAt: new Date('2020-01-01T00:00:00.000Z'),
          expiresAt: new Date('2020-01-01T00:05:00.000Z'),
        }),
      }),
      (error) =>
        isWorkflowError(error, 'ARCHIVE_PR_AUTHORIZATION_FACTS_INVALID'),
    );
    const runtimeRoot =
      loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
    const replayPreparation = createArchivePublicationPreparation({
      repositoryId: first.preparation.repositoryId,
      changeId: first.preparation.changeId,
      candidateIdentity: '9'.repeat(64),
      protectedBase: first.preparation.protectedBase,
      archive: first.preparation.archive,
      assurance: first.preparation.assurance,
    });
    persistArchivePublicationPreparation(runtimeRoot, replayPreparation);
    assert.throws(
      () =>
        authenticateCompletedArchivePullRequestGrant(
          grantStorePaths(runtimeRoot),
          runtimeRoot,
          grantChallengeId,
          replayPreparation.preparationIdentity,
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_CENTRAL_GRANT_INVALID'),
    );
    const published = await publishPostMergeArchivePullRequest(
      repository,
      first,
      config,
      publishOptions,
    );
    const publishedRetry = await publishPostMergeArchivePullRequest(
      repository,
      retry,
      config,
      publishOptions,
    );
    assert.deepEqual(publishedRetry.opened, published.opened);
    assert.equal(published.opened.number, 23);
    assert.equal(published.branchPublication.force, false);
    assert.equal(published.branchPublication.disposition, 'created');
    assert.equal(publishedRetry.branchPublication.disposition, 'confirmed');
    assert.equal(
      git(bareRepository, [
        'rev-parse',
        `refs/heads/${first.archiveBranch}`,
      ]).trim(),
      first.archive.commitHash,
    );
    assert.equal(fs.statSync(published.receiptPath).mode & 0o777, 0o600);
    assert.equal(repositoryProjection(repository).status, '');
  } finally {
    if (worktreePath !== undefined) {
      git(repository, ['worktree', 'remove', '--force', worktreePath]);
    }
    fs.rmSync(workspaceParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('local archive refuses remote-tracking drift while holding archive authority', () => {
  const repository = completedFixture();
  const workspaceParent = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-archive-race-worktrees`,
  );
  const worktreePath = path.join(workspaceParent, 'demo-change');
  try {
    const staleBase = git(repository, ['rev-parse', 'HEAD^']).trim();
    assert.throws(
      () =>
        preparePostMergeArchivePullRequest(repository, 'demo-change', {
          workspaceParent,
          archiveHooks: {
            beforeApply({ repositoryRoot }) {
              git(repositoryRoot, [
                'update-ref',
                'refs/remotes/origin/main',
                staleBase,
              ]);
            },
          },
          assure: (_cwd, baseCommit, headCommit) => ({
            status: 'passed',
            baseCommit,
            headCommit,
            reportIdentity: '8'.repeat(64),
          }),
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_REMOTE_BASE_CHANGED'),
    );
  } finally {
    if (fs.existsSync(worktreePath)) {
      git(repository, ['worktree', 'remove', '--force', worktreePath]);
    }
    fs.rmSync(workspaceParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function completedFixture(): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Portable archive pull request',
      'The fixture SHALL expose a deterministic archive candidate.',
      '',
      '#### Scenario: Candidate is independently reviewed',
      '',
      '- **WHEN** the completed change is merged',
      '- **THEN** one idempotent archive PR may be opened',
      '',
    ].join('\n'),
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure archive PR delta']);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  assert.throws(
    () => finalizeTask(repository, session.sessionId),
    (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
  );
  satisfyCurrentTaskDiffReview(repository, session.sessionId);
  finalizeTask(repository, session.sessionId);
  const completed = commitSession(
    repository,
    session.sessionId,
    'Complete archive PR fixture task',
  );
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', completed.commitHash]);
  syncOriginMain(repository);
  return repository;
}

function completePublicationGrant(
  repository: string,
  local: ReturnType<typeof preparePostMergeArchivePullRequest>,
  options: Readonly<{ challengeId?: string; now?: Date }> = {},
): string {
  const now = options.now ?? new Date();
  const runtimeRoot =
    loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
  const paths = grantStorePaths(runtimeRoot);
  const registry = createTransitionRegistry(
    archivePullRequestGrantTransitionDefinitions(runtimeRoot),
  );
  const challenge = createGrantChallenge(
    createArchivePullRequestGrantRequest(
      runtimeRoot,
      local.preparation.preparationIdentity,
      'Publish the reviewed archive branch and open its PR.',
    ),
    registry,
    {
      challengeId:
        options.challengeId ?? '00000000-0000-4000-8000-000000000001',
      now,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    },
  );
  persistGrantChallenge(paths, challenge);
  const subject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: 'publish-reviewed-archive',
      reason: 'Publish the exact locally assured archive branch.',
      sessionNonce: 'nonce-33333333333333333333333333333333',
    },
    { now },
  );
  const operationId = '77777777-7777-4777-8777-777777777777';
  prepareGrantTransition(paths, {
    operationId,
    challenge,
    subject,
    proofModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        claim: 'fresh-local-device-owner',
        proofDigest: digest('grant-proof'),
        identity: null,
      },
    ],
    createdAt: now.toISOString(),
  });
  recordGrantTransitionOutcome(paths, {
    challengeId: challenge.challengeId,
    operationId,
    poststateDigest: local.preparation.preparationIdentity,
    outcome: {
      outcome: 'completed',
      details: {
        schemaVersion: 1,
        kind: 'archive-pr-publication-authorized.v1',
        preparationIdentity: local.preparation.preparationIdentity,
        remoteEffectApplied: false,
      },
    },
    completedAt: now.toISOString(),
    audit: {
      approvalMethod: 'human-presence',
      authorityClass: 'local-device-owner',
      identity: null,
      identityAssurance: 'not-asserted',
      presenceAssurance: 'fresh-os-authentication',
      proofModules: ['human-gate-macos@1'],
    },
  });
  return challenge.challengeId;
}

function createRulesetObserver(
  local: ReturnType<typeof preparePostMergeArchivePullRequest>,
  times: Readonly<{ observedAt?: Date; expiresAt?: Date }> = {},
): GitHubArchiveRulesetObserverPortV1 {
  const observedAt = times.observedAt ?? new Date(Date.now() - 1_000);
  const expiresAt =
    times.expiresAt ?? new Date(observedAt.getTime() + 4 * 60_000);
  return {
    contractVersion: 'github-archive-ruleset-observer.v1',
    async observe(input) {
      const payload = {
        schemaVersion: 1 as const,
        kind: 'github-archive-ruleset-observation.v1' as const,
        authenticationReceiptDigest: digest('github-app-token-receipt'),
        repository: input.repository,
        protectedBase: input.protectedBase,
        activeRulesetIds: [17],
        requiredStatusChecks: ['workflow-assurance'],
        bypassActorCount: 0 as const,
        authentication: 'github-app-token' as const,
        observedAt: observedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      assert.equal(input.protectedBase.branch, local.candidate.base.branch);
      assert.equal(input.protectedBase.commit, local.candidate.base.commit);
      return {
        ...payload,
        observationDigest: digest(canonicalJson(payload)),
      } satisfies GitHubArchiveRulesetObservationV1;
    },
  };
}

function createBareGitBranchPublisher(
  bareRepository: string,
): ExactArchiveBranchPublisherPortV1 {
  return {
    contractVersion: 'exact-archive-branch-publisher.v1',
    publish(request) {
      const protectedBase = git(bareRepository, [
        'rev-parse',
        '--verify',
        request.protectedBaseRef,
      ]).trim();
      assert.equal(protectedBase, request.protectedBaseCommit);
      const observed =
        git(bareRepository, ['show-ref'])
          .split('\n')
          .map((line) => line.trim().split(' '))
          .find(([, reference]) => reference === request.archiveRef)?.[0] ?? '';
      let disposition: 'created' | 'confirmed';
      if (observed === '') {
        git(bareRepository, [
          'update-ref',
          request.archiveRef,
          request.archiveHead,
          '0000000000000000000000000000000000000000',
        ]);
        disposition = 'created';
      } else {
        assert.equal(observed, request.archiveHead);
        disposition = 'confirmed';
      }
      const body = {
        schemaVersion: 1 as const,
        kind: 'exact-archive-branch-publication-receipt.v1' as const,
        requestDigest: digest(canonicalJson(request)),
        observedProtectedBaseCommit: protectedBase,
        observedArchiveHead: request.archiveHead,
        disposition,
        force: false as const,
      };
      return { ...body, receiptDigest: digest(canonicalJson(body)) };
    },
  };
}

function disabledBranchPublisher(): ExactArchiveBranchPublisherPortV1 {
  return {
    contractVersion: 'exact-archive-branch-publisher.v1',
    publish() {
      throw new Error('publisher must not run');
    },
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function repositoryProjection(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    status: git(repository, ['status', '--porcelain']),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
