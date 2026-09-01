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
import { createArchivePullRequestCliDispatcherForTesting } from '../src/cli.ts';
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
import { writeArchiveReport } from '../src/runtime/storage-journal/archive-report.ts';
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
  prepareCurrentV3IntroductionFixture,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import {
  createGitExactArchiveBranchPublisher,
  createGitHubApiArchiveRulesetObserver,
  resolveArchivePullRequestPublicationTarget,
} from '../src/composition-root/archive-pr-publication-production.ts';
import { runGit as runWorkflowGit } from '../src/runtime/repository-transaction/git.ts';
import {
  archiveCommitMessage,
  commitChangedPaths,
} from '../src/runtime/repository-transaction/git-transitions.ts';

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

test('archive PR orchestration consumes archive evidence through its application boundary', () => {
  const source = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../src/application/archive/archive-pr-orchestration.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /runtime\/storage-journal\/archive-report\.ts|runtime\/repository-transaction\/git-transitions\.ts/u,
  );
  assert.match(source, /readVerifiedArchiveTransitionEvidence/u);
});

test('archive prepare returns one exact Fail-Grant and open uses its production publication seams', async () => {
  const repository = fs.mkdtempSync(
    path.join(path.dirname(import.meta.dirname), 'archive-pr-cli-'),
  );
  const configPath = path.join(repository, 'github-adapter.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
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
    })}\n`,
  );
  const preparationIdentity = `sha256:${'1'.repeat(64)}` as const;
  const local = {
    preparation: { preparationIdentity },
  } as ReturnType<typeof preparePostMergeArchivePullRequest>;
  const rulesetObserver = { contractVersion: 'test-ruleset-observer' };
  const branchPublisher = { contractVersion: 'test-branch-publisher' };
  let published:
    | Readonly<{
        cwd: string;
        local: unknown;
        config: unknown;
        grantChallengeId: string;
        publicationTarget: unknown;
        rulesetObserver: unknown;
        branchPublisher: unknown;
      }>
    | undefined;
  let requested: readonly string[] | undefined;
  const publicationTarget = archivePublicationTarget({
    tokenEnvironmentVariable: 'JIGWRIGHT_GITHUB_APP_TOKEN',
  });
  const dispatch = createArchivePullRequestCliDispatcherForTesting({
    discover: discoverArchivePullRequestCandidates,
    inspect() {
      throw new Error('status inspection is outside this CLI seam');
    },
    prepare(cwd, changeId) {
      assert.equal(cwd, repository);
      assert.equal(changeId, 'demo-change');
      return local;
    },
    async requestGrant(cwd, requestedPreparationIdentity, config, reason) {
      requested = [
        cwd,
        requestedPreparationIdentity,
        JSON.stringify(config),
        reason,
      ];
      return {
        challengeId: '11111111-1111-4111-8111-111111111111',
        challengeDigest: `sha256:${'2'.repeat(64)}` as const,
      };
    },
    async publish(cwd, prepared, config, options) {
      published = {
        cwd,
        local: prepared,
        config,
        grantChallengeId: options.grantChallengeId,
        publicationTarget: options.publicationTarget,
        rulesetObserver: options.rulesetObserver,
        branchPublisher: options.branchPublisher,
      };
      return { opened: { number: 23 } } as never;
    },
    async loadAdapter() {
      return {
        parseGitHubArchiveAdapterConfig(value: unknown) {
          return value as never;
        },
      } as never;
    },
    createRulesetObserver() {
      return rulesetObserver as never;
    },
    createBranchPublisher() {
      return branchPublisher as never;
    },
    resolvePublicationTarget() {
      return publicationTarget;
    },
  });

  try {
    const prepared = await dispatch(
      [
        'archive-pr',
        'prepare',
        'demo-change',
        '--config',
        'github-adapter.json',
      ],
      repository,
    );
    assert.equal(requested?.[0], repository);
    assert.equal(requested?.[1], preparationIdentity);
    assert.equal(
      requested?.[2],
      JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf8'))),
    );
    assert.match(requested?.[3] ?? '', /exact immutable archive preparation/u);
    assert.deepEqual(prepared, {
      command: 'archive-pr',
      action: 'prepare',
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'workflow-fail-grant-required.v1',
        changeId: 'demo-change',
        preparationIdentity,
        state: 'human-action-required',
        nextAction: 'human-action',
        failure: {
          code: 'ARCHIVE_PR_PUBLICATION_GRANT_REQUIRED',
          message:
            'The exact locally assured archive publication requires Human Gate authorization.',
        },
        grant: {
          challengeId: '11111111-1111-4111-8111-111111111111',
          challengeDigest: `sha256:${'2'.repeat(64)}`,
        },
        local,
        externalPublicationPending: true,
        inputSchema: {
          schemaVersion: 1,
          kind: 'central-grant-resolution.v1',
          inspectCommand:
            'pnpm workflow grant human inspect 11111111-1111-4111-8111-111111111111 --json',
          decisionCommand:
            'pnpm workflow grant human decide 11111111-1111-4111-8111-111111111111 --json',
          publishAfterDecision:
            'pnpm workflow archive-pr open demo-change --config github-adapter.json --grant 11111111-1111-4111-8111-111111111111 --json',
        },
      },
    });
    assert.deepEqual(
      workflowResultNextSteps(prepared, [
        'archive-pr',
        'prepare',
        'demo-change',
        '--config',
        'github-adapter.json',
      ]).map(({ command }) => command),
      [
        'pnpm workflow grant human inspect 11111111-1111-4111-8111-111111111111 --json',
        'pnpm workflow grant human decide 11111111-1111-4111-8111-111111111111 --json',
        'pnpm workflow archive-pr open demo-change --config github-adapter.json --grant 11111111-1111-4111-8111-111111111111 --json',
      ],
    );

    const opened = await dispatch(
      [
        'archive-pr',
        'open',
        'demo-change',
        '--config',
        'github-adapter.json',
        '--grant',
        '11111111-1111-4111-8111-111111111111',
      ],
      repository,
    );
    assert.deepEqual(opened, {
      command: 'archive-pr',
      action: 'open',
      ok: true,
      result: { opened: { number: 23 } },
    });
    assert.deepEqual(published, {
      cwd: repository,
      local,
      config: JSON.parse(fs.readFileSync(configPath, 'utf8')),
      grantChallengeId: '11111111-1111-4111-8111-111111111111',
      publicationTarget,
      rulesetObserver,
      branchPublisher,
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive-pr doctor reuses exact local candidate discovery without writes or remote seams', async () => {
  const repository = completedFixture();
  const remoteCalls: string[] = [];
  const runtimeRoot =
    loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
  const before = {
    repository: repositoryProjection(repository),
    refs: git(repository, ['show-ref']),
    worktrees: git(repository, ['worktree', 'list', '--porcelain']),
    runtime: snapshotDirectory(runtimeRoot),
  };
  const dispatch = createArchivePullRequestCliDispatcherForTesting(
    localOnlyArchiveCliDependencies(remoteCalls),
  );

  try {
    const output = await dispatch(
      ['archive-pr', 'doctor', '--base', 'origin/main'],
      repository,
    );
    assert.equal(output.command, 'archive-pr');
    assert.equal(output.action, 'doctor');
    assert.equal(output.ok, true);
    const inventory = output.result as ReturnType<
      typeof discoverArchivePullRequestCandidates
    >;
    assert.equal(inventory.schemaVersion, 1);
    assert.equal(inventory.kind, 'archive-pull-request-candidate-inventory');
    assert.equal(inventory.base, 'origin/main');
    assert.equal(inventory.items.length, 1);
    assert.equal(inventory.items[0]?.changeId, 'demo-change');
    assert.equal(inventory.items[0]?.state, 'eligible');
    await assert.rejects(
      dispatch(['archive-pr', 'doctor', '--base', 'main'], repository),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_BASE_INVALID'),
    );
    assert.deepEqual(remoteCalls, []);
    assert.deepEqual(
      {
        repository: repositoryProjection(repository),
        refs: git(repository, ['show-ref']),
        worktrees: git(repository, ['worktree', 'list', '--porcelain']),
        runtime: snapshotDirectory(runtimeRoot),
      },
      before,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive-pr dry-run creates only a local canonical preparation and reports the remote gate pending', async () => {
  const repository = completedFixture();
  const workspaceParent = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-archive-dry-run-worktrees`,
  );
  const worktreePath = path.join(workspaceParent, 'demo-change');
  const remoteCalls: string[] = [];
  const before = repositoryProjection(repository);
  const remoteBaseBefore = git(repository, [
    'rev-parse',
    'refs/remotes/origin/main',
  ]).trim();
  const dispatch = createArchivePullRequestCliDispatcherForTesting(
    localOnlyArchiveCliDependencies(remoteCalls, {
      prepare(cwd, changeId, options) {
        return preparePostMergeArchivePullRequest(cwd, changeId, {
          ...options,
          assure: (_worktree, baseCommit, headCommit) => ({
            status: 'passed',
            baseCommit,
            headCommit,
            reportIdentity: '8'.repeat(64),
          }),
        });
      },
    }),
  );

  try {
    const output = await dispatch(
      [
        'archive-pr',
        'dry-run',
        'demo-change',
        '--workspace-parent',
        workspaceParent,
      ],
      repository,
    );
    assert.equal(output.command, 'archive-pr');
    assert.equal(output.action, 'dry-run');
    assert.equal(output.ok, true);
    const result = output.result as {
      schemaVersion: number;
      kind: string;
      remoteState: string;
      operationalGate: string;
      local: ReturnType<typeof preparePostMergeArchivePullRequest>;
    };
    assert.deepEqual(
      {
        schemaVersion: result.schemaVersion,
        kind: result.kind,
        remoteState: result.remoteState,
        operationalGate: result.operationalGate,
      },
      {
        schemaVersion: 1,
        kind: 'archive-pr-dry-run.v1',
        remoteState: 'not-observed',
        operationalGate: 'pending',
      },
    );
    assert.equal(result.local.kind, 'prepared-post-merge-archive-pull-request');
    assert.equal(result.local.archiveBranch, 'work/archive-demo-change');
    assert.equal(result.local.worktreePath, fs.realpathSync(worktreePath));
    assert.equal(result.local.archive.status, 'committed');
    assert.equal(result.local.archiveReplay.status, 'already-archived');
    assert.equal(
      result.local.archive.commitHash,
      result.local.archiveReplay.commitHash,
    );
    assert.equal(fs.existsSync(result.local.preparationRecordPath), true);
    assert.equal(
      git(repository, ['rev-parse', result.local.archiveBranch]).trim(),
      result.local.archive.commitHash,
    );
    assert.equal(
      git(repository, ['rev-parse', 'refs/remotes/origin/main']).trim(),
      remoteBaseBefore,
    );
    assert.deepEqual(repositoryProjection(repository), before);
    assert.deepEqual(remoteCalls, []);
  } finally {
    if (fs.existsSync(worktreePath)) {
      git(repository, ['worktree', 'remove', '--force', worktreePath]);
    }
    fs.rmSync(workspaceParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
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

test('production archive branch publisher is exact, create-only, and idempotent against a bare remote', async () => {
  const root = fs.mkdtempSync(
    path.join(path.dirname(import.meta.dirname), 'archive-publisher-'),
  );
  const repository = path.join(root, 'repository');
  const remote = path.join(root, 'remote.git');
  try {
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '--initial-branch=main', repository], {
      stdio: 'ignore',
    });
    git(repository, ['config', 'user.email', 'fixture@example.com']);
    git(repository, ['config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
    git(repository, ['add', 'base.txt']);
    git(repository, ['commit', '-m', 'Create base']);
    const protectedBaseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    execFileSync('git', ['clone', '--bare', repository, remote], {
      stdio: 'ignore',
    });
    git(repository, ['remote', 'add', 'origin', remote]);
    git(repository, ['checkout', '-b', 'work/archive-demo-change']);
    fs.writeFileSync(path.join(repository, 'archive.txt'), 'archive\n');
    git(repository, ['add', 'archive.txt']);
    git(repository, ['commit', '-m', 'Archive demo change']);
    const archiveHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const request = {
      schemaVersion: 1 as const,
      kind: 'exact-archive-branch-publication-request.v1' as const,
      preparationIdentity: `sha256:${'3'.repeat(64)}` as const,
      repositoryRoot: repository,
      remoteName: 'origin' as const,
      protectedBaseRef: 'refs/heads/main',
      protectedBaseCommit,
      archiveRef: 'refs/heads/work/archive-demo-change',
      archiveHead,
      expectedArchiveRemoteHead: null,
    };
    const publisher = createGitExactArchiveBranchPublisher({
      expectedCanonicalOrigin: remote,
    });

    const first = await publisher.publish(request);
    const replay = await publisher.publish(request);
    assert.equal(first.disposition, 'created');
    assert.equal(replay.disposition, 'confirmed');
    assert.equal(first.force, false);
    assert.equal(
      git(remote, ['rev-parse', request.archiveRef]).trim(),
      archiveHead,
    );

    git(remote, ['update-ref', request.archiveRef, protectedBaseCommit]);
    await assert.rejects(Promise.resolve(publisher.publish(request)), (error) =>
      isWorkflowError(error, 'ARCHIVE_PR_BRANCH_PUBLICATION_COLLISION'),
    );
    assert.equal(
      git(remote, ['rev-parse', request.archiveRef]).trim(),
      protectedBaseCommit,
    );
    git(remote, ['update-ref', '-d', request.archiveRef]);
    let remoteObservationCount = 0;
    const unknownEffectPublisher = createGitExactArchiveBranchPublisher({
      expectedCanonicalOrigin: remote,
      runGit(cwd, args, allowFailure) {
        if (args[0] === 'ls-remote') {
          remoteObservationCount += 1;
          if (remoteObservationCount > 1) {
            throw new Error('forced post-dispatch observation failure');
          }
        }
        if (args[0] === 'push') {
          runWorkflowGit(cwd, args, allowFailure);
          throw new Error('forced ambiguous dispatch result');
        }
        return runWorkflowGit(cwd, args, allowFailure);
      },
    });
    await assert.rejects(
      Promise.resolve(unknownEffectPublisher.publish(request)),
      (error) =>
        isWorkflowError(error, 'ARCHIVE_PR_BRANCH_PUBLICATION_UNKNOWN_EFFECT'),
    );
    assert.equal(
      git(remote, ['rev-parse', request.archiveRef]).trim(),
      archiveHead,
    );
    git(repository, [
      'remote',
      'set-url',
      'origin',
      path.join(root, 'does-not-exist.git'),
    ]);
    await assert.rejects(Promise.resolve(publisher.publish(request)), (error) =>
      isWorkflowError(error, 'ARCHIVE_PR_REMOTE_IDENTITY_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production archive branch publisher snapshots the validated push target before dispatch', async () => {
  const root = fs.mkdtempSync(
    path.join(path.dirname(import.meta.dirname), 'archive-publisher-target-'),
  );
  const repository = path.join(root, 'repository');
  const expectedRemote = path.join(root, 'expected.git');
  const redirectedRemote = path.join(root, 'redirected.git');
  try {
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '--initial-branch=main', repository], {
      stdio: 'ignore',
    });
    git(repository, ['config', 'user.email', 'fixture@example.com']);
    git(repository, ['config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
    git(repository, ['add', 'base.txt']);
    git(repository, ['commit', '-m', 'Create base']);
    const protectedBaseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    for (const remote of [expectedRemote, redirectedRemote]) {
      execFileSync('git', ['clone', '--bare', repository, remote], {
        stdio: 'ignore',
      });
    }
    git(repository, ['remote', 'add', 'origin', expectedRemote]);
    git(repository, ['checkout', '-b', 'work/archive-demo-change']);
    fs.writeFileSync(path.join(repository, 'archive.txt'), 'archive\n');
    git(repository, ['add', 'archive.txt']);
    git(repository, ['commit', '-m', 'Archive demo change']);
    const archiveHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const archiveRef = 'refs/heads/work/archive-demo-change';
    let redirected = false;
    const publisher = createGitExactArchiveBranchPublisher({
      expectedCanonicalOrigin: expectedRemote,
      runGit(cwd, args, allowFailure) {
        if (args[0] === 'ls-remote' && !redirected) {
          redirected = true;
          runWorkflowGit(repository, [
            'remote',
            'set-url',
            'origin',
            redirectedRemote,
          ]);
        }
        return runWorkflowGit(cwd, args, allowFailure);
      },
    });

    await publisher.publish({
      schemaVersion: 1,
      kind: 'exact-archive-branch-publication-request.v1',
      preparationIdentity: `sha256:${'4'.repeat(64)}`,
      repositoryRoot: repository,
      remoteName: 'origin',
      protectedBaseRef: 'refs/heads/main',
      protectedBaseCommit,
      archiveRef,
      archiveHead,
      expectedArchiveRemoteHead: null,
    });

    assert.equal(
      git(expectedRemote, ['rev-parse', archiveRef]).trim(),
      archiveHead,
    );
    assert.throws(() => git(redirectedRemote, ['rev-parse', archiveRef]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production ruleset observer authenticates a current no-bypass workflow-assurance ruleset', async () => {
  const now = new Date('2026-08-30T00:00:00.000Z');
  const token = 'github-app-token-for-local-ruleset-double';
  const calls: Array<Readonly<{ url: string; authorization: string | null }>> =
    [];
  const fetchDouble: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    if (url.endsWith('/repos/example/fixture')) {
      return jsonResponse(200, { default_branch: 'main' });
    }
    if (url.includes('/repos/example/fixture/rulesets?')) {
      return jsonResponse(200, [
        { id: 17, target: 'branch', enforcement: 'active' },
      ]);
    }
    if (url.endsWith('/repos/example/fixture/rulesets/17')) {
      return jsonResponse(200, {
        id: 17,
        target: 'branch',
        enforcement: 'active',
        bypass_actors: [],
        conditions: {
          ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        },
        rules: [
          {
            type: 'required_status_checks',
            parameters: {
              required_status_checks: [
                { context: 'workflow-assurance', integration_id: 0 },
              ],
            },
          },
        ],
      });
    }
    return jsonResponse(500, {});
  };
  const config = {
    schemaVersion: 1 as const,
    apiBaseUrl: 'https://api.github.com',
    owner: 'example',
    repository: 'fixture',
    tokenEnvironmentVariable: 'JIGWRIGHT_GITHUB_APP_TOKEN',
    permissions: {
      contents: 'write' as const,
      pullRequests: 'write' as const,
      metadata: 'read' as const,
    },
  };
  const observer = createGitHubApiArchiveRulesetObserver({
    config,
    environment: { JIGWRIGHT_GITHUB_APP_TOKEN: token },
    fetch: fetchDouble,
    now: () => now,
  });
  const observation = await observer.observe({
    repository: { owner: 'example', name: 'fixture' },
    protectedBase: { branch: 'main', commit: 'a'.repeat(40) },
  });

  assert.deepEqual(observation.activeRulesetIds, [17]);
  assert.deepEqual(observation.requiredStatusChecks, ['workflow-assurance']);
  assert.equal(observation.bypassActorCount, 0);
  assert.equal(observation.authentication, 'github-app-token');
  assert.equal(
    calls.every(({ authorization }) => authorization === `Bearer ${token}`),
    true,
  );
  assert.equal(JSON.stringify(observation).includes(token), false);

  const unavailable = createGitHubApiArchiveRulesetObserver({
    config,
    environment: {},
    fetch: async () => assert.fail('must not contact GitHub'),
    now: () => now,
  });
  await assert.rejects(
    unavailable.observe({
      repository: { owner: 'example', name: 'fixture' },
      protectedBase: { branch: 'main', commit: 'a'.repeat(40) },
    }),
    (error) =>
      isWorkflowError(error, 'ARCHIVE_PR_GITHUB_CREDENTIAL_UNAVAILABLE'),
  );
  assert.throws(
    () =>
      resolveArchivePullRequestPublicationTarget(
        path.resolve(import.meta.dirname, '../../..'),
        config,
      ),
    (error) =>
      isWorkflowError(error, 'ARCHIVE_PR_GITHUB_CONFIG_TARGET_MISMATCH'),
  );
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
    const publicationTarget = archivePublicationTarget({
      tokenEnvironmentVariable: 'JIGWRIGHT_GITHUB_APP_TOKEN',
    });
    await assert.rejects(
      publishPostMergeArchivePullRequest(
        repository,
        first,
        {},
        {
          grantChallengeId: '00000000-0000-4000-8000-000000000001',
          publicationTarget,
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
      publicationTarget,
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
    } as const;
    await assert.rejects(
      publishPostMergeArchivePullRequest(repository, first, config, {
        ...publishOptions,
        grantChallengeId: '00000000-0000-4000-8000-000000000099',
      }),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_CENTRAL_GRANT_INVALID'),
    );
    const changedConfig = {
      ...config,
      tokenEnvironmentVariable: 'CHANGED_GITHUB_APP_TOKEN',
    } as const;
    await assert.rejects(
      publishPostMergeArchivePullRequest(repository, first, changedConfig, {
        ...publishOptions,
        rulesetObserver: {
          contractVersion: 'github-archive-ruleset-observer.v1',
          async observe() {
            return assert.fail('config drift must fail before ruleset access');
          },
        },
        branchPublisher: disabledBranchPublisher(),
      }),
      (error) =>
        isWorkflowError(error, 'ARCHIVE_PR_PUBLICATION_TARGET_CHANGED'),
    );
    await assert.rejects(
      publishPostMergeArchivePullRequest(repository, first, changedConfig, {
        ...publishOptions,
        publicationTarget: archivePublicationTarget({
          tokenEnvironmentVariable: 'CHANGED_GITHUB_APP_TOKEN',
        }),
        rulesetObserver: {
          contractVersion: 'github-archive-ruleset-observer.v1',
          async observe() {
            return assert.fail('Grant drift must fail before ruleset access');
          },
        },
        branchPublisher: disabledBranchPublisher(),
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
          publicationTarget,
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
          publicationTarget,
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

test('archive preparation status replays exact local Git truth without a worktree or runtime writes', () => {
  const repository = createFixtureRepository();
  try {
    const local = createLocalArchivePreparationFixture(repository);
    const runtimeRoot = local.runtimeRoot;
    const before = {
      repository: repositoryProjection(repository),
      refs: git(repository, ['show-ref']),
      worktrees: git(repository, ['worktree', 'list', '--porcelain']),
      runtime: snapshotDirectory(runtimeRoot),
    };

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(import.meta.dirname, '../src/cli.ts'),
        'archive-pr',
        'status',
        local.preparation.preparationIdentity,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      command: string;
      action: string;
      result: {
        schemaVersion: number;
        kind: string;
        authority: string;
        state: string;
        preparationIdentity: string;
        changeId: string;
        protectedBase: { commit: string; tree: string };
        archive: {
          branch: string;
          headCommit: string;
          reportId: string;
          archivePath: string;
        };
        recordedAssurance: { reportIdentity: string };
        publicationBoundary: {
          remoteState: string;
          operationalGate: string;
        };
        replayCommand: string;
      };
    };
    assert.equal(output.command, 'archive-pr');
    assert.equal(output.action, 'status');
    assert.equal(output.result.schemaVersion, 1);
    assert.equal(
      output.result.kind,
      'archive-publication-preparation-status.v1',
    );
    assert.equal(output.result.authority, 'diagnostic');
    assert.equal(output.result.state, 'local-preparation-current');
    assert.equal(
      output.result.preparationIdentity,
      local.preparation.preparationIdentity,
    );
    assert.equal(output.result.changeId, 'demo-change');
    assert.equal(
      output.result.protectedBase.commit,
      local.preparation.protectedBase.commit,
    );
    assert.equal(
      output.result.protectedBase.tree,
      local.preparation.protectedBase.tree,
    );
    assert.deepEqual(output.result.archive, {
      branch: local.archiveBranch,
      headCommit: local.archive.commitHash,
      reportId: local.archive.reportId,
      archivePath: local.archive.archivePath,
    });
    assert.equal(
      output.result.recordedAssurance.reportIdentity,
      '8'.repeat(64),
    );
    assert.deepEqual(output.result.publicationBoundary, {
      remoteState: 'not-observed-by-local-status',
      operationalGate: 'pending',
    });
    assert.equal(
      output.result.replayCommand,
      'pnpm workflow after-merge demo-change --json',
    );
    assert.deepEqual(
      {
        repository: repositoryProjection(repository),
        refs: git(repository, ['show-ref']),
        worktrees: git(repository, ['worktree', 'list', '--porcelain']),
        runtime: snapshotDirectory(runtimeRoot),
      },
      before,
    );

    git(repository, [
      'update-ref',
      `refs/heads/${local.archiveBranch}`,
      local.preparation.protectedBase.commit,
      local.archive.commitHash,
    ]);
    const drifted = {
      repository: repositoryProjection(repository),
      refs: git(repository, ['show-ref']),
      worktrees: git(repository, ['worktree', 'list', '--porcelain']),
      runtime: snapshotDirectory(runtimeRoot),
    };
    const stale = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(import.meta.dirname, '../src/cli.ts'),
        'archive-pr',
        'status',
        local.preparation.preparationIdentity,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(stale.status, 13, stale.stdout);
    assert.equal(
      (JSON.parse(stale.stderr) as { error: { code: string } }).error.code,
      'ARCHIVE_PR_PREPARATION_STALE',
    );
    assert.deepEqual(
      {
        repository: repositoryProjection(repository),
        refs: git(repository, ['show-ref']),
        worktrees: git(repository, ['worktree', 'list', '--porcelain']),
        runtime: snapshotDirectory(runtimeRoot),
      },
      drifted,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('local archive rejects a foreign canonical branch descendant before recovery writes', () => {
  const repository = completedFixture();
  const workspaceParent = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-archive-collision-worktrees`,
  );
  const worktreePath = path.join(workspaceParent, 'demo-change');
  try {
    const protectedBase = git(repository, ['rev-parse', 'HEAD']).trim();
    const tree = git(repository, [
      'rev-parse',
      `${protectedBase}^{tree}`,
    ]).trim();
    const foreignCommit = git(repository, [
      'commit-tree',
      tree,
      '-p',
      protectedBase,
      '-m',
      'Foreign canonical archive branch occupant',
    ]).trim();
    git(repository, [
      'update-ref',
      'refs/heads/work/archive-demo-change',
      foreignCommit,
    ]);
    const runtimeRoot =
      loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
    const before = {
      repository: repositoryProjection(repository),
      refs: git(repository, ['show-ref']),
      worktrees: git(repository, ['worktree', 'list', '--porcelain']),
      runtime: snapshotDirectory(runtimeRoot),
      foreignCommit: git(repository, ['cat-file', 'commit', foreignCommit]),
      workspaceParentExists: fs.existsSync(workspaceParent),
    };

    assert.throws(
      () =>
        preparePostMergeArchivePullRequest(repository, 'demo-change', {
          workspaceParent,
          assure: (_cwd, baseCommit, headCommit) => ({
            status: 'passed',
            baseCommit,
            headCommit,
            reportIdentity: '8'.repeat(64),
          }),
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_PR_BRANCH_COLLISION'),
    );
    assert.deepEqual(
      {
        repository: repositoryProjection(repository),
        refs: git(repository, ['show-ref']),
        worktrees: git(repository, ['worktree', 'list', '--porcelain']),
        runtime: snapshotDirectory(runtimeRoot),
        foreignCommit: git(repository, ['cat-file', 'commit', foreignCommit]),
        workspaceParentExists: fs.existsSync(workspaceParent),
      },
      before,
    );

    git(repository, [
      'update-ref',
      'refs/heads/work/archive-demo-change',
      protectedBase,
      foreignCommit,
    ]);
    const resumed = preparePostMergeArchivePullRequest(
      repository,
      'demo-change',
      {
        workspaceParent,
        assure: (_cwd, baseCommit, headCommit) => ({
          status: 'passed',
          baseCommit,
          headCommit,
          reportIdentity: '8'.repeat(64),
        }),
      },
    );
    assert.equal(resumed.archive.status, 'committed');
    assert.equal(resumed.archiveReplay.status, 'already-archived');
    assert.equal(resumed.preparation.protectedBase.commit, protectedBase);
  } finally {
    if (fs.existsSync(worktreePath)) {
      git(repository, ['worktree', 'remove', '--force', worktreePath]);
    }
    fs.rmSync(workspaceParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('local archive resumes one exact report-backed archive branch', () => {
  const repository = completedFixture();
  const workspaceParent = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-archive-report-recovery-worktrees`,
  );
  const worktreePath = path.join(workspaceParent, 'demo-change');
  try {
    const existing = createReportBackedArchiveBranchFixture(repository);
    const before = repositoryProjection(repository);
    const prepared = preparePostMergeArchivePullRequest(
      repository,
      'demo-change',
      {
        workspaceParent,
        assure: (_cwd, baseCommit, headCommit) => ({
          status: 'passed',
          baseCommit,
          headCommit,
          reportIdentity: '8'.repeat(64),
        }),
      },
    );

    assert.equal(prepared.archive.status, 'already-archived');
    assert.equal(prepared.archiveReplay.status, 'already-archived');
    assert.equal(prepared.archive.commitHash, existing.archiveHead);
    assert.equal(prepared.archive.reportId, existing.reportId);
    assert.equal(
      prepared.preparation.protectedBase.commit,
      existing.protectedBase,
    );
    assert.equal(prepared.preparation.archive.headCommit, existing.archiveHead);
    assert.deepEqual(repositoryProjection(repository), before);
  } finally {
    if (fs.existsSync(worktreePath)) {
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
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
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
  options: Readonly<{
    challengeId?: string;
    now?: Date;
    publicationTarget?: ReturnType<typeof archivePublicationTarget>;
  }> = {},
): string {
  const now = options.now ?? new Date();
  const runtimeRoot =
    loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
  const paths = grantStorePaths(runtimeRoot);
  const registry = createTransitionRegistry(
    archivePullRequestGrantTransitionDefinitions(runtimeRoot),
  );
  const publicationTarget =
    options.publicationTarget ??
    archivePublicationTarget({
      tokenEnvironmentVariable: 'JIGWRIGHT_GITHUB_APP_TOKEN',
    });
  const challenge = createGrantChallenge(
    createArchivePullRequestGrantRequest(
      runtimeRoot,
      local.preparation.preparationIdentity,
      publicationTarget,
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
        portableEvidence: null,
      },
    ],
    createdAt: now.toISOString(),
  });
  recordGrantTransitionOutcome(paths, {
    challengeId: challenge.challengeId,
    operationId,
    poststateDigest: challenge.stateBinding.digest,
    outcome: {
      outcome: 'completed',
      details: {
        schemaVersion: 1,
        kind: 'archive-pr-publication-authorized.v1',
        preparationIdentity: local.preparation.preparationIdentity,
        publicationTargetDigest: digest(canonicalJson(publicationTarget)),
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

function localOnlyArchiveCliDependencies(
  remoteCalls: string[],
  overrides: Partial<
    Parameters<typeof createArchivePullRequestCliDispatcherForTesting>[0]
  > = {},
): Parameters<typeof createArchivePullRequestCliDispatcherForTesting>[0] {
  return {
    discover: discoverArchivePullRequestCandidates,
    inspect() {
      throw new Error('local status inspection must not run');
    },
    prepare: preparePostMergeArchivePullRequest,
    async requestGrant() {
      remoteCalls.push('request-grant');
      throw new Error('Grant request must not run');
    },
    async publish() {
      remoteCalls.push('publish');
      throw new Error('remote publication must not run');
    },
    async loadAdapter() {
      remoteCalls.push('load-adapter');
      throw new Error('GitHub adapter must not load');
    },
    createRulesetObserver() {
      remoteCalls.push('create-ruleset-observer');
      throw new Error('ruleset observer must not be created');
    },
    createBranchPublisher() {
      remoteCalls.push('create-branch-publisher');
      throw new Error('branch publisher must not be created');
    },
    resolvePublicationTarget() {
      remoteCalls.push('resolve-publication-target');
      throw new Error('publication target must not be resolved');
    },
    ...overrides,
  };
}

function archivePublicationTarget(
  input: Readonly<{ tokenEnvironmentVariable: string }>,
) {
  const config = {
    schemaVersion: 1 as const,
    apiBaseUrl: 'https://api.github.com',
    owner: 'example',
    repository: 'fixture',
    tokenEnvironmentVariable: input.tokenEnvironmentVariable,
    permissions: {
      contents: 'write' as const,
      pullRequests: 'write' as const,
      metadata: 'read' as const,
    },
  };
  return {
    schemaVersion: 1 as const,
    kind: 'archive-pr-publication-target.v1' as const,
    repositoryId: 'github:fixture',
    canonicalOrigin: 'https://github.com/example/fixture.git',
    remoteName: 'origin' as const,
    apiBaseUrl: 'https://api.github.com' as const,
    owner: 'example',
    repository: 'fixture',
    adapterConfigDigest: digest(canonicalJson(config)),
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

function createLocalArchivePreparationFixture(repository: string) {
  const changeId = 'demo-change';
  const archiveBranch = `work/archive-${changeId}`;
  const protectedBaseCommit = git(repository, ['rev-parse', 'main']).trim();
  const protectedBaseTree = git(repository, [
    'rev-parse',
    `${protectedBaseCommit}^{tree}`,
  ]).trim();
  git(repository, ['checkout', '-b', archiveBranch]);
  const archivePath = `openspec/changes/archive/2026-09-01-${changeId}`;
  fs.mkdirSync(path.join(repository, archivePath), { recursive: true });
  fs.writeFileSync(
    path.join(repository, archivePath, 'status.txt'),
    'current archive status fixture\n',
  );
  git(repository, ['add', archivePath]);
  git(repository, [
    'commit',
    '-m',
    `Archive ${changeId}`,
    '-m',
    `Change: ${changeId}\nTransition: archive`,
  ]);
  const archiveHead = git(repository, ['rev-parse', 'HEAD']).trim();
  const archiveTree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
  const patch = git(repository, [
    'diff',
    '--binary',
    protectedBaseCommit,
    archiveHead,
  ]);
  git(repository, ['checkout', 'main']);

  const runtimeRoot =
    loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const reportId = writeArchiveReport(
    path.join(runtimeRoot, 'archive-reports'),
    {
      schemaVersion: 1,
      kind: 'archive-transition',
      createdAt: '2026-09-01T00:00:00.000Z',
      changeId,
      archivePath,
      parent: protectedBaseCommit,
      tree: archiveTree,
      commitHash: archiveHead,
      patch,
      patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
      changedPaths: [`${archivePath}/status.txt`],
      logicalIdentity: 'archive-status-fixture',
      contractDigest: '1'.repeat(64),
      promotedSpecDigests: {},
      archivedArtifactDigests: {},
    },
  );
  const preparation = createArchivePublicationPreparation({
    repositoryId: 'fixture',
    changeId,
    candidateIdentity: '7'.repeat(64),
    protectedBase: {
      branch: 'main',
      remoteName: 'origin',
      trackingRef: 'refs/remotes/origin/main',
      commit: protectedBaseCommit,
      tree: protectedBaseTree,
    },
    archive: {
      branch: archiveBranch,
      headCommit: archiveHead,
      reportId,
    },
    assurance: {
      reportIdentity: '8'.repeat(64),
      baseCommit: protectedBaseCommit,
      headCommit: archiveHead,
    },
  });
  persistArchivePublicationPreparation(runtimeRoot, preparation);
  return {
    runtimeRoot,
    archiveBranch,
    archive: {
      commitHash: archiveHead,
      reportId,
      archivePath,
    },
    preparation,
  };
}

function createReportBackedArchiveBranchFixture(repository: string) {
  const changeId = 'demo-change';
  const archiveBranch = `work/archive-${changeId}`;
  const protectedBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const builder = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-archive-report-builder`,
  );
  let worktreeAdded = false;
  try {
    git(repository, [
      'worktree',
      'add',
      '-b',
      archiveBranch,
      builder,
      protectedBase,
    ]);
    worktreeAdded = true;
    const archivePath = `openspec/changes/archive/2026-09-01-${changeId}`;
    fs.mkdirSync(path.dirname(path.join(builder, archivePath)), {
      recursive: true,
    });
    fs.renameSync(
      path.join(builder, 'openspec/changes', changeId),
      path.join(builder, archivePath),
    );
    git(builder, ['add', '-A']);
    git(builder, ['commit', '-m', archiveCommitMessage(changeId)]);
    const archiveHead = git(builder, ['rev-parse', 'HEAD']).trim();
    const archiveTree = git(builder, ['rev-parse', 'HEAD^{tree}']).trim();
    const changedPaths = commitChangedPaths(repository, archiveHead);
    const patch = git(repository, [
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
      protectedBase,
      archiveHead,
      '--',
      ...changedPaths.map((changedPath) => `:(literal)${changedPath}`),
    ]);
    const runtimeRoot =
      loadInvestigationRuntimeContext(repository).lifecycleRuntime.root;
    const reportId = writeArchiveReport(
      path.join(runtimeRoot, 'archive-reports'),
      {
        schemaVersion: 1,
        kind: 'archive-transition',
        createdAt: '2026-09-01T00:00:00.000Z',
        changeId,
        archivePath,
        parent: protectedBase,
        tree: archiveTree,
        commitHash: archiveHead,
        patch,
        patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
        changedPaths,
        logicalIdentity: 'archive-report-recovery-fixture',
        contractDigest: '1'.repeat(64),
        promotedSpecDigests: {},
        archivedArtifactDigests: {},
      },
    );
    return { archiveHead, protectedBase, reportId };
  } finally {
    if (worktreeAdded && fs.existsSync(builder)) {
      git(repository, ['worktree', 'remove', '--force', builder]);
    }
    fs.rmSync(builder, { recursive: true, force: true });
  }
}

function snapshotDirectory(root: string): readonly unknown[] {
  const entries: unknown[] = [];
  const visit = (absolute: string, relative: string): void => {
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stats === undefined) return;
    entries.push({
      path: relative,
      mode: stats.mode,
      kind: stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : stats.isSymbolicLink()
            ? 'symlink'
            : 'other',
      content: stats.isFile()
        ? fs.readFileSync(absolute).toString('base64')
        : stats.isSymbolicLink()
          ? fs.readlinkSync(absolute)
          : null,
    });
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, entry), path.join(relative, entry));
      }
    }
  };
  visit(root, '.');
  return entries;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
