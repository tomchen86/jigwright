import { preflightMaintainerGrantV2 } from '../bootstrap/maintainer-authority-production.ts';
import { prepareMaintainerGrantV2Checks } from '../bootstrap/maintainer-authority-production.ts';
import test from 'node:test';

import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';
import { openMaintainerCheckJournal } from '../src/runtime/storage-journal/maintainer-check-journal.ts';
import {
  type MaintainerPolicy,
  isAuthorityPathEligible,
  parseMaintainerPolicy,
} from '../src/modules/authority/maintainer-policy.ts';
import { assertCurrentMaintainerPolicyTransition } from '../src/modules/assurance/commit-replay/ci-authority.ts';
import {
  withTwoCheckCandidate,
  PROFILE_ID,
  checkRunCount,
  ROOT_PROFILE_ID,
  prepareCandidate,
  fakeSigner,
  approveAndApplyMaintainerGrantV2,
  TASK_ID,
} from './support/maintainer-grant-v2-fixture.ts';

test('preapproval checks durably resume after interruption without rerunning completed evidence', () => {
  withTwoCheckCandidate((repository) => {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    let interrupted = false;

    assert.throws(
      () =>
        prepareMaintainerGrantV2Checks(repository, preflight, process.env, {
          testAfterCheckPersisted(checkId) {
            if (checkId === 'fixture' && !interrupted) {
              interrupted = true;
              throw new Error('simulated check process crash');
            }
          },
        }),
      /simulated check process crash/,
    );
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(
      fs.existsSync(path.join(repository, '.git', 'check-two-count')),
      false,
    );

    const resumed = prepareMaintainerGrantV2Checks(
      repository,
      preflight,
      process.env,
    );
    assert.deepEqual(
      resumed.checks.map(({ evidence }) => evidence.checkId),
      ['fixture', 'fixture-two'],
    );
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(checkRunCount(repository, 'check-two-count'), 1);

    const replayed = prepareMaintainerGrantV2Checks(
      repository,
      preflight,
      process.env,
    );
    assert.deepEqual(replayed, resumed);
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(checkRunCount(repository, 'check-two-count'), 1);

    const journalDirectory = path.join(
      repository,
      '.git/workflow-engine/maintainer-checks',
    );
    const journals = fs
      .readdirSync(journalDirectory)
      .filter((entry) => entry.endsWith('.json'));
    assert.equal(journals.length, 1);
    const journal = JSON.parse(
      fs.readFileSync(path.join(journalDirectory, journals[0]!), 'utf8'),
    ) as {
      state: string;
      identity: { schemaVersion: number; harnessEngineDigest: string };
      finalAttestation: {
        schemaVersion: number;
        harnessEngineDigest: string;
      };
      checks: unknown[];
    };
    assert.equal(journal.state, 'completed');
    assert.equal(journal.identity.schemaVersion, 2);
    assert.match(journal.identity.harnessEngineDigest, /^[0-9a-f]{64}$/);
    assert.equal(journal.finalAttestation.schemaVersion, 2);
    assert.equal(
      journal.finalAttestation.harnessEngineDigest,
      journal.identity.harnessEngineDigest,
    );
    assert.equal(journal.checks.length, 2);
    assert.deepEqual(journal.finalAttestation, resumed);
  });
});

test('preapproval check journal rejects retired V1 identities', () => {
  const repository = createFixtureRepository();
  try {
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.throws(
      () =>
        openMaintainerCheckJournal(
          gitCommonDirectory,
          {
            schemaVersion: 1,
            repositoryId: 'github:R_fixture',
            repositoryRealPath: fs.realpathSync(repository),
            trustBaseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
            policyDigest: 'a'.repeat(64),
            profileId: PROFILE_ID,
            profileVersion: 1,
            patchDigest: 'b'.repeat(64),
            candidateStateDigest: 'c'.repeat(64),
            environmentDigest: 'd'.repeat(64),
            requiredChecks: [
              {
                checkId: 'fixture',
                definitionDigest: 'e'.repeat(64),
                runner: 'node',
                runnerDigest: 'f'.repeat(64),
                destructiveDatabase: false,
                databaseIdentity: null,
              },
            ],
          } as never,
          new Date('2026-08-03T08:00:00.000Z'),
        ),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_JOURNAL_INVALID'),
    );
    assert.equal(
      fs.existsSync(
        path.join(gitCommonDirectory, 'workflow-engine/maintainer-checks'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('preapproval check resume never reuses evidence after candidate drift', () => {
  withTwoCheckCandidate((repository) => {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });

    assert.throws(
      () =>
        prepareMaintainerGrantV2Checks(repository, preflight, process.env, {
          testAfterCheckPersisted(checkId) {
            if (checkId === 'fixture') {
              throw new Error('interrupt before drift');
            }
          },
        }),
      /interrupt before drift/,
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 3;\n',
    );
    assert.throws(
      () => prepareMaintainerGrantV2Checks(repository, preflight),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_PREFLIGHT_STALE'),
    );

    const current = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    const result = prepareMaintainerGrantV2Checks(repository, current);
    assert.equal(result.patchDigest, current.patchDigest);
    assert.notEqual(result.patchDigest, preflight.patchDigest);
    assert.equal(checkRunCount(repository, 'check-one-count'), 2);
    assert.equal(checkRunCount(repository, 'check-two-count'), 1);
    assert.equal(
      fs
        .readdirSync(
          path.join(repository, '.git/workflow-engine/maintainer-checks'),
        )
        .filter((entry) => entry.endsWith('.json')).length,
      2,
    );
  });
});

test('preapproval check resume rejects tampered or unsafe journal files', () => {
  withTwoCheckCandidate((repository) => {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    assert.throws(
      () =>
        prepareMaintainerGrantV2Checks(repository, preflight, process.env, {
          testAfterCheckPersisted() {
            throw new Error('interrupt for journal tamper');
          },
        }),
      /interrupt for journal tamper/,
    );
    const journalDirectory = path.join(
      repository,
      '.git/workflow-engine/maintainer-checks',
    );
    const journalPath = path.join(
      journalDirectory,
      fs
        .readdirSync(journalDirectory)
        .find((entry) => entry.endsWith('.json'))!,
    );
    assert.equal(fs.lstatSync(journalPath).mode & 0o777, 0o600);
    const tampered = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      checks: Array<{ evidence: { runner: string } }>;
    };
    tampered.checks[0]!.evidence.runner = 'forged-runner';
    fs.writeFileSync(journalPath, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(
      () => prepareMaintainerGrantV2Checks(repository, preflight),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_JOURNAL_INVALID'),
    );
    assert.equal(checkRunCount(repository, 'check-one-count'), 1);
    assert.equal(
      fs.existsSync(path.join(repository, '.git', 'check-two-count')),
      false,
    );

    const target = path.join(journalDirectory, 'attacker-controlled');
    fs.writeFileSync(target, fs.readFileSync(journalPath), { mode: 0o600 });
    fs.unlinkSync(journalPath);
    fs.symlinkSync(target, journalPath);
    assert.throws(
      () => prepareMaintainerGrantV2Checks(repository, preflight),
      (error: unknown) =>
        isWorkflowError(error, 'MAINTAINER_CHECK_JOURNAL_INVALID'),
    );
  });
});

test('repository publishes the trust-base capability profile used by v2', () => {
  const raw = fs.readFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-profiles.json'),
    'utf8',
  );
  const value = JSON.parse(raw) as {
    schemaVersion: number;
    profiles: Record<
      string,
      {
        requiredChecks: string[];
        authorityClass: string;
        checkDependencies: Record<string, string[]>;
        forbiddenPaths: string[];
      }
    >;
  };
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profiles[PROFILE_ID]?.authorityClass, 'ordinary');
  assert.equal(
    value.profiles[ROOT_PROFILE_ID]?.authorityClass,
    'root-one-shot',
  );
  assert.deepEqual(value.profiles[PROFILE_ID]?.requiredChecks, [
    'managed-documents',
    'workflow-format',
    'workflow-lint',
    'workflow-tests',
    'workflow-typecheck',
  ]);
  assert.deepEqual(
    value.profiles[PROFILE_ID]?.checkDependencies['workflow-typecheck'],
    ['runner', 'source-tree'],
  );
  assert.equal(
    value.profiles[PROFILE_ID]?.forbiddenPaths.includes(
      'packages/workflow-engine/src/application/control-plane/maintainer-approve.ts',
    ),
    true,
  );
  assert.equal(
    value.profiles[PROFILE_ID]?.forbiddenPaths.includes(
      'packages/workflow-engine/src/modules/authority/task-mandate.ts',
    ),
    true,
  );
});

test('current maintainer policy rejects malformed trust configuration', () => {
  const current = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as MaintainerPolicy;
  assert.doesNotThrow(() => parseMaintainerPolicy(current));

  const invalidPolicies = [
    {
      name: 'unknown property',
      value: { ...current, unexpected: true },
    },
    {
      name: 'consumer-branded signature namespace',
      value: {
        ...current,
        signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
      },
    },
    {
      name: 'unordered bootstrap paths',
      value: {
        ...current,
        bootstrapEligiblePaths: [...current.bootstrapEligiblePaths].reverse(),
      },
    },
    {
      name: 'immutable path outside bootstrap authority',
      value: {
        ...current,
        sealedImmutablePaths: ['workflow/not-eligible.json'],
      },
    },
  ];
  for (const { name, value } of invalidPolicies) {
    assert.throws(
      () => parseMaintainerPolicy(value),
      (error) => isWorkflowError(error, 'MAINTAINER_POLICY_INVALID'),
      name,
    );
  }
});

test('current V2 CI refuses stable identity and sealed trust rollback', () => {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as MaintainerPolicy;
  const current = parseMaintainerPolicy(raw);
  const sealed = parseMaintainerPolicy({ ...raw, phase: 'sealed' });
  assert.doesNotThrow(() =>
    assertCurrentMaintainerPolicyTransition(current, current),
  );

  const invalidTransitions = [
    {
      name: 'repository identity mutation',
      parent: current,
      candidate: parseMaintainerPolicy({
        ...raw,
        repository: {
          id: 'github:R_other',
          origin: 'https://github.com/example/other.git',
        },
      }),
    },
    {
      name: 'sealed phase rollback',
      parent: sealed,
      candidate: current,
    },
    {
      name: 'sealed path removal',
      parent: sealed,
      candidate: parseMaintainerPolicy({
        ...raw,
        phase: 'sealed',
        sealedImmutablePaths: raw.sealedImmutablePaths.slice(1),
      }),
    },
    {
      name: 'required check removal',
      parent: current,
      candidate: parseMaintainerPolicy({
        ...raw,
        requiredChecks: raw.requiredChecks.slice(1),
      }),
    },
  ];
  for (const { name, parent, candidate } of invalidTransitions) {
    assert.throws(
      () => assertCurrentMaintainerPolicyTransition(parent, candidate),
      (error) =>
        isWorkflowError(error, 'CI_AUTHORITY_POLICY_TRANSITION_INVALID'),
      name,
    );
  }
});

test('sealed maintainer paths remain ineligible and cannot be removed from current policy', () => {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  );
  const bootstrap = parseMaintainerPolicy({ ...raw, phase: 'bootstrap' });
  const sealed = parseMaintainerPolicy({ ...raw, phase: 'sealed' });
  assert.ok(sealed.sealedImmutablePaths.length > 0);
  for (const protectedPath of sealed.sealedImmutablePaths) {
    assert.equal(isAuthorityPathEligible(bootstrap, protectedPath), true);
    assert.equal(isAuthorityPathEligible(sealed, protectedPath), false);
    const weakened = parseMaintainerPolicy({
      ...sealed,
      sealedImmutablePaths: sealed.sealedImmutablePaths.filter(
        (filePath) => filePath !== protectedPath,
      ),
    });
    assert.throws(
      () => assertCurrentMaintainerPolicyTransition(sealed, weakened),
      (error) =>
        isWorkflowError(error, 'CI_AUTHORITY_POLICY_TRANSITION_INVALID'),
      protectedPath,
    );
  }
  for (const policy of [bootstrap, sealed]) {
    assert.equal(isAuthorityPathEligible(policy, 'workflow/checks.json'), true);
  }
});

test('managed trailer authority is limited to its exact core source', () => {
  const policy = parseMaintainerPolicy(
    JSON.parse(
      fs.readFileSync(
        path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
        'utf8',
      ),
    ),
  );
  const grammar = 'packages/core/src/managed-transition-trailers.ts';
  assert.deepEqual(
    policy.bootstrapEligiblePaths.filter((filePath) =>
      filePath.startsWith('packages/core/'),
    ),
    [grammar],
  );
  assert.ok(policy.sealedImmutablePaths.includes(grammar));
  for (const phase of ['bootstrap', 'sealed'] as const) {
    for (const sibling of [
      'packages/core/src/canonical-json.ts',
      `${grammar}x`,
      `${grammar}/child.ts`,
    ]) {
      assert.equal(
        isAuthorityPathEligible({ ...policy, phase }, sibling),
        false,
      );
    }
  }
  assert.throws(
    () =>
      parseMaintainerPolicy({
        ...policy,
        bootstrapEligiblePaths: policy.bootstrapEligiblePaths.filter(
          (filePath) => filePath !== grammar,
        ),
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_POLICY_INVALID'),
  );
});

test('repository publishes a protected capability dependency closure', () => {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/protected-capabilities.json'),
      'utf8',
    ),
  ) as {
    kind: unknown;
    schemaVersion: unknown;
    entries: Array<{
      entrypoints: string[];
      dependencies: string[];
    }>;
  };
  assert.equal(value.kind, 'protected-capability-manifest.v1');
  assert.equal(value.schemaVersion, 1);
  const protectedPaths = value.entries.flatMap(
    ({ entrypoints, dependencies }) => [...entrypoints, ...dependencies],
  );
  assert.equal(
    protectedPaths.includes(
      'packages/workflow-engine/src/modules/authority/execution-governance.ts',
    ),
    true,
  );
  assert.equal(
    protectedPaths.includes(
      'packages/workflow-engine/src/modules/authority/maintainer-candidate-contracts.ts',
    ),
    true,
  );
});

test('v2 preflight is read-only and derives exact overlay and checks from the trust base', () => {
  const repository = prepareCandidate();
  try {
    const before = git(repository, ['status', '--porcelain=v1', '-z']);
    const result = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    const after = git(repository, ['status', '--porcelain=v1', '-z']);

    assert.equal(result.classification, 'ordinary');
    assert.equal(result.grantable, true);
    assert.equal(result.manifest.profile, PROFILE_ID);
    assert.equal(result.manifest.trustBaseCommit, result.trustBaseCommit);
    assert.deepEqual(result.evidenceOverlay, [
      {
        path: 'packages/workflow-engine/test/limits.test.ts',
        role: 'evidence',
      },
    ]);
    assert.deepEqual(result.requiredChecks, ['fixture']);
    assert.deepEqual(result.checkDependencies, {
      fixture: ['harness-engine', 'runner', 'source-tree'],
    });
    assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.patchDigest, result.manifest.patchDigest);
    assert.equal(after, before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected dependency closure cannot pass as ordinary implementation', () => {
  const repository = prepareCandidate();
  try {
    git(repository, [
      'checkout',
      '--',
      'packages/workflow-engine/src/limits.ts',
      'packages/workflow-engine/test/limits.test.ts',
    ]);
    fs.writeFileSync(
      path.join(
        repository,
        'packages/workflow-engine/src/modules/authority/execution-governance.ts',
      ),
      'export const GRANT_LIMIT = 2;\n',
    );
    const result = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    assert.equal(
      result.manifest.files[0]?.role,
      'implementation',
      'the dependency closure, not a broad source role, must force escalation',
    );
    assert.equal(result.classification, 'control-plane');
    assert.equal(result.grantable, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('root one-shot profile remains exact-candidate bounded without policy mutation', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: ROOT_PROFILE_ID,
    });
    assert.equal(preflight.classification, 'root-one-shot');
    assert.equal(preflight.grantable, true);

    const result = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: ROOT_PROFILE_ID,
        reason: 'Root approves this exact nonpersistent candidate override',
        message: 'Apply root one-shot candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
      },
    );
    const payload = JSON.parse(signed[0]!) as {
      classification: string;
      candidateBundle: { classification: string };
    };
    assert.equal(payload.classification, 'root-one-shot');
    assert.equal(payload.candidateBundle.classification, 'root-one-shot');
    assert.equal(result.applied, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
