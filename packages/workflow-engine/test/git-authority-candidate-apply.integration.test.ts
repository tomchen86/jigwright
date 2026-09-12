import {
  createProductionCentralGrantRequestPort,
  createProductionWorkflowGrantCoordinator,
} from '../bootstrap/session-lifecycle-production.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
  parseGrantPolicyV2Document,
  type GrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import {
  approvalSubjectDigest,
  createApprovalSubject,
} from '../src/modules/authority/grant-core.ts';
import { collectSshApprovalProof } from '../src/adapters/signing/ssh/grant-proof-ssh.ts';
import type { MaintainerSignerProvider } from '../src/modules/authority/maintainer-signer-port.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  createGitAuthorityCandidateApplyGrantRequest,
  gitAuthorityCandidateApplyGrantTransitionDefinitions,
} from '../src/modules/authority/git-authority-candidate-apply-grant.ts';
import {
  buildImmutableGitCandidate,
  parseImmutableGitCandidate,
} from '../src/composition-root/immutable-git-candidate-production.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  createProductionGitAuthorityCandidateApplyParameters,
  createProductionGitAuthorityCandidateApplyPort,
  readProductionGitAuthorityCandidateBaseGrantPolicyDocument,
  type GitAuthorityCandidateApplyCrashPoint,
} from '../src/composition-root/git-authority-candidate-apply-production.ts';
import {
  listVerifiedGitAuthorityCandidateApplyReceipts,
  publishGitAuthorityCandidateApplyReceipt,
  readVerifiedGitAuthorityCandidateApplyReceipt,
} from '../src/composition-root/git-authority-candidate-apply-receipt-production.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/storage-journal/grant-store.ts';
import { grantRecordDigest } from '../src/modules/authority/grant-records.ts';
import {
  readGitAuthorityCandidateApplyJournal,
  readOptionalGitAuthorityCandidateApplyJournal,
} from '../src/runtime/storage-journal/git-authority-candidate-apply-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import {
  createProductionGitAuthorityCandidateApplyGrantCoordinator,
  createProductionGrantCoordinator,
} from '../src/composition-root/grant-production.ts';
import { createFixtureRepository, isWorkflowError } from './fixture.ts';
import {
  createSshSignedFixture,
  type SshSignedFixture,
} from './support/ssh-signed-fixture.ts';

const NOW = new Date('2026-08-30T00:00:00.000Z');
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
  includeCrossPlanePaths = false,
  addCandidateControlledGrantSigner = false,
  resultConfig: 'unchanged' | 'runtime-changed' | 'deleted' = 'unchanged',
  baseSshAuthority = false,
  testBeforeIndexPublicationLock?: () => void,
  testAfterIndexPublicationLock?: () => void,
  sshSigning?: SshSignedFixture,
  observedSshNamespaces?: string[],
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
  writeJson(
    path.join(repository, 'workflow/grant-policy.json'),
    baseSshAuthority
      ? baseSshGrantPolicyInput(sshSigning?.trustedSigner)
      : policyInput(),
  );
  git(repository, ['add', '--', 'workflow/checks.json']);
  git(repository, ['add', '--', 'workflow/grant-policy.json']);
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
  if (addCandidateControlledGrantSigner) {
    writeJson(
      path.join(repository, 'workflow/grant-policy.json'),
      attackerGrantPolicyInput(),
    );
  }
  const workflowConfigPath = path.join(repository, 'workflow/config.json');
  if (resultConfig === 'deleted') {
    fs.unlinkSync(workflowConfigPath);
  } else if (resultConfig === 'runtime-changed') {
    const config = JSON.parse(
      fs.readFileSync(workflowConfigPath, 'utf8'),
    ) as Record<string, unknown>;
    writeJson(workflowConfigPath, {
      ...config,
      runtimeDirectory: 'candidate-selected-runtime',
    });
  }
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
  if (includeCrossPlanePaths) {
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src/\ue000.txt'), 'bmp-private\n');
    fs.writeFileSync(
      path.join(repository, 'src/\ud83d\ude00.txt'),
      'supplementary\n',
    );
  }
  const candidate = buildImmutableGitCandidate(repository, {
    targetRef: 'refs/heads/main',
    expectedOldCommit: baseCommit,
    observeCheckIds: ['fixture'],
  });
  const indexPath = git(repository, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  ]).trim();
  const indexMode = fs.statSync(indexPath).mode & 0o7777;
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
    ...(testBeforeIndexPublicationLock === undefined
      ? {}
      : { testBeforeIndexPublicationLock }),
    ...(testAfterIndexPublicationLock === undefined
      ? {}
      : { testAfterIndexPublicationLock }),
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
  const coordinatorPolicy = parseGrantPolicyV2(
    baseSshAuthority
      ? baseSshGrantPolicyInput(sshSigning?.trustedSigner)
      : policyInput(),
    {
      registry: codeOwnedApprovalModuleRegistry(),
    },
  );
  const coordinator = createGrantCoordinatorKernel({
    store: createFileGrantRecordStore(grantPaths),
    registry: createTransitionRegistry([definition]),
    policy: coordinatorPolicy,
    now: () => new Date(NOW),
    randomUUID: () => ids.shift()!,
    challengeTtlMs: 10 * 60_000,
    openApprovalSession:
      sshSigning === undefined
        ? successfulHumanSession
        : (presentation) =>
            successfulSshSession(
              presentation,
              coordinatorPolicy,
              sshSigning.signer(observedSshNamespaces),
            ),
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
    indexPath,
    indexMode,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

test('production Central Grant authenticates an Apply candidate against its exact base policy', async () => {
  const current = fixture(undefined, 'deletion', false, true);
  try {
    assert.deepEqual(
      (
        JSON.parse(
          git(current.repository, [
            'show',
            `${current.baseCommit}:workflow/grant-policy.json`,
          ]),
        ) as { profiles: Record<string, unknown> }
      ).profiles,
      { 'local-presence': { requiredClaims: ['fresh-local-device-owner'] } },
    );
    assert.equal(
      (
        JSON.parse(
          fs.readFileSync(
            path.join(current.repository, 'workflow/grant-policy.json'),
            'utf8',
          ),
        ) as { optionalSsh?: unknown }
      ).optionalSsh !== undefined,
      true,
    );
    const before = repositorySnapshot(current.repository);
    const production =
      createProductionGitAuthorityCandidateApplyGrantCoordinator(
        current.repository,
        current.parameters,
      );
    const requested = await production.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'The candidate-controlled signer must not become authority.',
      ),
    );
    assert.deepEqual(
      production.inspectChallenge(requested.challengeId).approvalMethods,
      ['human-presence'],
    );
    assert.deepEqual(repositorySnapshot(current.repository), before);
    assert.equal(
      readOptionalGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ),
      null,
    );
  } finally {
    current.dispose();
  }
});

test('production base authority ignores real Git replacement refs', async () => {
  const current = fixture(
    undefined,
    'deletion',
    false,
    true,
    'runtime-changed',
  );
  try {
    const replacementCommit = git(current.repository, [
      'commit-tree',
      current.candidate.resultTree,
      '-m',
      'Attacker replacement authority context',
    ]).trim();
    git(current.repository, ['replace', current.baseCommit, replacementCommit]);
    assert.equal(
      (
        JSON.parse(
          git(current.repository, [
            'show',
            `${current.baseCommit}:workflow/config.json`,
          ]),
        ) as { runtimeDirectory: string }
      ).runtimeDirectory,
      'candidate-selected-runtime',
    );
    assert.equal(
      (
        JSON.parse(
          git(current.repository, [
            'show',
            `${current.baseCommit}:workflow/grant-policy.json`,
          ]),
        ) as { optionalSsh?: unknown }
      ).optionalSsh !== undefined,
      true,
    );

    const replacementBoundCandidate = buildImmutableGitCandidate(
      current.repository,
      {
        targetRef: 'refs/heads/main',
        expectedOldCommit: current.baseCommit,
        observeCheckIds: ['fixture'],
      },
    );
    const parameters = createProductionGitAuthorityCandidateApplyParameters(
      current.repository,
      replacementBoundCandidate,
      'Grant: Reject replacement authority',
      { now: NOW },
    );
    assert.equal(
      parameters.baseAuthorityContext.workflowConfig.runtimeDirectory,
      'workflow-engine',
    );
    const port = createProductionGitAuthorityCandidateApplyPort(
      current.repository,
    );
    const production =
      createProductionGitAuthorityCandidateApplyGrantCoordinator(
        current.repository,
        parameters,
      );
    const requested = await production.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        port,
        parameters,
        'Replacement-provided signer and runtime must not become authority.',
      ),
    );
    assert.deepEqual(
      production.inspectChallenge(requested.challengeId).approvalMethods,
      ['human-presence'],
    );
    assert.equal(
      createFileGrantRecordStore(current.grantPaths).readGrantRecord(
        requested.challengeId,
      ).state,
      'pending',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          current.repository,
          '.git/candidate-selected-runtime/grants-v2',
        ),
      ),
      false,
    );
  } finally {
    current.dispose();
  }
});

test('production SSH proof rejects a signer added only by the candidate result', async () => {
  const current = fixture(
    undefined,
    'deletion',
    false,
    true,
    'unchanged',
    true,
  );
  try {
    const production =
      createProductionGitAuthorityCandidateApplyGrantCoordinator(
        current.repository,
        current.parameters,
      );
    const requested = await production.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Only a signer trusted by the base policy may approve.',
      ),
    );
    const presentation = production.inspectChallenge(requested.challengeId);
    assert.deepEqual(presentation.approvalMethods, ['human-presence', 'ssh']);
    const subject = createApprovalSubject(
      presentation.challenge,
      {
        choiceId: presentation.choices[0]!.choiceId,
        approvalMethod: 'ssh',
        reasonCode: 'approve-exact-git-authority-candidate',
        reason: 'Attempt candidate-controlled SSH authority.',
        sessionNonce: 'nonce-candidate-attacker-000000000000000001',
      },
      { now: new Date(presentation.challenge.issuedAt) },
    );
    const policy = parseGrantPolicyV2Document(
      readProductionGitAuthorityCandidateBaseGrantPolicyDocument(
        current.repository,
        current.parameters,
      ),
    ).policy;
    let signed = false;
    assert.throws(
      () =>
        collectSshApprovalProof(
          policy,
          {
            approvalSubject: subject,
            approvalSubjectDigest: approvalSubjectDigest(subject),
          },
          {
            now: new Date(presentation.challenge.issuedAt),
            signer: {
              assertHumanPresent() {},
              identity: () => 'candidate-attacker',
              sign() {
                signed = true;
                return 'candidate-controlled-signature';
              },
              verify() {},
            },
          },
        ),
      (error) => isWorkflowError(error, 'GRANT_SSH_PROOF_INVALID'),
    );
    assert.equal(signed, false);
    assert.equal(
      readOptionalGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ),
      null,
    );
  } finally {
    current.dispose();
  }
});

test('ordinary production coordinator ignores dirty Grant policy and runtime redirection', async () => {
  const current = fixture(
    undefined,
    'deletion',
    false,
    true,
    'runtime-changed',
  );
  try {
    const production = createProductionGrantCoordinator(
      current.repository,
      createTransitionRegistry(
        gitAuthorityCandidateApplyGrantTransitionDefinitions(current.port),
      ),
    );
    const requested = await production.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Dirty authority configuration must remain a fact only.',
      ),
    );
    assert.deepEqual(
      production.inspectChallenge(requested.challengeId).approvalMethods,
      ['human-presence'],
    );
    assert.equal(
      createFileGrantRecordStore(current.grantPaths).readGrantRecord(
        requested.challengeId,
      ).state,
      'pending',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          current.repository,
          '.git/candidate-selected-runtime/grants-v2',
        ),
      ),
      false,
    );
  } finally {
    current.dispose();
  }
});

test('generic Central production coordinators omit the optional Collaboration package veto', () => {
  assert.doesNotMatch(
    createProductionGrantCoordinator.toString(),
    /assertOptionalGrantsPackageAvailable/u,
  );
  assert.doesNotMatch(
    createProductionGitAuthorityCandidateApplyGrantCoordinator.toString(),
    /assertOptionalGrantsPackageAvailable/u,
  );
  assert.doesNotMatch(
    createProductionWorkflowGrantCoordinator.toString(),
    /assertOptionalGrantsPackageAvailable/u,
  );
  assert.doesNotMatch(
    createProductionCentralGrantRequestPort.toString(),
    /assertOptionalGrantsPackageAvailable/u,
  );
});

test('Central Apply remains pre-cutover with no repository journal artifacts', () => {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  const repository = discoverRepository(workspaceRoot);
  const config = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, 'workflow/config.json'), 'utf8'),
  ) as { runtimeDirectory: string };
  for (const storeName of [
    'git-authority-candidate-apply-v1',
    'git-authority-candidate-apply-v2',
  ]) {
    assert.equal(
      fs.existsSync(
        path.join(
          repository.gitCommonDirectory,
          config.runtimeDirectory,
          storeName,
        ),
      ),
      false,
      storeName,
    );
  }
  const ciDirectory = path.join(
    workspaceRoot,
    'packages/workflow-engine/src/entrypoints/ci',
  );
  const cutoverSources = [
    path.join(
      workspaceRoot,
      'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
    ),
    ...fs
      .readdirSync(ciDirectory)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => path.join(ciDirectory, entry)),
  ]
    .map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    cutoverSources,
    /createProductionGitAuthorityCandidateApplyGrantCoordinator|git\.authority-candidate\.apply\.v1/u,
  );
});

test('Apply parameters reject digest-self-consistent unsafe base runtime paths', () => {
  const current = fixture();
  try {
    for (const runtimeDirectory of [
      'foo/./bar',
      '.git/authority',
      './workflow-engine',
      'workflow-*',
      'C:\\workflow-engine',
      ' workflow-engine',
      'workflow-engine\u0000tail',
    ]) {
      const forged = structuredClone(current.parameters) as unknown as Record<
        string,
        unknown
      > & {
        baseAuthorityContext: Record<string, unknown> & {
          workflowConfig: Record<string, unknown>;
          contextDigest: string;
        };
      };
      forged.baseAuthorityContext.workflowConfig.runtimeDirectory =
        runtimeDirectory;
      const { contextDigest: _contextDigest, ...body } =
        forged.baseAuthorityContext;
      forged.baseAuthorityContext.contextDigest = sha256(
        `workflow.git-authority-candidate-base-authority-context.v1\n${canonicalJson(
          body,
        )}`,
      );
      assert.throws(
        () => assertGitAuthorityCandidateApplyParameters(forged),
        (error) =>
          isWorkflowError(
            error,
            'GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETERS_INVALID',
          ),
        runtimeDirectory,
      );
    }
  } finally {
    current.dispose();
  }
});

test('Apply authority context rejects a symlink Grant policy in the exact base commit', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  try {
    const grantPolicyPath = path.join(repository, 'workflow/grant-policy.json');
    fs.symlinkSync('../candidate-controlled-policy.json', grantPolicyPath);
    git(repository, ['add', '--', 'workflow/grant-policy.json']);
    git(repository, ['commit', '-m', 'Commit unsafe Grant policy link']);
    const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.unlinkSync(path.join(repository, 'workflow/maintainer-policy.json'));
    const candidate = buildImmutableGitCandidate(repository, {
      targetRef: 'refs/heads/main',
      expectedOldCommit: baseCommit,
    });
    const before = repositorySnapshot(repository);
    assert.throws(
      () =>
        createProductionGitAuthorityCandidateApplyParameters(
          repository,
          candidate,
          'Reject unsafe base Grant policy mode',
          { now: NOW },
        ),
      (error) =>
        isWorkflowError(
          error,
          'GIT_AUTHORITY_CANDIDATE_APPLY_AUTHORITY_CONTEXT_CHANGED',
        ),
    );
    assert.deepEqual(repositorySnapshot(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

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
      fs.statSync(current.indexPath).mode & 0o7777,
      current.indexMode,
    );
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
        'commit-created',
        'ref-update-prepared',
        'ref-updated',
        'index-published',
        'completed',
      ],
    );
    assert.equal(journal.approvalMethod, 'human-presence');
    assert.equal(journal.preparedGrantRecordDigest.startsWith('sha256:'), true);
    const terminal = createFileGrantRecordStore(
      current.grantPaths,
    ).readGrantRecord(CHALLENGE_ID);
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

test('human-presence Central Apply is explicitly non-portable without a receipt mutation', async () => {
  const current = fixture();
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Complete locally without inventing portable SSH evidence.',
      ),
    );
    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'completed');
    const before = repositorySnapshot(current.repository);
    assert.throws(
      () =>
        publishGitAuthorityCandidateApplyReceipt(
          current.repository,
          current.parameters,
          CHALLENGE_ID,
        ),
      (error) =>
        isWorkflowError(
          error,
          'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_NON_PORTABLE',
        ),
    );
    assert.deepEqual(repositorySnapshot(current.repository), before);
    assert.equal(
      git(current.repository, [
        'for-each-ref',
        '--format=%(objectname)',
        `refs/tags/workflow-central-grant/${CHALLENGE_ID}`,
      ]).trim(),
      '',
    );
  } finally {
    current.dispose();
  }
});

test('real SSH Central Apply publishes one canonical receipt that verifies in a fresh clone', async () => {
  const ssh = createSshSignedFixture('central-receipt-maintainer');
  const observedSshNamespaces: string[] = [];
  const current = fixture(
    undefined,
    'deletion',
    false,
    false,
    'unchanged',
    true,
    undefined,
    undefined,
    ssh,
    observedSshNamespaces,
  );
  const cloneRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'central-receipt-clone-'),
  );
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Publish the exact SSH-authorized Central receipt.',
      ),
    );
    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'completed');
    const beforeBranch = git(current.repository, [
      'rev-parse',
      'refs/heads/main',
    ]).trim();
    const beforeIndex = git(current.repository, ['write-tree']).trim();
    const beforeStatus = git(current.repository, ['status', '--porcelain']);
    const published = publishGitAuthorityCandidateApplyReceipt(
      current.repository,
      current.parameters,
      CHALLENGE_ID,
    );
    assert.equal(published.targetCommit, beforeBranch);
    assert.equal(published.receipt.approvalMethod, 'ssh');
    assert.deepEqual(observedSshNamespaces, [
      'jigwright.workflow.grant-proof.v1',
      'jigwright.workflow.grant-proof.v1',
    ]);
    assert.equal(
      published.receipt.terminalGrantRecordDigest,
      grantRecordDigest(
        createFileGrantRecordStore(current.grantPaths).readGrantRecord(
          CHALLENGE_ID,
        ),
      ),
    );
    assert.deepEqual(
      publishGitAuthorityCandidateApplyReceipt(
        current.repository,
        current.parameters,
        CHALLENGE_ID,
      ),
      published,
    );
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      beforeBranch,
    );
    assert.equal(git(current.repository, ['write-tree']).trim(), beforeIndex);
    assert.equal(
      git(current.repository, ['status', '--porcelain']),
      beforeStatus,
    );

    const clone = path.join(cloneRoot, 'clone');
    git(current.repository, [
      'clone',
      '--quiet',
      '--no-local',
      current.repository,
      clone,
    ]);
    const verified = readVerifiedGitAuthorityCandidateApplyReceipt(
      clone,
      CHALLENGE_ID,
    );
    assert.equal(verified.tagObject, published.tagObject);
    assert.deepEqual(verified.receipt, published.receipt);
    assert.deepEqual(listVerifiedGitAuthorityCandidateApplyReceipts(clone), [
      verified,
    ]);
    assert.equal(git(clone, ['status', '--porcelain']), '');

    const tagRef = `refs/tags/workflow-central-grant/${CHALLENGE_ID}`;
    const originalTag = git(clone, ['rev-parse', `${tagRef}^{tag}`]).trim();
    const rawTag = git(clone, ['cat-file', 'tag', originalTag]);
    const boundary = rawTag.indexOf('\n\n');
    assert.notEqual(boundary, -1);
    const originalReceipt = JSON.parse(rawTag.slice(boundary + 2)) as Record<
      string,
      unknown
    >;
    const tamperCases: Array<
      readonly [string, (value: Record<string, unknown>) => void]
    > = [
      [
        'candidate digest',
        (value) => {
          value.candidateDigest = `sha256:${'f'.repeat(64)}`;
        },
      ],
      [
        'challenge digest',
        (value) => {
          value.challengeDigest = `sha256:${'d'.repeat(64)}`;
        },
      ],
      [
        'operation poststate digest',
        (value) => {
          value.poststateDigest = `sha256:${'c'.repeat(64)}`;
        },
      ],
      [
        'raw payload',
        (value) => {
          portableEvidence(value).payload += ' ';
        },
      ],
      [
        'raw signature',
        (value) => {
          portableEvidence(value).signature += 'tamper';
        },
      ],
      [
        'raw namespace',
        (value) => {
          portableEvidence(value).signatureNamespace =
            'jigwright.workflow.other.v1';
        },
      ],
      [
        'raw identity',
        (value) => {
          portableEvidence(value).identity = 'other-maintainer';
        },
      ],
      [
        'raw verification time',
        (value) => {
          portableEvidence(value).verifiedAt = '2026-08-30T00:00:01.000Z';
        },
      ],
      [
        'terminal record',
        (value) => {
          terminalRecord(value).completedAt = '2026-08-30T00:00:01.000Z';
        },
      ],
      [
        'Apply journal',
        (value) => {
          journalRecord(value).journalDigest = `sha256:${'e'.repeat(64)}`;
        },
      ],
    ];
    for (const [name, mutate] of tamperCases) {
      const tampered = structuredClone(originalReceipt);
      mutate(tampered);
      replaceAnnotatedTag(
        clone,
        tagRef,
        `${rawTag.slice(0, boundary + 2)}${canonicalJson(tampered)}\n`,
      );
      assert.throws(
        () =>
          readVerifiedGitAuthorityCandidateApplyReceipt(clone, CHALLENGE_ID),
        (error) =>
          isWorkflowError(
            error,
            'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID',
          ),
        name,
      );
      git(clone, ['update-ref', '--no-deref', tagRef, originalTag]);
    }

    replaceAnnotatedTag(
      clone,
      tagRef,
      rawTag.replace(
        `object ${published.targetCommit}\n`,
        `object ${current.baseCommit}\n`,
      ),
    );
    assert.throws(
      () => readVerifiedGitAuthorityCandidateApplyReceipt(clone, CHALLENGE_ID),
      (error) =>
        isWorkflowError(error, 'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID'),
      'tag target',
    );
    git(clone, ['update-ref', '--no-deref', tagRef, originalTag]);

    const replacement = git(clone, [
      'commit-tree',
      current.candidate.resultTree,
      '-m',
      'Replacement policy and config must not affect verification',
    ]).trim();
    git(clone, ['replace', current.baseCommit, replacement]);
    assert.equal(
      readVerifiedGitAuthorityCandidateApplyReceipt(clone, CHALLENGE_ID)
        .tagObject,
      originalTag,
    );
    git(clone, ['update-ref', '-d', tagRef]);
    git(clone, ['symbolic-ref', tagRef, 'refs/heads/main']);
    assert.throws(
      () => readVerifiedGitAuthorityCandidateApplyReceipt(clone, CHALLENGE_ID),
      (error) =>
        isWorkflowError(error, 'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID'),
      'symbolic tag ref',
    );
    git(clone, ['symbolic-ref', '--delete', tagRef]);
    git(clone, ['update-ref', '--no-deref', tagRef, originalTag]);
  } finally {
    current.dispose();
    ssh.dispose();
    fs.rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test('SSH receipt publication recovers both tag object and ref crash windows', async () => {
  for (const crashPoint of ['object', 'ref'] as const) {
    const ssh = createSshSignedFixture(`central-receipt-${crashPoint}`);
    const current = fixture(
      undefined,
      'deletion',
      false,
      false,
      'unchanged',
      true,
      undefined,
      undefined,
      ssh,
    );
    try {
      await current.coordinator.requestGrant(
        createGitAuthorityCandidateApplyGrantRequest(
          current.port,
          current.parameters,
          `Create the exact ${crashPoint} receipt crash window.`,
        ),
      );
      await current.coordinator.resolveChallenge(CHALLENGE_ID);
      assert.throws(
        () =>
          publishGitAuthorityCandidateApplyReceipt(
            current.repository,
            current.parameters,
            CHALLENGE_ID,
            crashPoint === 'object'
              ? {
                  testAfterTagObject: () => {
                    throw new Error('object crash');
                  },
                }
              : {
                  testAfterTagRefUpdate: () => {
                    throw new Error('ref crash');
                  },
                },
          ),
        new RegExp(`${crashPoint} crash`, 'u'),
      );
      const tagRef = `refs/tags/workflow-central-grant/${CHALLENGE_ID}`;
      assert.equal(
        git(current.repository, [
          'for-each-ref',
          '--format=%(objectname)',
          tagRef,
        ]).trim() !== '',
        crashPoint === 'ref',
      );
      assert.doesNotThrow(() =>
        publishGitAuthorityCandidateApplyReceipt(
          current.repository,
          current.parameters,
          CHALLENGE_ID,
        ),
      );
    } finally {
      current.dispose();
      ssh.dispose();
    }
  }
});

test('foreign Central receipt tag is preserved and rejected', async () => {
  const ssh = createSshSignedFixture('central-receipt-foreign');
  const current = fixture(
    undefined,
    'deletion',
    false,
    false,
    'unchanged',
    true,
    undefined,
    undefined,
    ssh,
  );
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Reject a foreign receipt ref without overwriting it.',
      ),
    );
    await current.coordinator.resolveChallenge(CHALLENGE_ID);
    const tagRef = `refs/tags/workflow-central-grant/${CHALLENGE_ID}`;
    git(current.repository, ['update-ref', tagRef, current.baseCommit]);
    assert.throws(
      () =>
        publishGitAuthorityCandidateApplyReceipt(
          current.repository,
          current.parameters,
          CHALLENGE_ID,
        ),
      (error) =>
        isWorkflowError(
          error,
          'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_CONFLICT',
        ),
    );
    assert.equal(
      git(current.repository, ['rev-parse', '--verify', tagRef]).trim(),
      current.baseCommit,
    );
  } finally {
    current.dispose();
    ssh.dispose();
  }
});

test('Apply refuses an unsafe executable Git index mode before publishing a ref effect', async () => {
  const current = fixture();
  try {
    const unsafeMode = 0o755;
    fs.chmodSync(current.indexPath, unsafeMode);
    const beforeIndex = fs.readFileSync(current.indexPath);

    assert.throws(
      () =>
        createGitAuthorityCandidateApplyGrantRequest(
          current.port,
          current.parameters,
          'An unsafe index mode must fail before the exact ref consequence.',
        ),
      (error) =>
        isWorkflowError(error, 'GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED'),
    );
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      current.baseCommit,
    );
    assert.deepEqual(fs.readFileSync(current.indexPath), beforeIndex);
    assert.equal(fs.statSync(current.indexPath).mode & 0o7777, unsafeMode);
    assert.equal(
      readOptionalGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ),
      null,
    );
  } finally {
    current.dispose();
  }
});

test('current Apply journal reader rejects digest-valid V1 bytes without mutating Git state', async () => {
  const current = fixture('prepared');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Create only the current journal before testing the retired format.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated prepared crash/u,
    );
    const currentJournal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    const currentEntry = currentJournal.entries[0]!;
    const legacyEntryBody = {
      revision: currentEntry.revision,
      phase: currentEntry.phase,
      previousEntryDigest: currentEntry.previousEntryDigest,
      commitHash: currentEntry.commitHash,
      failure: currentEntry.failure,
    };
    const legacyEntry = {
      ...legacyEntryBody,
      entryDigest: sha256(
        `workflow.git-authority-candidate-apply-journal-entry.v1\n${canonicalJson(
          legacyEntryBody,
        )}`,
      ),
    };
    const legacyBody = {
      schemaVersion: 1,
      kind: 'git-authority-candidate-apply-journal.v1',
      parameters: currentJournal.parameters,
      parametersDigest: currentJournal.parametersDigest,
      challengeId: currentJournal.challengeId,
      operationId: currentJournal.operationId,
      approvalSubject: currentJournal.approvalSubject,
      approvalMethod: currentJournal.approvalMethod,
      approvalSubjectDigest: currentJournal.approvalSubjectDigest,
      preparedGrantRecordDigest: currentJournal.preparedGrantRecordDigest,
      commitMessage: currentJournal.commitMessage,
      entries: [legacyEntry],
    };
    const legacyBytes = `${canonicalJson({
      ...legacyBody,
      journalDigest: sha256(
        `workflow.git-authority-candidate-apply-journal.v1\n${canonicalJson(
          legacyBody,
        )}`,
      ),
    })}\n`;
    const journalPath = path.join(
      current.investigationRuntime.root,
      'git-authority-candidate-apply-v2',
      'journals',
      `${OPERATION_ID}.json`,
    );
    fs.writeFileSync(journalPath, legacyBytes);
    const beforeRef = git(current.repository, [
      'rev-parse',
      'refs/heads/main',
    ]).trim();
    const beforeIndex = fs.readFileSync(current.indexPath);

    assert.throws(
      () =>
        readGitAuthorityCandidateApplyJournal(
          current.investigationRuntime,
          OPERATION_ID,
        ),
      (error) =>
        isWorkflowError(error, 'GIT_AUTHORITY_CANDIDATE_APPLY_JOURNAL_INVALID'),
    );
    assert.equal(fs.readFileSync(journalPath, 'utf8'), legacyBytes);
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      beforeRef,
    );
    assert.deepEqual(fs.readFileSync(current.indexPath), beforeIndex);
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

test('Central Grant Apply uses the candidate UTF-8 order for BMP and supplementary Unicode paths', async () => {
  const current = fixture(undefined, 'deletion', true);
  try {
    assert.deepEqual(
      current.candidate.manifest.files.map(({ path: filePath }) => filePath),
      [
        'src/\ue000.txt',
        'src/\ud83d\ude00.txt',
        'workflow/maintainer-policy.json',
      ],
    );
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve the exact cross-plane Unicode candidate.',
      ),
    );
    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'completed');
    assert.equal(git(current.repository, ['status', '--porcelain']), '');
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).entries.at(-1)?.phase,
      'completed',
    );
  } finally {
    current.dispose();
  }
});

test('durable exact Apply recovers every effect crash window without duplicate commits or result rewriting', async () => {
  for (const crashPoint of [
    'prepared',
    'index-lock-acquired',
    'index-publication',
    'index-publication-recorded',
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
        createFileGrantRecordStore(current.grantPaths).readGrantRecord(
          CHALLENGE_ID,
        ).state,
        'prepared',
      );
      assert.equal(
        fs.statSync(current.indexPath).mode & 0o7777,
        current.indexMode,
        crashPoint,
      );

      const recoveryPort = createProductionGitAuthorityCandidateApplyPort(
        current.repository,
      );
      const recoveryCoordinator = createGrantCoordinatorKernel({
        store: createFileGrantRecordStore(current.grantPaths),
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
      assert.equal(
        fs.statSync(current.indexPath).mode & 0o7777,
        current.indexMode,
        crashPoint,
      );
    } finally {
      current.dispose();
    }
  }
});

test('post-rename recovery rejects mode drift against the durable original index mode', async () => {
  const current = fixture('index-publication');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve the exact index publication mode before recovery.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated index-publication crash/u,
    );
    const operationCommit = git(current.repository, [
      'rev-parse',
      'HEAD',
    ]).trim();
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).entries.at(-1)?.phase,
      'ref-updated',
    );
    const driftMode =
      current.indexMode === 0o664 ? 0o644 : current.indexMode | 0o020;
    assert.notEqual(driftMode, current.indexMode);
    fs.chmodSync(current.indexPath, driftMode);
    assert.equal(fs.statSync(current.indexPath).mode & 0o7777, driftMode);

    const restarted =
      createProductionGitAuthorityCandidateApplyGrantCoordinator(
        current.repository,
        current.parameters,
      );
    const recovered = await restarted.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'failed');
    assert.equal(recovered.recovered, true);
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      operationCommit,
    );
    const journal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    assert.equal(journal.indexMode, current.indexMode);
    assert.equal(journal.entries.at(-1)?.phase, 'failed');
    assert.equal(journal.entries.at(-1)?.commitHash, operationCommit);
    assert.equal(
      journal.entries.at(-1)?.failure?.code,
      'git-authority-candidate-apply-index-changed',
    );
  } finally {
    current.dispose();
  }
});

test('prepared recovery rejects safe index mode drift before publishing a ref effect', async () => {
  const current = fixture('prepared');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Bind the exact original index mode before any Git effect.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated prepared crash/u,
    );
    const driftMode =
      current.indexMode === 0o664 ? 0o644 : current.indexMode | 0o020;
    assert.notEqual(driftMode, current.indexMode);
    fs.chmodSync(current.indexPath, driftMode);

    const restarted =
      createProductionGitAuthorityCandidateApplyGrantCoordinator(
        current.repository,
        current.parameters,
      );
    const recovered = await restarted.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'failed');
    assert.equal(recovered.recovered, true);
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      current.baseCommit,
    );
    const journal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    assert.equal(journal.indexMode, current.indexMode);
    assert.equal(journal.entries.at(-1)?.phase, 'failed');
    assert.equal(journal.entries.at(-1)?.commitHash, null);
    assert.equal(
      journal.entries.at(-1)?.failure?.code,
      'git-authority-candidate-apply-index-changed',
    );
  } finally {
    current.dispose();
  }
});

test('fresh production recovery keeps the exact base runtime after the result changes or deletes workflow config', async () => {
  for (const resultConfig of ['runtime-changed', 'deleted'] as const) {
    const current = fixture(
      'ref-update',
      'deletion',
      false,
      false,
      resultConfig,
    );
    try {
      await current.coordinator.requestGrant(
        createGitAuthorityCandidateApplyGrantRequest(
          current.port,
          current.parameters,
          `Approve exact ${resultConfig} config consequence.`,
        ),
      );
      await assert.rejects(
        current.coordinator.resolveChallenge(CHALLENGE_ID),
        /simulated ref-update crash/,
      );
      assert.notEqual(
        git(current.repository, ['rev-parse', 'HEAD']).trim(),
        current.baseCommit,
      );
      if (resultConfig === 'deleted') {
        assert.equal(
          fs.existsSync(path.join(current.repository, 'workflow/config.json')),
          false,
        );
      } else {
        assert.equal(
          (
            JSON.parse(
              fs.readFileSync(
                path.join(current.repository, 'workflow/config.json'),
                'utf8',
              ),
            ) as { runtimeDirectory: string }
          ).runtimeDirectory,
          'candidate-selected-runtime',
        );
      }

      const restarted =
        createProductionGitAuthorityCandidateApplyGrantCoordinator(
          current.repository,
          current.parameters,
        );
      const beforeRecovery = createFileGrantRecordStore(
        current.grantPaths,
      ).readGrantRecord(CHALLENGE_ID);
      assert.equal(beforeRecovery.state, 'prepared', resultConfig);
      if (beforeRecovery.state !== 'prepared') {
        assert.fail('expected prepared Grant before fresh recovery');
      }
      assert.equal(beforeRecovery.operationId, OPERATION_ID, resultConfig);
      const recovered = await restarted.recoverChallenge(CHALLENGE_ID);
      assert.equal(recovered.outcome, 'completed', resultConfig);
      assert.equal(recovered.recovered, true, resultConfig);
      assert.equal(
        createFileGrantRecordStore(current.grantPaths).readGrantRecord(
          CHALLENGE_ID,
        ).state,
        'completed',
        resultConfig,
      );
      assert.equal(
        readGitAuthorityCandidateApplyJournal(
          current.investigationRuntime,
          OPERATION_ID,
        ).entries.at(-1)?.phase,
        'completed',
        resultConfig,
      );
    } finally {
      current.dispose();
    }
  }
});

test('terminal Apply recovery preserves its natural result after the candidate changes Grant policy', async () => {
  const current = fixture(undefined, 'deletion', false, true);
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve exact policy consequence under the base authority.',
      ),
    );
    const completed = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(completed.outcome, 'completed');
    assert.equal(
      (
        JSON.parse(
          fs.readFileSync(
            path.join(current.repository, 'workflow/grant-policy.json'),
            'utf8',
          ),
        ) as { optionalSsh?: unknown }
      ).optionalSsh !== undefined,
      true,
    );
    const restarted =
      createProductionGitAuthorityCandidateApplyGrantCoordinator(
        current.repository,
        current.parameters,
      );
    const recovered = await restarted.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(recovered.recovered, true);
  } finally {
    current.dispose();
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
      store: createFileGrantRecordStore(current.grantPaths),
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
    const terminal = createFileGrantRecordStore(
      current.grantPaths,
    ).readGrantRecord(CHALLENGE_ID);
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

test('pre-publication recovery preserves foreign same-tree staging after a foreign ref advance', async () => {
  const current = fixture('commit-object');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve the exact commit before a foreign ref and index advance.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated commit-object crash/,
    );
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.indexTree,
    );
    git(current.repository, ['add', '-A', '--']);
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.resultTree,
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
      'Foreign branch and same-tree index advance before publication',
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
      store: createFileGrantRecordStore(current.grantPaths),
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
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      foreignCommit,
    );
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.resultTree,
    );
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).entries.at(-1)?.failure?.code,
      'git-authority-candidate-apply-ref-changed',
    );
  } finally {
    current.dispose();
  }
});

test('post-ref pre-index recovery records the partial effect and preserves foreign staging', async () => {
  const current = fixture('ref-update');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve the exact ref update before unrelated index drift.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated ref-update crash/,
    );
    const operationCommit = git(current.repository, [
      'rev-parse',
      'HEAD',
    ]).trim();
    assert.notEqual(operationCommit, current.baseCommit);
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.indexTree,
    );
    fs.writeFileSync(
      path.join(current.repository, 'foreign-index-change.txt'),
      'foreign staging\n',
    );
    git(current.repository, ['add', '--', 'foreign-index-change.txt']);
    const foreignIndexTree = git(current.repository, ['write-tree']).trim();
    assert.notEqual(foreignIndexTree, current.candidate.resultTree);
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
      operationCommit,
      '-m',
      'Foreign ref and index advance',
    ]).trim();
    git(current.repository, [
      'update-ref',
      'refs/heads/main',
      foreignCommit,
      operationCommit,
    ]);

    const recoveryPort = createProductionGitAuthorityCandidateApplyPort(
      current.repository,
    );
    const recoveryCoordinator = createGrantCoordinatorKernel({
      store: createFileGrantRecordStore(current.grantPaths),
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
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      foreignCommit,
    );
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      foreignIndexTree,
    );
    const journal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    assert.equal(journal.entries.at(-1)?.phase, 'failed');
    assert.equal(journal.entries.at(-1)?.commitHash, operationCommit);
    assert.equal(
      journal.entries.at(-1)?.failure?.code,
      'git-authority-candidate-apply-ref-changed',
    );
  } finally {
    current.dispose();
  }
});

test('index publication rechecks foreign staging under the standard Git lock', async () => {
  let foreignIndexTree = '';
  let current: ReturnType<typeof fixture>;
  current = fixture(
    undefined,
    'deletion',
    false,
    false,
    'unchanged',
    false,
    () => {
      fs.writeFileSync(
        path.join(current.repository, 'foreign-index-race.txt'),
        'foreign staging between observation and index lock\n',
      );
      git(current.repository, ['add', '--', 'foreign-index-race.txt']);
      foreignIndexTree = git(current.repository, ['write-tree']).trim();
    },
  );
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve exact publication without overwriting a foreign index race.',
      ),
    );
    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'failed');
    assert.notEqual(foreignIndexTree, '');
    assert.notEqual(foreignIndexTree, current.candidate.resultTree);
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      foreignIndexTree,
    );
    const journal = readGitAuthorityCandidateApplyJournal(
      current.investigationRuntime,
      OPERATION_ID,
    );
    assert.equal(journal.entries.at(-1)?.phase, 'failed');
    assert.equal(
      journal.entries.at(-1)?.failure?.code,
      'git-authority-candidate-apply-index-changed',
    );
  } finally {
    current.dispose();
  }
});

test('owned index lock blocks a foreign Git publication and preserves its worktree bytes', async () => {
  let foreignAttemptStatus: number | null = null;
  let current: ReturnType<typeof fixture>;
  current = fixture(
    undefined,
    'deletion',
    false,
    false,
    'unchanged',
    false,
    undefined,
    () => {
      fs.writeFileSync(
        path.join(current.repository, 'foreign-after-lock.txt'),
        'foreign worktree bytes after index lock\n',
      );
      foreignAttemptStatus = spawnSync(
        'git',
        ['add', '--', 'foreign-after-lock.txt'],
        {
          cwd: current.repository,
          encoding: 'utf8',
          shell: false,
        },
      ).status;
    },
  );
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve publication while preserving a foreign locked attempt.',
      ),
    );
    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'failed');
    assert.notEqual(foreignAttemptStatus, 0);
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.indexTree,
    );
    assert.equal(
      fs.readFileSync(
        path.join(current.repository, 'foreign-after-lock.txt'),
        'utf8',
      ),
      'foreign worktree bytes after index lock\n',
    );
    assert.equal(
      fs.existsSync(path.join(current.repository, '.git/index.lock')),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          current.investigationRuntime.root,
          'git-authority-candidate-apply-v2',
          'index-publications',
          OPERATION_ID,
          'candidate.index',
        ),
      ),
      false,
    );
  } finally {
    current.dispose();
  }
});

test('foreign pre-existing index lock is never removed by Apply', async () => {
  const foreignLockBytes = 'foreign index lock owner\n';
  let current: ReturnType<typeof fixture>;
  current = fixture(
    undefined,
    'deletion',
    false,
    false,
    'unchanged',
    false,
    () => {
      fs.writeFileSync(
        path.join(current.repository, '.git/index.lock'),
        foreignLockBytes,
        { flag: 'wx', mode: 0o600 },
      );
    },
  );
  const beforeIndex = fs.readFileSync(current.indexPath);
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve without adopting or deleting a foreign Git lock.',
      ),
    );
    const result = await current.coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'failed');
    assert.equal(
      fs.readFileSync(path.join(current.repository, '.git/index.lock'), 'utf8'),
      foreignLockBytes,
    );
    assert.deepEqual(fs.readFileSync(current.indexPath), beforeIndex);
    assert.equal(
      fs.statSync(current.indexPath).mode & 0o7777,
      current.indexMode,
    );
  } finally {
    current.dispose();
  }
});

test('durable terminal checkpoint fixes the natural result before later foreign ref drift', async () => {
  const current = fixture('terminal');
  try {
    await current.coordinator.requestGrant(
      createGitAuthorityCandidateApplyGrantRequest(
        current.port,
        current.parameters,
        'Approve the exact terminal result before a later foreign ref event.',
      ),
    );
    await assert.rejects(
      current.coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated terminal crash/,
    );
    const operationCommit = git(current.repository, [
      'rev-parse',
      'HEAD',
    ]).trim();
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).entries.at(-1)?.phase,
      'completed',
    );
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.resultTree,
    );
    const foreignCommit = git(current.repository, [
      'commit-tree',
      current.candidate.resultTree,
      '-p',
      operationCommit,
      '-m',
      'Foreign ref event after the exact durable terminal checkpoint',
    ]).trim();
    git(current.repository, [
      'update-ref',
      'refs/heads/main',
      foreignCommit,
      operationCommit,
    ]);

    const recoveryPort = createProductionGitAuthorityCandidateApplyPort(
      current.repository,
    );
    const recoveryCoordinator = createGrantCoordinatorKernel({
      store: createFileGrantRecordStore(current.grantPaths),
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
    assert.equal(recovered.outcome, 'completed');
    assert.equal(
      git(current.repository, ['rev-parse', 'refs/heads/main']).trim(),
      foreignCommit,
    );
    assert.equal(
      git(current.repository, ['write-tree']).trim(),
      current.candidate.resultTree,
    );
    assert.equal(
      readGitAuthorityCandidateApplyJournal(
        current.investigationRuntime,
        OPERATION_ID,
      ).entries.at(-1)?.phase,
      'completed',
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
          'git-authority-candidate-apply-v2',
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
      createFileGrantRecordStore(driftFixture.grantPaths).readGrantRecord(
        CHALLENGE_ID,
      ).state,
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

function successfulSshSession(
  presentation: TrustedGrantPresentation,
  policy: GrantPolicyV2,
  signer: MaintainerSignerProvider,
): GrantApprovalSession {
  return Object.freeze({
    async collectDecision() {
      return {
        choiceId: presentation.choices[0]!.choiceId,
        approvalMethod: 'ssh' as const,
        reasonCode: 'approve-exact-git-authority-candidate',
        reason:
          'Approve this exact immutable Git candidate with portable SSH evidence.',
        sessionNonce: 'nonce-git-authority-ssh-00000000000000000001',
      };
    },
    async authenticate(request) {
      return [
        collectSshApprovalProof(policy, request, {
          signer,
          now: NOW,
        }),
      ];
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

function attackerGrantPolicyInput() {
  return {
    ...policyInput(),
    profiles: {
      ...policyInput().profiles,
      ssh: { requiredClaims: ['ssh-signature'] },
    },
    approvalModules: [
      ...policyInput().approvalModules,
      {
        moduleId: 'grant-proof-ssh',
        version: '1',
        allowedClaims: ['ssh-signature'],
        configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
      },
    ],
    optionalSsh: {
      signatureNamespace: 'jigwright.workflow.grant-proof.v1',
      trustedSigners: [
        {
          identity: 'candidate-attacker',
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
          fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
        },
      ],
    },
  };
}

function baseSshGrantPolicyInput(
  trustedSigner: Readonly<{
    identity: string;
    publicKey: string;
    fingerprint: string;
  }> = {
    identity: 'base-trusted',
    publicKey:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
    fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
  },
) {
  return {
    ...policyInput(),
    profiles: {
      ...policyInput().profiles,
      ssh: { requiredClaims: ['ssh-signature'] },
    },
    approvalModules: [
      ...policyInput().approvalModules,
      {
        moduleId: 'grant-proof-ssh',
        version: '1',
        allowedClaims: ['ssh-signature'],
        configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
      },
    ],
    optionalSsh: {
      signatureNamespace: 'jigwright.workflow.grant-proof.v1',
      trustedSigners: [trustedSigner],
    },
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

function replaceAnnotatedTag(
  repository: string,
  tagRef: string,
  rawTag: string,
): void {
  const result = spawnSync('git', ['mktag'], {
    cwd: repository,
    encoding: 'utf8',
    input: rawTag,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  git(repository, ['update-ref', '--no-deref', tagRef, result.stdout.trim()]);
}

function terminalRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return value.terminalGrantRecord as Record<string, unknown>;
}

function journalRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return value.journal as Record<string, unknown>;
}

function portableEvidence(value: Record<string, unknown>): {
  payload: string;
  signature: string;
  signatureNamespace: string;
  identity: string;
  verifiedAt: string;
} {
  const terminal = terminalRecord(value);
  const proofs = terminal.proofModules as Array<Record<string, unknown>>;
  return proofs[0]!.portableEvidence as {
    payload: string;
    signature: string;
    signatureNamespace: string;
    identity: string;
    verifiedAt: string;
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
