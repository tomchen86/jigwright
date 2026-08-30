import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ensurePlainDirectory } from '../src/runtime/repository-transaction/filesystem-safety.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createGrantCoordinatorKernel,
  type GrantApprovalSession,
  type TrustedGrantPresentation,
} from '../src/modules/authority/grant-coordinator.ts';
import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import {
  codeOwnedApprovalModuleRegistry,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import {
  createGitAuthorityCandidateApplyGrantRequest,
  gitAuthorityCandidateApplyGrantTransitionDefinitions,
} from '../src/modules/authority/git-authority-candidate-apply-grant.ts';
import {
  buildImmutableGitCandidate,
  parseImmutableGitCandidate,
} from '../src/modules/authority/immutable-git-candidate.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  createProductionGitAuthorityCandidateApplyParameters,
  createProductionGitAuthorityCandidateApplyPort,
  type GitAuthorityCandidateApplyCrashPoint,
} from '../src/composition-root/git-authority-candidate-apply-production.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  readGitAuthorityCandidateApplyJournal,
  readOptionalGitAuthorityCandidateApplyJournal,
} from '../src/runtime/storage-journal/git-authority-candidate-apply-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import { createFixtureRepository, isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-31T01:00:00.000Z');
const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

type PolicyScenario =
  | 'deletion'
  | 'sealed-rollback'
  | 'immutable-path-removal'
  | 'required-check-removal';

function fixture(
  crashPoint?: GitAuthorityCandidateApplyCrashPoint,
  policyScenario: PolicyScenario = 'deletion',
) {
  const repository = fs.realpathSync(createFixtureRepository());
  const checksPath = path.join(repository, 'workflow/checks.json');
  const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
    schemaVersion: 1;
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>;
  };
  checks.checks.fixture!.command = [
    'node',
    'scripts/write-file.mjs',
    '.git/git-authority-candidate-check-ran',
  ];
  writeJson(checksPath, checks);
  git(repository, ['add', '--', 'workflow/checks.json']);
  git(repository, ['commit', '-m', 'Configure non-executed candidate check']);
  const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
  let baselinePolicy = JSON.parse(
    fs.readFileSync(policyPath, 'utf8'),
  ) as Record<string, unknown> & {
    phase: string;
    sealedImmutablePaths: string[];
    requiredChecks: string[];
  };
  if (
    policyScenario === 'sealed-rollback' ||
    policyScenario === 'immutable-path-removal'
  ) {
    baselinePolicy = {
      ...baselinePolicy,
      phase: 'sealed',
      sealedImmutablePaths: [
        ...new Set([...baselinePolicy.sealedImmutablePaths, 'workflow/**']),
      ].sort(),
    };
    writeJson(policyPath, baselinePolicy);
    git(repository, ['add', '--', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Prepare sealed policy baseline']);
  }
  const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  if (policyScenario === 'deletion') {
    fs.unlinkSync(policyPath);
  } else if (policyScenario === 'sealed-rollback') {
    writeJson(policyPath, { ...baselinePolicy, phase: 'bootstrap' });
  } else if (policyScenario === 'immutable-path-removal') {
    writeJson(policyPath, {
      ...baselinePolicy,
      sealedImmutablePaths: baselinePolicy.sealedImmutablePaths.filter(
        (value) => value !== 'workflow/**',
      ),
    });
  } else {
    writeJson(policyPath, {
      ...baselinePolicy,
      requiredChecks: baselinePolicy.requiredChecks.slice(1),
    });
  }
  const candidate = buildImmutableGitCandidate(repository, {
    targetRef: 'refs/heads/main',
    expectedOldCommit: baseCommit,
    observeCheckIds: ['fixture'],
  });
  const discovered = discoverRepository(repository);
  const lifecycleRuntime = runtimePaths(
    discovered.gitCommonDirectory,
    'workflow-engine',
  );
  const investigationRuntime = investigationRuntimePaths(
    discovered.gitCommonDirectory,
    'workflow-engine',
  );
  ensurePlainDirectory(lifecycleRuntime.root);
  const grantPaths = grantStorePaths(lifecycleRuntime.root);
  const port = createProductionGitAuthorityCandidateApplyPort(repository, {
    ...(crashPoint === undefined
      ? {}
      : {
          testAfterCrashPoint(point) {
            if (point === crashPoint) {
              throw new Error(`simulated ${point} crash`);
            }
          },
        }),
  });
  const parameters = createProductionGitAuthorityCandidateApplyParameters(
    repository,
    candidate,
    'Grant: Apply exact Central candidate',
    { now: NOW },
  );
  const definition =
    gitAuthorityCandidateApplyGrantTransitionDefinitions(port)[0]!;
  const ids = [CHALLENGE_ID, OPERATION_ID];
  const coordinator = createGrantCoordinatorKernel({
    paths: grantPaths,
    registry: createTransitionRegistry([definition]),
    policy: parseGrantPolicyV2(policyInput(), {
      registry: codeOwnedApprovalModuleRegistry(),
    }),
    now: () => new Date(NOW),
    randomUUID: () => ids.shift()!,
    challengeTtlMs: 10 * 60_000,
    openApprovalSession: successfulHumanSession,
    async withLifecycleOperation(challengeId, operation) {
      return withRepositoryLifecycleOperationAsync(
        lifecycleRuntime,
        operation,
        { allowGrantChallengeIds: [challengeId] },
      );
    },
  });
  return {
    repository,
    baseCommit,
    candidate,
    parameters,
    port,
    coordinator,
    grantPaths,
    investigationRuntime,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('real Central Grant applies policy deletion as an exact fact without a second veto or pre-Grant mutation', async () => {
  const current = fixture();
  try {
    assert.deepEqual(
      current.candidate.policyObservations.map(({ kind }) => kind),
      ['policy-file-deletion.v1'],
    );
    const before = repositorySnapshot(current.repository);
    const request = createGitAuthorityCandidateApplyGrantRequest(
      current.port,
      current.parameters,
      'Approve only this exact Git candidate.',
    );
    const challenge = await current.coordinator.requestGrant(request);
    assert.equal(challenge.challengeId, CHALLENGE_ID);
    assert.deepEqual(
      current.coordinator.inspectChallenge(CHALLENGE_ID).choices[0]
        ?.allowedApprovalMethods,
      ['human-presence', 'ssh'],
    );
    assert.deepEqual(repositorySnapshot(current.repository), before);
    assert.equal(
      fs.existsSync(
        path.join(current.repository, '.git/git-authority-candidate-check-ran'),
      ),
      false,
    );
    assert.equal(
      readOptionalGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ),
      null,
    );

    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.recovered, false);
    const commitHash = git(current.repository, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(commitHash, current.baseCommit);
    assert.equal(
      git(current.repository, ['show', '-s', '--format=%P', commitHash]).trim(),
      current.baseCommit,
    );
    assert.equal(
      git(current.repository, ['show', '-s', '--format=%T', commitHash]).trim(),
      current.candidate.resultTree,
    );
    assert.equal(
      fs.existsSync(
        path.join(current.repository, 'workflow/maintainer-policy.json'),
      ),
      false,
    );
    assert.equal(git(current.repository, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(
        path.join(current.repository, '.git/git-authority-candidate-check-ran'),
      ),
      false,
    );

    const journal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    assert.deepEqual(
      journal.entries.map(({ phase }) => phase),
      [
        'prepared',
        'index-published',
        'commit-created',
        'ref-update-prepared',
        'ref-updated',
        'completed',
      ],
    );
    assert.equal(journal.approvalMethod, 'human-presence');
    assert.equal(journal.preparedGrantRecordDigest.startsWith('sha256:'), true);
    const terminal = readGrantRecord(current.grantPaths, CHALLENGE_ID);
    assert.equal(terminal.state, 'completed');
    if (terminal.state !== 'completed') assert.fail('expected completed Grant');
    assert.equal(terminal.audit.approvalMethod, 'human-presence');
    assert.equal(terminal.proofModules[0]?.portableEvidence, null);
    assert.equal(
      terminal.outcome.details instanceof Object &&
        (terminal.outcome.details as { preparedGrantRecordDigest?: string })
          .preparedGrantRecordDigest,
      journal.preparedGrantRecordDigest,
    );

    const duplicate = await current.coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(duplicate.outcome, 'completed');
    assert.equal(
      git(current.repository, ['rev-parse', 'HEAD']).trim(),
      commitHash,
    );
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).journalDigest,
      journal.journalDigest,
    );
  } finally {
    current.dispose();
  }
});

test('Central Grant applies sealed rollback, immutable-path removal, and required-check removal as exact facts', async () => {
  const scenarios: ReadonlyArray<readonly [PolicyScenario, string]> = [
    ['sealed-rollback', 'policy-sealed-phase-rollback.v1'],
    ['immutable-path-removal', 'policy-sealed-immutable-path-removal.v1'],
    ['required-check-removal', 'policy-required-check-removal.v1'],
  ];
  for (const [scenario, observationKind] of scenarios) {
    const current = fixture(undefined, scenario);
    try {
      assert.equal(
        current.candidate.policyObservations.some(
          ({ kind }) => kind === observationKind,
        ),
        true,
        scenario,
      );
      await current.coordinator.requestGrant(
        createGitAuthorityCandidateApplyGrantRequest(
          current.port,
          current.parameters,
          `Approve exact ${scenario} candidate facts.`,
        ),
      );
      const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
      assert.equal(result.outcome, 'completed', scenario);
      assert.equal(git(current.repository, ['status', '--porcelain']), '');
      assert.equal(
        readGitAuthorityCandidateApplyJournal(
          current.investigationRuntime,
          OPERATION_ID,
        ).entries.at(-1)?.phase,
        'completed',
        scenario,
      );
    } finally {
      current.dispose();
    }
  }
});

test('durable exact Apply recovers every effect crash window without duplicate commits or result rewriting', async () => {
  for (const crashPoint of [
    'prepared',
    'index-publication',
    'commit-object',
    'ref-update',
    'terminal',
  ] as const) {
    const current = fixture(crashPoint);
    try {
      await current.coordinator.requestGrant(
        createGitAuthorityCandidateApplyGrantRequest(
          current.port,
          current.parameters,
          `Approve exact candidate before ${crashPoint} recovery.`,
        ),
      );
      await assert.rejects(
        current.coordinator.resolveChallenge(CHALLENGE_ID),
        new RegExp(`simulated ${crashPoint} crash`),
      );
      assert.equal(
        readGrantRecord(current.grantPaths, CHALLENGE_ID).state,
        'prepared',
      );

      const recoveryPort = createProductionGitAuthorityCandidateApplyPort(
        current.repository,
      );
      const recoveryCoordinator = createGrantCoordinatorKernel({
        paths: current.grantPaths,
        registry: createTransitionRegistry(
          gitAuthorityCandidateApplyGrantTransitionDefinitions(recoveryPort),
        ),
        policy: parseGrantPolicyV2(policyInput(), {
          registry: codeOwnedApprovalModuleRegistry(),
        }),
        now: () => new Date(NOW),
        randomUUID: () => crypto.randomUUID(),
        openApprovalSession: successfulHumanSession,
        async withLifecycleOperation(challengeId, operation) {
          const discovered = discoverRepository(current.repository);
          return withRepositoryLifecycleOperationAsync(
            runtimePaths(discovered.gitCommonDirectory, 'workflow-engine'),
            operation,
            { allowGrantChallengeIds: [challengeId] },
          );
        },
      });
      const recovered =
        await recoveryCoordinator.recoverChallenge(CHALLENGE_ID);
      assert.equal(recovered.outcome, 'completed', crashPoint);
      assert.equal(recovered.recovered, true, crashPoint);
      const commitHash = git(current.repository, ['rev-parse', 'HEAD']).trim();
      assert.equal(
        git(current.repository, [
          'rev-list',
          '--count',
          `${current.baseCommit}..HEAD`,
        ]).trim(),
        '1',
        crashPoint,
      );
      const journal = readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      );
      assert.equal(journal.entries.at(-1)?.phase, 'completed', crashPoint);
      assert.equal(journal.entries.at(-1)?.commitHash, commitHash, crashPoint);
      const repeated = await recoveryCoordinator.recoverChallenge(CHALLENGE_ID);
      assert.equal(repeated.outcome, 'completed', crashPoint);
      assert.equal(
        git(current.repository, ['rev-parse', 'HEAD']).trim(),
        commitHash,
      );
    } finally {
      current.dispose();
    }
  }
});

test('prepared Apply records branch CAS drift as a natural failed result without overwriting the foreign ref', async () => {
  const current = fixture('prepared');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve the exact candidate before branch CAS.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated prepared crash/,
    );
    const baseTree = git(current.repository, [
      'show',
      '-s',
      '--format=%T',
      current.baseCommit,
    ]).trim();
    const foreignCommit = git(current.repository, [
      'commit-tree',
      baseTree,
      '-p',
      current.baseCommit,
      '-m',
      'Foreign branch advance',
    ]).trim();
    git(current.repository, [
      'update-ref',
      'refs/heads/main',
      foreignCommit,
      current.baseCommit,
    ]);

    const recoveryPort = createProductionGitAuthorityCandidateApplyPort(
      current.repository,
    );
    const recoveryCoordinator = createGrantCoordinatorKernel({
      paths: current.grantPaths,
      registry: createTransitionRegistry(
        gitAuthorityCandidateApplyGrantTransitionDefinitions(recoveryPort),
      ),
      policy: parseGrantPolicyV2(policyInput(), {
        registry: codeOwnedApprovalModuleRegistry(),
      }),
      now: () => new Date(NOW),
      randomUUID: () => crypto.randomUUID(),
      openApprovalSession: successfulHumanSession,
      async withLifecycleOperation(challengeId, operation) {
        const discovered = discoverRepository(current.repository);
        return withRepositoryLifecycleOperationAsync(
          runtimePaths(discovered.gitCommonDirectory, 'workflow-engine'),
          operation,
          { allowGrantChallengeIds: [challengeId] },
        );
      },
    });
    const recovered = await recoveryCoordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'failed');
    assert.equal(recovered.recovered, true);
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      foreignCommit,
    );
    const journal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    assert.equal(journal.entries.at(-1)?.phase, 'failed');
    assert.equal(
      journal.entries.at(-1)?.failure?.code,
      'git-authority-candidate-apply-ref-changed',
    );
    const terminal = readGrantRecord(current.grantPaths, CHALLENGE_ID);
    assert.equal(terminal.state, 'failed');
    const duplicate = await recoveryCoordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(duplicate.outcome, 'failed');
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).journalDigest,
      journal.journalDigest,
    );
  } finally {
    current.dispose();
  }
});

test('forged check observations and post-challenge Git drift fail closed without an Apply journal or Git publication', async () => {
  const forgedFixture = fixture();
  try {
    const forged = structuredClone(
      forgedFixture.candidate,
    ) as unknown as Record<string, unknown> & {
      checkObservations: Array<Record<string, unknown>>;
      checkObservationsDigest: string;
      candidateDigest: string;
    };
    const check = forged.checkObservations[0]!;
    check.runnerDigest = '0'.repeat(64);
    const checkBody = { ...check };
    delete checkBody.observationDigest;
    check.observationDigest = sha256(canonicalJson(checkBody));
    forged.checkObservationsDigest = sha256(
      canonicalJson(forged.checkObservations),
    );
    const { candidateDigest: _candidateDigest, ...candidateBody } = forged;
    forged.candidateDigest = sha256(canonicalJson(candidateBody));
    const parsedForgery = parseImmutableGitCandidate(
      `${canonicalJson(forged)}\n`,
    );
    const forgedParameters =
      createProductionGitAuthorityCandidateApplyParameters(
        forgedFixture.repository,
        parsedForgery,
        'Apply forged candidate',
        { now: NOW },
      );
    const before = repositorySnapshot(forgedFixture.repository);
    assert.throws(
      () =>
        createGitAuthorityCandidateApplyGrantRequest(
          forgedFixture.port,
          forgedParameters,
          'This forged check observation must not be grantable.',
        ),
      (error) => isWorkflowError(error, 'IMMUTABLE_GIT_CANDIDATE_DRIFT'),
    );
    assert.deepEqual(repositorySnapshot(forgedFixture.repository), before);
    assert.equal(
      fs.existsSync(
        path.join(
          forgedFixture.investigationRuntime.root,
          'git-authority-candidate-apply-v1',
        ),
      ),
      false,
    );
  } finally {
    forgedFixture.dispose();
  }

  const driftFixture = fixture();
  try {
    await driftFixture.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        driftFixture.port,
        driftFixture.parameters,
        'Approve the exact candidate before any drift.',
      ),
    );
    const beforeRef = git(driftFixture.repository, [
      'rev-parse',
      'refs/heads/main',
    ]).trim();
    const beforeIndex = git(driftFixture.repository, ['write-tree']).trim();
    fs.appendFileSync(
      path.join(driftFixture.repository, 'workflow/checks.json'),
      '\n',
    );
    await assert.rejects(
      driftFixture.coordinator.resolveChallenge(CHALLENGE_ID),
      (error) => isWorkflowError(error, 'IMMUTABLE_GIT_CANDIDATE_DRIFT'),
    );
    assert.equal(
      readGrantRecord(driftFixture.grantPaths, CHALLENGE_ID).state,
      'pending',
    );
    assert.equal(
      git(driftFixture.repository, ['rev-parse', 'refs/heads/main']).trim(),
      beforeRef,
    );
    assert.equal(
      git(driftFixture.repository, ['write-tree']).trim(),
      beforeIndex,
    );
    assert.equal(
      readOptionalGitAuthorityCandidateApplyJournal(
        driftFixture.investigationRuntime,
        OPERATION_ID,
      ),
      null,
    );
  } finally {
    driftFixture.dispose();
  }
});

function successfulHumanSession(
  presentation: TrustedGrantPresentation,
): GrantApprovalSession {
  return Object.freeze({
    async collectDecision() {
      return {
        choiceId: presentation.choices[0]!.choiceId,
        approvalMethod: 'human-presence' as const,
        reasonCode: 'approve-exact-git-authority-candidate',
        reason: 'Approve only the exact immutable Git candidate.',
        sessionNonce: 'nonce-git-authority-apply-000000000000000001',
      };
    },
    async authenticate({ approvalSubjectDigest }) {
      return [humanProof(approvalSubjectDigest)];
    },
    async close() {},
  });
}

function humanProof(subjectDigest: `sha256:${string}`): VerifiedApprovalProof {
  return Object.freeze({
    moduleId: 'human-gate-macos',
    version: '1',
    claims: Object.freeze(['fresh-local-device-owner'] as const),
    approvalSubjectDigest: subjectDigest,
    proofDigest: `sha256:${'4'.repeat(64)}` as const,
    verifiedAt: NOW.toISOString(),
    identity: null,
    portableEvidence: null,
  });
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

function repositorySnapshot(repository: string) {
  return {
    refs: git(repository, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]),
    indexTree: git(repository, ['write-tree']).trim(),
    status: git(repository, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]),
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
