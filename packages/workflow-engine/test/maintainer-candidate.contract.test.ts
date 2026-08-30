import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  acceptApplyPrestate,
  assertCandidateV2ChecksFresh,
  buildImmutableCandidateBundleV2,
  canonicalImmutableCandidateBundle,
  createRefGenerationLedger,
  ensureDurableRefGenerationLedger,
  parseImmutableCandidateBundle,
  readStoredImmutableCandidateBundle,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
  recordRefGenerationTransition,
  storeImmutableCandidateBundle,
  type CandidateChecksAttestationV3,
} from '../src/modules/authority/maintainer-candidate.ts';
import {
  buildImmutableGitCandidate,
  canonicalImmutableGitCandidate,
  parseImmutableGitCandidate,
  verifyImmutableGitCandidateAgainstRepository,
} from '../src/modules/authority/immutable-git-candidate.ts';
import type { PatchManifest } from '../src/modules/authority/maintainer-manifest.ts';
import { canonicalPatchManifest } from '../src/modules/authority/maintainer-manifest.ts';
import { isWorkflowError } from './fixture.ts';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const ENVIRONMENT = 'e'.repeat(64);
const mandateBinding = {
  schemaVersion: 1 as const,
  mandateTaskId: 'demo-task',
  mandateId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: '1'.repeat(64),
  changeId: 'demo-change',
  externalAuditRoot: path.join(os.tmpdir(), 'candidate-audit-root'),
};

type NeutralPolicy = {
  schemaVersion: 1;
  repository: { id: string; origin: string };
  phase: 'bootstrap' | 'sealed';
  auditTagPrefix: string;
  signatureNamespace: string;
  maxTtlMinutes: 30;
  maxUses: 1;
  bootstrapEligiblePaths: string[];
  sealedImmutablePaths: string[];
  requiredChecks: string[];
  trustedSigners: Array<{
    identity: string;
    publicKey: string;
    fingerprint: string;
  }>;
};

function neutralPolicy(overrides: Partial<NeutralPolicy> = {}): NeutralPolicy {
  return {
    schemaVersion: 1,
    repository: {
      id: 'github:R_neutral_candidate',
      origin: 'https://github.com/example/neutral-candidate.git',
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/maintainer-grants/',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: ['packages/**', 'workflow/**'],
    sealedImmutablePaths: [],
    requiredChecks: ['candidate-fail', 'candidate-pass'],
    trustedSigners: [
      {
        identity: 'fixture-maintainer',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture',
        fingerprint: 'SHA256:fixturefixturefixturefixture',
      },
    ],
    ...overrides,
  };
}

function createNeutralCandidateFixture(
  label: string,
  policy: NeutralPolicy,
): {
  repository: string;
  policyPath: string;
  baseCommit: string;
  dispose(): void;
} {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `neutral-candidate-${label}-`)),
  );
  gitForCandidate(repository, ['init', '-b', 'main']);
  gitForCandidate(repository, [
    'config',
    'user.email',
    'candidate@example.test',
  ]);
  gitForCandidate(repository, ['config', 'user.name', 'Candidate Test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'checks'), { recursive: true });
  const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
  writeCandidateJson(policyPath, policy);
  writeCandidateJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks: {
      'candidate-fail': {
        command: ['node', 'checks/fail.mjs'],
        destructiveDatabase: false,
      },
      'candidate-mutate': {
        command: ['node', 'checks/mutate.mjs'],
        destructiveDatabase: false,
      },
      'candidate-pass': {
        command: ['node', 'checks/pass.mjs'],
        destructiveDatabase: false,
      },
    },
  });
  fs.writeFileSync(
    path.join(repository, 'checks/pass.mjs'),
    "process.stdout.write('candidate-pass\\n');\n",
  );
  fs.writeFileSync(
    path.join(repository, 'checks/fail.mjs'),
    "process.stderr.write('candidate-fail\\n'); process.exitCode = 7;\n",
  );
  fs.writeFileSync(
    path.join(repository, 'checks/mutate.mjs'),
    "await import('node:fs').then(({writeFileSync}) => writeFileSync('.git/pre-grant-check-ran', 'unsafe\\n'));\n",
  );
  gitForCandidate(repository, ['add', '--', 'workflow', 'checks']);
  gitForCandidate(repository, ['commit', '-m', 'Create candidate fixture']);
  return {
    repository,
    policyPath,
    baseCommit: gitForCandidate(repository, ['rev-parse', 'HEAD']).trim(),
    dispose: () => fs.rmSync(repository, { recursive: true, force: true }),
  };
}

function writeCandidateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function gitForCandidate(repository: string, args: string[]): string {
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

function neutralCandidateDigest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function candidateRepositorySnapshot(repository: string) {
  return {
    refs: gitForCandidate(repository, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]),
    indexTree: gitForCandidate(repository, ['write-tree']).trim(),
    status: gitForCandidate(repository, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]),
    storeExists: fs.existsSync(path.join(repository, '.git/workflow-engine')),
  };
}

test('neutral immutable Git candidates observe grantable policy mutations without acting as authority', () => {
  const scenarios: Array<{
    name: string;
    policy: NeutralPolicy;
    mutate(fixture: ReturnType<typeof createNeutralCandidateFixture>): void;
    observationKind: string;
  }> = [
    {
      name: 'policy-deletion',
      policy: neutralPolicy(),
      mutate: ({ policyPath }) => fs.unlinkSync(policyPath),
      observationKind: 'policy-file-deletion.v1',
    },
    {
      name: 'sealed-rollback',
      policy: neutralPolicy({
        phase: 'sealed',
        sealedImmutablePaths: ['workflow/**'],
      }),
      mutate: ({ policyPath }) => {
        const current = JSON.parse(
          fs.readFileSync(policyPath, 'utf8'),
        ) as NeutralPolicy;
        writeCandidateJson(policyPath, { ...current, phase: 'bootstrap' });
      },
      observationKind: 'policy-sealed-phase-rollback.v1',
    },
    {
      name: 'immutable-path-removal',
      policy: neutralPolicy({
        phase: 'sealed',
        sealedImmutablePaths: ['packages/**', 'workflow/**'],
      }),
      mutate: ({ policyPath }) => {
        const current = JSON.parse(
          fs.readFileSync(policyPath, 'utf8'),
        ) as NeutralPolicy;
        writeCandidateJson(policyPath, {
          ...current,
          sealedImmutablePaths: ['workflow/**'],
        });
      },
      observationKind: 'policy-sealed-immutable-path-removal.v1',
    },
    {
      name: 'required-check-removal',
      policy: neutralPolicy(),
      mutate: ({ policyPath }) => {
        const current = JSON.parse(
          fs.readFileSync(policyPath, 'utf8'),
        ) as NeutralPolicy;
        writeCandidateJson(policyPath, {
          ...current,
          requiredChecks: ['candidate-pass'],
        });
      },
      observationKind: 'policy-required-check-removal.v1',
    },
  ];
  const candidateDigests = new Set<string>();
  const observationDigests = new Set<string>();
  for (const scenario of scenarios) {
    const fixture = createNeutralCandidateFixture(
      scenario.name,
      scenario.policy,
    );
    try {
      scenario.mutate(fixture);
      const before = candidateRepositorySnapshot(fixture.repository);
      const candidate = buildImmutableGitCandidate(fixture.repository, {
        targetRef: 'refs/heads/main',
        expectedOldCommit: fixture.baseCommit,
        observeCheckIds: ['candidate-pass', 'candidate-fail'],
      });
      const after = candidateRepositorySnapshot(fixture.repository);

      assert.deepEqual(after, before);
      assert.equal(candidate.expectedOldCommit, fixture.baseCommit);
      assert.equal(candidate.repositoryId, 'github:R_neutral_candidate');
      assert.equal(
        candidate.repositoryOrigin,
        'https://github.com/example/neutral-candidate.git',
      );
      assert.equal(candidate.expectedOldTree, candidate.indexTree);
      assert.notEqual(candidate.resultTree, candidate.expectedOldTree);
      assert.deepEqual(
        candidate.manifest.files.map(({ path: filePath }) => filePath),
        ['workflow/maintainer-policy.json'],
      );
      assert.deepEqual(
        candidate.policyObservations.map(({ kind }) => kind),
        [scenario.observationKind],
      );
      assert.deepEqual(
        candidate.checkObservations.map(({ checkId, definition, runner }) => ({
          checkId,
          definition,
          runner,
        })),
        [
          {
            checkId: 'candidate-fail',
            definition: {
              command: ['node', 'checks/fail.mjs'],
              destructiveDatabase: false,
            },
            runner: 'node',
          },
          {
            checkId: 'candidate-pass',
            definition: {
              command: ['node', 'checks/pass.mjs'],
              destructiveDatabase: false,
            },
            runner: 'node',
          },
        ],
      );
      assert.equal(
        candidate.checkObservations.every(
          (observation) =>
            !('outcome' in observation) &&
            !('exitCode' in observation) &&
            !('stdoutDigest' in observation) &&
            !('stderrDigest' in observation) &&
            /^[0-9a-f]{64}$/u.test(observation.runnerDigest),
        ),
        true,
      );
      assert.equal('mandateBinding' in candidate, false);
      assert.equal('grant' in candidate, false);
      assert.equal('signature' in candidate, false);
      assert.equal('candidateCommit' in candidate, false);
      assert.deepEqual(
        parseImmutableGitCandidate(canonicalImmutableGitCandidate(candidate)),
        candidate,
      );
      assert.deepEqual(
        verifyImmutableGitCandidateAgainstRepository(
          fixture.repository,
          candidate,
        ),
        candidate,
      );
      candidateDigests.add(candidate.candidateDigest);
      observationDigests.add(candidate.policyObservationsDigest);
    } finally {
      fixture.dispose();
    }
  }
  assert.equal(candidateDigests.size, scenarios.length);
  assert.equal(observationDigests.size, scenarios.length);
});

test('neutral immutable Git candidates use locale-independent UTF-8 ordering for Unicode paths and observations', () => {
  const fixture = createNeutralCandidateFixture(
    'unicode-ordering',
    neutralPolicy({
      phase: 'sealed',
      sealedImmutablePaths: ['packages/**', 'workflow/**'],
      requiredChecks: ['candidate-fail', 'candidate-pass'],
    }),
  );
  try {
    const sourceDirectory = path.join(fixture.repository, 'src');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    for (const name of ['Z.txt', 'a.txt', 'Å.txt', 'Ω.txt', '𐐀.txt']) {
      fs.writeFileSync(path.join(sourceDirectory, name), `${name}\n`);
    }
    const current = JSON.parse(
      fs.readFileSync(fixture.policyPath, 'utf8'),
    ) as NeutralPolicy;
    writeCandidateJson(fixture.policyPath, {
      ...current,
      phase: 'bootstrap',
      sealedImmutablePaths: ['workflow/**'],
      requiredChecks: ['candidate-pass'],
    });

    const candidate = buildImmutableGitCandidate(fixture.repository, {
      targetRef: 'refs/heads/main',
      expectedOldCommit: fixture.baseCommit,
    });
    const expectedPaths = [
      'workflow/maintainer-policy.json',
      'src/Z.txt',
      'src/a.txt',
      'src/Å.txt',
      'src/Ω.txt',
      'src/𐐀.txt',
    ].sort(compareUtf8);
    assert.deepEqual(
      candidate.manifest.files.map(({ path: filePath }) => filePath),
      expectedPaths,
    );
    assert.deepEqual(
      candidate.policyObservations.map(({ kind }) => kind),
      candidate.policyObservations.map(({ kind }) => kind).sort(compareUtf8),
    );
    assert.deepEqual(
      parseImmutableGitCandidate(canonicalImmutableGitCandidate(candidate)),
      candidate,
    );
  } finally {
    fixture.dispose();
  }
});

test('neutral candidate rejects malformed facts, drift, symlinks, and preserves isolated preview state on interruption', () => {
  const fixture = createNeutralCandidateFixture('drift', neutralPolicy());
  try {
    const current = JSON.parse(
      fs.readFileSync(fixture.policyPath, 'utf8'),
    ) as NeutralPolicy;
    writeCandidateJson(fixture.policyPath, {
      ...current,
      requiredChecks: ['candidate-pass'],
    });
    const candidate = buildImmutableGitCandidate(fixture.repository, {
      targetRef: 'refs/heads/main',
      expectedOldCommit: fixture.baseCommit,
    });
    const malformed = structuredClone(candidate) as unknown as {
      manifest: { files: Array<{ after: { sha256: string } }> };
    };
    malformed.manifest.files[0]!.after.sha256 = `sha256:${'0'.repeat(64)}`;
    assert.throws(
      () => parseImmutableGitCandidate(`${canonicalJson(malformed)}\n`),
      (error) => isWorkflowError(error, 'IMMUTABLE_GIT_CANDIDATE_INVALID'),
    );

    writeCandidateJson(fixture.policyPath, {
      ...current,
      requiredChecks: ['candidate-fail'],
    });
    assert.throws(
      () =>
        verifyImmutableGitCandidateAgainstRepository(
          fixture.repository,
          candidate,
        ),
      (error) => isWorkflowError(error, 'IMMUTABLE_GIT_CANDIDATE_DRIFT'),
    );
  } finally {
    fixture.dispose();
  }

  const unrecognizedPolicyFixture = createNeutralCandidateFixture(
    'unrecognized-policy',
    neutralPolicy(),
  );
  try {
    fs.writeFileSync(
      unrecognizedPolicyFixture.policyPath,
      '{"phase":"sealed","requiredChecks":\n',
    );
    const before = candidateRepositorySnapshot(
      unrecognizedPolicyFixture.repository,
    );
    const candidate = buildImmutableGitCandidate(
      unrecognizedPolicyFixture.repository,
      {
        targetRef: 'refs/heads/main',
        expectedOldCommit: unrecognizedPolicyFixture.baseCommit,
        observeCheckIds: ['candidate-mutate'],
      },
    );
    assert.deepEqual(
      candidate.policyObservations.map(({ kind }) => kind),
      ['policy-bytes-unrecognized.v1'],
    );
    assert.deepEqual(
      candidate.checkObservations.map(({ checkId }) => checkId),
      ['candidate-mutate'],
    );
    assert.equal(
      fs.existsSync(
        path.join(
          unrecognizedPolicyFixture.repository,
          '.git/pre-grant-check-ran',
        ),
      ),
      false,
    );
    const forged = structuredClone(candidate) as unknown as Record<
      string,
      unknown
    > & {
      checkObservations: Array<Record<string, unknown>>;
      checkObservationsDigest: string;
      candidateDigest: string;
    };
    const forgedObservation = forged.checkObservations[0]!;
    forgedObservation.runnerDigest = '0'.repeat(64);
    const forgedObservationBody = { ...forgedObservation };
    delete forgedObservationBody.observationDigest;
    forgedObservation.observationDigest = neutralCandidateDigest(
      canonicalJson(forgedObservationBody),
    );
    forged.checkObservationsDigest = neutralCandidateDigest(
      canonicalJson(forged.checkObservations),
    );
    const { candidateDigest: _forgedCandidateDigest, ...forgedCandidateBody } =
      forged;
    forged.candidateDigest = neutralCandidateDigest(
      canonicalJson(forgedCandidateBody),
    );
    const parsedForgery = parseImmutableGitCandidate(
      `${canonicalJson(forged)}\n`,
    );
    assert.throws(
      () =>
        verifyImmutableGitCandidateAgainstRepository(
          unrecognizedPolicyFixture.repository,
          parsedForgery,
        ),
      (error) => isWorkflowError(error, 'IMMUTABLE_GIT_CANDIDATE_DRIFT'),
    );
    assert.deepEqual(
      candidateRepositorySnapshot(unrecognizedPolicyFixture.repository),
      before,
    );
    assert.deepEqual(
      verifyImmutableGitCandidateAgainstRepository(
        unrecognizedPolicyFixture.repository,
        candidate,
      ),
      candidate,
    );
  } finally {
    unrecognizedPolicyFixture.dispose();
  }

  const bootstrapPathFixture = createNeutralCandidateFixture(
    'bootstrap-path-removal',
    neutralPolicy({ sealedImmutablePaths: ['workflow/**'] }),
  );
  try {
    const current = JSON.parse(
      fs.readFileSync(bootstrapPathFixture.policyPath, 'utf8'),
    ) as NeutralPolicy;
    writeCandidateJson(bootstrapPathFixture.policyPath, {
      ...current,
      sealedImmutablePaths: [],
    });
    const candidate = buildImmutableGitCandidate(
      bootstrapPathFixture.repository,
      {
        targetRef: 'refs/heads/main',
        expectedOldCommit: bootstrapPathFixture.baseCommit,
      },
    );
    assert.deepEqual(candidate.policyObservations, []);
  } finally {
    bootstrapPathFixture.dispose();
  }

  const symlinkFixture = createNeutralCandidateFixture(
    'symlink',
    neutralPolicy(),
  );
  try {
    fs.unlinkSync(symlinkFixture.policyPath);
    fs.symlinkSync('../checks/pass.mjs', symlinkFixture.policyPath);
    assert.throws(
      () =>
        buildImmutableGitCandidate(symlinkFixture.repository, {
          targetRef: 'refs/heads/main',
          expectedOldCommit: symlinkFixture.baseCommit,
        }),
      (error) => isWorkflowError(error, 'IMMUTABLE_GIT_CANDIDATE_PATH_UNSAFE'),
    );
  } finally {
    symlinkFixture.dispose();
  }

  const crashFixture = createNeutralCandidateFixture(
    'preview-crash',
    neutralPolicy(),
  );
  try {
    const current = JSON.parse(
      fs.readFileSync(crashFixture.policyPath, 'utf8'),
    ) as NeutralPolicy;
    writeCandidateJson(crashFixture.policyPath, {
      ...current,
      requiredChecks: ['candidate-pass'],
    });
    const before = candidateRepositorySnapshot(crashFixture.repository);
    assert.throws(
      () =>
        buildImmutableGitCandidate(
          crashFixture.repository,
          {
            targetRef: 'refs/heads/main',
            expectedOldCommit: crashFixture.baseCommit,
          },
          {
            testAfterPreview: () => {
              throw new Error('interrupt after isolated preview');
            },
          },
        ),
      /interrupt after isolated preview/u,
    );
    assert.deepEqual(
      candidateRepositorySnapshot(crashFixture.repository),
      before,
    );
  } finally {
    crashFixture.dispose();
  }
});

const manifestBody: PatchManifest = {
  schema: 'maintainer-patch-manifest.v2',
  profile: 'workflow-engine-bootstrap',
  profileVersion: 1,
  trustBaseCommit: OID_A,
  policyDigest: DIGEST,
  files: [
    {
      path: 'packages/workflow-engine/src/example.ts',
      role: 'implementation',
      operation: 'modify',
      beforeBlobOid: OID_A,
      afterSha256: DIGEST,
      beforeMode: '100644',
      afterMode: '100644',
    },
  ],
  patchDigest: '',
};
const manifest: PatchManifest = {
  ...manifestBody,
  patchDigest: crypto
    .createHash('sha256')
    .update(canonicalPatchManifest(manifestBody))
    .digest('hex'),
};

function checks(
  completedAt = '2026-08-03T09:00:00.000Z',
): CandidateChecksAttestationV3['checks'] {
  return [
    {
      checkId: 'workflow-tests',
      definitionDigest: '2'.repeat(64),
      commandDigest: '3'.repeat(64),
      runnerDigest: '4'.repeat(64),
      environmentDigest: ENVIRONMENT,
      resultDigest: '5'.repeat(64),
      outcome: 'passed',
      startedAt: '2026-08-03T08:59:00.000Z',
      completedAt,
      reuseClass: 'toolchain-dependent',
      maxAgeMs: 86_400_000,
      externalSnapshotDigest: null,
      dependsOn: ['harness-engine', 'runner', 'source-tree'],
    },
  ];
}

function checksV3(
  completedAt = '2026-08-03T09:00:00.000Z',
): CandidateChecksAttestationV3 {
  return {
    schemaVersion: 3,
    candidateTree: TREE,
    patchDigest: manifest.patchDigest,
    trustBaseCommit: OID_A,
    dependencySnapshot: {
      schemaVersion: 1,
      sourceTree: TREE,
      baseCommit: OID_A,
      harnessEngineDigest: '6'.repeat(64),
      policyDigest: DIGEST,
      runnerDigests: { 'workflow-tests': '4'.repeat(64) },
      externalStateDigests: { 'workflow-tests': null },
    },
    checks: checks(completedAt),
  };
}

function candidateBundle(commitMessage = 'Apply exact candidate\n') {
  return buildImmutableCandidateBundleV2({
    mandateBinding,
    repositoryId: 'github:R_fixture',
    targetRef: 'refs/heads/work/demo-change',
    expectedOldCommit: OID_A,
    expectedRefGeneration: 7,
    candidateCommit: OID_B,
    resultTree: TREE,
    commitMessage,
    manifest,
    checksAttestation: checksV3(),
    effectsManifestDigest: '6'.repeat(64),
    providerInvocationsDigest: '7'.repeat(64),
    classification: 'ordinary',
    recoveryPlanDigest: '8'.repeat(64),
    createdAt: '2026-08-03T09:01:00.000Z',
  }).bundle;
}

function retiredV1CandidateBytes(): string {
  const current = candidateBundle();
  const legacyChecks = {
    schemaVersion: 2 as const,
    candidateTree: current.checksAttestation.candidateTree,
    patchDigest: current.checksAttestation.patchDigest,
    trustBaseCommit: current.checksAttestation.trustBaseCommit,
    checks: current.checksAttestation.checks,
  };
  const {
    schemaVersion: _schemaVersion,
    humanReadableSummaryDigest: _humanReadableSummaryDigest,
    candidateBundleDigest: _candidateBundleDigest,
    checksAttestation: _checksAttestation,
    checksAttestationDigest: _checksAttestationDigest,
    ...common
  } = current;
  const body = {
    schemaVersion: 1 as const,
    ...common,
    checksAttestation: legacyChecks,
    checksAttestationDigest: canonicalDigest(legacyChecks),
  };
  return `${canonicalJson({
    ...body,
    candidateBundleDigest: canonicalDigest(body),
  })}\n`;
}

function canonicalDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

test('immutable candidate identity binds commit, result tree, manifests, effects, and message', () => {
  const candidate = candidateBundle();

  assert.match(candidate.candidateBundleDigest, /^[0-9a-f]{64}$/);
  assert.equal(candidate.resultTree, TREE);
  assert.equal(candidate.expectedRefGeneration, 7);
  const changedMessage = candidateBundle('Apply different candidate\n');
  assert.notEqual(
    changedMessage.candidateBundleDigest,
    candidate.candidateBundleDigest,
  );

  const canonical = canonicalImmutableCandidateBundle(candidate);
  assert.deepEqual(parseImmutableCandidateBundle(canonical), candidate);
  const unknown = JSON.parse(canonical) as Record<string, unknown>;
  unknown.untrusted = true;
  assert.throws(
    () => parseImmutableCandidateBundle(`${JSON.stringify(unknown)}\n`),
    (error) => isWorkflowError(error, 'APPLY_CANDIDATE_INVALID'),
  );
});

test('immutable candidate parser rejects retired V1 bundles', () => {
  assert.throws(
    () => parseImmutableCandidateBundle(retiredV1CandidateBytes()),
    (error) => isWorkflowError(error, 'APPLY_CANDIDATE_INVALID'),
  );
});

test('candidate checks expose only current dependency-bound freshness verification', async () => {
  const candidateModule =
    await import('../src/modules/authority/maintainer-candidate.ts');
  assert.equal('assertCandidateChecksFresh' in candidateModule, false);
});

test('immutable candidate store is private, content-addressed, canonical, and idempotent', () => {
  const gitCommonDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-candidate-store-')),
  );
  const candidate = candidateBundle();
  try {
    const stored = storeImmutableCandidateBundle(gitCommonDirectory, candidate);
    assert.equal(
      path.basename(stored),
      `${candidate.candidateBundleDigest}.json`,
    );
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(stored)).mode & 0o777, 0o700);
    assert.deepEqual(
      readStoredImmutableCandidateBundle(
        gitCommonDirectory,
        candidate.candidateBundleDigest,
      ),
      candidate,
    );
    assert.equal(
      storeImmutableCandidateBundle(gitCommonDirectory, candidate),
      stored,
    );

    fs.chmodSync(stored, 0o644);
    assert.throws(
      () =>
        readStoredImmutableCandidateBundle(
          gitCommonDirectory,
          candidate.candidateBundleDigest,
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_STORE_INVALID'),
    );
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});

test('current attestation freshness is anchored to original completion', () => {
  const current = structuredClone(checksV3().dependencySnapshot);
  assert.doesNotThrow(() =>
    assertCandidateV2ChecksFresh(checksV3(), {
      now: new Date('2026-08-04T08:59:59.000Z'),
      candidateTree: TREE,
      patchDigest: manifest.patchDigest,
      trustBaseCommit: OID_A,
      requiredChecks: ['workflow-tests'],
      environmentDigest: ENVIRONMENT,
      currentDependencySnapshot: current,
    }),
  );
  assert.throws(
    () =>
      assertCandidateV2ChecksFresh(checksV3(), {
        now: new Date('2026-08-04T09:00:01.000Z'),
        candidateTree: TREE,
        patchDigest: manifest.patchDigest,
        trustBaseCommit: OID_A,
        requiredChecks: ['workflow-tests'],
        environmentDigest: ENVIRONMENT,
        currentDependencySnapshot: current,
      }),
    (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
  );
});

test('candidate v2 compares sealed dependency snapshots instead of caller change hints', () => {
  const current = structuredClone(checksV3().dependencySnapshot);
  assert.doesNotThrow(() =>
    assertCandidateV2ChecksFresh(checksV3(), {
      now: new Date('2026-08-03T09:01:00.000Z'),
      candidateTree: TREE,
      patchDigest: manifest.patchDigest,
      trustBaseCommit: OID_A,
      requiredChecks: ['workflow-tests'],
      environmentDigest: ENVIRONMENT,
      currentDependencySnapshot: { ...current, policyDigest: '9'.repeat(64) },
    }),
  );
  assert.throws(
    () =>
      assertCandidateV2ChecksFresh(checksV3(), {
        now: new Date('2026-08-03T09:01:00.000Z'),
        candidateTree: TREE,
        patchDigest: manifest.patchDigest,
        trustBaseCommit: OID_A,
        requiredChecks: ['workflow-tests'],
        environmentDigest: ENVIRONMENT,
        currentDependencySnapshot: {
          ...current,
          runnerDigests: { 'workflow-tests': '7'.repeat(64) },
        },
      }),
    (error) => isWorkflowError(error, 'APPLY_ATTESTATION_INVALIDATED'),
  );
  assert.throws(
    () =>
      assertCandidateV2ChecksFresh(checksV3(), {
        now: new Date('2026-08-03T09:01:00.000Z'),
        candidateTree: TREE,
        patchDigest: manifest.patchDigest,
        trustBaseCommit: OID_A,
        requiredChecks: ['workflow-tests'],
        environmentDigest: ENVIRONMENT,
        currentDependencySnapshot: {
          ...current,
          harnessEngineDigest: '7'.repeat(64),
        },
      }),
    (error) => isWorkflowError(error, 'APPLY_ATTESTATION_INVALIDATED'),
  );
});

test('ref generation rejects ABA even when the object id returns to the approved base', () => {
  let ledger = createRefGenerationLedger('refs/heads/work/demo-change', OID_A);
  ledger = recordRefGenerationTransition(ledger, {
    expectedOid: OID_A,
    expectedGeneration: 0,
    nextOid: OID_B,
    reason: 'apply',
    at: '2026-08-03T09:02:00.000Z',
  });
  ledger = recordRefGenerationTransition(ledger, {
    expectedOid: OID_B,
    expectedGeneration: 1,
    nextOid: OID_A,
    reason: 'rollback',
    at: '2026-08-03T09:03:00.000Z',
  });

  assert.equal(ledger.currentOid, OID_A);
  assert.equal(ledger.generation, 2);
  assert.throws(
    () => acceptApplyPrestate(ledger, OID_A, 0),
    (error) => isWorkflowError(error, 'APPLY_REF_GENERATION_MISMATCH'),
  );
});

test('ref generation ledger persists an atomic monotonic transition outside candidate data', () => {
  const gitCommonDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ref-generation-ledger-')),
  );
  try {
    const created = ensureDurableRefGenerationLedger(
      gitCommonDirectory,
      'refs/heads/work/demo-change',
      OID_A,
    );
    assert.equal(created.generation, 0);
    recordDurableRefGenerationTransitionUnderLifecycleLock(
      gitCommonDirectory,
      {
        ref: created.ref,
        expectedOid: OID_A,
        expectedGeneration: 0,
        nextOid: OID_B,
        reason: 'apply',
        at: '2026-08-03T09:02:00.000Z',
      },
      () => {},
    );
    const reread = readDurableRefGenerationLedger(
      gitCommonDirectory,
      created.ref,
      true,
    );
    assert.equal(reread.currentOid, OID_B);
    assert.equal(reread.generation, 1);
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});
