import { preflightMaintainerGrantV2 } from '../bootstrap/maintainer-authority-production.ts';
import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import {
  readStoredImmutableCandidateBundle,
  readStoredCandidateHumanReadableSummary,
} from '../src/runtime/storage-journal/maintainer-candidate-reader.ts';
import { readDurableRefGenerationLedger } from '../src/runtime/storage-journal/maintainer-candidate-ref-ledger.ts';
import { git, isWorkflowError } from './fixture.ts';
import { inspectMaintainerGrants } from '../src/runtime/storage-journal/maintainer-store.ts';
import { spawnSync } from 'node:child_process';
import {
  projectAuthorityAttestationRelay,
  issueAuthorityAttestation,
} from '../bootstrap/maintainer-authority-production.ts';
import { verifyBaseAuthorityAttestations } from '../src/composition-root/ci-verification-production.ts';
import { type MaintainerGrantV2Payload } from '../src/modules/authority/maintainer-grant-v2-codec.ts';
import { issueMaintainerGrantV2 } from '../bootstrap/maintainer-authority-production.ts';
import { readAuthoritySession } from '../src/application/control-plane/maintainer-session.ts';
import { startAuthoritySession } from '../bootstrap/maintainer-authority-production.ts';
import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
} from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import {
  verifyAuthorityAuditEvents,
  showAuthorityAuditTask,
} from '../src/runtime/storage-journal/authority-audit-service.ts';

import os from 'node:os';
import { listRangeCommits } from '../src/runtime/repository-validation/commit-replay/ci-git.ts';
import { validateCiAuthorityCommit } from '../src/composition-root/ci-replay-production.ts';
import { replayCommitSequence } from '../src/composition-root/ci-replay-production.ts';
import {
  parseAuthorityApplicationReceiptEnvelope,
  type AuthorityApplicationReceiptEnvelope,
  AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  canonicalAuthorityApplicationReceiptPayload,
  canonicalAuthorityApplicationReceiptEnvelope,
} from '../src/modules/authority/authority-application-receipt.ts';
import { createSshSignedFixture } from './support/ssh-signed-fixture.ts';
import {
  prepareCandidate,
  fakeSigner,
  approveAndApplyMaintainerGrantV2,
  TASK_ID,
  PROFILE_ID,
  fixtureV2SshSigner,
  verifyingReissueSigner,
  externalAuditRoot,
  reissueAndApplyMaintainerGrantV2,
  annotatedTagBody,
  writeAnnotatedTag,
  afterEvidenceExpires,
} from './support/maintainer-grant-v2-fixture.ts';

test('approve-and-apply checks before signing and atomically consumes the exact grant', () => {
  const repository = prepareCandidate();
  const marker = path.join(repository, '.git/v2-check-passed');
  const signed: string[] = [];
  let candidateSigningObserved = false;
  let humanPresenceChecks = 0;
  const baseSigner = fakeSigner(signed, () => {
    assert.equal(fs.readFileSync(marker, 'utf8'), 'passed');
  });
  const signer: MaintainerSignerProvider = {
    ...baseSigner,
    assertHumanPresent() {
      humanPresenceChecks += 1;
    },
  };
  try {
    const result = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Approve and apply the exact checked candidate',
        message: 'Apply exact workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
        testBeforeCandidateCommitSigning: () => {
          assert.equal(fs.readFileSync(marker, 'utf8'), 'passed');
          candidateSigningObserved = true;
        },
      },
    );

    assert.equal(candidateSigningObserved, true);
    assert.equal(humanPresenceChecks, 1);
    assert.equal(result.applied, true);
    assert.equal(result.commitHash, result.candidateCommit);
    assert.equal(
      result.attestationRelayCommand,
      `pnpm workflow maintainer attestation-relay --original ${result.commitHash} --json`,
    );
    assert.match(result.candidateBundleDigest, /^[0-9a-f]{64}$/);
    const storedCandidate = readStoredImmutableCandidateBundle(
      fs.realpathSync(path.join(repository, '.git')),
      result.candidateBundleDigest,
    );
    assert.equal(storedCandidate.schemaVersion, 2);
    if (storedCandidate.schemaVersion !== 2) {
      assert.fail('Production approve-and-apply must emit candidate v2.');
    }
    assert.equal(storedCandidate.candidateCommit, result.candidateCommit);
    assert.equal(storedCandidate.checksAttestation.schemaVersion, 3);
    assert.equal(
      storedCandidate.checksAttestation.dependencySnapshot.sourceTree,
      result.resultTree,
    );
    assert.equal(
      storedCandidate.checksAttestation.dependencySnapshot.baseCommit,
      storedCandidate.expectedOldCommit,
    );
    assert.deepEqual(
      Object.keys(
        storedCandidate.checksAttestation.dependencySnapshot.runnerDigests,
      ),
      ['fixture'],
    );
    const summary = readStoredCandidateHumanReadableSummary(
      fs.realpathSync(path.join(repository, '.git')),
      storedCandidate.humanReadableSummaryDigest,
    );
    assert.match(summary, /^# Immutable Candidate Summary\n/u);
    assert.match(summary, /Change: `demo-change`/u);
    assert.match(summary, /Required checks: `fixture`/u);
    assert.equal(
      git(repository, [
        'show',
        '-s',
        '--format=%T',
        result.candidateCommit,
      ]).trim(),
      result.resultTree,
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      result.commitHash,
    );
    assert.equal(
      fs.readFileSync(
        path.join(repository, 'packages/workflow-engine/src/limits.ts'),
        'utf8',
      ),
      'export const LIMIT = 2;\n',
    );
    assert.match(result.checksAttestationDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal(signed.length, 2);
    assert.equal(
      (JSON.parse(signed[1]!) as { kind?: string }).kind,
      'authority-application-receipt.v1',
    );
    assert.equal(
      result.applicationReceiptTagRef,
      `refs/tags/workflow-grant/application-${result.grantId}`,
    );
    assert.equal(
      (
        JSON.parse(signed[0]!) as {
          candidateBundleDigest: string | null;
        }
      ).candidateBundleDigest,
      result.candidateBundleDigest,
    );
    assert.equal(git(repository, ['status', '--porcelain=v1']), '');
    assert.equal(
      inspectMaintainerGrants(
        fs.realpathSync(path.join(repository, '.git')),
        result.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.deepEqual(
      readDurableRefGenerationLedger(
        fs.realpathSync(path.join(repository, '.git')),
        'refs/heads/work/demo-change',
        true,
      ),
      {
        schemaVersion: 1,
        ref: 'refs/heads/work/demo-change',
        currentOid: result.commitHash,
        generation: 1,
        transitions: [
          {
            fromOid: git(repository, [
              'rev-parse',
              `${result.commitHash}^`,
            ]).trim(),
            toOid: result.commitHash,
            fromGeneration: 0,
            toGeneration: 1,
            reason: 'apply',
            at: '2026-08-03T09:00:00.000Z',
          },
        ],
      },
    );
    assert.equal(
      git(repository, ['rev-parse', '--verify', result.tagRef]).trim().length,
      40,
    );
    assert.equal(
      result.publishCommand,
      `git push git@github.com:example/fixture.git ${result.tagRef}:${result.tagRef}`,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('V2 ordinary Apply refuses required and unused check-registry edits before checks or signing', () => {
  for (const mutation of [
    'required-definition',
    'unused-definition',
  ] as const) {
    const repository = prepareCandidate();
    try {
      const base = git(repository, ['rev-parse', 'HEAD']).trim();
      const registryPath = path.join(repository, 'workflow/checks.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (mutation === 'required-definition') {
        registry.checks.fixture.command.push('updated-definition');
      } else {
        registry.checks.unused = {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        };
      }
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const before = git(repository, ['status', '--porcelain=v1']);
      const preflight = preflightMaintainerGrantV2(repository, {
        profileId: PROFILE_ID,
      });
      assert.equal(preflight.classification, 'control-plane', mutation);
      assert.equal(preflight.grantable, false, mutation);
      const signed: string[] = [];
      assert.throws(
        () =>
          approveAndApplyMaintainerGrantV2(
            repository,
            {
              changeId: 'demo-change',
              taskId: TASK_ID,
              externalEffects: [],
              profileId: PROFILE_ID,
              reason: 'Observe the exact registry control-plane classification',
              message: 'Refuse ordinary registry Apply',
            },
            {
              now: new Date('2026-08-03T09:00:00.000Z'),
              signer: fakeSigner(signed),
            },
          ),
        (error) =>
          isWorkflowError(error, 'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED'),
        mutation,
      );
      assert.deepEqual(signed, [], mutation);
      assert.equal(
        fs.existsSync(path.join(repository, '.git/v2-check-passed')),
        false,
        mutation,
      );
      assert.deepEqual(
        inspectMaintainerGrants(fs.realpathSync(path.join(repository, '.git'))),
        [],
        mutation,
      );
      assert.equal(
        git(repository, ['rev-parse', 'HEAD']).trim(),
        base,
        mutation,
      );
      assert.equal(
        git(repository, ['status', '--porcelain=v1']),
        before,
        mutation,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('maintainer attestation accepts the current signed v2 authority grant', () => {
  const repository = prepareCandidate();
  try {
    git(repository, [
      'commit',
      '--allow-empty',
      '-m',
      'Plan demo-change\n\nChange: demo-change\nTransition: plan',
    ]);
    const signer = fixtureV2SshSigner(repository);
    const applied = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Approve the exact candidate before attesting its rewrite',
        message: 'Apply exact workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
        testPostApprovalBudget: { monotonicNow: () => 0 },
      },
    );
    const parent = git(repository, [
      'rev-parse',
      `${applied.commitHash}^`,
    ]).trim();
    const parentObject = git(repository, ['cat-file', 'commit', parent]);
    const parentMessageBoundary = parentObject.indexOf('\n\n');
    assert.notEqual(parentMessageBoundary, -1);
    const parentMessage = parentObject.slice(parentMessageBoundary + 2);
    const parentParents = git(repository, ['show', '-s', '--format=%P', parent])
      .trim()
      .split(' ')
      .filter(Boolean);
    assert.equal(parentParents.length, 1);
    const rewrittenParent = spawnSync(
      'git',
      ['commit-tree', `${parent}^{tree}`, '-p', parentParents[0]!],
      {
        cwd: repository,
        encoding: 'utf8',
        input: parentMessage,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'GitHub',
          GIT_AUTHOR_EMAIL: 'noreply@github.com',
          GIT_AUTHOR_DATE: '2026-08-03T09:04:00.000Z',
          GIT_COMMITTER_NAME: 'GitHub',
          GIT_COMMITTER_EMAIL: 'noreply@github.com',
          GIT_COMMITTER_DATE: '2026-08-03T09:04:00.000Z',
        },
      },
    );
    assert.equal(rewrittenParent.status, 0, rewrittenParent.stderr);
    const mainParent = rewrittenParent.stdout.trim();
    const originalCommitObject = git(repository, [
      'cat-file',
      'commit',
      applied.commitHash,
    ]);
    const messageBoundary = originalCommitObject.indexOf('\n\n');
    assert.notEqual(messageBoundary, -1);
    const message = originalCommitObject.slice(messageBoundary + 2);
    const rewritten = spawnSync(
      'git',
      ['commit-tree', `${applied.commitHash}^{tree}`, '-p', mainParent],
      {
        cwd: repository,
        encoding: 'utf8',
        input: message,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'GitHub',
          GIT_AUTHOR_EMAIL: 'noreply@github.com',
          GIT_AUTHOR_DATE: '2026-08-03T09:05:00.000Z',
          GIT_COMMITTER_NAME: 'GitHub',
          GIT_COMMITTER_EMAIL: 'noreply@github.com',
          GIT_COMMITTER_DATE: '2026-08-03T09:05:00.000Z',
        },
      },
    );
    assert.equal(rewritten.status, 0, rewritten.stderr);
    const mainCommit = rewritten.stdout.trim();
    git(repository, ['update-ref', 'refs/remotes/origin/main', mainCommit]);

    const relay = projectAuthorityAttestationRelay(
      repository,
      applied.commitHash,
    );
    assert.equal(relay.grantId, applied.grantId);
    assert.equal(relay.mainCommit, mainCommit);
    assert.deepEqual(relay.grantBasePairs, [
      { originalBase: parent, mainBase: mainParent },
    ]);
    assert.equal(
      relay.attestCommand,
      `pnpm workflow maintainer attest --original ${applied.commitHash} ` +
        `--main ${mainCommit} --base ${parent}=${mainParent} --json`,
    );

    const attestation = issueAuthorityAttestation(
      repository,
      {
        originalCommit: applied.commitHash,
        mainCommit,
        grantBasePairs: relay.grantBasePairs,
      },
      {
        now: new Date('2026-08-03T09:06:00.000Z'),
        signer,
      },
    );

    assert.equal(attestation.grantId, applied.grantId);
    assert.equal(
      attestation.envelope.payload.originalCommit,
      applied.commitHash,
    );
    assert.equal(attestation.envelope.payload.mainCommit, mainCommit);
    assert.deepEqual(
      verifyBaseAuthorityAttestations(
        repository,
        mainCommit,
        new Date('2026-08-03T09:07:00.000Z'),
      ),
      {
        attestedAuthorities: [
          {
            grantId: applied.grantId,
            changeId: 'demo-change',
            originalCommit: applied.commitHash,
            mainCommit,
          },
        ],
        directAuthorities: [],
        roleContextSharingTerminalReceipts: [],
      },
    );
    git(repository, ['checkout', '-b', 'work/rotated-history', mainCommit]);
    const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
    const rotated = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    rotated.trustedSigners[0].identity = 'rotated-maintainer';
    fs.writeFileSync(policyPath, `${JSON.stringify(rotated, null, 2)}\n`);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, [
      'commit',
      '-m',
      'Fixture removes a historical signer from current replay trust',
    ]);
    const rotatedHead = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        verifyBaseAuthorityAttestations(
          repository,
          rotatedHead,
          new Date('2026-08-03T09:08:00.000Z'),
        ),
      (error) => isWorkflowError(error, 'CI_ATTESTATION_GRANT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply terminalizes expiry between admission and ref CAS', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let clock = new Date('2026-08-03T09:00:00.000Z');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Exercise the exact pre-CAS grant expiry boundary',
            message: 'Apply expiring workflow candidate',
          },
          {
            now: clock,
            signer,
            commitClock: () => clock,
            testBeforeRefUpdate: () => {
              clock = new Date('2026-08-10T09:00:00.001Z');
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    assert.equal(signed.length, 1);
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      candidateBundleDigest: string;
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const inspection = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(inspection?.state, 'expired');
    assert.equal(
      fs.existsSync(
        path.join(
          gitCommonDirectory,
          'workflow-engine/maintainer-grants/reserved',
          `${payload.grantId}.json`,
        ),
      ),
      false,
    );
    const terminal = JSON.parse(
      fs.readFileSync(
        path.join(
          gitCommonDirectory,
          'workflow-engine/maintainer-grants/terminal',
          `${payload.grantId}.json`,
        ),
        'utf8',
      ),
    ) as { envelope: { payload: { candidateBundleDigest: string } } };
    assert.equal(
      terminal.envelope.payload.candidateBundleDigest,
      payload.candidateBundleDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a fresh G2 applies the exact retained candidate after G1 expires before CAS', () => {
  const repository = prepareCandidate();
  const firstSigned: string[] = [];
  const secondSigned: string[] = [];
  const firstSigner = fakeSigner(firstSigned);
  const secondSigner = verifyingReissueSigner(firstSigner, secondSigned);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const auditRoot = externalAuditRoot(repository);
  let clock = new Date('2026-08-03T09:00:00.000Z');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Expire G1 while retaining its exact immutable candidate',
            message: 'Apply retained workflow candidate',
            ttlMinutes: 1,
          },
          {
            now: clock,
            signer: firstSigner,
            commitClock: () => clock,
            testBeforeRefUpdate: () => {
              clock = new Date('2026-08-03T09:01:00.001Z');
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);

    const firstPayload = JSON.parse(
      firstSigned[0]!,
    ) as MaintainerGrantV2Payload;
    assert.ok(firstPayload.candidateBundle);
    assert.ok(firstPayload.checksAttestation);
    const candidate = firstPayload.candidateBundle;
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, firstPayload.grantId)[0]
        ?.state,
      'expired',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          gitCommonDirectory,
          'workflow-engine/maintainer-grants/reserved',
          `${firstPayload.grantId}.json`,
        ),
      ),
      false,
    );

    const candidateStorePath = path.join(
      gitCommonDirectory,
      'workflow-engine/candidates',
      `${candidate.candidateBundleDigest}.json`,
    );
    const originalCandidateBytes = fs.readFileSync(candidateStorePath, 'utf8');
    const originalCompletedAt = candidate.checksAttestation.checks.map(
      ({ completedAt }) => completedAt,
    );
    const checkMarker = path.join(repository, '.git/v2-check-passed');
    fs.writeFileSync(checkMarker, 'sentinel-after-g1');

    const reapplied = reissueAndApplyMaintainerGrantV2(
      repository,
      {
        priorGrantId: firstPayload.grantId,
        reason: 'Re-sign the still-fresh exact candidate after G1 expiry',
      },
      {
        now: new Date('2026-08-03T09:01:01.000Z'),
        grantId: '44444444-4444-4444-8444-444444444444',
        signer: secondSigner,
      },
    );
    const secondPayload = JSON.parse(
      secondSigned[0]!,
    ) as MaintainerGrantV2Payload;
    assert.notEqual(reapplied.grantId, firstPayload.grantId);
    assert.equal(reapplied.reissuedFromGrantId, firstPayload.grantId);
    assert.equal(
      secondPayload.candidateBundleDigest,
      firstPayload.candidateBundleDigest,
    );
    assert.deepEqual(secondPayload.mandateBinding, firstPayload.mandateBinding);
    assert.deepEqual(
      secondPayload.candidateBundle?.mandateBinding,
      firstPayload.mandateBinding,
    );
    assert.equal(
      secondPayload.candidateBundle?.candidateCommit,
      candidate.candidateCommit,
    );

    assert.equal(reapplied.commitHash, candidate.candidateCommit);
    assert.equal(reapplied.grantId, secondPayload.grantId);
    assert.equal(reapplied.journalState, 'audited');
    assert.equal(fs.readFileSync(checkMarker, 'utf8'), 'sentinel-after-g1');
    assert.equal(
      fs.readFileSync(candidateStorePath, 'utf8'),
      originalCandidateBytes,
    );
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(candidateStorePath))
        .filter((entry) => entry.endsWith('.json')),
      [`${candidate.candidateBundleDigest}.json`],
    );
    assert.deepEqual(
      readStoredImmutableCandidateBundle(
        gitCommonDirectory,
        candidate.candidateBundleDigest,
      ).checksAttestation.checks.map(({ completedAt }) => completedAt),
      originalCompletedAt,
    );
    assert.match(
      git(repository, ['show', '-s', '--format=%B', reapplied.commitHash]),
      /Transition: authority-candidate/,
    );
    assert.doesNotMatch(
      git(repository, ['show', '-s', '--format=%B', reapplied.commitHash]),
      new RegExp(`${firstPayload.grantId}|${reapplied.grantId}`),
    );

    const committedSession = readAuthoritySession(
      repository,
      reapplied.sessionId,
    );
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(firstPayload.repositoryId),
    };
    const auditRecords = scanAuthorityAuditLedger(scope).records.map(
      ({ record }) => record,
    );
    const auditVerification = verifyAuthorityAuditEvents(scope);
    assert.equal(auditVerification.ok, true);
    assert.deepEqual(
      auditRecords.map(({ eventType }) => eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'error',
        'error',
        'apply-grant',
        'cas',
        'poststate',
        'grant-consume',
      ],
    );
    assert.deepEqual(
      auditVerification.events
        .map(({ event }) => event)
        .filter(({ eventType }) => eventType === 'error')
        .map(({ command, errorCode }) => [command?.name, errorCode]),
      [
        ['authority.commit', 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'],
        ['maintainer.approve-and-apply', 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'],
      ],
    );
    const transactionRecords = auditRecords.filter(({ eventType }) =>
      ['cas', 'poststate', 'grant-consume'].includes(eventType),
    );
    assert.deepEqual(
      transactionRecords.map(({ grantDigest }) => grantDigest),
      Array(3).fill(`sha256:${committedSession.grantDigest}`),
    );
    assert.deepEqual(
      transactionRecords.map(
        ({ candidateBundleDigest }) => candidateBundleDigest,
      ),
      Array(3).fill(`sha256:${committedSession.candidateBundleDigest}`),
    );
    assert.equal(
      transactionRecords.every(
        ({ prestateDigest, poststateDigest, resultDigest }) =>
          /^sha256:[0-9a-f]{64}$/.test(prestateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(poststateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(resultDigest),
      ),
      true,
    );
    assert.equal(
      auditRecords.every(
        (record) => Buffer.byteLength(JSON.stringify(record)) < 4_096,
      ),
      true,
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, reapplied.grantId)[0]?.state,
      'consumed',
    );
    assert.throws(
      () =>
        startAuthoritySession(
          repository,
          firstPayload.changeId,
          reapplied.grantId,
          {
            now: new Date('2026-08-03T09:01:04.000Z'),
            signer: secondSigner,
            allowSignedV2Candidate: true,
          },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_UNAVAILABLE'),
    );
    const replaySigned: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          reissueAndApplyMaintainerGrantV2(
            repository,
            {
              priorGrantId: firstPayload.grantId,
              reason: 'Reject a second apply of the retained candidate',
            },
            {
              now: new Date('2026-08-03T09:01:05.000Z'),
              grantId: '55555555-5555-4555-8555-555555555555',
              signer: verifyingReissueSigner(firstSigner, replaySigned),
            },
          ),
        (error) => isWorkflowError(error, 'MAINTAINER_PATCH_STALE_BASE'),
      );
    }
    assert.deepEqual(replaySigned, []);
    const refusal = showAuthorityAuditTask(scope, TASK_ID)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.eventType === 'error' &&
          event.command?.name === 'maintainer.reissue-and-apply',
      );
    assert.equal(refusal.length, 1);
    assert.equal(refusal[0]?.errorCode, 'MAINTAINER_PATCH_STALE_BASE');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reissue rejects a retained candidate after its Task Mandate is revoked', () => {
  const repository = prepareCandidate();
  const firstSigned: string[] = [];
  const secondSigned: string[] = [];
  const signer = fakeSigner(firstSigned);
  let clock = new Date('2026-08-03T09:00:00.000Z');
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Retain an expired candidate for revoked mandate admission',
            message: 'Retain revoked mandate candidate',
            ttlMinutes: 1,
          },
          {
            now: clock,
            signer,
            commitClock: () => clock,
            testBeforeRefUpdate: () => {
              clock = new Date('2026-08-03T09:01:00.001Z');
            },
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
    );
    const firstPayload = JSON.parse(
      firstSigned[0]!,
    ) as MaintainerGrantV2Payload;
    revokeTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T09:01:01.000Z'),
      reason: 'Revoke the task before any retained candidate can be reissued',
      signer,
    });
    assert.throws(
      () =>
        reissueAndApplyMaintainerGrantV2(
          repository,
          {
            priorGrantId: firstPayload.grantId,
            reason: 'Reject reissue after the retained mandate was revoked',
          },
          {
            now: new Date('2026-08-03T09:01:02.000Z'),
            grantId: '44444444-4444-4444-8444-444444444444',
            signer: verifyingReissueSigner(signer, secondSigned),
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(secondSigned, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('remote CI verifies an applied v2 candidate from portable Git authority receipts', () => {
  const repository = prepareCandidate();
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  const cloneParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-v2-receipt-clone-'),
  );
  const clone = path.join(cloneParent, 'repository');
  try {
    const applied = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Publish a portable exact authority application receipt',
        message: 'Apply retained workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer: fixtureV2SshSigner(repository),
      },
    );
    const cloned = spawnSync(
      '/usr/bin/git',
      ['clone', '--no-local', repository, clone],
      { encoding: 'utf8' },
    );
    assert.equal(cloned.status, 0, cloned.stderr);
    git(clone, ['config', 'user.name', 'Fixture Maintainer']);
    git(clone, ['config', 'user.email', 'fixture-maintainer@example.test']);
    assert.match(
      git(repository, ['tag', '--list']),
      new RegExp(`workflow-grant/application-${applied.grantId}`),
    );
    assert.match(
      git(clone, ['tag', '--list']),
      new RegExp(`workflow-grant/application-${applied.grantId}`),
    );
    const head = git(clone, ['rev-parse', 'HEAD']).trim();
    assert.equal(head, applied.commitHash);
    const [commit] = listRangeCommits(clone, base, head);
    assert.ok(commit);
    assert.equal(commit.trailers?.kind, 'authority-candidate');

    const verified = validateCiAuthorityCommit(
      clone,
      commit,
      new Date('2026-08-10T09:00:00.000Z'),
    );
    assert.equal(verified.grantId, applied.grantId);
    assert.equal(verified.changeId, 'demo-change');
    assert.deepEqual(
      replayCommitSequence(clone, [commit], new Map()).authorityGrants,
      [applied.grantId],
    );
    assert.deepEqual(
      verifyBaseAuthorityAttestations(
        clone,
        head,
        new Date('2026-08-10T09:00:00.000Z'),
      ).directAuthorities,
      [
        {
          grantId: applied.grantId,
          changeId: 'demo-change',
          commit: applied.commitHash,
        },
      ],
    );

    const receiptRef = `refs/tags/workflow-grant/application-${applied.grantId}`;
    const originalReceiptTag = git(clone, [
      'rev-parse',
      `${receiptRef}^{tag}`,
    ]).trim();
    const originalReceiptBody = annotatedTagBody(clone, receiptRef);
    const originalReceipt =
      parseAuthorityApplicationReceiptEnvelope(originalReceiptBody);
    const storedCandidate = readStoredImmutableCandidateBundle(
      fs.realpathSync(path.join(repository, '.git')),
      applied.candidateBundleDigest,
    );
    assert.equal(
      originalReceipt.payload.effectsManifestDigest,
      storedCandidate.effectsManifestDigest,
    );
    const validateReceipt = () => validateCiAuthorityCommit(clone, commit);
    const restoreReceipt = () =>
      git(clone, ['update-ref', receiptRef, originalReceiptTag]);

    git(clone, ['update-ref', '-d', receiptRef, originalReceiptTag]);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REQUIRED'),
    );
    assert.throws(
      () => verifyBaseAuthorityAttestations(clone, head),
      (error) => isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REQUIRED'),
    );
    restoreReceipt();

    const candidateSigner = createSshSignedFixture('fixture-maintainer');
    try {
      const candidateSignedEnvelope: AuthorityApplicationReceiptEnvelope = {
        payload: originalReceipt.payload,
        signatureNamespace: AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
        signature: candidateSigner.sign(
          canonicalAuthorityApplicationReceiptPayload(originalReceipt.payload),
          AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
        ),
      };
      writeAnnotatedTag(
        clone,
        receiptRef,
        head,
        canonicalAuthorityApplicationReceiptEnvelope(candidateSignedEnvelope),
      );
      assert.throws(validateReceipt, (error) =>
        isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_SIGNATURE_INVALID'),
      );
      restoreReceipt();
    } finally {
      candidateSigner.dispose();
    }

    const tamperedEnvelope: AuthorityApplicationReceiptEnvelope = {
      ...originalReceipt,
      payload: {
        ...originalReceipt.payload,
        grantEnvelopeDigest: `sha256:${'f'.repeat(64)}`,
      },
    };
    writeAnnotatedTag(
      clone,
      receiptRef,
      head,
      canonicalAuthorityApplicationReceiptEnvelope(tamperedEnvelope),
    );
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_TAMPERED'),
    );
    restoreReceipt();

    const replayRef = `${receiptRef}-replay`;
    writeAnnotatedTag(clone, replayRef, head, originalReceiptBody);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REPLAYED'),
    );
    git(clone, ['update-ref', '-d', replayRef]);

    const wrongRef = `${receiptRef}-wrong`;
    git(clone, ['update-ref', '-d', receiptRef]);
    writeAnnotatedTag(clone, wrongRef, head, originalReceiptBody);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_REF_MISMATCH'),
    );
    git(clone, ['update-ref', '-d', wrongRef]);
    restoreReceipt();

    const wrongGenerationPayload = {
      ...originalReceipt.payload,
      oldRefGeneration: originalReceipt.payload.oldRefGeneration + 1,
      newRefGeneration: originalReceipt.payload.newRefGeneration + 1,
    };
    const receiptSigner = fixtureV2SshSigner(repository);
    const wrongEffectsPayload = {
      ...originalReceipt.payload,
      effectsManifestDigest: 'f'.repeat(64),
    };
    const wrongEffectsEnvelope: AuthorityApplicationReceiptEnvelope = {
      payload: wrongEffectsPayload,
      signatureNamespace: AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      signature: receiptSigner.sign(
        canonicalAuthorityApplicationReceiptPayload(wrongEffectsPayload),
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      ),
    };
    writeAnnotatedTag(
      clone,
      receiptRef,
      head,
      canonicalAuthorityApplicationReceiptEnvelope(wrongEffectsEnvelope),
    );
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_TAMPERED'),
    );
    restoreReceipt();

    const wrongGenerationEnvelope: AuthorityApplicationReceiptEnvelope = {
      payload: wrongGenerationPayload,
      signatureNamespace: AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      signature: receiptSigner.sign(
        canonicalAuthorityApplicationReceiptPayload(wrongGenerationPayload),
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      ),
    };
    writeAnnotatedTag(
      clone,
      receiptRef,
      head,
      canonicalAuthorityApplicationReceiptEnvelope(wrongGenerationEnvelope),
    );
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_GENERATION_MISMATCH'),
    );
    restoreReceipt();

    writeAnnotatedTag(clone, receiptRef, base, originalReceiptBody);
    assert.throws(validateReceipt, (error) =>
      isWorkflowError(error, 'CI_AUTHORITY_V2_RECEIPT_COMMIT_MISMATCH'),
    );
    restoreReceipt();
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(cloneParent, { recursive: true, force: true });
  }
});

test('reissuing a stored candidate rejects stale evidence before signing', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  try {
    const applied = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Create a retained candidate with expiring evidence',
        message: 'Apply retained workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer: fakeSigner(signed),
      },
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    git(repository, [
      'update-ref',
      payload.candidateBundle!.targetRef,
      base,
      applied.commitHash,
    ]);
    git(repository, ['reset', '--mixed', base]);
    const secondSigned: string[] = [];

    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject an ABA transition before asking for a signature',
            manifest: payload.manifest,
            checksAttestation: payload.checksAttestation!,
            candidateBundle: payload.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: '44444444-4444-4444-8444-444444444444',
            signer: fakeSigner(secondSigned),
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_REF_GENERATION_MISMATCH'),
    );
    assert.deepEqual(secondSigned, []);

    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reissue only while original evidence remains fresh',
            manifest: payload.manifest,
            checksAttestation: payload.checksAttestation!,
            candidateBundle: payload.candidateBundle!,
          },
          {
            now: afterEvidenceExpires(
              payload.candidateBundle!.checksAttestation,
            ),
            grantId: '55555555-5555-4555-8555-555555555555',
            signer: fakeSigner(secondSigned),
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_ATTESTATION_STALE'),
    );
    assert.deepEqual(secondSigned, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';
const { revokeTaskMandate } = taskMandateOperations;
