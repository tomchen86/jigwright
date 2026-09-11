import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  assertCanonicalGrantRecordV1,
  assertCentralGrantPublicDocumentV1,
  parseCanonicalGrantRecordV1,
  type CanonicalGrantRecordV1,
} from '@jigwright/grants/central-grant-contracts';

import {
  approvalSubjectDigest,
  createApprovalSubject,
  createGrantChallenge,
  type GrantChallenge,
} from '../src/modules/authority/grant-core.ts';
import {
  assertSshPortableApprovalEvidenceV1,
  sshPortableApprovalEvidenceDigest,
} from '../src/modules/authority/grant-approval.ts';
import {
  assertGrantLifecycleBarrier,
  grantStorePaths,
  type GrantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  grantRecordDigest,
  parseGrantRecord,
  projectPreparedGrantRecord,
  type GrantRecord,
} from '../src/modules/authority/grant-records.ts';
import {
  createTransitionRegistry,
  type TransitionDefinition,
} from '../src/modules/authority/grant-transition-registry.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-18T02:00:00.000Z');
const EXPIRES_AT = '2026-08-18T02:10:00.000Z';

test('a challenge remains canonical and readable after a new store instance', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const challenge = fixtureChallenge();

    assert.deepEqual(Object.keys(paths).sort(), ['records', 'root']);

    const stored =
      createFileGrantRecordStore(paths).persistGrantChallenge(challenge);
    assert.equal(stored.state, 'pending');
    assert.deepEqual(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        challenge.challengeId,
      ),
      stored,
    );

    const filePath = path.join(paths.records, `${challenge.challengeId}.json`);
    const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      challenge: { failureCode: string };
    };
    tampered.challenge.failureCode = 'agent-substituted-failure';
    fs.writeFileSync(filePath, `${JSON.stringify(tampered)}\n`);
    assert.throws(
      () =>
        createFileGrantRecordStore(paths).readGrantRecord(
          challenge.challengeId,
        ),
      (error) => isWorkflowError(error, 'GRANT_STORE_UNSAFE'),
    );
  });
});

test('one atomic record moves from pending to prepared to terminal exactly once', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const challenge = fixtureChallenge();
    createFileGrantRecordStore(paths).persistGrantChallenge(challenge);
    const subject = createApprovalSubject(
      challenge,
      {
        choiceId: challenge.choices[0]!.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'cannot-complete-review',
        reason: 'The investigation cannot safely continue.',
        sessionNonce: 'nonce-33333333333333333333333333333333',
      },
      { now: NOW },
    );
    const prepared = createFileGrantRecordStore(paths).prepareGrantTransition({
      operationId: '77777777-7777-4777-8777-777777777777',
      challenge,
      subject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: digest('8'),
          identity: null,
          portableEvidence: null,
        },
      ],
      createdAt: NOW.toISOString(),
    });

    assert.equal(prepared.state, 'prepared');
    assert.deepEqual(Object.keys(prepared).sort(), [
      'approvalSubject',
      'challenge',
      'kind',
      'operationId',
      'preparedAt',
      'proofModules',
      'recordedAt',
      'schemaVersion',
      'state',
    ]);
    assert.deepEqual(
      createFileGrantRecordStore(paths).readGrantRecord(challenge.challengeId),
      prepared,
    );
    assert.deepEqual(
      fs.readdirSync(paths.records).filter((name) => name.endsWith('.json')),
      [`${challenge.challengeId}.json`],
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
    assert.doesNotThrow(() =>
      assertGrantLifecycleBarrier(runtimeRoot, [challenge.challengeId]),
    );

    const completed = createFileGrantRecordStore(
      paths,
    ).recordGrantTransitionOutcome({
      challengeId: challenge.challengeId,
      operationId: prepared.operationId,
      poststateDigest: digest('9'),
      outcome: { outcome: 'completed', details: { terminal: true } },
      completedAt: '2026-08-18T02:00:02.000Z',
      audit: {
        approvalMethod: 'human-presence',
        authorityClass: 'local-device-owner',
        identity: null,
        identityAssurance: 'not-asserted',
        presenceAssurance: 'fresh-os-authentication',
        proofModules: ['human-gate-macos@1'],
      },
    });
    assert.equal(completed.state, 'completed');
    assert.deepEqual(Object.keys(completed).sort(), [
      'approvalSubject',
      'audit',
      'challenge',
      'completedAt',
      'kind',
      'operationId',
      'outcome',
      'poststateDigest',
      'preparedAt',
      'proofModules',
      'recordedAt',
      'schemaVersion',
      'state',
    ]);
    assert.deepEqual(
      createFileGrantRecordStore(paths).readGrantRecord(challenge.challengeId),
      completed,
    );
    assert.deepEqual(
      parseGrantRecord(`${canonicalJson(completed)}\n`),
      completed,
    );
    assert.deepEqual(projectPreparedGrantRecord(completed), prepared);
    assert.equal(
      grantRecordDigest(projectPreparedGrantRecord(completed)),
      grantRecordDigest(prepared),
    );
    assert.throws(
      () =>
        parseGrantRecord(`${canonicalJson({ ...completed, extra: true })}\n`),
      (error) => isWorkflowError(error, 'GRANT_STORE_UNSAFE'),
    );
    assert.deepEqual(
      createFileGrantRecordStore(paths).recordGrantTransitionOutcome({
        challengeId: challenge.challengeId,
        operationId: prepared.operationId,
        poststateDigest: digest('9'),
        outcome: { outcome: 'completed', details: { terminal: true } },
        completedAt: '2026-08-18T02:00:02.000Z',
        audit: completed.audit,
      }),
      completed,
    );
    assert.doesNotThrow(() => assertGrantLifecycleBarrier(runtimeRoot));
    assert.throws(
      () =>
        createFileGrantRecordStore(paths).prepareGrantTransition({
          operationId: '88888888-8888-4888-8888-888888888888',
          challenge,
          subject,
          proofModules: prepared.proofModules,
          createdAt: NOW.toISOString(),
        }),
      (error) => isWorkflowError(error, 'GRANT_CHALLENGE_UNAVAILABLE'),
    );
  });
});

test('an exact nested Grant allowance still blocks an unrelated prepared Grant', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const parent = fixtureChallenge('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const child = fixtureChallenge('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    for (const [challenge, operationId, sessionNonce] of [
      [
        parent,
        '11111111-1111-4111-8111-111111111111',
        'nonce-parent-1111111111111111111111111111',
      ],
      [
        child,
        '22222222-2222-4222-8222-222222222222',
        'nonce-child-22222222222222222222222222222',
      ],
    ] as const) {
      createFileGrantRecordStore(paths).persistGrantChallenge(challenge);
      preparePublicRecord(paths, challenge, operationId, sessionNonce);
    }
    assert.doesNotThrow(() =>
      assertGrantLifecycleBarrier(runtimeRoot, [
        parent.challengeId,
        child.challengeId,
      ]),
    );

    const unrelated = fixtureChallenge('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    createFileGrantRecordStore(paths).persistGrantChallenge(unrelated);
    preparePublicRecord(
      paths,
      unrelated,
      '33333333-3333-4333-8333-333333333333',
      'nonce-unrelated-3333333333333333333333333',
    );
    assert.throws(
      () =>
        assertGrantLifecycleBarrier(runtimeRoot, [
          parent.challengeId,
          child.challengeId,
        ]),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
  });
});

test('@jigwright/grants matches exact pending, prepared, completed, and failed live record bytes', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const completedChallenge = fixtureChallenge(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const pending =
      createFileGrantRecordStore(paths).persistGrantChallenge(
        completedChallenge,
      );
    assertPublicRecord(paths, pending);

    const prepared = preparePublicRecord(
      paths,
      completedChallenge,
      '77777777-7777-4777-8777-777777777777',
      'nonce-77777777777777777777777777777777',
    );
    assertPublicRecord(paths, prepared);

    const completed = createFileGrantRecordStore(
      paths,
    ).recordGrantTransitionOutcome({
      challengeId: completedChallenge.challengeId,
      operationId: prepared.operationId,
      poststateDigest: digest('9'),
      outcome: { outcome: 'completed', details: { accepted: true } },
      completedAt: '2026-08-18T02:00:02.000Z',
      audit: humanPresenceAudit(),
    });
    assertPublicRecord(paths, completed);

    const failedChallenge = fixtureChallenge(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    createFileGrantRecordStore(paths).persistGrantChallenge(failedChallenge);
    const preparedToFail = preparePublicSshRecord(
      paths,
      failedChallenge,
      '88888888-8888-4888-8888-888888888888',
      'nonce-88888888888888888888888888888888',
    );
    const failed = createFileGrantRecordStore(
      paths,
    ).recordGrantTransitionOutcome({
      challengeId: failedChallenge.challengeId,
      operationId: preparedToFail.operationId,
      poststateDigest: digest('8'),
      outcome: { outcome: 'failed', details: { reason: 'state-changed' } },
      completedAt: '2026-08-18T02:00:03.000Z',
      audit: sshAudit(),
    });
    assertPublicRecord(paths, failed);

    assert.throws(
      () => parseCanonicalGrantRecordV1(canonicalJson(completed)),
      /malformed/u,
    );
    assert.throws(
      () =>
        assertCanonicalGrantRecordV1({
          ...pending,
          agentInjectedApproval: true,
        }),
      /malformed/u,
    );
    assert.throws(
      () =>
        assertCanonicalGrantRecordV1({
          ...completed,
          outcome: { outcome: 'failed', details: completed.outcome.details },
        }),
      /malformed/u,
    );
    const invalidClaim = JSON.parse(canonicalJson(prepared)) as {
      proofModules: Array<{ claim: string }>;
    };
    invalidClaim.proofModules[0]!.claim = 'agent-asserted-approval';
    assert.throws(
      () => assertCanonicalGrantRecordV1(invalidClaim),
      /malformed/u,
    );
  });
});

test('tampered portable SSH evidence makes the durable Grant record unreadable', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const challenge = fixtureChallenge();
    createFileGrantRecordStore(paths).persistGrantChallenge(challenge);
    preparePublicSshRecord(
      paths,
      challenge,
      '45454545-4545-4454-8454-454545454545',
      'nonce-45454545454545454545454545454545',
    );
    const recordPath = path.join(
      paths.records,
      `${challenge.challengeId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      proofModules: Array<{
        portableEvidence: { signature: string };
      }>;
    };
    tampered.proofModules[0]!.portableEvidence.signature =
      'tampered-portable-signature';
    fs.writeFileSync(recordPath, `${canonicalJson(tampered)}\n`);

    assert.throws(
      () =>
        createFileGrantRecordStore(paths).readGrantRecord(
          challenge.challengeId,
        ),
      (error) => isWorkflowError(error, 'GRANT_STORE_UNSAFE'),
    );
    assert.throws(
      () => parseCanonicalGrantRecordV1(fs.readFileSync(recordPath, 'utf8')),
      /malformed/u,
    );
  });
});

test('a symlink cannot become a grant store root', () => {
  withRuntime((runtimeRoot) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-outside-'));
    try {
      fs.symlinkSync(outside, path.join(runtimeRoot, 'grants-v2'));
      assert.throws(
        () =>
          createFileGrantRecordStore(
            grantStorePaths(runtimeRoot),
          ).persistGrantChallenge(fixtureChallenge()),
        (error) => isWorkflowError(error, 'GRANT_STORE_UNSAFE'),
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('the repository lifecycle lock honors a prepared Grant Core record', () => {
  withRuntime((gitCommonDirectory) => {
    const runtime = runtimePaths(
      fs.realpathSync(gitCommonDirectory),
      'workflow-engine',
    );
    fs.mkdirSync(runtime.root, { recursive: true });
    const paths = grantStorePaths(runtime.root);
    const challenge = fixtureChallenge();
    createFileGrantRecordStore(paths).persistGrantChallenge(challenge);
    const subject = createApprovalSubject(
      challenge,
      {
        choiceId: challenge.choices[0]!.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'cannot-complete-review',
        reason: 'A prepared transition must be recovered first.',
        sessionNonce: 'nonce-44444444444444444444444444444444',
      },
      { now: NOW },
    );
    createFileGrantRecordStore(paths).prepareGrantTransition({
      operationId: '99999999-9999-4999-8999-999999999999',
      challenge,
      subject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: digest('a'),
          identity: null,
          portableEvidence: null,
        },
      ],
      createdAt: NOW.toISOString(),
    });

    assert.throws(
      () => withRepositoryLifecycleOperation(runtime, () => undefined),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
    assert.doesNotThrow(() =>
      withRepositoryLifecycleOperation(runtime, () => undefined, {
        allowGrantChallengeIds: [challenge.challengeId],
      }),
    );
  });
});

test('the async repository lifecycle lock remains owned across await', async () => {
  const gitCommonDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'grant-async-lock-')),
  );
  try {
    const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
    fs.mkdirSync(runtime.root, { recursive: true });
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = withRepositoryLifecycleOperationAsync(
      runtime,
      async (assertOwned) => {
        assertOwned();
        entered();
        await releasePromise;
        assertOwned();
        return 'held';
      },
    );
    await enteredPromise;
    assert.throws(
      () => withRepositoryLifecycleOperation(runtime, () => undefined),
      (error) => isWorkflowError(error, 'REPOSITORY_LIFECYCLE_CONFLICT'),
    );
    release();
    assert.equal(await running, 'held');
    assert.doesNotThrow(() =>
      withRepositoryLifecycleOperation(runtime, () => undefined),
    );
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});

function assertPublicRecord(
  paths: GrantStorePaths,
  liveRecord: GrantRecord,
): void {
  const publicRecord: CanonicalGrantRecordV1 = liveRecord;
  const liveRecordAgain: GrantRecord = publicRecord;
  const storedBytes = fs.readFileSync(
    path.join(paths.records, `${liveRecord.challenge.challengeId}.json`),
    'utf8',
  );
  const parsed = parseCanonicalGrantRecordV1(storedBytes);

  assert.equal(storedBytes, `${canonicalJson(liveRecord)}\n`);
  assert.deepEqual(parsed, liveRecord);
  assert.deepEqual(
    assertCentralGrantPublicDocumentV1(JSON.parse(storedBytes) as unknown),
    liveRecord,
  );
  assert.equal(canonicalJson(liveRecordAgain), canonicalJson(publicRecord));
  assert.equal(Object.isFrozen(parsed), true);
}

function preparePublicRecord(
  paths: GrantStorePaths,
  challenge: GrantChallenge,
  operationId: string,
  sessionNonce: string,
) {
  const subject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: 'cannot-complete-review',
      reason: 'The investigation cannot safely continue.',
      sessionNonce,
    },
    { now: NOW },
  );
  return createFileGrantRecordStore(paths).prepareGrantTransition({
    operationId,
    challenge,
    subject,
    proofModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        claim: 'fresh-local-device-owner',
        proofDigest: digest('4'),
        identity: null,
        portableEvidence: null,
      },
    ],
    createdAt: NOW.toISOString(),
  });
}

function preparePublicSshRecord(
  paths: GrantStorePaths,
  challenge: GrantChallenge,
  operationId: string,
  sessionNonce: string,
) {
  const subject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'ssh',
      reasonCode: 'cannot-complete-review',
      reason: 'The investigation cannot safely continue.',
      sessionNonce,
    },
    { now: NOW },
  );
  const portableEvidence = assertSshPortableApprovalEvidenceV1({
    schemaVersion: 1,
    kind: 'grant-proof-ssh-portable-evidence.v1',
    payload: canonicalJson({
      schemaVersion: 1,
      kind: 'grant-proof-ssh-subject.v1',
      approvalSubject: subject,
      approvalSubjectDigest: approvalSubjectDigest(subject),
      signerIdentity: 'maintainer',
    }),
    signature: 'fixture-portable-signature',
    signatureNamespace: 'jigwright.workflow.grant-proof.v1',
    identity: 'maintainer',
    verifiedAt: NOW.toISOString(),
  });
  return createFileGrantRecordStore(paths).prepareGrantTransition({
    operationId,
    challenge,
    subject,
    proofModules: [
      {
        moduleId: 'grant-proof-ssh',
        version: '1',
        claim: 'ssh-signature',
        proofDigest: sshPortableApprovalEvidenceDigest(portableEvidence),
        identity: 'maintainer',
        portableEvidence,
      },
    ],
    createdAt: NOW.toISOString(),
  });
}

function humanPresenceAudit() {
  return {
    approvalMethod: 'human-presence' as const,
    authorityClass: 'local-device-owner' as const,
    identity: null,
    identityAssurance: 'not-asserted' as const,
    presenceAssurance: 'fresh-os-authentication' as const,
    proofModules: ['human-gate-macos@1'],
  };
}

function sshAudit() {
  return {
    approvalMethod: 'ssh' as const,
    authorityClass: 'ssh-credential' as const,
    identity: 'maintainer',
    identityAssurance: 'policy-trusted-ssh-key' as const,
    presenceAssurance: 'not-asserted' as const,
    proofModules: ['grant-proof-ssh@1'],
  };
}

function fixtureChallenge(
  challengeId = '66666666-6666-4666-8666-666666666666',
) {
  return createGrantChallenge(
    {
      sourceModuleId: 'investigation',
      failureCode: 'reviewer-terms-exhausted',
      facts: { investigationId: 'investigation-1' },
      stateBinding: {
        kind: 'investigation-state',
        digest: digest('1'),
      },
      candidates: [
        {
          transitionId: 'investigation.abort.v1',
          parameters: { terminalReason: 'reviewer-terms-exhausted' },
          allowedReasonCodes: ['cannot-complete-review'],
          reasonRequired: true,
          proposedReason:
            'The reviewer budget is exhausted and the investigation cannot continue.',
        },
      ],
    },
    createTransitionRegistry([abortDefinition()]),
    {
      challengeId,
      now: NOW,
      expiresAt: EXPIRES_AT,
    },
  );
}

function abortDefinition(): TransitionDefinition<{ terminalReason: string }> {
  return {
    transitionId: 'investigation.abort.v1',
    parameterSchemaDigest: digest('2'),
    consequenceDigest: digest('3'),
    resolutionKind: 'non-retry',
    allowedApprovalMethods: ['human-presence', 'ssh'],
    validateParameters(value) {
      assert.deepEqual(value, { terminalReason: 'reviewer-terms-exhausted' });
      return value as { terminalReason: string };
    },
    renderTrustedChoice() {
      return {
        title: 'Abort investigation',
        consequences: ['The investigation becomes terminal.'],
      };
    },
    observeState() {
      return { kind: 'investigation-state', digest: digest('1') };
    },
    async execute({ parameters }) {
      return { outcome: 'completed', details: parameters };
    },
  };
}

function withRuntime(operation: (runtimeRoot: string) => void): void {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-store-'));
  try {
    operation(runtimeRoot);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
