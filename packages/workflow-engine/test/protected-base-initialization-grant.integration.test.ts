import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import {
  createGrantCoordinatorKernel,
  type TrustedGrantPresentation,
} from '../src/modules/authority/grant-coordinator.ts';
import {
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  codeOwnedApprovalModuleRegistry,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import {
  createProtectedBaseInitializationGrantRequest,
  protectedBaseInitializationGrantTransitionDefinitions,
} from '../src/modules/authority/protected-base-initialization-grant.ts';
import {
  createGitProtectedBaseInitializationPort,
  publishCompletedProtectedBaseInitialization,
} from '../src/composition-root/protected-base-initialization-production.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import { createProposeProtectedBaseFailGrantResult } from '../src/cli.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { git, isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-29T01:00:00.000Z');
const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('propose maps an unavailable protected base to a durable Fail-Grant result', async () => {
  const result = await createProposeProtectedBaseFailGrantResult(
    ['propose', 'demo-change', '--intent', 'intent.json'],
    '/fixture',
    workflowError(
      'PROPOSE_PROTECTED_BASE_UNAVAILABLE',
      'The configured protected remote-tracking base is unavailable.',
      ExitCode.staleState,
      { details: { protectedBaseRef: 'refs/remotes/origin/main' } },
    ),
    async (cwd, reason) => {
      assert.equal(cwd, '/fixture');
      assert.match(reason, /create-only initialization/);
      return {
        challengeId: CHALLENGE_ID,
        challengeDigest: digest('challenge'),
      };
    },
  );

  assert.deepEqual(result, {
    command: 'propose',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      changeId: 'demo-change',
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: 'PROPOSE_PROTECTED_BASE_UNAVAILABLE',
        message:
          'The configured protected remote-tracking base is unavailable.',
        details: { protectedBaseRef: 'refs/remotes/origin/main' },
      },
      grant: {
        challengeId: CHALLENGE_ID,
        challengeDigest: digest('challenge'),
      },
      externalPublicationPending: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${CHALLENGE_ID} --json`,
        decisionCommand: `pnpm workflow grant human decide ${CHALLENGE_ID} --json`,
        retryAfterPublication: 'rerun the same propose command',
      },
    },
  });
});

test('a completed Human Presence grant publishes one exact create-only protected base', async () => {
  await withRepositories(async ({ repository, remote, runtimeRoot }) => {
    const sourceCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    const port = createGitProtectedBaseInitializationPort({
      repositoryRoot: repository,
      repositoryId: 'fixture',
      canonicalOrigin: remote,
      remoteName: 'origin',
      protectedBranch: 'main',
    });
    const coordinator = createCoordinator(runtimeRoot, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseInitializationGrantRequest(
        port,
        'Initialize the empty protected base from the exact reviewed local commit.',
      ),
    );

    const presentation = coordinator.inspectChallenge(challenge.challengeId);
    assert.equal(presentation.failureCode, 'protected-base-unavailable');
    assert.deepEqual(presentation.approvalMethods, ['human-presence']);
    assert.equal(
      presentation.choices[0]!.transitionId,
      'git.protected-base.initialize-authorize.v1',
    );

    const result = await coordinator.resolveChallenge(challenge.challengeId);
    assert.equal(result.outcome, 'completed');
    assert.throws(() =>
      git(remote, ['show-ref', '--verify', 'refs/heads/main']),
    );
    assert.throws(() =>
      git(repository, ['show-ref', '--verify', 'refs/remotes/origin/main']),
    );

    const record = readGrantRecord(
      grantStorePaths(runtimeRoot),
      challenge.challengeId,
    );
    assert.equal(record.state, 'completed');
    if (record.state !== 'completed') assert.fail('expected completed grant');
    assert.deepEqual(record.outcome, {
      outcome: 'completed',
      details: {
        schemaVersion: 1,
        kind: 'protected-base-initialization-authorized.v1',
        protectedBranch: 'main',
        sourceCommit,
        remoteEffectApplied: false,
      },
    });
    assert.deepEqual(record.audit, {
      approvalMethod: 'human-presence',
      authorityClass: 'local-device-owner',
      identity: null,
      identityAssurance: 'not-asserted',
      presenceAssurance: 'fresh-os-authentication',
      proofModules: ['human-gate-macos@1'],
    });

    const publication = publishCompletedProtectedBaseInitialization({
      repositoryRoot: repository,
      runtimeRoot,
      challengeId: challenge.challengeId,
      port,
      now: NOW,
    });
    assert.equal(publication.disposition, 'created');
    assert.equal(publication.sourceCommit, sourceCommit);
    assert.equal(publication.remoteCommit, sourceCommit);
    assert.equal(publication.trackingCommit, sourceCommit);
    assert.equal(publication.overwrite, false);
    assert.equal(
      git(remote, ['show-ref', '--verify', 'refs/heads/main']).trim(),
      `${sourceCommit} refs/heads/main`,
    );
    assert.equal(
      git(repository, [
        'rev-parse',
        '--verify',
        'refs/remotes/origin/main^{commit}',
      ]).trim(),
      sourceCommit,
    );
    assert.deepEqual(
      publishCompletedProtectedBaseInitialization({
        repositoryRoot: repository,
        runtimeRoot,
        challengeId: challenge.challengeId,
        port,
        now: NOW,
      }),
      publication,
    );
  });
});

test('a completed grant cannot overwrite a competing protected ref', async () => {
  await withRepositories(async ({ repository, remote, runtimeRoot }) => {
    const port = createGitProtectedBaseInitializationPort({
      repositoryRoot: repository,
      repositoryId: 'fixture',
      canonicalOrigin: remote,
      remoteName: 'origin',
      protectedBranch: 'main',
    });
    const coordinator = createCoordinator(runtimeRoot, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseInitializationGrantRequest(
        port,
        'Initialize the exact empty protected base.',
      ),
    );
    const result = await coordinator.resolveChallenge(challenge.challengeId);
    assert.equal(result.outcome, 'completed');

    const tree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
    const competingCommit = git(repository, [
      'commit-tree',
      tree,
      '-m',
      'Competing remote commit',
    ]).trim();
    git(repository, ['push', 'origin', `${competingCommit}:refs/heads/main`]);

    assert.throws(
      () =>
        publishCompletedProtectedBaseInitialization({
          repositoryRoot: repository,
          runtimeRoot,
          challengeId: challenge.challengeId,
          port,
          now: NOW,
        }),
      (error) =>
        isWorkflowError(error, 'PROTECTED_BASE_PUBLICATION_STATE_CHANGED'),
    );
    assert.equal(
      git(remote, ['rev-parse', 'refs/heads/main']).trim(),
      competingCommit,
    );
  });
});

test('a pending grant cannot publish any protected ref', async () => {
  await withRepositories(async ({ repository, remote, runtimeRoot }) => {
    const port = createGitProtectedBaseInitializationPort({
      repositoryRoot: repository,
      repositoryId: 'fixture',
      canonicalOrigin: remote,
      remoteName: 'origin',
      protectedBranch: 'main',
    });
    const coordinator = createCoordinator(runtimeRoot, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseInitializationGrantRequest(
        port,
        'Initialize the exact empty protected base.',
      ),
    );

    assert.throws(
      () =>
        publishCompletedProtectedBaseInitialization({
          repositoryRoot: repository,
          runtimeRoot,
          challengeId: challenge.challengeId,
          port,
          now: NOW,
        }),
      (error) =>
        isWorkflowError(error, 'PROTECTED_BASE_COMPLETED_GRANT_INVALID'),
    );
    assert.throws(() =>
      git(remote, ['show-ref', '--verify', 'refs/heads/main']),
    );
  });
});

test('publication recovers when the exact push landed before its receipt', async () => {
  await withRepositories(async ({ repository, remote, runtimeRoot }) => {
    const sourceCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    const port = createGitProtectedBaseInitializationPort({
      repositoryRoot: repository,
      repositoryId: 'fixture',
      canonicalOrigin: remote,
      remoteName: 'origin',
      protectedBranch: 'main',
    });
    const coordinator = createCoordinator(runtimeRoot, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseInitializationGrantRequest(
        port,
        'Initialize the exact empty protected base.',
      ),
    );
    const result = await coordinator.resolveChallenge(challenge.challengeId);
    assert.equal(result.outcome, 'completed');
    git(repository, ['push', 'origin', `${sourceCommit}:refs/heads/main`]);

    const publication = publishCompletedProtectedBaseInitialization({
      repositoryRoot: repository,
      runtimeRoot,
      challengeId: challenge.challengeId,
      port,
      now: NOW,
    });
    assert.equal(publication.disposition, 'recovered');
    assert.equal(publication.remoteCommit, sourceCommit);
    assert.equal(publication.trackingCommit, sourceCommit);
  });
});

test('a protected-base challenge becomes stale when the source commit changes', async () => {
  await withRepositories(async ({ repository, remote, runtimeRoot }) => {
    const port = createGitProtectedBaseInitializationPort({
      repositoryRoot: repository,
      repositoryId: 'fixture',
      canonicalOrigin: remote,
      remoteName: 'origin',
      protectedBranch: 'main',
    });
    const coordinator = createCoordinator(runtimeRoot, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseInitializationGrantRequest(
        port,
        'Initialize the exact empty protected base.',
      ),
    );
    fs.writeFileSync(path.join(repository, 'drift.txt'), 'drift\n');
    git(repository, ['add', 'drift.txt']);
    git(repository, ['commit', '-m', 'Drift source commit']);

    await assert.rejects(
      coordinator.resolveChallenge(challenge.challengeId),
      (error) => isWorkflowError(error, 'GRANT_STATE_CHANGED'),
    );
    assert.throws(() =>
      git(remote, ['show-ref', '--verify', 'refs/heads/main']),
    );
  });
});

function createCoordinator(
  runtimeRoot: string,
  port: ReturnType<typeof createGitProtectedBaseInitializationPort>,
) {
  return createGrantCoordinatorKernel({
    paths: grantStorePaths(runtimeRoot),
    registry: createTransitionRegistry(
      protectedBaseInitializationGrantTransitionDefinitions(port),
    ),
    policy: parseGrantPolicyV2(policyInput(), {
      registry: codeOwnedApprovalModuleRegistry(),
    }),
    now: () => new Date(NOW),
    randomUUID: (() => {
      const ids = [CHALLENGE_ID, OPERATION_ID];
      return () => ids.shift() ?? crypto.randomUUID();
    })(),
    openApprovalSession(presentation) {
      return successfulHumanPresenceSession(presentation);
    },
    async withLifecycleOperation(_challengeId, operation) {
      return operation(() => {});
    },
  });
}

function successfulHumanPresenceSession(
  presentation: TrustedGrantPresentation,
) {
  return {
    async collectDecision() {
      return {
        choiceId: presentation.choices[0]!.choiceId,
        approvalMethod: 'human-presence' as const,
        reasonCode: 'initialize-empty-protected-base',
        reason: presentation.choices[0]!.proposedReason,
        sessionNonce: 'nonce-11111111111111111111111111111111',
      };
    },
    async authenticate({
      approvalSubjectDigest,
    }: {
      approvalSubjectDigest: `sha256:${string}`;
    }): Promise<readonly VerifiedApprovalProof[]> {
      return [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claims: ['fresh-local-device-owner'],
          approvalSubjectDigest,
          proofDigest: digest('human-presence-proof'),
          verifiedAt: NOW.toISOString(),
          identity: null,
        },
      ];
    },
    async close() {},
  };
}

function policyInput() {
  return {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': {
        requiredClaims: ['fresh-local-device-owner'],
      },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
    legacyVerification: { maintainerPolicyV1: 'read-only' },
  };
}

async function withRepositories(
  operation: (input: {
    repository: string;
    remote: string;
    runtimeRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-protected-base-grant-'),
  );
  const repository = path.join(root, 'repository');
  const remote = path.join(root, 'remote.git');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(repository);
  fs.mkdirSync(remote);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'Initial fixture']);
  git(repository, ['switch', '-c', 'work/bootstrap']);
  git(remote, ['init', '--bare']);
  git(repository, ['remote', 'add', 'origin', remote]);
  try {
    await operation({ repository, remote, runtimeRoot });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
