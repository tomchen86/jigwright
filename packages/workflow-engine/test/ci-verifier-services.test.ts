import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createPullRequestVerifier,
  type PullRequestVerification,
} from '../src/application/assurance/pull-request-verification.ts';
import { createBaseAuthorityAttestationVerifier } from '../src/application/assurance/base-authority-attestation.ts';
import { createPreMergeVerifier } from '../src/application/assurance/pre-merge-verification.ts';
import type { PullRequestVerificationServices } from '../src/modules/assurance/ci-verification.ts';
import type { CiAttestationServices } from '../src/modules/assurance/ci-attestation.ts';
import type { PreMergeVerificationServices } from '../src/modules/assurance/pre-merge-verification.ts';
import {
  createPlanningGenerationCurrentnessProof,
  createPreMergeCoverageEntry,
  createRequiredPreMergeCoverage,
  preparePreMergeAssurance,
  completePreMergeAssurance,
} from '../src/modules/assurance/pre-merge-assurance.ts';
import { parseAttestationTag } from '../src/modules/assurance/ci-attestation.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../src/foundation/errors/errors.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const base = 'a'.repeat(40),
  head = 'b'.repeat(40);
function unexpected(): never {
  throw new Error('Unexpected capability observation');
}
const config = {
  schemaVersion: 1 as const,
  repositoryName: 'memory',
  changeRoot: 'changes',
  runtimeDirectory: '.runtime',
  protectedBranches: ['main'],
  branchTemplate: 'change/{changeId}',
};
const git = {
  repositoryRoot: '/memory',
  repositoryRealPath: '/memory',
  gitCommonDirectory: '/memory/.git',
  branch: 'main',
  head,
  tree: 'c'.repeat(40),
  statusEntries: [],
};
function pullRequestServices(
  calls: string[],
  overrides: Partial<PullRequestVerificationServices> = {},
): PullRequestVerificationServices {
  return {
    discoverRepository() {
      calls.push('discover');
      return git;
    },
    assertCiCommit(_root, value) {
      calls.push(`assert:${value}`);
      return value;
    },
    findMergeBase() {
      calls.push('merge-base');
      return base;
    },
    listRangeCommits() {
      calls.push('range');
      return [{ hash: head, parents: [base], subject: 'ordinary' }];
    },
    verifyBaseAuthorityAttestations() {
      calls.push('attestations');
      return {
        attestedAuthorities: [],
        directAuthorities: [],
        roleContextSharingTerminalReceipts: [],
      };
    },
    validateRepositoryStateAtCommit() {
      calls.push('repository');
      return { repositoryRoot: git.repositoryRoot, changes: [], documents: [] };
    },
    validateWorkflowIntegrationAssets() {
      calls.push('assets');
    },
    loadCommittedChangeContract: unexpected,
    currentRepositorySchemaName() {
      calls.push('schema');
      return 'test-current';
    },
    listChangesAtCommit() {
      calls.push('changes');
      return [];
    },
    loadWorkflowConfig() {
      calls.push('config');
      return config;
    },
    readFileAtCommit(_root, _commit, file) {
      calls.push(`base:${file}`);
      return undefined;
    },
    readCurrentFile: unexpected,
    collectHistoricalCollaborationGrantUses: unexpected,
    replayCommitSequence() {
      calls.push('replay');
      return {
        completedTasks: [],
        archivedChanges: [],
        authorityGrants: [],
        requiredCheckDefinitions: {},
        collaborationGrantUses: [],
      };
    },
    assertRoleContextSharingTerminalReceiptUseBijection() {
      calls.push('bijection');
    },
    listRangePaths() {
      calls.push('paths');
      return [];
    },
    loadChecksConfig() {
      calls.push('check-config');
      return { schemaVersion: 1, checks: {} };
    },
    runCiChecksAtCommit() {
      calls.push('checks');
      return [];
    },
    ...overrides,
  };
}
function attestationServices(
  overrides: Partial<CiAttestationServices> = {},
): CiAttestationServices {
  return {
    listVerifiedRoleContextSharingTerminalReceipts: unexpected,
    listFirstParentHashes: unexpected,
    commitFacts: unexpected,
    listTagRefs: unexpected,
    readTagObject: unexpected,
    readHistoricalPolicyBlob: unexpected,
    readHistoricalPolicyContent: unexpected,
    resolveTagCommit: unexpected,
    resolveCommitTree: unexpected,
    readFileAtCommit: unexpected,
    verifySshDataSignature: unexpected,
    verifyTrustedCommitSignature: unexpected,
    validateCiAuthorityCommit: unexpected,
    readHumanResolutionAuditTag: unexpected,
    ...overrides,
  };
}
function preMergeServices(
  overrides: Partial<PreMergeVerificationServices> = {},
): PreMergeVerificationServices {
  return {
    discoverRepository: unexpected,
    loadWorkflowConfig: unexpected,
    currentRepositorySchemaName: unexpected,
    listRangeCommits: unexpected,
    committedPlanningGeneration: unexpected,
    commitFacts: unexpected,
    commitChangedPaths: unexpected,
    latestPlanCommit: unexpected,
    commitsChangingPath: unexpected,
    resolveAncestorMergeBase: unexpected,
    loadCommittedChangeContract: unexpected,
    productionPlanningAssurance: { validateReadiness: unexpected },
    productionConsumedPlanReviewReplayPort: {
      verify: unexpected,
      verifyRoleContextSharing: unexpected,
    },
    storePreMergeAssuranceForRepository: unexpected,
    readPreMergeAssuranceForRepository: unexpected,
    ...overrides,
  };
}
function verification(): PullRequestVerification {
  return {
    base,
    head,
    mergeBase: base,
    commits: [head],
    completedTasks: [],
    archivedChanges: [],
    authorityGrants: [],
    attestedAuthorities: [],
    directAuthorities: [],
    changedPaths: [],
    checks: [],
    managedDocuments: [],
    runtimeReportsTrusted: false,
  };
}

test('all CI factories construct without observing repository, signature, provider or journal capabilities', () => {
  const calls: string[] = [];
  createPullRequestVerifier(pullRequestServices(calls));
  createBaseAuthorityAttestationVerifier(attestationServices());
  createPreMergeVerifier({
    ...preMergeServices(),
    verifyPullRequest: unexpected,
  });
  assert.deepEqual(calls, []);
});
test('head mismatch preserves initial observation sequence and rejects before ancestry or policies', () => {
  const calls: string[] = [];
  const verifier = createPullRequestVerifier(
    pullRequestServices(calls, {
      discoverRepository() {
        calls.push('discover');
        return { ...git, head: base, statusEntries: ['dirty'] };
      },
    }),
  );
  assert.throws(
    () => verifier.verifyPullRequest('/memory', base, head),
    (error) =>
      error instanceof WorkflowError && error.code === 'CI_HEAD_MISMATCH',
  );
  assert.deepEqual(calls, ['discover', `assert:${base}`, `assert:${head}`]);
});
test('absent base policies never trigger current-file reads and checks follow replay/bijection', () => {
  const calls: string[] = [];
  const result = createPullRequestVerifier(
    pullRequestServices(calls),
  ).verifyPullRequest('/memory', base, head);
  assert.deepEqual(calls, [
    'discover',
    `assert:${base}`,
    `assert:${head}`,
    'merge-base',
    'range',
    'attestations',
    'repository',
    'assets',
    'schema',
    'config',
    'changes',
    'base:workflow/config.json',
    'base:workflow/document-policy.json',
    'replay',
    'bijection',
    'paths',
    'check-config',
    'checks',
  ]);
  assert.deepEqual(result.commits, [head]);
});
test('policy mismatch stops before the next policy, replay and checks', () => {
  const calls: string[] = [];
  const verifier = createPullRequestVerifier(
    pullRequestServices(calls, {
      readFileAtCommit(_root, _commit, file) {
        calls.push(`base:${file}`);
        return 'before';
      },
      readCurrentFile(_root, file) {
        calls.push(`current:${file}`);
        return 'after';
      },
    }),
  );
  assert.throws(
    () => verifier.verifyPullRequest('/memory', base, head),
    (error) =>
      error instanceof WorkflowError && error.code === 'CI_POLICY_CHANGED',
  );
  assert.deepEqual(calls.slice(-2), [
    'base:workflow/config.json',
    'current:workflow/config.json',
  ]);
  assert.ok(!calls.includes('replay'));
});
test('ordinary protected history returns before policy, tag and signature observations', () => {
  const calls: string[] = [];
  const verifier = createBaseAuthorityAttestationVerifier(
    attestationServices({
      listVerifiedRoleContextSharingTerminalReceipts() {
        calls.push('receipts');
        return [];
      },
      listFirstParentHashes() {
        calls.push('history');
        return [base];
      },
      commitFacts() {
        calls.push('facts');
        return {
          hash: base,
          tree: head,
          parents: [],
          message: 'ordinary commit',
        };
      },
    }),
  );
  assert.deepEqual(verifier.verifyBaseAuthorityAttestations('/memory', base), {
    attestedAuthorities: [],
    directAuthorities: [],
    roleContextSharingTerminalReceipts: [],
  });
  assert.deepEqual(calls, ['receipts', 'history', 'facts']);
});
test('direct candidate replay failure retains its exact error identity when no attestation exists', () => {
  const calls: string[] = [];
  const failure = workflowError(
    'MEMORY_DIRECT_FAILURE',
    'exact replay error',
    ExitCode.verification,
  );
  const policy = {
    schemaVersion: 1,
    repository: {
      id: 'github:memory',
      origin: 'https://github.com/test/memory.git',
    },
    phase: 'sealed',
    auditTagPrefix: 'refs/tags/workflow-grant/',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: [],
    sealedImmutablePaths: [],
    requiredChecks: ['test'],
    trustedSigners: [
      {
        identity: 'memory',
        publicKey: 'ssh-ed25519 AAAA',
        fingerprint: 'SHA256:' + 'a'.repeat(43),
      },
    ],
  };
  const verifier = createBaseAuthorityAttestationVerifier(
    attestationServices({
      listVerifiedRoleContextSharingTerminalReceipts() {
        return [];
      },
      listFirstParentHashes() {
        return [base];
      },
      commitFacts() {
        return {
          hash: base,
          tree: head,
          parents: [head],
          message:
            'Candidate\n\nChange: memory-change\nTransition: authority-candidate',
        };
      },
      readFileAtCommit(_root, _commit, file) {
        calls.push(file);
        return JSON.stringify(
          file === 'workflow/maintainer-policy.json' ? policy : config,
        );
      },
      listTagRefs(_root, prefix) {
        calls.push(prefix);
        return [];
      },
      validateCiAuthorityCommit() {
        calls.push('direct');
        throw failure;
      },
    }),
  );
  assert.throws(
    () => verifier.verifyBaseAuthorityAttestations('/memory', base),
    (error) => error === failure,
  );
  assert.equal(calls.at(-1), 'direct');
  assert.equal(calls.length, 5);
});
test('canonical attestation parser rejects malformed tag bytes without external capabilities', () => {
  assert.throws(
    () => parseAttestationTag('memory', 'object bad\nno separator'),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'CI_ATTESTATION_TAG_INVALID',
  );
});
test('pre-merge completion checks absence first and skips journal reads without cwd', () => {
  const api = createPreMergeVerifier({
    ...preMergeServices(),
    verifyPullRequest: unexpected,
  });
  assert.throws(
    () =>
      api.completePreparedPullRequestPreMergeAssurance(
        { verification: verification(), prepared: null },
        null,
        '/memory',
      ),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'PRE_MERGE_ASSURANCE_UNAVAILABLE',
  );
  const prepared = coveredPreparation();
  const result = api.completePreparedPullRequestPreMergeAssurance(
    { verification: verification(), prepared },
    null,
  );
  assert.equal(result.preMergeAssurance.requiredCoverage.headCommit, head);
});
test('pre-merge cached completion preserves stored object identity and skips persistence', () => {
  const prepared = coveredPreparation();
  const stored = completePreMergeAssurance(prepared, null),
    calls: string[] = [];
  const api = createPreMergeVerifier({
    ...preMergeServices({
      readPreMergeAssuranceForRepository(cwd, b, h) {
        calls.push(cwd, b, h);
        return stored;
      },
    }),
    verifyPullRequest: unexpected,
  });
  assert.equal(
    api.completePreparedPullRequestPreMergeAssurance(
      { verification: verification(), prepared },
      null,
      '/memory',
    ).preMergeAssurance,
    stored,
  );
  assert.deepEqual(calls, ['/memory', base, head]);
});
for (const entry of [
  'modules/assurance/ci-verification.ts',
  'modules/assurance/ci-attestation.ts',
  'modules/assurance/pre-merge-verification.ts',
  'modules/assurance/documentation-closure.ts',
])
  test(`${entry} keeps a complete pure type and value closure`, () => {
    assert.ok(
      assertPureDependencyClosure(
        path.resolve(import.meta.dirname, '../src', entry),
      ).size > 1,
    );
  });

function coveredPreparation() {
  const entry = createPreMergeCoverageEntry({
    category: 'implementation',
    changeId: 'memory-change',
    subjectDigest: 'a'.repeat(64),
    paths: ['src/main.ts'],
    contextDigests: ['b'.repeat(64)],
  });
  return preparePreMergeAssurance({
    requiredCoverage: createRequiredPreMergeCoverage({
      baseCommit: base,
      headCommit: head,
      entries: [entry],
      integrationSubjectDigest: null,
    }),
    planningCurrentness: [
      createPlanningGenerationCurrentnessProof({
        changeId: 'memory-change',
        planningGenerationId: 'e'.repeat(64),
        planCommit: base,
        taskBindings: [
          {
            taskId: '1.1',
            taskCommit: head,
            planningGenerationId: 'e'.repeat(64),
          },
        ],
        supersedingPlanCommits: [],
        ancestorPairs: [{ ancestor: base, descendant: head }],
      }),
    ],
    existingCoverage: [
      {
        source: 'task-diff-review',
        nodeId: 'c'.repeat(64),
        resultDigest: 'd'.repeat(64),
        coveredEntryDigests: [entry.entryDigest],
      },
    ],
  });
}

test('async pre-merge rejects a range without reviewed tasks before cache or provider access', async () => {
  const calls: string[] = [];
  const environment = { CI: 'memory' },
    evaluatedAt = new Date('2026-01-01T00:00:00Z');
  const api = createPreMergeVerifier({
    ...preMergeServices({
      discoverRepository() {
        calls.push('discover');
        return git;
      },
      loadWorkflowConfig() {
        calls.push('config');
        return config;
      },
      currentRepositorySchemaName() {
        calls.push('schema');
        return 'current';
      },
      listRangeCommits() {
        calls.push('range');
        return [{ hash: head, parents: [base], subject: 'ordinary' }];
      },
    }),
    verifyPullRequest(cwd, b, h, env, at) {
      calls.push('verify');
      assert.equal(cwd, '/memory');
      assert.equal(b, base);
      assert.equal(h, head);
      assert.equal(env, environment);
      assert.equal(at, evaluatedAt);
      return verification();
    },
  });
  await assert.rejects(
    api.verifyPullRequestWithPreMergeAssurance('/memory', base, head, {
      environment,
      evaluatedAt,
      invokeIntegrationReview: async () => unexpected(),
    }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'PRE_MERGE_ASSURANCE_UNAVAILABLE',
  );
  assert.deepEqual(calls, ['verify', 'discover', 'config', 'schema', 'range']);
});

test('pre-merge conflicting cached coverage is rejected before persistence or completion', () => {
  const prepared = coveredPreparation(),
    stored = completePreMergeAssurance(prepared, null);
  const api = createPreMergeVerifier({
    ...preMergeServices({
      readPreMergeAssuranceForRepository() {
        return { ...stored, uncoveredEntryDigests: ['e'.repeat(64)] };
      },
    }),
    verifyPullRequest: unexpected,
  });
  assert.throws(
    () =>
      api.completePreparedPullRequestPreMergeAssurance(
        { verification: verification(), prepared },
        null,
        '/memory',
      ),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'PRE_MERGE_ASSURANCE_INVALID',
  );
});
