/**
 * Exercises protected-base selection and real Git effects through the Grant kernel in disposable repositories.
 *
 * Invariants:
 * - Local initialization creates only the exact approved ref and never overwrites competing commits.
 * - Synthetic Human Presence proofs are test input, not formal human acceptance.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionProtectedBaseSelectionPort } from '../src/composition-root/local-protected-base-initialization-production.ts';
import {
  createGitProtectedBaseInitializationPort,
  publishCompletedProtectedBaseInitialization,
} from '../src/composition-root/protected-base-initialization-production.ts';
import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import {
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  codeOwnedApprovalModuleRegistry,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  assertProtectedBaseInitializationParameters,
  createProtectedBaseInitializationGrantRequest,
} from '../src/modules/authority/protected-base-initialization-grant.ts';
import {
  createProtectedBaseSelectionGrantRequest,
  initialLocalProtectedBaseObservation,
  protectedBaseSelectionGrantTransitionDefinitions,
} from '../src/modules/authority/protected-base-selection-grant.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

const LOCAL_REF = 'refs/jigwright/protected-base';
const LOCAL_TRANSITION = 'git.protected-base.local-initialize.v1';
const REMOTE_TRANSITION = 'git.protected-base.initialize-authorize.v1';
const NOW = new Date('2026-09-10T01:00:00.000Z');

test('a pending local protected-base Grant has no effect and exact approval creates one replayable ref', async () => {
  await withSelectionRepository(async (repository) => {
    const source = git(repository, ['rev-parse', 'HEAD']).trim();
    const before = git(repository, ['show-ref']);
    const port = createProductionProtectedBaseSelectionPort(repository);
    const coordinator = createSelectionCoordinator(repository, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseSelectionGrantRequest(
        port,
        'Initialize the exact local protected base.',
      ),
    );
    const paths = grantStorePaths(runtimeRoot(repository));

    assert.equal(
      createFileGrantRecordStore(paths).readGrantRecord(challenge.challengeId)
        .state,
      'pending',
    );
    assert.equal(git(repository, ['show-ref']), before);
    await assert.rejects(
      coordinator.recoverChallenge(challenge.challengeId),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECORD_MISSING'),
    );
    assert.equal(git(repository, ['show-ref']), before);

    const completed = await coordinator.resolveChallenge(challenge.challengeId);

    assert.equal(completed.outcome, 'completed');
    assert.equal(completed.transitionId, LOCAL_TRANSITION);
    assert.equal(git(repository, ['rev-parse', LOCAL_REF]).trim(), source);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), source);
    assert.equal(
      createFileGrantRecordStore(paths).readGrantRecord(challenge.challengeId)
        .state,
      'completed',
    );
    const after = git(repository, ['show-ref']);
    const replayed = await coordinator.recoverChallenge(challenge.challengeId);
    assert.deepEqual(replayed, { ...completed, recovered: true });
    assert.equal(git(repository, ['show-ref']), after);
    assert.equal(git(repository, ['remote']), '');
    assert.equal(git(repository, ['for-each-ref', 'refs/remotes/']), '');
  });
});

for (const changedRef of ['HEAD', LOCAL_REF]) {
  test(`local protected-base approval rejects ${changedRef} drift without overwriting it`, async () => {
    await withSelectionRepository(async (repository) => {
      const port = createProductionProtectedBaseSelectionPort(repository);
      const coordinator = createSelectionCoordinator(repository, port);
      const challenge = await coordinator.requestGrant(
        createProtectedBaseSelectionGrantRequest(
          port,
          'Initialize the exact local protected base.',
        ),
      );
      const competing = competingCommit(repository);
      git(repository, ['update-ref', changedRef, competing]);
      const before = git(repository, ['show-ref']);

      await assert.rejects(
        coordinator.resolveChallenge(challenge.challengeId),
        (error) => isWorkflowError(error, 'GRANT_STATE_CHANGED'),
      );

      assert.equal(git(repository, ['show-ref']), before);
      assert.equal(
        git(repository, ['rev-parse', changedRef]).trim(),
        competing,
      );
      assert.equal(
        createFileGrantRecordStore(
          grantStorePaths(runtimeRoot(repository)),
        ).readGrantRecord(challenge.challengeId).state,
        'pending',
      );
    });
  });
}

for (const competingRef of [false, true]) {
  test(`local protected-base recovery ${competingRef ? 'preserves a competing ref and records failure' : 'converges after the ref was created before the outcome was durable'}`, async () => {
    await withSelectionRepository(async (repository) => {
      const source = git(repository, ['rev-parse', 'HEAD']).trim();
      const port = createProductionProtectedBaseSelectionPort(repository);
      const interruptedPort: typeof port = {
        ...port,
        initializeLocal(...args) {
          port.initializeLocal(...args);
          throw new Error('Simulated interruption after local ref creation');
        },
      };
      const coordinator = createSelectionCoordinator(
        repository,
        interruptedPort,
      );
      const challenge = await coordinator.requestGrant(
        createProtectedBaseSelectionGrantRequest(
          interruptedPort,
          'Initialize the exact local protected base.',
        ),
      );
      const paths = grantStorePaths(runtimeRoot(repository));
      await assert.rejects(
        coordinator.resolveChallenge(challenge.challengeId),
        /Simulated interruption after local ref creation/,
      );
      assert.equal(
        createFileGrantRecordStore(paths).readGrantRecord(challenge.challengeId)
          .state,
        'prepared',
      );
      assert.equal(git(repository, ['rev-parse', LOCAL_REF]).trim(), source);
      if (competingRef) {
        git(repository, [
          'update-ref',
          LOCAL_REF,
          competingCommit(repository),
          source,
        ]);
      }
      const beforeRecovery = git(repository, ['show-ref']);

      const recovered = await createSelectionCoordinator(
        repository,
        port,
      ).recoverChallenge(challenge.challengeId);

      assert.equal(recovered.recovered, true);
      assert.equal(recovered.outcome, competingRef ? 'failed' : 'completed');
      const record = createFileGrantRecordStore(paths).readGrantRecord(
        challenge.challengeId,
      );
      assert.equal(record.state, recovered.outcome);
      assert.ok(record.state === 'completed' || record.state === 'failed');
      if (competingRef) {
        assert.deepEqual(record.outcome.details, {
          schemaVersion: 1,
          kind: 'local-protected-base-recovery-conflict.v1',
          ref: LOCAL_REF,
          requestedCommit: source,
          observedCommit: git(repository, ['rev-parse', LOCAL_REF]).trim(),
          priorInitializationEffect: 'unknown',
          recoveryEffectApplied: false,
        });
      }
      assert.equal(git(repository, ['show-ref']), beforeRecovery);
      const replayed = await createSelectionCoordinator(
        repository,
        port,
      ).recoverChallenge(challenge.challengeId);
      assert.deepEqual(replayed, recovered);
      assert.equal(git(repository, ['show-ref']), beforeRecovery);
      assert.equal(git(repository, ['remote']), '');
    });
  });
}

test('local selection stays offline when a canonical remote is configured', async () => {
  await withSelectionRepository(async (repository) => {
    const canonicalOrigin =
      'https://github.com/workflow-fixture/protected-base.git';
    const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      repository: { id: string; origin: string };
    };
    policy.repository = { id: 'github:fixture', origin: canonicalOrigin };
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Configure canonical remote identity']);
    git(repository, ['remote', 'add', 'origin', canonicalOrigin]);
    const nativePort = createProductionProtectedBaseSelectionPort(repository);
    const port: typeof nativePort = {
      ...nativePort,
      observeRemote() {
        assert.fail('local selection must not observe the remote');
      },
    };
    const coordinator = createSelectionCoordinator(repository, port);
    const challenge = await coordinator.requestGrant(
      createProtectedBaseSelectionGrantRequest(
        port,
        'Initialize the protected base locally.',
      ),
    );
    assert.deepEqual(
      new Set(
        coordinator
          .inspectChallenge(challenge.challengeId)
          .choices.map(({ transitionId }) => transitionId),
      ),
      new Set([LOCAL_TRANSITION, REMOTE_TRANSITION]),
    );

    const completed = await coordinator.resolveChallenge(challenge.challengeId);

    assert.equal(completed.outcome, 'completed');
    assert.equal(
      git(repository, ['rev-parse', LOCAL_REF]).trim(),
      git(repository, ['rev-parse', 'HEAD']).trim(),
    );
    assert.equal(git(repository, ['for-each-ref', 'refs/remotes/']), '');
  });
});

test('the selected remote transition retains exact create-only publication', async () => {
  const remote = fs.mkdtempSync(
    path.join(os.tmpdir(), 'local-base-selection-remote-'),
  );
  try {
    git(remote, ['init', '--bare']);
    await withSelectionRepository(async (repository) => {
      git(repository, ['remote', 'add', 'origin', remote]);
      const source = git(repository, ['rev-parse', 'HEAD']).trim();
      const remotePort = createGitProtectedBaseInitializationPort({
        repositoryRoot: repository,
        repositoryId: 'fixture',
        canonicalOrigin: remote,
        remoteName: 'origin',
        protectedBranch: 'main',
      });
      // The native Git port permits a disposable bare remote; production policy requires GitHub.
      const remoteParameters = assertProtectedBaseInitializationParameters(
        createProtectedBaseInitializationGrantRequest(
          remotePort,
          'Initialize the exact empty remote.',
        ).candidates[0]!.parameters,
      );
      const port: ReturnType<
        typeof createProductionProtectedBaseSelectionPort
      > = {
        observeLocal: () =>
          initialLocalProtectedBaseObservation(remoteParameters),
        remoteParameters: () => remoteParameters,
        observeRemote: () => remotePort.observe(),
        initializeLocal() {
          assert.fail('remote selection must not initialize a local ref');
        },
      };
      const coordinator = createSelectionCoordinator(
        repository,
        port,
        REMOTE_TRANSITION,
      );
      const challenge = await coordinator.requestGrant(
        createProtectedBaseSelectionGrantRequest(
          port,
          'Initialize the exact empty remote protected base.',
        ),
      );
      assert.deepEqual(
        new Set(
          coordinator
            .inspectChallenge(challenge.challengeId)
            .choices.map(({ transitionId }) => transitionId),
        ),
        new Set([LOCAL_TRANSITION, REMOTE_TRANSITION]),
      );

      const completed = await coordinator.resolveChallenge(
        challenge.challengeId,
      );

      assert.equal(completed.outcome, 'completed');
      assert.equal(completed.transitionId, REMOTE_TRANSITION);
      assert.equal(git(remote, ['for-each-ref']), '');
      assert.equal(git(repository, ['for-each-ref', LOCAL_REF]), '');
      const publicationInput = {
        repositoryRoot: repository,
        runtimeRoot: runtimeRoot(repository),
        challengeId: challenge.challengeId,
        port: remotePort,
        now: NOW,
      };
      const receipt =
        publishCompletedProtectedBaseInitialization(publicationInput);
      assert.equal(receipt.disposition, 'created');
      assert.equal(
        git(remote, ['rev-parse', 'refs/heads/main']).trim(),
        source,
      );
      assert.equal(
        git(repository, ['rev-parse', 'refs/remotes/origin/main']).trim(),
        source,
      );
      assert.equal(git(repository, ['for-each-ref', LOCAL_REF]), '');
      assert.deepEqual(
        publishCompletedProtectedBaseInitialization(publicationInput),
        receipt,
      );
    });
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

function createSelectionCoordinator(
  repository: string,
  port: ReturnType<typeof createProductionProtectedBaseSelectionPort>,
  transitionId: string = LOCAL_TRANSITION,
) {
  return createGrantCoordinatorKernel({
    randomUUID: () => crypto.randomUUID(),
    store: createFileGrantRecordStore(grantStorePaths(runtimeRoot(repository))),
    registry: createTransitionRegistry(
      protectedBaseSelectionGrantTransitionDefinitions(port),
    ),
    policy: parseGrantPolicyV2(policyInput(), {
      registry: codeOwnedApprovalModuleRegistry(),
    }),
    now: () => new Date(NOW),
    openApprovalSession(presentation) {
      const choice = presentation.choices.find(
        (candidate) => candidate.transitionId === transitionId,
      );
      assert.ok(choice, `expected explicit ${transitionId} choice`);
      return {
        async collectDecision() {
          return {
            choiceId: choice.choiceId,
            approvalMethod: 'human-presence' as const,
            reasonCode: choice.allowedReasonCodes[0]!,
            reason: choice.proposedReason,
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
              proofDigest: `sha256:${crypto.createHash('sha256').update('synthetic-test-proof').digest('hex')}`,
              verifiedAt: NOW.toISOString(),
              identity: null,
              portableEvidence: null,
            },
          ];
        },
        async close() {},
      };
    },
    async withLifecycleOperation(_challengeId, operation) {
      return operation(() => {});
    },
  });
}

function competingCommit(repository: string): string {
  return git(repository, [
    'commit-tree',
    'HEAD^{tree}',
    '-p',
    'HEAD',
    '-m',
    'Competing protected-base state',
  ]).trim();
}

async function withSelectionRepository(
  operation: (repository: string) => Promise<void>,
): Promise<void> {
  const repository = createFixtureRepository({
    initializeRemoteTrackingBase: false,
  });
  try {
    fs.writeFileSync(
      path.join(repository, 'workflow/grant-policy.json'),
      `${JSON.stringify(policyInput(), null, 2)}\n`,
    );
    git(repository, ['add', 'workflow/grant-policy.json']);
    git(repository, [
      'commit',
      '-m',
      'Configure protected-base selection Grant policy',
    ]);
    fs.mkdirSync(runtimeRoot(repository), { recursive: true, mode: 0o700 });
    await operation(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

function policyInput() {
  return {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': { requiredClaims: ['fresh-local-device-owner'] },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
  };
}
