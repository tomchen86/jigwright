/**
 * Journals authority commits and recovers their durable completion phases.
 *
 * Invariants:
 * - The journal audit scope must match the pinned mandate and repository.
 */
import { createMaintainerRecoveryJournal } from './maintainer-recovery-journal.ts';
import { createMaintainerRecoveryAudit } from './maintainer-recovery-audit.ts';
import { createMaintainerRecoveryVerification } from './maintainer-recovery-verification.ts';
import { createMaintainerRecoveryTerminalization } from './maintainer-recovery-terminalization.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authorityAuditLedgerPaths,
  scanAuthorityAuditLedger,
  type AuthorityAuditAppendInput,
  type AuthorityAuditEventType,
  type AuthorityAuditLedgerEntry,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  authorityAuditAppendInputForEvent,
  buildAuthorityAuditEvent,
  recordAuthorityAuditEvent,
  verifyAuthorityAuditEvents,
  type AuthorityAuditEventInput,
} from '../../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityApplicationReceiptTagRef,
  createAuthorityApplicationReceiptPayload,
  publishAuthorityApplicationReceipt,
  signedGrantEnvelopeDigest,
} from '../../modules/authority/authority-application-receipt.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { authorityAttestationRelayProjectionCommand } from '../../adapters/remote/github/authority-relay-command.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  authorityCandidateCommitMessage,
  commitChangedPaths,
  commitFacts,
  rollbackExactStaging,
  updateManagedRef,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  armPostApprovalAdmissionDeadline,
  assertPostApprovalAdmissionDeadline,
  assertPostApprovalAdmissionPhase,
  createPostApprovalAdmissionDeadline,
  discoverRepository,
  enterActivePostApprovalTerminalCleanup,
  enterPostApprovalCompletionObligation,
  enterPostApprovalTerminalCleanup,
  isPostApprovalAdmissionFailure,
  runGit,
  withPostApprovalAdmissionDeadline,
  type PostApprovalAdmissionDeadline,
  type PostApprovalBudgetTestOptions,
} from '../../runtime/repository-transaction/git.ts';
import { canonicalMaintainerGrantV2Envelope } from '../../modules/authority/maintainer-grant-v2.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  failAuthoritySession,
  markAuthoritySessionCommitted,
  readAuthoritySession,
  type AuthoritySession,
} from './maintainer-session.ts';
import {
  acceptApplyPrestate,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
} from '../../modules/authority/maintainer-candidate.ts';
import {
  consumeMaintainerReservationUnderLifecycleLock,
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
  readTerminalMaintainerGrant,
  terminallyExpireMaintainerReservationUnderLifecycleLock,
  terminallyFailMaintainerReservationUnderLifecycleLock,
  terminallyInvalidateMaintainerReservationUnderLifecycleLock,
} from '../../runtime/storage-journal/maintainer-store.ts';
import { parseManagedTrailers } from '../../modules/lifecycle/managed-trailers.ts';
import { assertSessionId } from '../../runtime/session-workspace/paths.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  type TaskMandateBinding,
} from '../../modules/authority/task-mandate.ts';

/**
 * The normative apply crash journal.
 *
 * Every production authority commit write-ahead-journals through this state
 * machine: prepare, CAS, consume, audit, with rollback entered only from
 * ref-updated or rollback-prepared. A parallel journal once lived in
 * maintainer-candidate.ts with contract tests and no callers; its decision
 * table diverged from this one on externally-moved refs, and a table proven
 * on a module nothing runs proves nothing about recovery. This is the one
 * implementation of the plan's apply-journal requirement.
 */
export type AuthorityCommitJournalState =
  | 'preparing'
  | 'commit-created'
  | 'cas-prepared'
  | 'ref-updated'
  | 'rollback-prepared'
  | 'rolled-back'
  | 'consumed'
  | 'audited'
  | 'revoked';

export type AuthorityCommitJournal = {
  schemaVersion: 4;
  state: AuthorityCommitJournalState;
  sessionId: string;
  grantId: string;
  changeId: string;
  repositoryRoot: string;
  branch: string;
  baseCommit: string;
  expectedTree: string;
  previousIndexTree: string;
  allowedPaths: string[];
  subject: string;
  messageDigest: string;
  policyBlob: string;
  signer: string;
  mandateBinding: TaskMandateBinding | null;
  commitHash: string | null;
  externalAuditRoot: string | null;
  auditRepositoryId: Sha256Digest | null;
  casAuditRecordDigest: Sha256Digest | null;
  poststateAuditRecordDigest: Sha256Digest | null;
  consumeAuditRecordDigest: Sha256Digest | null;
  errorAuditRecordDigest: Sha256Digest | null;
  rollbackAuditRecordDigest: Sha256Digest | null;
  refUpdatedAt: string | null;
  poststateVerifiedAt: string | null;
  consumedAt: string | null;
  rollbackStartedAt: string | null;
  rolledBackAt: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthorityCommitResult = {
  session: AuthoritySession;
  grantId: string;
  commitHash: string;
  changedPaths: string[];
  journalState: 'consumed' | 'audited';
  attestationRelayCommand: string;
};

export type AuthorityRecoveryOptions = {
  testBeforeConsume?: () => void;
  testBeforeAudit?: (eventType: 'cas' | 'grant-consume') => void;
  receiptSigner?: MaintainerSignerProvider;
  /** Engine-owned post-approval token; never populated from CLI input. */
  postApprovalDeadline?: PostApprovalAdmissionDeadline;
  /** Test-only deterministic seam; production always uses the code-owned cap. */
  testPostApprovalBudget?: PostApprovalBudgetTestOptions;
};

function journalRequiresCompletion(
  state: AuthorityCommitJournalState,
): boolean {
  return (
    state === 'cas-prepared' ||
    state === 'ref-updated' ||
    state === 'rollback-prepared' ||
    state === 'rolled-back' ||
    state === 'consumed' ||
    state === 'audited'
  );
}

export function beginAuthorityCommitJournal(
  session: AuthoritySession,
  input: {
    expectedTree: string;
    previousIndexTree: string;
    changedPaths: string[];
    subject: string;
    now: Date;
    auditScope: AuthorityAuditLedgerScope;
  },
): AuthorityCommitJournal {
  const timestamp = exactDate(input.now).toISOString();
  const auditScope = input.auditScope;
  if (
    session.mandateBinding === null ||
    auditScope.repositoryRoot !== session.repositoryRoot ||
    auditScope.externalAuditRoot !== session.mandateBinding.externalAuditRoot
  ) {
    throw recoveryError(
      'AUTHORITY_AUDIT_SCOPE_MISMATCH',
      'Authority audit scope does not match the pinned grant and repository.',
    );
  }
  authorityAuditLedgerPaths(auditScope);
  const journal: AuthorityCommitJournal = {
    schemaVersion: 4,
    state: 'preparing',
    sessionId: session.sessionId,
    grantId: session.grantId,
    changeId: session.changeId,
    repositoryRoot: session.repositoryRoot,
    branch: session.branch,
    baseCommit: session.baseCommit,
    expectedTree: assertObjectId(input.expectedTree),
    previousIndexTree: assertObjectId(input.previousIndexTree),
    allowedPaths: [...input.changedPaths],
    subject: input.subject,
    messageDigest: digest(
      `${expectedAuthorityMessage(session, input.subject)}\n`,
    ),
    policyBlob: assertObjectId(session.policyBlob),
    signer: session.signer,
    mandateBinding: session.mandateBinding,
    commitHash: null,
    externalAuditRoot: auditScope?.externalAuditRoot ?? null,
    auditRepositoryId: auditScope?.repositoryId ?? null,
    casAuditRecordDigest: null,
    poststateAuditRecordDigest: null,
    consumeAuditRecordDigest: null,
    errorAuditRecordDigest: null,
    rollbackAuditRecordDigest: null,
    refUpdatedAt: null,
    poststateVerifiedAt: null,
    consumedAt: null,
    rollbackStartedAt: null,
    rolledBackAt: null,
    reason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeJournal(session.gitCommonDirectory, journal, true);
  return journal;
}

export function recordAuthorityCommitCreated(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  commitHash: string,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'preparing', {
    state: 'commit-created',
    commitHash: assertObjectId(commitHash),
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recordAuthorityRefUpdated(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'cas-prepared', {
    state: 'ref-updated',
    refUpdatedAt: exactDate(now).toISOString(),
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recordAuthorityCasPrepared(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'commit-created', {
    state: 'cas-prepared',
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recoverAuthorityCommit(
  cwd: string,
  requestedSessionId: string,
  now = new Date(),
  options: AuthorityRecoveryOptions = {},
): AuthorityCommitResult {
  let deadline = options.postApprovalDeadline;
  try {
    if (deadline === undefined) {
      const session = readAuthoritySession(cwd, requestedSessionId);
      const journal = readAuthorityCommitJournal(
        session.gitCommonDirectory,
        session.sessionId,
      );
      deadline = createPostApprovalAdmissionDeadline(
        options.testPostApprovalBudget,
      );
      if (journalRequiresCompletion(journal.state)) {
        enterPostApprovalCompletionObligation(deadline, {
          allowExpired: true,
        });
      }
    }
    const phaseSession = readAuthoritySession(cwd, requestedSessionId);
    const phaseJournal = readAuthorityCommitJournal(
      phaseSession.gitCommonDirectory,
      phaseSession.sessionId,
    );
    if (journalRequiresCompletion(phaseJournal.state)) {
      enterPostApprovalCompletionObligation(deadline, {
        allowExpired: true,
      });
    } else {
      assertPostApprovalAdmissionPhase(deadline);
    }
    if (deadline.phase === 'unarmed') {
      armPostApprovalAdmissionDeadline(deadline);
    }
    return withPostApprovalAdmissionDeadline(deadline, () =>
      recoverAuthorityCommitWithDeadline(cwd, requestedSessionId, now, {
        ...options,
        postApprovalDeadline: deadline,
      }),
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) {
      enterPostApprovalTerminalCleanup(deadline);
      const session = readAuthoritySession(cwd, requestedSessionId);
      const journal = readAuthorityCommitJournal(
        session.gitCommonDirectory,
        session.sessionId,
      );
      if (journal.state === 'preparing' || journal.state === 'commit-created') {
        failAuthorityCommitBeforeCas(cwd, requestedSessionId, error, now);
      }
    }
    throw error;
  }
}

function recoverAuthorityCommitWithDeadline(
  cwd: string,
  requestedSessionId: string,
  now: Date,
  options: AuthorityRecoveryOptions,
): AuthorityCommitResult {
  const session = readAuthoritySession(cwd, requestedSessionId);
  const journal = readAuthorityCommitJournal(
    session.gitCommonDirectory,
    session.sessionId,
  );
  assertJournalMatchesSession(journal, session);
  if (journalRequiresCompletion(journal.state)) {
    enterPostApprovalCompletionObligation(options.postApprovalDeadline, {
      allowExpired: true,
    });
  } else {
    assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
  }
  const auditScope = authorityAuditScopeForJournal(session, journal);

  if (
    journal.state === 'rollback-prepared' ||
    journal.state === 'rolled-back'
  ) {
    rollbackAuthorityCommitAfterCas(
      cwd,
      session.sessionId,
      journal.reason ?? 'Resume journaled poststate rollback',
      now,
    );
    throw recoveryError(
      'AUTHORITY_RECOVERY_ROLLED_BACK',
      'The failed authority apply was rolled back during recovery.',
    );
  }

  if (journal.state === 'revoked') {
    const denial = recoveryError(
      'AUTHORITY_RECOVERY_REVOKED',
      'The authority transaction was terminally revoked.',
    );
    enterPostApprovalTerminalCleanup(options.postApprovalDeadline);
    failAuthorityCommitBeforeCas(cwd, session.sessionId, denial, now);
    throw denial;
  }

  const grantState = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    journal.state !== 'cas-prepared' &&
    (grantState?.state === 'expired' ||
      (grantState?.state === 'reserved' &&
        Date.parse(grantState.expiresAt) <= exactDate(now).getTime() &&
        discoverRepository(cwd).head === journal.baseCommit))
  ) {
    expireAuthorityCommitBeforeCas(cwd, session.sessionId, now);
    throw recoveryError(
      'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS',
      'The authority grant expired before the protected ref was updated.',
    );
  }
  if (
    journal.state === 'commit-created' &&
    (grantState?.state !== 'reserved' ||
      grantState.reservationSessionId !== session.sessionId)
  ) {
    const denial = recoveryError(
      'AUTHORITY_RECOVERY_REVOKED',
      'Pre-CAS recovery requires the exact live same-session reservation.',
    );
    enterPostApprovalTerminalCleanup(options.postApprovalDeadline);
    failAuthorityCommitBeforeCas(cwd, session.sessionId, denial, now);
    throw denial;
  }

  if (journal.state === 'preparing') {
    revokePreparingTransaction(cwd, session, now);
  }

  try {
    return withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const currentSession = readAuthoritySession(cwd, session.sessionId);
        assertJournalMatchesSession(journal, currentSession);
        const currentJournal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        if (journalRequiresCompletion(currentJournal.state)) {
          enterPostApprovalCompletionObligation(options.postApprovalDeadline, {
            allowExpired: true,
          });
        } else {
          assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
        }
        if (currentJournal.state === 'audited') {
          return finalizeAudited(
            cwd,
            currentSession,
            currentJournal,
            auditScope,
            now,
            options,
          );
        }
        if (currentJournal.state === 'consumed') {
          return finalizeConsumed(
            cwd,
            currentSession,
            currentJournal,
            auditScope,
            now,
            options,
          );
        }
        if (
          currentJournal.state !== 'commit-created' &&
          currentJournal.state !== 'cas-prepared' &&
          currentJournal.state !== 'ref-updated'
        ) {
          throw recoveryError(
            'AUTHORITY_JOURNAL_DIVERGED',
            'Authority journal state changed during recovery.',
          );
        }
        const commitHash = requireCommitHash(currentJournal);
        verifyJournaledCommit(cwd, currentSession, currentJournal, commitHash);
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (indexTree !== currentJournal.expectedTree) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_INDEX_DIVERGED',
            'The Git index differs from the journaled authority tree.',
          );
        }
        let advanced = currentJournal;
        const targetRef = `refs/heads/${currentSession.branch}`;
        const expectedGeneration = currentSession.expectedRefGeneration;
        if (git.head === currentJournal.baseCommit) {
          if (currentSession.mandateBinding === null) {
            throw recoveryError(
              'AUTHORITY_TASK_MANDATE_BINDING_REQUIRED',
              'Pre-CAS recovery requires the durable Task Mandate binding.',
            );
          }
          assertActiveTaskMandateBindingUnderLifecycleLock(
            cwd,
            currentSession.mandateBinding,
            assertOwned,
            { now, signer: options.receiptSigner },
          );
          if (currentJournal.state === 'cas-prepared') {
            rejectAmbiguousAuthorityCas(
              git.repositoryRoot,
              currentSession,
              currentJournal,
              indexTree,
              now,
              assertOwned,
            );
          }
          if (currentJournal.state !== 'commit-created') {
            throw recoveryError(
              'AUTHORITY_RECOVERY_REF_DIVERGED',
              'The ref-updated journal no longer points to its candidate.',
            );
          }
          if (expectedGeneration !== null) {
            acceptApplyPrestate(
              readDurableRefGenerationLedger(
                currentSession.gitCommonDirectory,
                targetRef,
                true,
              ),
              currentJournal.baseCommit,
              expectedGeneration,
            );
          }
          assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
          advanced = recordAuthorityCasPrepared(
            session.gitCommonDirectory,
            advanced,
            now,
          );
          enterPostApprovalCompletionObligation(options.postApprovalDeadline, {
            allowExpired: true,
          });
          updateManagedRef(
            git.repositoryRoot,
            currentJournal.baseCommit,
            commitHash,
            targetRef,
          );
          if (expectedGeneration !== null) {
            recordDurableRefGenerationTransitionUnderLifecycleLock(
              currentSession.gitCommonDirectory,
              {
                ref: targetRef,
                expectedOid: currentJournal.baseCommit,
                expectedGeneration,
                nextOid: commitHash,
                reason: 'apply',
                at: exactDate(now).toISOString(),
              },
              assertOwned,
            );
          }
        } else if (git.head !== commitHash) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_REF_DIVERGED',
            'The branch no longer points to the journaled base or commit.',
          );
        } else if (expectedGeneration !== null) {
          const ledger = readDurableRefGenerationLedger(
            currentSession.gitCommonDirectory,
            targetRef,
            true,
          );
          if (
            ledger.currentOid === currentJournal.baseCommit &&
            ledger.generation === expectedGeneration
          ) {
            recordDurableRefGenerationTransitionUnderLifecycleLock(
              currentSession.gitCommonDirectory,
              {
                ref: targetRef,
                expectedOid: currentJournal.baseCommit,
                expectedGeneration,
                nextOid: commitHash,
                reason: 'apply',
                at: exactDate(now).toISOString(),
              },
              assertOwned,
            );
          } else if (
            ledger.currentOid !== commitHash ||
            ledger.generation !== expectedGeneration + 1
          ) {
            throw recoveryError(
              'AUTHORITY_RECOVERY_REF_GENERATION_DIVERGED',
              'The protected ref generation ledger differs from the journaled transition.',
            );
          }
        }
        if (advanced.state === 'cas-prepared') {
          advanced = recordAuthorityRefUpdated(
            session.gitCommonDirectory,
            advanced,
            now,
          );
        }
        assertOwned();
        assertAppliedTransactionPoststate(
          git.repositoryRoot,
          targetRef,
          commitHash,
          advanced.expectedTree,
        );
        if (auditScope !== null) {
          advanced = ensureTransactionAuditReceipt(
            currentSession,
            advanced,
            auditScope,
            'cas',
            now,
            options,
          );
          if (advanced.poststateVerifiedAt === null) {
            advanced = transitionJournal(
              currentSession.gitCommonDirectory,
              advanced,
              'ref-updated',
              {
                state: 'ref-updated',
                poststateVerifiedAt: exactDate(now).toISOString(),
                updatedAt: exactDate(now).toISOString(),
              },
            );
          }
          advanced = ensureTransactionAuditReceipt(
            currentSession,
            advanced,
            auditScope,
            'poststate',
            now,
            options,
          );
        }
        options.testBeforeConsume?.();
        consumeMaintainerReservationUnderLifecycleLock(
          session.gitCommonDirectory,
          session.grantId,
          session.sessionId,
          commitHash,
          now,
        );
        const consumed = transitionJournal(
          session.gitCommonDirectory,
          advanced,
          'ref-updated',
          {
            state: 'consumed',
            consumedAt: exactDate(now).toISOString(),
            updatedAt: exactDate(now).toISOString(),
          },
        );
        return finalizeConsumed(
          cwd,
          currentSession,
          consumed,
          auditScope,
          now,
          options,
        );
      },
      { allowMaintainerGrantId: session.grantId },
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) {
      enterPostApprovalTerminalCleanup(options.postApprovalDeadline);
      const observed = readAuthorityCommitJournal(
        session.gitCommonDirectory,
        session.sessionId,
      );
      if (
        observed.state === 'preparing' ||
        observed.state === 'commit-created'
      ) {
        failAuthorityCommitBeforeCas(cwd, session.sessionId, error, now);
      }
      throw error;
    }
    const inspection = inspectMaintainerGrants(
      session.gitCommonDirectory,
      session.grantId,
    )[0];
    if (
      inspection?.state === 'consumed' &&
      inspection.commitHash === journal.commitHash
    ) {
      throw recoveryError(
        'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        'The grant is consumed but journal finalization must be retried.',
      );
    }
    const observedJournal = readAuthorityCommitJournal(
      session.gitCommonDirectory,
      session.sessionId,
    );
    if (
      inspection?.state === 'reserved' &&
      observedJournal.state === 'ref-updated' &&
      observedJournal.commitHash !== null &&
      discoverRepository(cwd).head === observedJournal.commitHash
    ) {
      throw recoveryError(
        'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        'The ref is applied and grant consumption must be retried to completion.',
      );
    }
    revokeAmbiguousTransaction(session, journal, error, now);
    throw error;
  }
}

function finalizeConsumed(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  auditScope: AuthorityAuditLedgerScope,
  now: Date,
  options: AuthorityRecoveryOptions,
): AuthorityCommitResult {
  const commitHash = requireCommitHash(journal);
  verifyJournaledCommit(cwd, session, journal, commitHash);
  const terminal = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    terminal?.state !== 'consumed' ||
    terminal.commitHash !== commitHash ||
    terminal.reservationSessionId !== session.sessionId
  ) {
    throw recoveryError(
      'AUTHORITY_TERMINAL_STATE_DIVERGED',
      'Consumed journal and terminal grant state do not match.',
    );
  }
  if (journal.casAuditRecordDigest === null) {
    throw recoveryError(
      'AUTHORITY_AUDIT_STATE_INVALID',
      'Consumed v2 authority state is missing its bound external audit scope or CAS receipt.',
    );
  }
  assertAppliedTransactionPoststate(
    session.repositoryRoot,
    `refs/heads/${session.branch}`,
    commitHash,
    journal.expectedTree,
  );
  let verified = ensureTransactionAuditReceipt(
    session,
    journal,
    auditScope,
    'cas',
    now,
  );
  if (verified.poststateVerifiedAt === null) {
    const verifiedAt =
      verified.consumedAt ?? verified.refUpdatedAt ?? verified.updatedAt;
    verified = transitionJournal(
      session.gitCommonDirectory,
      verified,
      'consumed',
      {
        state: 'consumed',
        poststateVerifiedAt: verifiedAt,
        updatedAt: verified.updatedAt,
      },
    );
  }
  verified = ensureTransactionAuditReceipt(
    session,
    verified,
    auditScope,
    'poststate',
    now,
  );
  verified = ensureTransactionAuditReceipt(
    session,
    verified,
    auditScope,
    'grant-consume',
    now,
    options,
  );
  const audited = transitionJournal(
    session.gitCommonDirectory,
    verified,
    'consumed',
    {
      state: 'audited',
      updatedAt: exactDate(now).toISOString(),
    },
  );
  return finalizeAudited(cwd, session, audited, auditScope, now, options);
}

function finalizeAudited(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  auditScope: AuthorityAuditLedgerScope,
  now: Date,
  options: AuthorityRecoveryOptions,
): AuthorityCommitResult {
  const commitHash = requireCommitHash(journal);
  verifyJournaledCommit(cwd, session, journal, commitHash);
  if (
    journal.casAuditRecordDigest === null ||
    journal.poststateAuditRecordDigest === null ||
    journal.consumeAuditRecordDigest === null
  ) {
    throw recoveryError(
      'AUTHORITY_AUDIT_STATE_INVALID',
      'Audited authority state is incomplete.',
    );
  }
  const terminal = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    terminal?.state !== 'consumed' ||
    terminal.commitHash !== commitHash ||
    terminal.reservationSessionId !== session.sessionId
  ) {
    throw recoveryError(
      'AUTHORITY_TERMINAL_STATE_DIVERGED',
      'Audited journal and terminal grant state do not match.',
    );
  }
  let verified = ensureTransactionAuditReceipt(
    session,
    journal,
    auditScope,
    'cas',
    now,
  );
  verified = ensureTransactionAuditReceipt(
    session,
    verified,
    auditScope,
    'poststate',
    now,
  );
  verified = ensureTransactionAuditReceipt(
    session,
    verified,
    auditScope,
    'grant-consume',
    now,
  );
  ensurePortableApplicationReceipt(
    session,
    verified,
    auditScope,
    options.receiptSigner,
  );
  const committed =
    session.state === 'committed'
      ? session
      : markAuthoritySessionCommitted(cwd, session, commitHash, now);
  if (committed.commitHash !== commitHash) {
    throw recoveryError(
      'AUTHORITY_SESSION_DIVERGED',
      'Committed authority session references another commit.',
    );
  }
  return result(committed, journal, commitHash);
}

type TransactionAuditEvent = Extract<
  AuthorityAuditEventType,
  'cas' | 'poststate' | 'grant-consume' | 'error' | 'rollback'
>;

type AuditReceiptField =
  | 'casAuditRecordDigest'
  | 'poststateAuditRecordDigest'
  | 'consumeAuditRecordDigest'
  | 'errorAuditRecordDigest'
  | 'rollbackAuditRecordDigest';

const CURRENT_JOURNAL_KEYS = [
  'schemaVersion',
  'state',
  'sessionId',
  'grantId',
  'changeId',
  'repositoryRoot',
  'branch',
  'baseCommit',
  'expectedTree',
  'previousIndexTree',
  'allowedPaths',
  'subject',
  'messageDigest',
  'policyBlob',
  'signer',
  'mandateBinding',
  'commitHash',
  'externalAuditRoot',
  'auditRepositoryId',
  'casAuditRecordDigest',
  'poststateAuditRecordDigest',
  'consumeAuditRecordDigest',
  'errorAuditRecordDigest',
  'rollbackAuditRecordDigest',
  'refUpdatedAt',
  'poststateVerifiedAt',
  'consumedAt',
  'rollbackStartedAt',
  'rolledBackAt',
  'reason',
  'createdAt',
  'updatedAt',
].sort();

function result(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  commitHash: string,
): AuthorityCommitResult {
  return {
    session,
    grantId: journal.grantId,
    commitHash,
    changedPaths: [...journal.allowedPaths],
    journalState: journal.state === 'audited' ? 'audited' : 'consumed',
    attestationRelayCommand:
      authorityAttestationRelayProjectionCommand(commitHash),
  };
}

function requireCommitHash(journal: AuthorityCommitJournal): string {
  if (!journal.commitHash) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_COMMIT_MISSING',
      'Authority journal does not identify its commit object.',
    );
  }
  return journal.commitHash;
}

function assertObjectId(value: string): string {
  if (!isObjectId(value)) {
    throw recoveryError(
      'AUTHORITY_OBJECT_ID_INVALID',
      'Authority transaction requires full Git object IDs.',
    );
  }
  return value;
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
}

function isPrefixedDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw recoveryError(
      'AUTHORITY_RECOVERY_TIME_INVALID',
      'Authority recovery requires an exact timestamp.',
    );
  }
  return date;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recoveryError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type MaintainerRecoveryJournalBindings = {
  assertSessionId: typeof assertSessionId;
  path: typeof path;
  maintainerGrantStorePaths: typeof maintainerGrantStorePaths;
  fs: typeof fs;
  recoveryError: typeof recoveryError;
  crypto: typeof crypto;
  canonicalJson: typeof canonicalJson;
  isRecord: typeof isRecord;
  CURRENT_JOURNAL_KEYS: typeof CURRENT_JOURNAL_KEYS;
  isPrefixedDigest: typeof isPrefixedDigest;
  isTimestamp: typeof isTimestamp;
  isObjectId: typeof isObjectId;
};
export type MaintainerRecoveryJournalBindingsTypes = {
  AuthorityCommitJournal: AuthorityCommitJournal;
  AuthorityCommitJournalState: AuthorityCommitJournalState;
  AuthoritySession: AuthoritySession;
};

const {
  readAuthorityCommitJournal,
  transitionJournal,
  writeJournal,
  assertJournalMatchesSession,
} = createMaintainerRecoveryJournal(() => ({
  assertSessionId,
  path,
  maintainerGrantStorePaths,
  fs,
  recoveryError,
  crypto,
  canonicalJson,
  isRecord,
  CURRENT_JOURNAL_KEYS,
  isPrefixedDigest,
  isTimestamp,
  isObjectId,
}));
export { readAuthorityCommitJournal };

export type MaintainerRecoveryAuditBindings = {
  readTerminalMaintainerGrant: typeof readTerminalMaintainerGrant;
  recoveryError: typeof recoveryError;
  runGit: typeof runGit;
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  createAuthorityApplicationReceiptPayload: typeof createAuthorityApplicationReceiptPayload;
  signedGrantEnvelopeDigest: typeof signedGrantEnvelopeDigest;
  canonicalMaintainerGrantV2Envelope: typeof canonicalMaintainerGrantV2Envelope;
  authorityApplicationReceiptTagRef: typeof authorityApplicationReceiptTagRef;
  createInteractiveSshSigner: typeof createInteractiveSshSigner;
  publishAuthorityApplicationReceipt: typeof publishAuthorityApplicationReceipt;
  canonicalJson: typeof canonicalJson;
  authorityAuditLedgerPaths: typeof authorityAuditLedgerPaths;
  authorityAuditAppendInputForEvent: typeof authorityAuditAppendInputForEvent;
  buildAuthorityAuditEvent: typeof buildAuthorityAuditEvent;
  scanAuthorityAuditLedger: typeof scanAuthorityAuditLedger;
  verifyAuthorityAuditEvents: typeof verifyAuthorityAuditEvents;
  recordAuthorityAuditEvent: typeof recordAuthorityAuditEvent;
  exactDate: typeof exactDate;
  transitionJournal: typeof transitionJournal;
  requireCommitHash: typeof requireCommitHash;
  digest: typeof digest;
};
export type MaintainerRecoveryAuditBindingsTypes = {
  AuthoritySession: AuthoritySession;
  AuthorityCommitJournal: AuthorityCommitJournal;
  AuthorityAuditLedgerScope: AuthorityAuditLedgerScope;
  MaintainerSignerProvider: MaintainerSignerProvider;
  TransactionAuditEvent: TransactionAuditEvent;
  AuthorityRecoveryOptions: AuthorityRecoveryOptions;
  AuthorityCommitJournalState: AuthorityCommitJournalState;
  AuthorityAuditEventInput: AuthorityAuditEventInput;
  AuditReceiptField: AuditReceiptField;
  AuthorityAuditLedgerEntry: AuthorityAuditLedgerEntry;
  AuthorityAuditAppendInput: AuthorityAuditAppendInput;
  Sha256Digest: Sha256Digest;
};

const {
  ensurePortableApplicationReceipt,
  authorityAuditScopeForJournal,
  ensureTransactionAuditReceipt,
  assertAppliedTransactionPoststate,
  assertRolledBackTransactionPoststate,
} = createMaintainerRecoveryAudit(() => ({
  readTerminalMaintainerGrant,
  recoveryError,
  runGit,
  parseMaintainerPolicy,
  createAuthorityApplicationReceiptPayload,
  signedGrantEnvelopeDigest,
  canonicalMaintainerGrantV2Envelope,
  authorityApplicationReceiptTagRef,
  createInteractiveSshSigner,
  publishAuthorityApplicationReceipt,
  canonicalJson,
  authorityAuditLedgerPaths,
  authorityAuditAppendInputForEvent,
  buildAuthorityAuditEvent,
  scanAuthorityAuditLedger,
  verifyAuthorityAuditEvents,
  recordAuthorityAuditEvent,
  exactDate,
  transitionJournal,
  requireCommitHash,
  digest,
}));

export type MaintainerRecoveryVerificationBindings = {
  assertJournalMatchesSession: typeof assertJournalMatchesSession;
  recoveryError: typeof recoveryError;
  requireCommitHash: typeof requireCommitHash;
  discoverRepository: typeof discoverRepository;
  commitFacts: typeof commitFacts;
  parseManagedTrailers: typeof parseManagedTrailers;
  digest: typeof digest;
  commitChangedPaths: typeof commitChangedPaths;
  authorityCandidateCommitMessage: typeof authorityCandidateCommitMessage;
  runGit: typeof runGit;
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  fs: typeof fs;
  path: typeof path;
  os: typeof os;
  isPostApprovalAdmissionFailure: typeof isPostApprovalAdmissionFailure;
};
export type MaintainerRecoveryVerificationBindingsTypes = {
  AuthoritySession: AuthoritySession;
  AuthorityCommitJournal: AuthorityCommitJournal;
};

const {
  verifyCreatedAuthorityCommit,
  verifyJournaledCommit,
  expectedAuthorityMessage,
} = createMaintainerRecoveryVerification(() => ({
  assertJournalMatchesSession,
  recoveryError,
  requireCommitHash,
  discoverRepository,
  commitFacts,
  parseManagedTrailers,
  digest,
  commitChangedPaths,
  authorityCandidateCommitMessage,
  runGit,
  parseMaintainerPolicy,
  fs,
  path,
  os,
  isPostApprovalAdmissionFailure,
}));
export { verifyCreatedAuthorityCommit };

export type MaintainerRecoveryTerminalizationBindings = {
  exactDate: typeof exactDate;
  recoveryError: typeof recoveryError;
  recordDurableRefGenerationTransitionUnderLifecycleLock: typeof recordDurableRefGenerationTransitionUnderLifecycleLock;
  terminallyInvalidateMaintainerReservationUnderLifecycleLock: typeof terminallyInvalidateMaintainerReservationUnderLifecycleLock;
  rollbackExactStaging: typeof rollbackExactStaging;
  transitionJournal: typeof transitionJournal;
  enterActivePostApprovalTerminalCleanup: typeof enterActivePostApprovalTerminalCleanup;
  readAuthoritySession: typeof readAuthoritySession;
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
  maintainerGrantStorePaths: typeof maintainerGrantStorePaths;
  readAuthorityCommitJournal: typeof readAuthorityCommitJournal;
  assertJournalMatchesSession: typeof assertJournalMatchesSession;
  discoverRepository: typeof discoverRepository;
  runGit: typeof runGit;
  terminallyExpireMaintainerReservationUnderLifecycleLock: typeof terminallyExpireMaintainerReservationUnderLifecycleLock;
  failAuthoritySession: typeof failAuthoritySession;
  terminallyFailMaintainerReservationUnderLifecycleLock: typeof terminallyFailMaintainerReservationUnderLifecycleLock;
  isPostApprovalAdmissionFailure: typeof isPostApprovalAdmissionFailure;
  authorityAuditScopeForJournal: typeof authorityAuditScopeForJournal;
  ensureTransactionAuditReceipt: typeof ensureTransactionAuditReceipt;
  requireCommitHash: typeof requireCommitHash;
  verifyJournaledCommit: typeof verifyJournaledCommit;
  updateManagedRef: typeof updateManagedRef;
  readDurableRefGenerationLedger: typeof readDurableRefGenerationLedger;
  assertRolledBackTransactionPoststate: typeof assertRolledBackTransactionPoststate;
};
export type MaintainerRecoveryTerminalizationBindingsTypes = {
  AuthoritySession: AuthoritySession;
  AuthorityCommitJournal: AuthorityCommitJournal;
};

const {
  rejectAmbiguousAuthorityCas,
  expireAuthorityCommitBeforeCas,
  failAuthorityCommitBeforeCas,
  rollbackAuthorityCommitAfterCas,
  revokePreparingTransaction,
  revokeAmbiguousTransaction,
} = createMaintainerRecoveryTerminalization(() => ({
  exactDate,
  recoveryError,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
  terminallyInvalidateMaintainerReservationUnderLifecycleLock,
  rollbackExactStaging,
  transitionJournal,
  enterActivePostApprovalTerminalCleanup,
  readAuthoritySession,
  withRepositoryLifecycleOperation,
  maintainerGrantStorePaths,
  readAuthorityCommitJournal,
  assertJournalMatchesSession,
  discoverRepository,
  runGit,
  terminallyExpireMaintainerReservationUnderLifecycleLock,
  failAuthoritySession,
  terminallyFailMaintainerReservationUnderLifecycleLock,
  isPostApprovalAdmissionFailure,
  authorityAuditScopeForJournal,
  ensureTransactionAuditReceipt,
  requireCommitHash,
  verifyJournaledCommit,
  updateManagedRef,
  readDurableRefGenerationLedger,
  assertRolledBackTransactionPoststate,
}));
export {
  expireAuthorityCommitBeforeCas,
  failAuthorityCommitBeforeCas,
  rollbackAuthorityCommitAfterCas,
};
