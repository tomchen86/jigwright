import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, isWorkflowError } from './fixture.ts';
import {
  createGitExactArchiveBranchPublisher,
  createGitHubApiArchiveRulesetObserver,
  resolveArchivePullRequestPublicationTarget,
} from '../src/composition-root/archive-pr-publication-production.ts';
import assert from 'node:assert/strict';
import { runGit as runWorkflowGit } from '../src/runtime/repository-transaction/git.ts';
import { jsonResponse } from './archive-publication-fixture.ts';

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
