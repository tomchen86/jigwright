/** Signed collaboration Grant envelopes, CLI authority, durable reservation and revocation. */
import test from 'node:test';
import {
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  authoritativeCollaborationGrantVerifierForTest,
} from './fixture.ts';
import {
  issueCollaborationGrant,
  prepareCollaborationGrantIssue,
} from '../src/runtime/grants/collaboration-grant-issuance.ts';
import {
  canonicalCollaborationGrantPayload,
  canonicalCollaborationGrantEnvelope,
  parseCollaborationGrantEnvelope,
  collaborationGrantEnvelopeDigest,
  validateCollaborationGrantEnvelope,
} from '../src/runtime/grants/grant-services.ts';
import {
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from '../src/modules/provider-orchestration/role-independence.ts';
import type {
  CollaborationGrantEnvelope,
  CollaborationGrantPayload,
  CollaborationGrantExpectedBinding,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collaborationGrantStorePaths } from '../src/runtime/storage-journal/collaboration-grant-private-files.ts';
import {
  storeAvailableCollaborationGrant,
  reserveCollaborationGrant,
  reserveCollaborationGrantUnderLifecycleLock,
  readReservedCollaborationGrantUnderLifecycleLock,
} from '../src/runtime/storage-journal/collaboration-grant-reservation.ts';
import {
  consumeCollaborationGrant,
  readExactConsumedCollaborationGrantUse,
  consumeCollaborationGrantUnderLifecycleLock,
  failCollaborationReservationUnderLifecycleLock,
} from '../src/runtime/storage-journal/collaboration-grant-consumption.ts';
import { revokeCollaborationGrant } from '../src/composition-root/collaboration-grant-production.ts';
import {
  inspectCollaborationGrants,
  readCollaborationGrantInspection,
} from '../src/runtime/storage-journal/collaboration-grant-records.ts';
import type { CollaborationConsumptionRequest } from '../src/modules/authority/collaboration-grant-records.ts';
import { loadWorkflowConformanceVectors } from './support/conformance-vectors.ts';
import type { GrantVerifierPort } from '../src/modules/authority/grant-verifier-port.ts';
import { spawnSync } from 'node:child_process';
import { parseCollaborationGrantArguments } from '../src/entrypoints/cli/collaboration-grant-cli.ts';
import os from 'node:os';
import {
  authorizeGrantedOrdinaryRole,
  admitRoleResult,
} from '../src/composition-root/role-admission-production.ts';
import crypto from 'node:crypto';
import { withRepositoryLifecycleOperation } from '../src/runtime/session-workspace/session-store.ts';
import {
  minimalCollaborationGrantRepository,
  fixtureSigner,
  sameProviderRequest,
  NOW,
  GRANT_ID,
  NEUTRAL_COLLABORATION_GRANT_NAMESPACE,
  POLICY,
  snapshotGrantStore,
  vectorSignature,
  expectedBinding,
  vectorSigner,
  collaborationFixture,
  collaborationCliArguments,
  TRANSITION_DIGEST,
  TARGET_DIGEST,
  CONTENT_NODE_ID,
  CONTENT_RESULT_DIGEST,
} from './collaboration-grant-signed-fixture.ts';
import {
  participant,
  roleContent,
} from './collaboration-grant-role-fixture.ts';

test('collaboration issuance is canonical, domain-separated, and has no authority side effects', () => {
  const repository = minimalCollaborationGrantRepository();
  const namespaces: string[] = [];
  const signer = fixtureSigner(namespaces);
  try {
    const request = sameProviderRequest(repository);
    const refsBefore = git(repository, ['for-each-ref', '--format=%(refname)']);
    const headBefore = git(repository, ['rev-parse', 'HEAD']).trim();
    const indexBefore = git(repository, ['write-tree']).trim();
    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: GRANT_ID,
      signer,
    });

    assert.equal(
      canonicalCollaborationGrantPayload(issued.envelope.payload),
      `${JSON.stringify(issued.envelope.payload)}\n`,
    );
    assert.equal(
      canonicalCollaborationGrantEnvelope(issued.envelope),
      `${JSON.stringify(issued.envelope)}\n`,
    );
    assert.deepEqual(
      parseCollaborationGrantEnvelope(
        canonicalCollaborationGrantEnvelope(issued.envelope),
      ),
      issued.envelope,
    );
    assert.equal(issued.envelope.payload.version, 2);
    assert.equal(
      'signatureNamespace' in issued.envelope.payload
        ? issued.envelope.payload.signatureNamespace
        : undefined,
      NEUTRAL_COLLABORATION_GRANT_NAMESPACE,
    );
    assert.deepEqual(namespaces, [
      NEUTRAL_COLLABORATION_GRANT_NAMESPACE,
      NEUTRAL_COLLABORATION_GRANT_NAMESPACE,
    ]);
    assert.notEqual(
      NEUTRAL_COLLABORATION_GRANT_NAMESPACE,
      POLICY.signatureNamespace,
    );
    assert.notEqual(
      DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
      NEUTRAL_COLLABORATION_GRANT_NAMESPACE,
    );
    assert.equal(issued.envelope.payload.maxUses, 1);
    assert.equal(
      issued.envelope.payload.authorizedEffect,
      COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    );
    assert.equal(
      'allowedPaths' in issued.envelope.payload,
      false,
      'collaboration grants must not acquire authority path scope',
    );
    assert.equal('tagRef' in issued, false);
    assert.equal('publishCommand' in issued, false);
    assert.equal(
      git(repository, ['for-each-ref', '--format=%(refname)']),
      refsBefore,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(git(repository, ['write-tree']).trim(), indexBefore);
    assert.equal(git(repository, ['status', '--porcelain']).trim(), '');

    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    assert.equal(
      issued.availableEnvelopePath,
      path.join(paths.available, `${GRANT_ID}.json`),
    );
    assert.equal(
      fs.existsSync(
        path.join(
          common,
          'workflow-engine/maintainer-grants/available',
          `${GRANT_ID}.json`,
        ),
      ),
      false,
    );
    assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(issued.availableEnvelopePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production collaboration parser and store reject retired V1 without durable mutation', () => {
  const repository = minimalCollaborationGrantRepository();
  try {
    const prepared = prepareCollaborationGrantIssue(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer: fixtureSigner() },
    );
    const retiredV1 = structuredClone(prepared.envelope) as unknown as {
      payload: Record<string, unknown>;
      signature: string;
    };
    retiredV1.payload.version = 1;
    delete retiredV1.payload.signatureNamespace;
    const raw = `${JSON.stringify(retiredV1)}\n`;
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const store = collaborationGrantStorePaths(gitCommonDirectory);
    const before = snapshotGrantStore(store.root);

    assert.throws(
      () => parseCollaborationGrantEnvelope(raw),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_INVALID'),
    );
    assert.throws(
      () =>
        storeAvailableCollaborationGrant(
          gitCommonDirectory,
          retiredV1 as unknown as CollaborationGrantEnvelope,
        ),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_INVALID'),
    );
    assert.deepEqual(snapshotGrantStore(store.root), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('portable current collaboration grant vector preserves namespace-V2 signed bytes', () => {
  const vectors = loadWorkflowConformanceVectors(
    import.meta.dirname,
  ).collaborationGrants.filter(({ payload }) => payload.version === 2);
  assert.deepEqual(
    vectors.map(({ payload }) => payload.version),
    [2],
  );
  for (const vector of vectors) {
    const payload = structuredClone(
      vector.payload,
    ) as unknown as CollaborationGrantPayload;
    const envelope: CollaborationGrantEnvelope = {
      payload,
      signature: vector.signature,
    };
    const canonicalPayload = canonicalCollaborationGrantPayload(payload);
    const canonicalEnvelope = canonicalCollaborationGrantEnvelope(envelope);
    assert.equal(
      Buffer.from(canonicalPayload, 'utf8').toString('base64'),
      vector.canonicalPayloadUtf8Base64,
      vector.id,
    );
    assert.equal(
      vector.signature,
      vectorSignature(canonicalPayload, vector.signatureNamespace),
      vector.id,
    );
    assert.equal(
      Buffer.from(canonicalEnvelope, 'utf8').toString('base64'),
      vector.canonicalEnvelopeUtf8Base64,
      vector.id,
    );
    assert.equal(
      collaborationGrantEnvelopeDigest(envelope),
      vector.envelopeSha256,
      vector.id,
    );
    assert.deepEqual(
      parseCollaborationGrantEnvelope(canonicalEnvelope),
      envelope,
      vector.id,
    );
    const namespaces: string[] = [];
    assert.deepEqual(
      validateCollaborationGrantEnvelope(envelope, POLICY, {
        now: NOW,
        expected: expectedBinding(envelope),
        verifier: vectorSigner(namespaces),
      }),
      envelope,
      vector.id,
    );
    assert.deepEqual(namespaces, [vector.signatureNamespace], vector.id);
  }
});

test('collaboration grant versions own one namespace without fallback or pre-validation verification', () => {
  const repository = minimalCollaborationGrantRepository();
  const issuer = fixtureSigner();
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer: issuer },
    );
    const invalidCandidates: unknown[] = [];

    const wrongNamespace = structuredClone(issued.envelope) as unknown as {
      payload: Record<string, unknown>;
    };
    wrongNamespace.payload.signatureNamespace =
      'workflow.collaboration-grant.v1';
    invalidCandidates.push(wrongNamespace);

    const futureVersion = structuredClone(issued.envelope) as unknown as {
      payload: Record<string, unknown>;
    };
    futureVersion.payload.version = 3;
    invalidCandidates.push(futureVersion);

    const missingNamespace = structuredClone(issued.envelope) as unknown as {
      payload: Record<string, unknown>;
    };
    delete missingNamespace.payload.signatureNamespace;
    invalidCandidates.push(missingNamespace);

    const extraKey = structuredClone(issued.envelope) as unknown as {
      payload: Record<string, unknown>;
    };
    extraKey.payload.allowedPaths = ['workflow/checks.json'];
    invalidCandidates.push(extraKey);

    const unknownEffect = structuredClone(issued.envelope) as unknown as {
      payload: Record<string, unknown>;
    };
    unknownEffect.payload.authorizedEffect = 'role-context-sharing-degradation';
    invalidCandidates.push(unknownEffect);

    for (const candidate of invalidCandidates) {
      let verifyCalls = 0;
      const verifier: GrantVerifierPort = {
        verify() {
          verifyCalls += 1;
        },
      };
      assert.throws(
        () =>
          validateCollaborationGrantEnvelope(
            candidate as CollaborationGrantEnvelope,
            POLICY,
            {
              now: NOW,
              expected: expectedBinding(issued.envelope),
              verifier,
            },
          ),
        (error) => isWorkflowError(error, 'COLLABORATION_GRANT_INVALID'),
      );
      assert.equal(verifyCalls, 0);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('collaboration grant CLI requires a controlling TTY and has no unattended escape hatch', () => {
  const repository = collaborationFixture();
  try {
    const request = sameProviderRequest(repository);
    const cli = path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
    );
    const args = collaborationCliArguments(cli, request);
    const nonInteractive = spawnSync(process.execPath, args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(nonInteractive.status, 12, nonInteractive.stderr);
    assert.equal(
      JSON.parse(nonInteractive.stderr).error.code,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/collaboration-grants'),
      ),
      false,
    );

    const unattended = spawnSync(
      process.execPath,
      [...args.slice(0, -1), '--unattended', '--json'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(unattended.status, 2, unattended.stderr);
    assert.equal(JSON.parse(unattended.stderr).error.code, 'INVALID_USAGE');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('collaboration grant CLI validates the base object ID before invoking Git', () => {
  const repository = collaborationFixture();
  try {
    const request = sameProviderRequest(repository);
    const cli = path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
    );
    const args = collaborationCliArguments(cli, request).slice(3, -1);
    const baselineIndex = args.indexOf('--base') + 1;
    args[baselineIndex] = '--not-an-object-id';

    assert.throws(
      () => parseCollaborationGrantArguments(args, repository),
      (error) => isWorkflowError(error, 'INVALID_USAGE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('signed collaboration binding rejects every substituted transition fact', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const request = sameProviderRequest(repository);
    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: GRANT_ID,
      signer,
    });
    const expected = expectedBinding(issued.envelope);
    assert.doesNotThrow(() =>
      validateCollaborationGrantEnvelope(issued.envelope, POLICY, {
        now: new Date(NOW.getTime() + 60_000),
        expected,
        verifier: authoritativeCollaborationGrantVerifierForTest(signer),
      }),
    );

    const substitutions: CollaborationGrantExpectedBinding[] = [
      { ...expected, repositoryId: 'github:R_other' },
      {
        ...expected,
        repositoryOrigin: 'https://github.com/example/other.git',
      },
      { ...expected, policyBlob: '9'.repeat(expected.policyBlob.length) },
      {
        ...expected,
        collaborationPolicyDigest: '8'.repeat(64),
      },
      { ...expected, changeId: 'other-change' },
      { ...expected, taskId: '6.2' },
      {
        ...expected,
        baselineCommit: 'a'.repeat(expected.baselineCommit.length),
      },
      { ...expected, baselineTree: 'b'.repeat(expected.baselineTree.length) },
      { ...expected, targetDigest: 'c'.repeat(64) },
      { ...expected, lifecyclePhase: 'plan-review' },
      {
        ...expected,
        rolePair: {
          authorRole: 'plan-author',
          conflictingRole: 'plan-reviewer',
        },
      },
      {
        ...expected,
        availableActor: {
          kind: 'provider',
          providerId: 'claude',
          assurance: 'runtime-hint',
        },
      },
      { ...expected, degradedForm: 'caller-supplied' },
    ];
    for (const substituted of substitutions) {
      assert.throws(
        () =>
          validateCollaborationGrantEnvelope(issued.envelope, POLICY, {
            now: new Date(NOW.getTime() + 60_000),
            expected: substituted,
            verifier: authoritativeCollaborationGrantVerifierForTest(signer),
          }),
        (error) =>
          isWorkflowError(error, 'COLLABORATION_GRANT_BINDING_MISMATCH'),
      );
    }

    const extra = JSON.parse(
      canonicalCollaborationGrantEnvelope(issued.envelope),
    );
    extra.payload.allowedPaths = ['workflow/checks.json'];
    assert.throws(
      () => parseCollaborationGrantEnvelope(`${JSON.stringify(extra)}\n`),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_INVALID'),
    );

    const altered = structuredClone(issued.envelope);
    altered.payload.reason = 'Altered exact continuation reason';
    assert.throws(
      () =>
        validateCollaborationGrantEnvelope(altered, POLICY, {
          now: new Date(NOW.getTime() + 60_000),
          expected: { ...expected, reason: altered.payload.reason },
          verifier: authoritativeCollaborationGrantVerifierForTest(signer),
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_SIGNATURE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('collaboration store reserves once across worktrees and rejects replay', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  const verifier = authoritativeCollaborationGrantVerifierForTest(signer);
  let linkedWorktree: string | undefined;
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer },
    );
    linkedWorktree = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-collaboration-linked-'),
    );
    fs.rmdirSync(linkedWorktree);
    git(repository, [
      'worktree',
      'add',
      '-b',
      'work/collaboration-linked',
      linkedWorktree,
      'HEAD',
    ]);
    const common = fs.realpathSync(path.join(repository, '.git'));
    const linkedCommon = fs.realpathSync(
      git(linkedWorktree, ['rev-parse', '--git-common-dir']).trim(),
    );
    assert.equal(linkedCommon, common);

    const reservation = reserveCollaborationGrant(linkedWorktree, GRANT_ID, {
      transitionDigest: TRANSITION_DIGEST,
      now: new Date(NOW.getTime() + 60_000),
      expected: expectedBinding(issued.envelope),
      verifier,
    });
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.transitionDigest, TRANSITION_DIGEST);
    assert.throws(
      () =>
        reserveCollaborationGrant(repository, GRANT_ID, {
          transitionDigest: '5'.repeat(64),
          now: new Date(NOW.getTime() + 60_000),
          expected: expectedBinding(issued.envelope),
          verifier,
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_UNAVAILABLE'),
    );

    const assignment = authorizeGrantedOrdinaryRole({
      role: 'plan-reviewer',
      author: participant('codex', 'author-session'),
      targetDigest: TARGET_DIGEST,
      reservation,
      actualParticipant: participant('codex', 'fresh-session'),
      callableProviderIds: ['codex'],
    });
    const consumption: CollaborationConsumptionRequest = {
      transitionDigest: TRANSITION_DIGEST,
      assignment,
      contentAdmission: {
        kind: 'blind-survey',
        nodeId: CONTENT_NODE_ID,
        resultDigest: CONTENT_RESULT_DIGEST,
        current: true,
      },
      now: new Date(NOW.getTime() + 120_000),
      verifier,
    };
    const consumed = consumeCollaborationGrant(common, GRANT_ID, consumption);
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.use?.grantId, GRANT_ID);
    assert.equal(
      consumed.use?.signedEnvelopeDigest,
      crypto
        .createHash('sha256')
        .update(canonicalCollaborationGrantEnvelope(issued.envelope))
        .digest('hex'),
    );
    assert.deepEqual(
      consumed.use?.retainedObligations,
      COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    );
    assert.equal(
      consumed.use?.assignment.achievedIndependence,
      'session-independent',
    );
    assert.equal(
      consumed.use?.assignment.requiredIndependence,
      'provider-independent',
    );
    assert.equal(
      consumed.use?.reservedAt,
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    assert.equal(consumed.use?.replayScope, COLLABORATION_GRANT_REPLAY_SCOPE);
    assert.deepEqual(consumed.use?.residuals, COLLABORATION_GRANT_RESIDUALS);
    assert.ok(consumed.use);
    const admitted = admitRoleResult({
      assignment,
      author: assignment.author,
      participant: assignment.participant,
      content: roleContent('blind-survey'),
      providerInvocation: {
        invocationId: 'same-provider-invocation',
        requestDigest: '5'.repeat(64),
        outputDigest: '6'.repeat(64),
        providerId: 'codex',
        sessionId: 'fresh-session',
        targetDigest: TARGET_DIGEST,
        engineSpawned: true,
      },
      grantUse: consumed.use,
      grantValidation: {
        now: new Date(NOW.getTime() + 120_000),
        expectedBinding: expectedBinding(issued.envelope),
        policy: POLICY,
        verifier: authoritativeCollaborationGrantVerifierForTest(signer),
        transitionDigest: TRANSITION_DIGEST,
      },
    });
    assert.equal(admitted.form, 'granted-same-provider');
    assert.equal(admitted.achievedIndependence, 'session-independent');

    const paths = collaborationGrantStorePaths(common);
    const reservedResidual = path.join(paths.reserved, `${GRANT_ID}.json`);
    fs.writeFileSync(reservedResidual, `${JSON.stringify(reservation)}\n`, {
      mode: 0o600,
    });
    const exactResidual = fs.readFileSync(reservedResidual, 'utf8');
    assert.deepEqual(
      readExactConsumedCollaborationGrantUse(common, GRANT_ID, consumption),
      consumed.use,
    );
    assert.equal(fs.readFileSync(reservedResidual, 'utf8'), exactResidual);

    const mismatchedResidual = JSON.parse(exactResidual);
    mismatchedResidual.transitionDigest = '5'.repeat(64);
    fs.writeFileSync(
      reservedResidual,
      `${JSON.stringify(mismatchedResidual)}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        readExactConsumedCollaborationGrantUse(common, GRANT_ID, consumption),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    const mismatchedTransitionBytes = fs.readFileSync(reservedResidual, 'utf8');
    assert.throws(
      () =>
        consumeCollaborationGrant(common, GRANT_ID, {
          ...consumption,
          now: new Date(NOW.getTime() + 180_000),
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    assert.equal(
      fs.readFileSync(reservedResidual, 'utf8'),
      mismatchedTransitionBytes,
    );
    mismatchedResidual.transitionDigest = TRANSITION_DIGEST;
    mismatchedResidual.envelope.payload.reason =
      'Mismatching interrupted reservation';
    fs.writeFileSync(
      reservedResidual,
      `${JSON.stringify(mismatchedResidual)}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        readExactConsumedCollaborationGrantUse(common, GRANT_ID, consumption),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    fs.writeFileSync(reservedResidual, exactResidual, { mode: 0o600 });

    const repeated = consumeCollaborationGrant(common, GRANT_ID, {
      ...consumption,
      now: new Date(NOW.getTime() + 180_000),
    });
    assert.deepEqual(repeated, consumed);
    assert.throws(
      () =>
        consumeCollaborationGrant(common, GRANT_ID, {
          transitionDigest: TRANSITION_DIGEST,
          assignment,
          contentAdmission: {
            kind: 'blind-survey',
            nodeId: '6'.repeat(64),
            resultDigest: CONTENT_RESULT_DIGEST,
            current: true,
          },
          now: new Date(NOW.getTime() + 180_000),
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_UNAVAILABLE'),
    );
  } finally {
    if (linkedWorktree && fs.existsSync(repository)) {
      try {
        git(repository, ['worktree', 'remove', '--force', linkedWorktree]);
      } catch {
        fs.rmSync(linkedWorktree, { recursive: true, force: true });
      }
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('grant reserve and consume compose under an already-owned lifecycle lock', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  const verifier = authoritativeCollaborationGrantVerifierForTest(signer);
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const consumed = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) => {
        const reservation = reserveCollaborationGrantUnderLifecycleLock(
          repository,
          GRANT_ID,
          {
            transitionDigest: TRANSITION_DIGEST,
            now: new Date(NOW.getTime() + 60_000),
            expected: expectedBinding(issued.envelope),
            verifier,
          },
          assertOwned,
        );
        const assignment = authorizeGrantedOrdinaryRole({
          role: 'plan-reviewer',
          author: participant('codex', 'author-session'),
          targetDigest: TARGET_DIGEST,
          reservation,
          actualParticipant: participant('codex', 'fresh-session'),
          callableProviderIds: ['codex'],
        });
        return consumeCollaborationGrantUnderLifecycleLock(
          common,
          GRANT_ID,
          {
            transitionDigest: TRANSITION_DIGEST,
            assignment,
            contentAdmission: {
              kind: 'blind-survey',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
            now: new Date(NOW.getTime() + 120_000),
            verifier,
          },
          assertOwned,
        );
      },
    );
    assert.equal(consumed.state, 'consumed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reserved grants can be read and failed under the governing lifecycle lock', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  const verifier = authoritativeCollaborationGrantVerifierForTest(signer);
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const failed = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) => {
        const reserved = reserveCollaborationGrantUnderLifecycleLock(
          repository,
          GRANT_ID,
          {
            transitionDigest: TRANSITION_DIGEST,
            now: new Date(NOW.getTime() + 60_000),
            expected: expectedBinding(issued.envelope),
            verifier,
          },
          assertOwned,
        );
        assert.deepEqual(
          readReservedCollaborationGrantUnderLifecycleLock(
            common,
            GRANT_ID,
            assertOwned,
          ),
          reserved,
        );
        return failCollaborationReservationUnderLifecycleLock(
          common,
          GRANT_ID,
          TRANSITION_DIGEST,
          'Provider execution failed before content admission',
          new Date(NOW.getTime() + 120_000),
          assertOwned,
        );
      },
    );
    assert.equal(failed.state, 'failed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expired and revoked collaboration grants never authorize a transition', () => {
  for (const terminal of ['expired', 'revoked'] as const) {
    const repository = collaborationFixture();
    const grantId =
      terminal === 'expired'
        ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    try {
      const signer = fixtureSigner();
      const verifier = authoritativeCollaborationGrantVerifierForTest(signer);
      const issued = issueCollaborationGrant(
        repository,
        { ...sameProviderRequest(repository), ttlMinutes: 1 },
        { now: NOW, grantId, signer },
      );
      if (terminal === 'revoked') {
        const unattended = fixtureSigner();
        unattended.assertHumanPresent = () => {
          throw new Error('no controlling terminal');
        };
        assert.throws(() =>
          revokeCollaborationGrant(repository, grantId, {
            reason: 'Retire unused collaboration authority',
            signer: unattended,
            verifier: signer,
          }),
        );
        assert.equal(
          inspectCollaborationGrants(
            fs.realpathSync(path.join(repository, '.git')),
            grantId,
          )[0]?.state,
          'available',
        );
        const revoked = revokeCollaborationGrant(repository, grantId, {
          reason: 'Retire unused collaboration authority',
          now: new Date(NOW.getTime() + 30_000),
          signer,
          verifier: signer,
        });
        assert.equal(revoked.state, 'revoked');
        assert.deepEqual(
          revokeCollaborationGrant(repository, grantId, {
            reason: 'Retire unused collaboration authority',
            now: new Date(NOW.getTime() + 40_000),
            signer,
            verifier: signer,
          }),
          revoked,
        );
        assert.throws(
          () =>
            revokeCollaborationGrant(repository, grantId, {
              reason: 'A different reason must not replace the tombstone',
              signer,
              verifier: signer,
            }),
          (error) => isWorkflowError(error, 'HUMAN_REVOCATION_CONFLICT'),
        );
      }
      assert.throws(
        () =>
          reserveCollaborationGrant(repository, grantId, {
            transitionDigest: TRANSITION_DIGEST,
            now:
              terminal === 'expired'
                ? new Date(NOW.getTime() + 61_000)
                : new Date(NOW.getTime() + 40_000),
            expected: expectedBinding(issued.envelope),
            verifier,
          }),
        (error) =>
          isWorkflowError(
            error,
            terminal === 'expired'
              ? 'COLLABORATION_GRANT_EXPIRED'
              : 'COLLABORATION_GRANT_UNAVAILABLE',
          ),
      );
      assert.equal(
        inspectCollaborationGrants(
          fs.realpathSync(path.join(repository, '.git')),
          grantId,
        )[0]?.state,
        terminal,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('revoked collaboration terminal records require the current human revocation authorization', () => {
  const repository = collaborationFixture();
  const grantId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  try {
    const signer = fixtureSigner();
    issueCollaborationGrant(repository, sameProviderRequest(repository), {
      now: NOW,
      grantId,
      signer,
    });
    const revoked = revokeCollaborationGrant(repository, grantId, {
      reason: 'Retire unused collaboration authority',
      now: new Date(NOW.getTime() + 30_000),
      signer,
      verifier: signer,
    });
    assert.equal(revoked.state, 'revoked');

    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    const terminalPath = path.join(paths.terminal, `${grantId}.json`);
    const current = JSON.parse(fs.readFileSync(terminalPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const {
      revocationAuthorization: omittedAuthorization,
      ...retiredTerminal
    } = current;
    assert.notEqual(omittedAuthorization, undefined);
    assert.deepEqual(
      omittedAuthorization,
      JSON.parse(
        fs.readFileSync(
          path.join(paths.revocationAuthorizations, `${grantId}.json`),
          'utf8',
        ),
      ),
    );
    const retiredBytes = `${JSON.stringify(retiredTerminal)}\n`;
    fs.writeFileSync(terminalPath, retiredBytes);
    const beforeInspection = snapshotGrantStore(paths.runtime.root);
    const refsBefore = git(repository, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
    ]);
    const statusBefore = git(repository, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);

    assert.throws(
      () => readCollaborationGrantInspection(gitCommonDirectory, grantId),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    assert.equal(fs.readFileSync(terminalPath, 'utf8'), retiredBytes);
    assert.deepEqual(snapshotGrantStore(paths.runtime.root), beforeInspection);
    assert.equal(
      git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
      refsBefore,
    );
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '--untracked-files=all']),
      statusBefore,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
