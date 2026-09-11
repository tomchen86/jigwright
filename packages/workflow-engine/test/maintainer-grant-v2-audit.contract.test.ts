import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkflowError, git } from './fixture.ts';

import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/runtime/storage-journal/authority-audit-service.ts';
import fs from 'node:fs';
import {
  deriveAuthorityAuditRepositoryId,
  authorityAuditLedgerPaths,
} from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import path from 'node:path';
import { type MaintainerGrantV2Payload } from '../src/modules/authority/maintainer-grant-v2.ts';
import { issueMaintainerGrantV2 } from '../src/composition-root/maintainer-authority-production.ts';
import {
  buildImmutableCandidateBundleV2,
  storeImmutableCandidateBundle,
} from '../src/modules/authority/maintainer-candidate.ts';
import { revokeMaintainerGrantV2 } from '../src/application/control-plane/maintainer-approve.ts';
import { inspectMaintainerGrants } from '../src/runtime/storage-journal/maintainer-store.ts';
import { readAuthoritySession } from '../src/application/control-plane/maintainer-session.ts';
import {
  startAuthoritySession,
  checkAuthoritySession,
} from '../src/composition-root/maintainer-authority-production.ts';
import {
  prepareCandidate,
  TASK_ID,
  PROFILE_ID,
  approveAndApplyMaintainerGrantV2,
  fakeSigner,
  freezeIssuableCandidate,
  GRANT_ID,
  commitAuthoritySession,
} from './support/maintainer-grant-v2-fixture.ts';

test('approve-and-apply requires an explicit empty effects declaration and rejects unverified effects before signing', () => {
  for (const declaration of ['missing', 'non-empty'] as const) {
    const repository = prepareCandidate();
    const signed: string[] = [];
    try {
      const request = {
        changeId: 'demo-change',
        taskId: TASK_ID,
        profileId: PROFILE_ID,
        reason:
          'Require exact external effect evidence before candidate signing',
        message: 'Reject undeclared candidate effects',
        ...(declaration === 'non-empty'
          ? {
              externalEffects: [
                {
                  effectType: 'publish-git-ref',
                  targetDigest: 'a'.repeat(64),
                  authorizationDigest: null,
                  resultDigest: null,
                },
              ],
            }
          : {}),
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(
          () =>
            approveAndApplyMaintainerGrantV2(repository, request as never, {
              now: new Date('2026-08-03T09:00:00.000Z'),
              signer: fakeSigner(signed),
            }),
          (error) =>
            isWorkflowError(
              error,
              declaration === 'missing'
                ? 'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED'
                : 'APPLY_CANDIDATE_EXTERNAL_EFFECT_UNSUPPORTED',
            ),
        );
      }
      assert.deepEqual(signed, []);
      const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer: fakeSigner(signed),
      });
      const errors = showAuthorityAuditTask(
        {
          externalAuditRoot: binding.externalAuditRoot,
          repositoryRoot: fs.realpathSync(repository),
          repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
        },
        TASK_ID,
      ).events.filter(
        ({ event }) =>
          event.eventType === 'error' &&
          event.command?.name === 'maintainer.approve-and-apply',
      );
      assert.equal(errors.length, 1);
      assert.equal(
        errors[0]?.event.errorCode,
        declaration === 'missing'
          ? 'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED'
          : 'APPLY_CANDIDATE_EXTERNAL_EFFECT_UNSUPPORTED',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('approve-and-apply preflight refusal is task-bound, durable, and retry-idempotent', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
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
    const request = {
      changeId: 'demo-change',
      taskId: TASK_ID,
      externalEffects: [],
      profileId: PROFILE_ID,
      reason: 'Reject a protected control-plane candidate before signing',
      message: 'Reject protected candidate',
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          approveAndApplyMaintainerGrantV2(repository, request, {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
          }),
        (error) =>
          isWorkflowError(error, 'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED'),
      );
    }
    assert.deepEqual(signed, []);
    const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
    });
    const errors = showAuthorityAuditTask(
      {
        externalAuditRoot: binding.externalAuditRoot,
        repositoryRoot: fs.realpathSync(repository),
        repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
      },
      TASK_ID,
    ).events.filter(
      ({ event }) =>
        event.eventType === 'error' &&
        event.command?.name === 'maintainer.approve-and-apply',
    );
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.event.errorCode,
      'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply refusal recovers a ledger-first crash with no grant or signature', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const request = {
    changeId: 'demo-change',
    taskId: TASK_ID,
    profileId: PROFILE_ID,
    reason: 'Reject a missing effects declaration before candidate signing',
    message: 'Reject undeclared effects',
  };
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request as never, {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer,
          testRefusalAuditServiceHooks: {
            testAfterLedgerAppend() {
              throw new Error('simulated-apply-refusal-audit-crash');
            },
          },
        }),
      // Failing to record a refusal must not replace the refusal: the caller
      // still receives the stable code it can act on, and the audit
      // infrastructure failure rides along as its cause.
      (error) => {
        assert.equal(
          isWorkflowError(
            error,
            'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED',
          ),
          true,
        );
        assert.match(
          String((error as Error & { cause?: unknown }).cause),
          /simulated-apply-refusal-audit-crash/,
        );
        return true;
      },
    );
    const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
    });
    const scope = {
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
    };
    assert.equal(verifyAuthorityAuditEvents(scope).ok, false);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request as never, {
          now: new Date('2026-08-03T09:00:01.000Z'),
          signer,
        }),
      (error) =>
        isWorkflowError(error, 'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED'),
    );
    assert.equal(verifyAuthorityAuditEvents(scope).ok, true);
    assert.equal(
      showAuthorityAuditTask(scope, TASK_ID).events.filter(
        ({ event }) =>
          event.eventType === 'error' &&
          event.command?.name === 'maintainer.approve-and-apply',
      ).length,
      1,
    );
    assert.deepEqual(signed, []);
    assert.equal(
      fs.existsSync(
        path.join(
          repository,
          '.git/workflow-engine/maintainer-grants/available',
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply binds the active task mandate and projects every authority event by task', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:00.000Z'),
      signer,
    });
    const result = approveAndApplyMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        taskId: TASK_ID,
        externalEffects: [],
        profileId: PROFILE_ID,
        reason: 'Bind this exact apply transaction to its active task mandate',
        message: 'Apply task-bound workflow candidate',
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        signer,
      },
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.equal(payload.taskId, TASK_ID);
    assert.deepEqual(payload.mandateBinding, binding);
    assert.deepEqual(payload.candidateBundle?.mandateBinding, binding);
    assert.equal(
      payload.effectsManifestDigest,
      payload.candidateBundle?.effectsManifestDigest,
    );

    const scope = {
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    const byTask = showAuthorityAuditTask(scope, TASK_ID);
    assert.equal(byTask.ok, true);
    assert.deepEqual(
      byTask.events.map(({ event }) => event.eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'poststate',
        'grant-consume',
      ],
    );
    assert.equal(
      byTask.events.every(
        ({ event }) =>
          event.taskId === TASK_ID && event.changeId === 'demo-change',
      ),
      true,
    );
    assert.equal(result.applied, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply rejects cross-change and revoked Task Mandates before signing', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'different-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Reject a Task Mandate that belongs to another change',
            message: 'Reject cross-change candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_TASK_MANDATE_CHANGE_MISMATCH'),
    );
    revokeTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T09:00:01.000Z'),
      reason: 'Stop all preparation and exact apply authority for this task',
      signer,
    });
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            taskId: TASK_ID,
            externalEffects: [],
            profileId: PROFILE_ID,
            reason: 'Reject an apply after its Task Mandate was revoked',
            message: 'Reject revoked task candidate',
          },
          {
            now: new Date('2026-08-03T09:00:02.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate and supporting artifacts cannot be reused under another audit root', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const original = prepared.candidateBundle!;
    assert.equal(original.schemaVersion, 2);
    if (original.schemaVersion !== 2) assert.fail('expected candidate v2');
    const { candidateBundleDigest: _digest, ...candidateInput } = original;
    const { humanReadableSummaryDigest: _summaryDigest, ...candidateV2Input } =
      candidateInput;
    const rebound = buildImmutableCandidateBundleV2({
      ...candidateV2Input,
      mandateBinding: {
        ...original.mandateBinding,
        externalAuditRoot: `${original.mandateBinding.externalAuditRoot}-other`,
      },
    }).bundle;
    storeImmutableCandidateBundle(
      fs.realpathSync(path.join(repository, '.git')),
      rebound,
    );
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject cross-root reuse of retained candidate evidence',
            manifest: prepared.manifest,
            checksAttestation: prepared.checksAttestation!,
            candidateBundle: rebound,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: GRANT_ID,
            signer: fakeSigner(signed),
          },
        ),
      (error) =>
        isWorkflowError(error, 'APPLY_CANDIDATE_ARTIFACT_BINDING_INVALID'),
    );
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate audit failure exposes no Apply Grant or available capability', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const binding = inspectActiveTaskMandateBinding(repository, TASK_ID, {
    now: new Date('2026-08-03T09:00:00.000Z'),
    signer,
  });
  const records = authorityAuditLedgerPaths({
    externalAuditRoot: binding.externalAuditRoot,
    repositoryRoot: fs.realpathSync(repository),
    repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
  }).records;
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
            reason:
              'Fail closed when the external candidate audit is unavailable',
            message: 'Reject unaudited workflow candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testBeforeCandidateCommitSigning: () => {
              fs.chmodSync(records, 0o500);
            },
          },
        ),
      (error) => error instanceof Error,
    );
    assert.deepEqual(signed, []);
    assert.equal(
      fs.existsSync(
        path.join(
          repository,
          '.git/workflow-engine/maintainer-grants/available',
        ),
      ),
      false,
    );
  } finally {
    fs.chmodSync(records, 0o700);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 revoke is human-trusted, audit-first, task-bound, and replay-safe', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const issued = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Issue an unused exact candidate for audited revocation',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const reason = 'Withdraw this unused exact apply authority before use';
    assert.throws(
      () =>
        revokeMaintainerGrantV2(
          repository,
          { grantId: issued.grantId, reason },
          {
            now: new Date('2026-08-03T09:02:00.000Z'),
            signer,
            testAfterAudit: () => {
              throw new Error('simulated crash after durable revoke audit');
            },
          },
        ),
      /simulated crash/,
    );
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, issued.grantId)[0]?.state,
      'available',
    );

    const revoked = revokeMaintainerGrantV2(
      repository,
      { grantId: issued.grantId, reason },
      {
        now: new Date('2026-08-03T09:02:30.000Z'),
        signer,
      },
    );
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.replayed, false);
    assert.equal(revoked.taskId, TASK_ID);
    const replay = revokeMaintainerGrantV2(
      repository,
      { grantId: issued.grantId, reason },
      {
        now: new Date('2026-08-03T09:03:00.000Z'),
        signer,
      },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.audit.eventDigest, revoked.audit.eventDigest);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          revokeMaintainerGrantV2(
            repository,
            {
              grantId: issued.grantId,
              reason: 'Conflicting revocation reason must not rewrite history',
            },
            {
              now: new Date('2026-08-03T09:03:30.000Z'),
              signer,
            },
          ),
        (error) =>
          isWorkflowError(error, 'MAINTAINER_GRANT_REVOCATION_STATE_INVALID'),
      );
    }

    const binding = prepared.mandateBinding;
    const events = showAuthorityAuditTask(
      {
        externalAuditRoot: binding.externalAuditRoot,
        repositoryRoot: fs.realpathSync(repository),
        repositoryId: deriveAuthorityAuditRepositoryId(prepared.repositoryId),
      },
      TASK_ID,
    ).events.map(({ event }) => event);
    const revoke = events.findLast((event) => event.eventType === 'revoke');
    assert.equal(revoke?.result, 'revoked');
    assert.equal(revoke?.taskId, TASK_ID);
    assert.equal(revoke?.changeId, 'demo-change');
    const refusal = events.filter(
      (event) =>
        event.eventType === 'error' &&
        event.command?.name === 'maintainer.grant-v2.revoke',
    );
    assert.equal(refusal.length, 1);
    assert.equal(
      refusal[0]?.errorCode,
      'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('direct v2 authority lifecycle refusals are verified-bound and retry-idempotent', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Exercise verified direct authority lifecycle refusals',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    git(repository, ['branch', '--move', 'work/wrong-branch']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          startAuthoritySession(repository, 'demo-change', grant.grantId, {
            now: new Date('2026-08-03T09:02:00.000Z'),
            signer,
            allowSignedV2Candidate: true,
          }),
        (error) =>
          isWorkflowError(error, 'AUTHORITY_CANDIDATE_BINDING_INVALID'),
      );
    }
    git(repository, ['branch', '--move', 'work/demo-change']);
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:03:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );

    const forcedCheckFailure = path.join(
      repository,
      '.git/v2-force-check-failure',
    );
    fs.writeFileSync(forcedCheckFailure, 'fail\n');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          checkAuthoritySession(repository, session.sessionId, {
            now: new Date('2026-08-03T09:04:00.000Z'),
            signer,
          }),
        (error) => isWorkflowError(error, 'CHECK_FAILED'),
      );
    }
    fs.unlinkSync(forcedCheckFailure);
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );
    checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-08-03T09:05:00.000Z'),
      signer,
    });

    git(repository, ['config', '--unset', 'gpg.format']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          commitAuthoritySession(
            repository,
            session.sessionId,
            'Apply exact workflow candidate',
            {
              now: new Date('2026-08-03T09:06:00.000Z'),
              signer,
            },
          ),
        (error) => isWorkflowError(error, 'AUTHORITY_GIT_SIGNING_REQUIRED'),
      );
    }
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );

    const scope = {
      externalAuditRoot: prepared.mandateBinding.externalAuditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(prepared.repositoryId),
    };
    const errors = showAuthorityAuditTask(scope, TASK_ID)
      .events.map(({ event }) => event)
      .filter((event) => event.eventType === 'error');
    assert.deepEqual(
      errors.map((event) => [event.command?.name, event.errorCode]),
      [
        ['authority.start', 'AUTHORITY_CANDIDATE_BINDING_INVALID'],
        ['authority.check', 'CHECK_FAILED'],
        ['authority.commit', 'AUTHORITY_GIT_SIGNING_REQUIRED'],
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expired v2 admission terminalizes the grant and releases its reservation', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
        ttlMinutes: 1,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', grant.grantId, {
          now: new Date('2026-08-03T09:02:00.000Z'),
          signer,
          allowSignedV2Candidate: true,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(
      inspectMaintainerGrants(
        fs.realpathSync(path.join(repository, '.git')),
        grant.grantId,
      )[0]?.state,
      'expired',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';
const { inspectActiveTaskMandateBinding, revokeTaskMandate } =
  taskMandateOperations;
