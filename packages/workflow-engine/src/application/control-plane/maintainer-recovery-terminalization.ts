// maintainer recovery terminalization; repository effects remain bound by the public module.
import type {
  MaintainerRecoveryTerminalizationBindings,
  MaintainerRecoveryTerminalizationBindingsTypes,
} from './maintainer-recovery.ts';
type AuthoritySession =
  MaintainerRecoveryTerminalizationBindingsTypes['AuthoritySession'];
type AuthorityCommitJournal =
  MaintainerRecoveryTerminalizationBindingsTypes['AuthorityCommitJournal'];

export function createMaintainerRecoveryTerminalization(
  bindings: () => MaintainerRecoveryTerminalizationBindings,
) {
  function rejectAmbiguousAuthorityCas(
    repositoryRoot: string,
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    indexTree: string,
    now: Date,
    assertOwned: () => void,
  ): never {
    const boundServices: MaintainerRecoveryTerminalizationBindings = bindings();
    const {
      exactDate,
      recoveryError,
      recordDurableRefGenerationTransitionUnderLifecycleLock,
      terminallyInvalidateMaintainerReservationUnderLifecycleLock,
      rollbackExactStaging,
      transitionJournal,
    } = boundServices;

    const timestamp = exactDate(now);
    const error = recoveryError(
      'AUTHORITY_CAS_OUTCOME_AMBIGUOUS',
      'The ref returned to its base after CAS preparation; replay is forbidden.',
    );
    if (session.expectedRefGeneration !== null) {
      recordDurableRefGenerationTransitionUnderLifecycleLock(
        session.gitCommonDirectory,
        {
          ref: `refs/heads/${session.branch}`,
          expectedOid: journal.baseCommit,
          expectedGeneration: session.expectedRefGeneration,
          nextOid: journal.baseCommit,
          reason: 'uncertain-cas',
          at: timestamp.toISOString(),
        },
        assertOwned,
      );
    }
    terminallyInvalidateMaintainerReservationUnderLifecycleLock(
      session.gitCommonDirectory,
      session.grantId,
      session.sessionId,
      error.message,
      timestamp,
    );
    if (indexTree === journal.expectedTree) {
      rollbackExactStaging(
        repositoryRoot,
        journal.previousIndexTree,
        journal.expectedTree,
        error,
      );
    }
    transitionJournal(session.gitCommonDirectory, journal, 'cas-prepared', {
      state: 'revoked',
      reason: error.message,
      updatedAt: timestamp.toISOString(),
    });
    throw error;
  }

  function expireAuthorityCommitBeforeCas(
    cwd: string,
    requestedSessionId: string,
    now = new Date(),
  ): void {
    const boundServices: MaintainerRecoveryTerminalizationBindings = bindings();
    const {
      enterActivePostApprovalTerminalCleanup,
      readAuthoritySession,
      exactDate,
      recoveryError,
      withRepositoryLifecycleOperation,
      maintainerGrantStorePaths,
      readAuthorityCommitJournal,
      assertJournalMatchesSession,
      discoverRepository,
      runGit,
      transitionJournal,
      terminallyExpireMaintainerReservationUnderLifecycleLock,
      rollbackExactStaging,
      failAuthoritySession,
    } = boundServices;

    enterActivePostApprovalTerminalCleanup();
    const session = readAuthoritySession(cwd, requestedSessionId);
    const timestamp = exactDate(now);
    const expiryError = recoveryError(
      'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS',
      'The authority grant expired before the protected ref was updated.',
    );
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const journal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        assertJournalMatchesSession(journal, session);
        if (
          journal.state !== 'preparing' &&
          journal.state !== 'commit-created' &&
          journal.state !== 'revoked'
        ) {
          throw recoveryError(
            'AUTHORITY_EXPIRY_STATE_INVALID',
            'Only a pre-CAS commit-created transaction may expire.',
          );
        }
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (
          git.head !== journal.baseCommit ||
          (indexTree !== journal.expectedTree &&
            indexTree !== journal.previousIndexTree)
        ) {
          throw recoveryError(
            'AUTHORITY_EXPIRY_PRESTATE_DIVERGED',
            'The pre-CAS transaction diverged before expiry cleanup.',
          );
        }
        if (
          journal.state === 'preparing' ||
          journal.state === 'commit-created'
        ) {
          transitionJournal(
            session.gitCommonDirectory,
            journal,
            journal.state,
            {
              state: 'revoked',
              reason: expiryError.message,
              updatedAt: timestamp.toISOString(),
            },
          );
        }
        terminallyExpireMaintainerReservationUnderLifecycleLock(
          session.gitCommonDirectory,
          session.grantId,
          session.sessionId,
          expiryError.message,
          timestamp,
        );
        if (indexTree === journal.expectedTree) {
          rollbackExactStaging(
            git.repositoryRoot,
            journal.previousIndexTree,
            journal.expectedTree,
            expiryError,
          );
        }
      },
      { allowMaintainerGrantId: session.grantId },
    );
    if (session.state === 'active') {
      failAuthoritySession(session, expiryError, timestamp);
    }
  }

  function failAuthorityCommitBeforeCas(
    cwd: string,
    requestedSessionId: string,
    cause: unknown,
    now = new Date(),
  ): void {
    const boundServices: MaintainerRecoveryTerminalizationBindings = bindings();
    const {
      readAuthoritySession,
      exactDate,
      recoveryError,
      withRepositoryLifecycleOperation,
      maintainerGrantStorePaths,
      readAuthorityCommitJournal,
      assertJournalMatchesSession,
      transitionJournal,
      terminallyFailMaintainerReservationUnderLifecycleLock,
      discoverRepository,
      runGit,
      rollbackExactStaging,
      isPostApprovalAdmissionFailure,
      enterActivePostApprovalTerminalCleanup,
      failAuthoritySession,
    } = boundServices;

    const session = readAuthoritySession(cwd, requestedSessionId);
    const timestamp = exactDate(now);
    const failure =
      cause instanceof Error
        ? cause
        : recoveryError(
            'AUTHORITY_POST_APPROVAL_TIMEOUT',
            'Post-approval admission timed out before CAS.',
          );
    let cleanupAdmissionFailure: unknown;
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const journal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        assertJournalMatchesSession(journal, session);
        if (
          journal.state !== 'preparing' &&
          journal.state !== 'commit-created' &&
          journal.state !== 'revoked'
        ) {
          throw recoveryError(
            'AUTHORITY_POST_APPROVAL_TIMEOUT_STATE_INVALID',
            'Only a pre-CAS authority transaction may fail admission.',
          );
        }
        if (
          journal.state === 'preparing' ||
          journal.state === 'commit-created'
        ) {
          transitionJournal(
            session.gitCommonDirectory,
            journal,
            journal.state,
            {
              state: 'revoked',
              reason: failure.message,
              updatedAt: timestamp.toISOString(),
            },
          );
        }
        terminallyFailMaintainerReservationUnderLifecycleLock(
          session.gitCommonDirectory,
          session.grantId,
          session.sessionId,
          failure.message,
          timestamp,
        );
        const restoreExactIndex = () => {
          const git = discoverRepository(cwd);
          const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
          if (
            git.head === journal.baseCommit &&
            indexTree === journal.expectedTree
          ) {
            rollbackExactStaging(
              git.repositoryRoot,
              journal.previousIndexTree,
              journal.expectedTree,
              failure,
            );
          }
        };
        try {
          restoreExactIndex();
        } catch (error) {
          if (isPostApprovalAdmissionFailure(error)) {
            cleanupAdmissionFailure = error;
            enterActivePostApprovalTerminalCleanup();
            try {
              restoreExactIndex();
            } catch {
              // Durable denial remains authoritative when exact residue cleanup
              // encounters a second independent failure.
            }
          }
          // Denial is durable before best-effort exact residue cleanup. Unknown
          // or foreign Git state is preserved and cannot restore authority.
        }
      },
      { allowMaintainerGrantId: session.grantId },
    );
    if (session.state === 'active') {
      failAuthoritySession(session, failure, timestamp);
    }
    if (cleanupAdmissionFailure !== undefined) {
      throw cleanupAdmissionFailure;
    }
  }

  function rollbackAuthorityCommitAfterCas(
    cwd: string,
    requestedSessionId: string,
    reason: string,
    now = new Date(),
  ): void {
    const boundServices: MaintainerRecoveryTerminalizationBindings = bindings();
    const {
      readAuthoritySession,
      exactDate,
      withRepositoryLifecycleOperation,
      maintainerGrantStorePaths,
      readAuthorityCommitJournal,
      assertJournalMatchesSession,
      authorityAuditScopeForJournal,
      transitionJournal,
      ensureTransactionAuditReceipt,
      recoveryError,
      requireCommitHash,
      verifyJournaledCommit,
      discoverRepository,
      runGit,
      terminallyFailMaintainerReservationUnderLifecycleLock,
      updateManagedRef,
      readDurableRefGenerationLedger,
      recordDurableRefGenerationTransitionUnderLifecycleLock,
      rollbackExactStaging,
      assertRolledBackTransactionPoststate,
      failAuthoritySession,
    } = boundServices;

    const session = readAuthoritySession(cwd, requestedSessionId);
    const timestamp = exactDate(now);
    const rollbackReason =
      reason.trim().length > 0
        ? reason.trim().slice(0, 1_000)
        : 'Authority poststate verification failed';
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        let journal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        assertJournalMatchesSession(journal, session);
        const auditScope = authorityAuditScopeForJournal(session, journal);
        if (journal.state === 'ref-updated') {
          journal = transitionJournal(
            session.gitCommonDirectory,
            journal,
            'ref-updated',
            {
              state: 'rollback-prepared',
              reason: rollbackReason,
              rollbackStartedAt: timestamp.toISOString(),
              updatedAt: timestamp.toISOString(),
            },
          );
        }
        if (
          journal.state === 'rollback-prepared' &&
          journal.rollbackStartedAt === null
        ) {
          journal = transitionJournal(
            session.gitCommonDirectory,
            journal,
            'rollback-prepared',
            {
              state: 'rollback-prepared',
              rollbackStartedAt: journal.updatedAt,
              updatedAt: journal.updatedAt,
            },
          );
        }
        if (journal.state === 'rolled-back') {
          if (
            journal.rollbackStartedAt === null ||
            journal.rolledBackAt === null
          ) {
            journal = transitionJournal(
              session.gitCommonDirectory,
              journal,
              'rolled-back',
              {
                state: 'rolled-back',
                rollbackStartedAt:
                  journal.rollbackStartedAt ?? journal.updatedAt,
                rolledBackAt: journal.rolledBackAt ?? journal.updatedAt,
                updatedAt: journal.updatedAt,
              },
            );
          }
          if (auditScope !== null) {
            journal = ensureTransactionAuditReceipt(
              session,
              journal,
              auditScope,
              'cas',
              timestamp,
            );
            journal = ensureTransactionAuditReceipt(
              session,
              journal,
              auditScope,
              'error',
              timestamp,
            );
            ensureTransactionAuditReceipt(
              session,
              journal,
              auditScope,
              'rollback',
              timestamp,
            );
          }
          return;
        }
        if (journal.state !== 'rollback-prepared') {
          throw recoveryError(
            'AUTHORITY_ROLLBACK_STATE_INVALID',
            'Only a ref-updated authority transaction may roll back.',
          );
        }
        const commitHash = requireCommitHash(journal);
        verifyJournaledCommit(cwd, session, journal, commitHash);
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (
          (git.head !== commitHash && git.head !== journal.baseCommit) ||
          (indexTree !== journal.expectedTree &&
            indexTree !== journal.previousIndexTree)
        ) {
          throw recoveryError(
            'AUTHORITY_ROLLBACK_PRESTATE_DIVERGED',
            'Authority rollback prestate differs from its journal.',
          );
        }
        if (auditScope !== null) {
          journal = ensureTransactionAuditReceipt(
            session,
            journal,
            auditScope,
            'cas',
            timestamp,
          );
          journal = ensureTransactionAuditReceipt(
            session,
            journal,
            auditScope,
            'error',
            timestamp,
          );
        }
        terminallyFailMaintainerReservationUnderLifecycleLock(
          session.gitCommonDirectory,
          session.grantId,
          session.sessionId,
          rollbackReason,
          timestamp,
        );
        const targetRef = `refs/heads/${session.branch}`;
        if (git.head === commitHash) {
          updateManagedRef(
            git.repositoryRoot,
            commitHash,
            journal.baseCommit,
            targetRef,
          );
        }
        if (session.expectedRefGeneration !== null) {
          const ledger = readDurableRefGenerationLedger(
            session.gitCommonDirectory,
            targetRef,
            true,
          );
          const appliedGeneration = session.expectedRefGeneration + 1;
          if (
            ledger.currentOid === commitHash &&
            ledger.generation === appliedGeneration
          ) {
            recordDurableRefGenerationTransitionUnderLifecycleLock(
              session.gitCommonDirectory,
              {
                ref: targetRef,
                expectedOid: commitHash,
                expectedGeneration: appliedGeneration,
                nextOid: journal.baseCommit,
                reason: 'rollback',
                at: timestamp.toISOString(),
              },
              assertOwned,
            );
          } else if (
            ledger.currentOid !== journal.baseCommit ||
            ledger.generation !== appliedGeneration + 1
          ) {
            throw recoveryError(
              'AUTHORITY_ROLLBACK_GENERATION_DIVERGED',
              'Authority rollback ref generation differs from its journal.',
            );
          }
        }
        if (indexTree === journal.expectedTree) {
          rollbackExactStaging(
            git.repositoryRoot,
            journal.previousIndexTree,
            journal.expectedTree,
            new Error(rollbackReason),
          );
        }
        assertRolledBackTransactionPoststate(
          git.repositoryRoot,
          targetRef,
          journal.baseCommit,
          session.baselineTree,
        );
        journal = transitionJournal(
          session.gitCommonDirectory,
          journal,
          'rollback-prepared',
          {
            state: 'rolled-back',
            reason: rollbackReason,
            rolledBackAt: timestamp.toISOString(),
            updatedAt: timestamp.toISOString(),
          },
        );
        if (auditScope !== null) {
          ensureTransactionAuditReceipt(
            session,
            journal,
            auditScope,
            'rollback',
            timestamp,
          );
        }
      },
      { allowMaintainerGrantId: session.grantId },
    );
    if (session.state === 'active') {
      failAuthoritySession(
        session,
        recoveryError(
          'AUTHORITY_POSTSTATE_VERIFICATION_FAILED',
          rollbackReason,
        ),
        timestamp,
      );
    }
  }

  function revokePreparingTransaction(
    cwd: string,
    session: AuthoritySession,
    now: Date,
  ): never {
    const boundServices: MaintainerRecoveryTerminalizationBindings = bindings();
    const { recoveryError } = boundServices;

    const error = recoveryError(
      'AUTHORITY_RECOVERY_REVOKED',
      'Preparing authority transaction was rolled back and revoked.',
    );
    failAuthorityCommitBeforeCas(cwd, session.sessionId, error, now);
    throw error;
  }

  function revokeAmbiguousTransaction(
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    cause: unknown,
    now: Date,
  ): void {
    const boundServices: MaintainerRecoveryTerminalizationBindings = bindings();
    const {
      readAuthorityCommitJournal,
      transitionJournal,
      exactDate,
      failAuthoritySession,
    } = boundServices;

    try {
      const observed = readAuthorityCommitJournal(
        session.gitCommonDirectory,
        session.sessionId,
      );
      if (
        observed.state !== 'consumed' &&
        observed.state !== 'audited' &&
        observed.state !== 'revoked'
      ) {
        transitionJournal(
          session.gitCommonDirectory,
          observed,
          observed.state,
          {
            state: 'revoked',
            reason:
              cause instanceof Error
                ? cause.message
                : 'Ambiguous recovery state',
            updatedAt: exactDate(now).toISOString(),
          },
        );
      }
    } catch {
      // The terminal grant record remains the fail-closed authority if the
      // private journal itself is too damaged to update safely.
    }
    if (session.state === 'active') {
      failAuthoritySession(session, cause, now);
    }
  }
  return {
    rejectAmbiguousAuthorityCas,
    expireAuthorityCommitBeforeCas,
    failAuthorityCommitBeforeCas,
    rollbackAuthorityCommitAfterCas,
    revokePreparingTransaction,
    revokeAmbiguousTransaction,
  };
}
