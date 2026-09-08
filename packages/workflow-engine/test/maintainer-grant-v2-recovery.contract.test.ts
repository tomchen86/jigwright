import test from 'node:test';
import { git, isWorkflowError } from './fixture.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectMaintainerGrants } from '../src/runtime/storage-journal/maintainer-store.ts';
import { readAuthoritySession } from '../src/application/control-plane/maintainer-session.ts';
import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
  authorityAuditLedgerPaths,
} from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/runtime/storage-journal/authority-audit-service.ts';
import { readDurableRefGenerationLedger } from '../src/modules/authority/maintainer-candidate.ts';
import { type MaintainerGrantV2Payload } from '../src/modules/authority/maintainer-grant-v2.ts';
import { readAuthorityCommitJournal } from '../src/application/control-plane/maintainer-recovery.ts';
import { SimulatedAuthorityCrash } from '../src/application/control-plane/maintainer-commit.ts';
import {
  prepareCandidate,
  externalAuditRoot,
  fakeSigner,
  approveAndApplyMaintainerGrantV2,
  TASK_ID,
  PROFILE_ID,
  recoverAuthorityCommit,
} from './support/maintainer-grant-v2-fixture.ts';

test('poststate verification failure rolls back and advances ref generation', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
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
            reason: 'Verify the prebuilt rollback transition after CAS',
            message: 'Apply rollback workflow candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testPoststateVerification: () => {
              throw new Error('simulated poststate mismatch');
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_POSTSTATE_VERIFICATION_FAILED'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      repositoryId: string;
      candidateBundleDigest: string;
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const terminal = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(terminal?.state, 'failed');
    assert.ok(terminal?.reservationSessionId);
    const failedSession = readAuthoritySession(
      repository,
      terminal.reservationSessionId,
    );
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    const records = scanAuthorityAuditLedger(scope).records.map(
      ({ record }) => record,
    );
    const auditVerification = verifyAuthorityAuditEvents(scope);
    assert.equal(auditVerification.ok, true);
    assert.deepEqual(
      records.map(({ eventType }) => eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'error',
        'rollback',
        'error',
        'error',
      ],
    );
    assert.deepEqual(
      records.map(({ result }) => result),
      [
        'recorded',
        'recorded',
        'recorded',
        'succeeded',
        'failed',
        'rolled-back',
        'failed',
        'failed',
      ],
    );
    assert.deepEqual(
      auditVerification.events
        .map(({ event }) => event)
        .slice(-2)
        .map(({ command, errorCode }) => [command?.name, errorCode]),
      [
        ['authority.commit', 'AUTHORITY_POSTSTATE_VERIFICATION_FAILED'],
        [
          'maintainer.approve-and-apply',
          'AUTHORITY_POSTSTATE_VERIFICATION_FAILED',
        ],
      ],
    );
    const transactionRecords = records.slice(3, 6);
    assert.equal(
      transactionRecords.every(
        ({
          grantDigest,
          candidateBundleDigest,
          prestateDigest,
          poststateDigest,
          resultDigest,
        }) =>
          grantDigest === `sha256:${failedSession.grantDigest}` &&
          candidateBundleDigest === `sha256:${payload.candidateBundleDigest}` &&
          /^sha256:[0-9a-f]{64}$/.test(prestateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(poststateDigest ?? '') &&
          /^sha256:[0-9a-f]{64}$/.test(resultDigest),
      ),
      true,
    );
    assert.notEqual(
      transactionRecords[1]?.poststateDigest,
      transactionRecords[2]?.poststateDigest,
    );
    assert.equal(
      records.every(
        (record) => Buffer.byteLength(JSON.stringify(record)) < 4_096,
      ),
      true,
    );
    const ledger = readDurableRefGenerationLedger(
      gitCommonDirectory,
      'refs/heads/work/demo-change',
      true,
    );
    assert.equal(ledger.currentOid, base);
    assert.equal(ledger.generation, 2);
    assert.deepEqual(
      ledger.transitions.map(({ reason }) => reason),
      ['apply', 'rollback'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('poststate audit outage leaves the applied ref recovery-only and rollback resumes once', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  let recordsDirectory: string | undefined;
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
            reason: 'Hold rollback until its external audit is writable',
            message: 'Apply audited rollback candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testPoststateVerification: () => {
              const payload = JSON.parse(
                signed[0]!,
              ) as MaintainerGrantV2Payload;
              const scope = {
                externalAuditRoot: auditRoot,
                repositoryRoot: fs.realpathSync(repository),
                repositoryId: deriveAuthorityAuditRepositoryId(
                  payload.repositoryId,
                ),
              };
              recordsDirectory = authorityAuditLedgerPaths(scope).records;
              fs.chmodSync(recordsDirectory, 0o500);
              throw new Error('simulated audited poststate failure');
            },
          },
        ),
      (error) => error instanceof Error,
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const pending = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(pending?.state, 'reserved');
    assert.ok(pending?.reservationSessionId);
    const pendingSessionId = pending.reservationSessionId;
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(
      readAuthorityCommitJournal(gitCommonDirectory, pendingSessionId).state,
      'rollback-prepared',
    );

    assert.ok(recordsDirectory);
    fs.chmodSync(recordsDirectory, 0o700);
    recordsDirectory = undefined;
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          pendingSessionId,
          new Date('2026-08-03T09:01:00.000Z'),
          {},
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_ROLLED_BACK'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), base);
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    const firstRecovery = scanAuthorityAuditLedger(scope);
    assert.deepEqual(
      firstRecovery.records.map(({ record }) => record.eventType),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'error',
        'rollback',
      ],
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      2,
    );

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          pendingSessionId,
          new Date('2026-08-03T09:02:00.000Z'),
          {},
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_RECOVERY_ROLLED_BACK'),
    );
    const secondRecovery = scanAuthorityAuditLedger(scope);
    assert.equal(secondRecovery.recordCount, firstRecovery.recordCount);
    assert.equal(
      secondRecovery.headRecordDigest,
      firstRecovery.headRecordDigest,
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      2,
    );
  } finally {
    if (recordsDirectory !== undefined) {
      fs.chmodSync(recordsDirectory, 0o700);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('external ref ABA during an uncertain CAS cannot replay the candidate', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
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
              'Exercise rollback replay protection after an uncertain CAS',
            message: 'Apply uncertain CAS candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-cas',
          },
        ),
      (error) =>
        error instanceof Error && error.name === 'SimulatedAuthorityCrash',
    );
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      baseCommit: string;
      candidateBundle: {
        candidateCommit: string;
        targetRef: string;
      };
    };
    git(repository, [
      'update-ref',
      payload.candidateBundle.targetRef,
      payload.baseCommit,
      payload.candidateBundle.candidateCommit,
    ]);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(reservation?.state, 'reserved');
    assert.ok(reservation?.reservationSessionId);

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          reservation.reservationSessionId!,
          new Date('2026-08-03T09:01:00.000Z'),
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_CAS_OUTCOME_AMBIGUOUS'),
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.baseCommit,
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'invalidated',
    );
    const ledger = readDurableRefGenerationLedger(
      gitCommonDirectory,
      payload.candidateBundle.targetRef,
      true,
    );
    assert.equal(ledger.currentOid, payload.baseCommit);
    assert.equal(ledger.generation, 1);
    assert.equal(ledger.transitions[0]?.reason, 'uncertain-cas');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expired grant cannot hide an uncertain CAS replay boundary', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
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
            reason: 'Keep uncertain CAS recovery dominant after grant expiry',
            message: 'Apply expiring uncertain CAS candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-cas',
          },
        ),
      (error) =>
        error instanceof Error && error.name === 'SimulatedAuthorityCrash',
    );
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      baseCommit: string;
      candidateBundle: {
        candidateCommit: string;
        targetRef: string;
      };
    };
    git(repository, [
      'update-ref',
      payload.candidateBundle.targetRef,
      payload.baseCommit,
      payload.candidateBundle.candidateCommit,
    ]);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.ok(reservation?.reservationSessionId);

    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          reservation.reservationSessionId!,
          new Date('2026-08-10T09:00:00.001Z'),
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_CAS_OUTCOME_AMBIGUOUS'),
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'invalidated',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('transient consume failure resumes completion without applying twice', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
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
            reason: 'Resume completion after a transient consume write failure',
            message: 'Apply consume recovery candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testBeforeConsume: () => {
              throw new Error('simulated transient consume failure');
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED'),
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const pending = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(pending?.state, 'reserved');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.ok(pending?.reservationSessionId);
    const pendingJournal = readAuthorityCommitJournal(
      gitCommonDirectory,
      pending.reservationSessionId!,
    );
    assert.deepEqual(pendingJournal.mandateBinding, payload.mandateBinding);
    assert.equal(
      pendingJournal.externalAuditRoot,
      payload.mandateBinding.externalAuditRoot,
    );

    const recovered = recoverAuthorityCommit(
      repository,
      pending.reservationSessionId!,
      new Date('2026-08-03T09:01:00.000Z'),
      { receiptSigner: signer },
    );
    assert.equal(recovered.commitHash, payload.candidateBundle.candidateCommit);
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'consumed',
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      1,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current incomplete v2 recovery journal fails closed without moving the ref', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
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
            reason: 'Crash after the exact candidate ref update',
            message: 'Apply journal corruption candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-updated',
          },
        ),
      SimulatedAuthorityCrash,
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(reservation?.state, 'reserved');
    assert.ok(reservation?.reservationSessionId);
    const sessionId = reservation.reservationSessionId;
    const journalPath = path.join(
      gitCommonDirectory,
      'workflow-engine/maintainer-grants/journals',
      `${sessionId}.json`,
    );
    const appliedHead = payload.candidateBundle.candidateCommit;
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), appliedHead);
    assert.equal(
      readAuthorityCommitJournal(gitCommonDirectory, sessionId).state,
      'ref-updated',
    );

    const incomplete = JSON.parse(
      fs.readFileSync(journalPath, 'utf8'),
    ) as Record<string, unknown>;
    delete incomplete.commitHash;
    fs.writeFileSync(journalPath, `${JSON.stringify(incomplete)}\n`, {
      mode: 0o600,
    });

    assert.throws(
      () => readAuthorityCommitJournal(gitCommonDirectory, sessionId),
      (error: unknown) => isWorkflowError(error, 'AUTHORITY_JOURNAL_INVALID'),
    );
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          sessionId,
          new Date('2026-08-03T09:01:00.000Z'),
          { receiptSigner: signer },
        ),
      (error: unknown) => isWorkflowError(error, 'AUTHORITY_JOURNAL_INVALID'),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), appliedHead);
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]?.state,
      'reserved',
    );
    assert.equal(
      inspectMaintainerGrants(gitCommonDirectory, payload.grantId)[0]
        ?.reservationSessionId,
      sessionId,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority recovery rejects every non-current commit journal schema', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
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
            reason: 'Reject a non-current recovery journal after ref update',
            message: 'Apply current recovery candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            commitCrashAfter: 'ref-updated',
          },
        ),
      SimulatedAuthorityCrash,
    );
    const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
    assert.ok(payload.candidateBundle);
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const reservation = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(reservation?.state, 'reserved');
    assert.ok(reservation?.reservationSessionId);
    const journalPath = path.join(
      gitCommonDirectory,
      'workflow-engine/maintainer-grants/journals',
      `${reservation.reservationSessionId}.json`,
    );
    const current = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const journalV3: Record<string, unknown> = {
      ...current,
      schemaVersion: 3,
    };
    delete journalV3.mandateBinding;
    const journalV2: Record<string, unknown> = {
      ...journalV3,
      schemaVersion: 2,
    };
    for (const key of [
      'poststateAuditRecordDigest',
      'errorAuditRecordDigest',
      'rollbackAuditRecordDigest',
      'poststateVerifiedAt',
      'rollbackStartedAt',
      'rolledBackAt',
    ]) {
      delete journalV2[key];
    }
    const journalV1: Record<string, unknown> = {
      ...journalV2,
      schemaVersion: 1,
    };
    const earlyJournalV1: Record<string, unknown> = { ...journalV1 };
    for (const key of [
      'externalAuditRoot',
      'auditRepositoryId',
      'casAuditRecordDigest',
      'consumeAuditRecordDigest',
      'refUpdatedAt',
      'consumedAt',
    ]) {
      delete earlyJournalV1[key];
    }
    for (const nonCurrent of [
      earlyJournalV1,
      journalV1,
      journalV2,
      journalV3,
    ]) {
      fs.writeFileSync(journalPath, `${JSON.stringify(nonCurrent)}\n`, {
        mode: 0o600,
      });
      assert.throws(
        () =>
          readAuthorityCommitJournal(
            gitCommonDirectory,
            reservation.reservationSessionId!,
          ),
        (error: unknown) => isWorkflowError(error, 'AUTHORITY_JOURNAL_INVALID'),
      );
    }
    assert.throws(
      () =>
        recoverAuthorityCommit(
          repository,
          reservation.reservationSessionId!,
          new Date('2026-08-03T09:01:00.000Z'),
          { receiptSigner: signer },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_JOURNAL_INVALID'),
    );
    const scan = scanAuthorityAuditLedger({
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    });
    assert.deepEqual(
      scan.records.map(({ record }) => record.eventType),
      ['task-mandate', 'candidate-bundle', 'apply-grant'],
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      1,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 audit failure after consume remains recovery-only until both receipts are durable', () => {
  const repository = prepareCandidate();
  const auditRoot = externalAuditRoot(repository);
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  let rejectConsumeAudit = true;
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
            reason: 'Require external audit completion after grant consumption',
            message: 'Apply externally audited candidate',
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            signer,
            testBeforeAudit: (eventType) => {
              if (eventType === 'grant-consume' && rejectConsumeAudit) {
                throw new Error('simulated external audit outage');
              }
            },
          },
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED'),
    );
    const payload = JSON.parse(signed[0]!) as {
      grantId: string;
      repositoryId: string;
      candidateBundle: { candidateCommit: string; targetRef: string };
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const terminal = inspectMaintainerGrants(
      gitCommonDirectory,
      payload.grantId,
    )[0];
    assert.equal(terminal?.state, 'consumed');
    assert.ok(terminal?.reservationSessionId);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(
      readAuthoritySession(repository, terminal.reservationSessionId!).state,
      'active',
    );
    assert.equal(
      readAuthorityCommitJournal(
        gitCommonDirectory,
        terminal.reservationSessionId!,
      ).state,
      'consumed',
    );
    const scope = {
      externalAuditRoot: auditRoot,
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
    assert.deepEqual(
      scanAuthorityAuditLedger(scope).records.map(
        ({ record }) => record.eventType,
      ),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'poststate',
        'error',
        'error',
      ],
    );
    assert.deepEqual(
      verifyAuthorityAuditEvents(scope)
        .events.map(({ event }) => event)
        .slice(-2)
        .map(({ command, errorCode }) => [command?.name, errorCode]),
      [
        ['authority.commit', 'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED'],
        [
          'maintainer.approve-and-apply',
          'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        ],
      ],
    );

    rejectConsumeAudit = false;
    const recovered = recoverAuthorityCommit(
      repository,
      terminal.reservationSessionId!,
      new Date('2026-08-03T09:01:00.000Z'),
      { receiptSigner: signer },
    );
    assert.equal(recovered.journalState, 'audited');
    assert.equal(
      readAuthoritySession(repository, terminal.reservationSessionId!).state,
      'committed',
    );
    const receiptRef = `refs/tags/workflow-grant/application-${payload.grantId}`;
    const receiptTagObject = git(repository, [
      'rev-parse',
      `${receiptRef}^{tag}`,
    ]).trim();
    assert.equal(
      git(repository, ['rev-parse', `${receiptRef}^{commit}`]).trim(),
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(signed.length, 2);
    assert.deepEqual(
      scanAuthorityAuditLedger(scope).records.map(
        ({ record }) => record.eventType,
      ),
      [
        'task-mandate',
        'candidate-bundle',
        'apply-grant',
        'cas',
        'poststate',
        'error',
        'error',
        'grant-consume',
      ],
    );
    const completedAudit = scanAuthorityAuditLedger(scope);
    assert.equal(
      recoverAuthorityCommit(
        repository,
        terminal.reservationSessionId!,
        new Date('2026-08-03T09:02:00.000Z'),
        { receiptSigner: signer },
      ).commitHash,
      payload.candidateBundle.candidateCommit,
    );
    assert.equal(signed.length, 2);
    assert.equal(
      git(repository, ['rev-parse', `${receiptRef}^{tag}`]).trim(),
      receiptTagObject,
    );
    const replayedRecoveryAudit = scanAuthorityAuditLedger(scope);
    assert.equal(replayedRecoveryAudit.recordCount, completedAudit.recordCount);
    assert.equal(
      replayedRecoveryAudit.headRecordDigest,
      completedAudit.headRecordDigest,
    );
    assert.equal(
      readDurableRefGenerationLedger(
        gitCommonDirectory,
        payload.candidateBundle.targetRef,
        true,
      ).generation,
      1,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('approve-and-apply rejects commit preconditions before checks or grant signing', () => {
  const repository = prepareCandidate();
  const marker = path.join(repository, '.git/v2-check-passed');
  const signed: string[] = [];
  try {
    git(repository, ['config', '--unset', 'gpg.format']);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(
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
            signer: fakeSigner(signed),
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_GIT_SIGNING_REQUIRED'),
    );
    assert.deepEqual(signed, []);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/maintainer-grants'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
