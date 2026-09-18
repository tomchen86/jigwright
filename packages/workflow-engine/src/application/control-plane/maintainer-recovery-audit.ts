import type { MaintainerSignerFactory } from '../../modules/authority/maintainer-signer-port.ts';
import type { AuthorityApplicationReceiptOperations } from '../../modules/authority/authority-application-receipt.ts';
/**
 * Reconstructs portable application and transaction audit receipts during
 * recovery.
 *
 * Invariants:
 * - Portable receipts require the exact consumed grant, session, commit,
 *   and time.
 */
// maintainer recovery audit; repository effects remain bound by the public module.
import type {
  MaintainerRecoveryAuditBindings,
  MaintainerRecoveryAuditBindingsTypes,
} from './maintainer-recovery.ts';
type AuthoritySession =
  MaintainerRecoveryAuditBindingsTypes['AuthoritySession'];
type AuthorityCommitJournal =
  MaintainerRecoveryAuditBindingsTypes['AuthorityCommitJournal'];
type AuthorityAuditLedgerScope =
  MaintainerRecoveryAuditBindingsTypes['AuthorityAuditLedgerScope'];
type MaintainerSignerProvider =
  MaintainerRecoveryAuditBindingsTypes['MaintainerSignerProvider'];
type TransactionAuditEvent =
  MaintainerRecoveryAuditBindingsTypes['TransactionAuditEvent'];
type AuthorityRecoveryOptions =
  MaintainerRecoveryAuditBindingsTypes['AuthorityRecoveryOptions'];
type AuthorityCommitJournalState =
  MaintainerRecoveryAuditBindingsTypes['AuthorityCommitJournalState'];
type AuthorityAuditEventInput =
  MaintainerRecoveryAuditBindingsTypes['AuthorityAuditEventInput'];
type AuditReceiptField =
  MaintainerRecoveryAuditBindingsTypes['AuditReceiptField'];
type AuthorityAuditLedgerEntry =
  MaintainerRecoveryAuditBindingsTypes['AuthorityAuditLedgerEntry'];
type AuthorityAuditAppendInput =
  MaintainerRecoveryAuditBindingsTypes['AuthorityAuditAppendInput'];
type Sha256Digest = MaintainerRecoveryAuditBindingsTypes['Sha256Digest'];

export function createMaintainerRecoveryAudit(
  bindings: () => MaintainerRecoveryAuditBindings,
) {
  function ensurePortableApplicationReceipt(
    createSigner: MaintainerSignerFactory,
    authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    auditScope: AuthorityAuditLedgerScope,
    providedSigner: MaintainerSignerProvider | undefined,
  ): void {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const {
      readTerminalMaintainerGrant,
      recoveryError,
      runGit,
      parseMaintainerPolicy,
      createAuthorityApplicationReceiptPayload,
      signedGrantEnvelopeDigest,
      canonicalMaintainerGrantV2Envelope,
      authorityApplicationReceiptTagRef,
    } = boundServices;

    const terminal = readTerminalMaintainerGrant(
      session.gitCommonDirectory,
      session.grantId,
    );
    if (
      terminal.state !== 'consumed' ||
      terminal.sessionId !== session.sessionId ||
      terminal.commitHash !== journal.commitHash ||
      terminal.recordedAt !== journal.consumedAt
    ) {
      throw recoveryError(
        'AUTHORITY_APPLICATION_RECEIPT_TERMINAL_MISMATCH',
        'Portable authority receipt requires the exact consumed v2 terminal grant state.',
      );
    }
    const envelope = terminal.envelope;
    const candidate = envelope.payload.candidateBundle;
    if (
      candidate === null ||
      journal.commitHash === null ||
      journal.refUpdatedAt === null ||
      journal.poststateVerifiedAt === null ||
      journal.consumedAt === null ||
      journal.casAuditRecordDigest === null ||
      journal.poststateAuditRecordDigest === null ||
      journal.consumeAuditRecordDigest === null ||
      session.expectedRefGeneration === null ||
      session.candidateBundleDigest !== candidate.candidateBundleDigest ||
      envelope.payload.effectsManifestDigest !==
        candidate.effectsManifestDigest ||
      session.candidateCommit !== candidate.candidateCommit ||
      session.resultTree !== candidate.resultTree ||
      candidate.targetRef !== `refs/heads/${session.branch}` ||
      candidate.expectedOldCommit !== journal.baseCommit ||
      candidate.expectedRefGeneration !== session.expectedRefGeneration ||
      candidate.candidateCommit !== journal.commitHash ||
      candidate.resultTree !== journal.expectedTree
    ) {
      throw recoveryError(
        'AUTHORITY_APPLICATION_RECEIPT_BINDING_INVALID',
        'Portable authority receipt inputs differ from the exact candidate transaction.',
      );
    }
    const policyContent = runGit(session.repositoryRoot, [
      'show',
      `${session.baseCommit}:workflow/maintainer-policy.json`,
    ]);
    const policy = parseMaintainerPolicy(JSON.parse(policyContent));
    const grantTagRef = `${policy.auditTagPrefix}${session.grantId}`;
    const receipt = createAuthorityApplicationReceiptPayload({
      grantId: session.grantId,
      repositoryId: envelope.payload.repositoryId,
      repositoryOrigin: envelope.payload.repositoryOrigin,
      changeId: session.changeId,
      signer: session.signer,
      grantTagRef,
      grantEnvelopeDigest: signedGrantEnvelopeDigest(
        canonicalMaintainerGrantV2Envelope(envelope),
      ),
      candidateBundleDigest: candidate.candidateBundleDigest,
      effectsManifestDigest: candidate.effectsManifestDigest,
      evidenceWaivers: envelope.payload.evidenceWaivers,
      candidatePatchDigest: envelope.payload.patchDigest,
      candidateCommit: candidate.candidateCommit,
      candidateTree: candidate.resultTree,
      targetRef: candidate.targetRef,
      oldRefOid: candidate.expectedOldCommit,
      oldRefGeneration: candidate.expectedRefGeneration,
      newRefOid: candidate.candidateCommit,
      newRefGeneration: candidate.expectedRefGeneration + 1,
      casAt: journal.refUpdatedAt,
      casAuditReceiptDigest: journal.casAuditRecordDigest,
      auditRepositoryId: auditScope.repositoryId,
      poststateVerifiedAt: journal.poststateVerifiedAt,
      poststateAuditReceiptDigest: journal.poststateAuditRecordDigest,
      terminalGrantState: 'consumed',
      terminalReservationId: session.sessionId,
      terminalCommit: candidate.candidateCommit,
      terminalConsumedAt: terminal.recordedAt,
      grantConsumeAuditReceiptDigest: journal.consumeAuditRecordDigest,
      issuedAt: journal.updatedAt,
    });
    const receiptRef = authorityApplicationReceiptTagRef(
      policy,
      session.grantId,
    );
    const alreadyPublished = runGit(
      session.repositoryRoot,
      ['rev-parse', '--verify', receiptRef],
      true,
    ).trim();
    let signer = providedSigner;
    if (!alreadyPublished) {
      signer ??= createSigner(session.repositoryRoot, policy);
      signer.assertHumanPresent();
    }
    authorityApplicationReceipts.publishAuthorityApplicationReceipt(
      session.repositoryRoot,
      policy,
      receipt,
      signer,
    );
  }

  function authorityAuditScopeForJournal(
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
  ): AuthorityAuditLedgerScope {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { canonicalJson, recoveryError, authorityAuditLedgerPaths } =
      boundServices;

    if (
      journal.externalAuditRoot === null ||
      journal.auditRepositoryId === null ||
      journal.mandateBinding === null ||
      session.mandateBinding === null ||
      canonicalJson(journal.mandateBinding) !==
        canonicalJson(session.mandateBinding) ||
      journal.externalAuditRoot !== session.mandateBinding.externalAuditRoot
    ) {
      throw recoveryError(
        'AUTHORITY_AUDIT_ROOT_MISMATCH',
        'Recovery requires the exact external audit root bound before the authority CAS.',
      );
    }
    const scope: AuthorityAuditLedgerScope = {
      externalAuditRoot: journal.externalAuditRoot,
      repositoryRoot: session.repositoryRoot,
      repositoryId: journal.auditRepositoryId,
    };
    authorityAuditLedgerPaths(scope);
    return scope;
  }

  function ensureTransactionAuditReceipt(
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    scope: AuthorityAuditLedgerScope,
    eventType: TransactionAuditEvent,
    now: Date,
    options: AuthorityRecoveryOptions = {},
  ): AuthorityCommitJournal {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const {
      authorityAuditAppendInputForEvent,
      buildAuthorityAuditEvent,
      scanAuthorityAuditLedger,
      verifyAuthorityAuditEvents,
      recoveryError,
      recordAuthorityAuditEvent,
      exactDate,
      transitionJournal,
    } = boundServices;

    const field = auditReceiptField(eventType);
    const eventInput = transactionAuditEventInput(session, journal, eventType);
    const input = authorityAuditAppendInputForEvent(
      buildAuthorityAuditEvent(scope.repositoryId, eventInput),
    );
    const expectedDigest = journal[field];
    if (expectedDigest !== null) {
      const existing = scanAuthorityAuditLedger(scope).records.find(
        ({ recordDigest }) => recordDigest === expectedDigest,
      );
      const projected = verifyAuthorityAuditEvents(scope).events.some(
        ({ ledger }) => ledger.recordDigest === expectedDigest,
      );
      if (
        existing === undefined ||
        !auditRecordMatches(existing, input) ||
        !projected
      ) {
        throw recoveryError(
          'AUTHORITY_AUDIT_RECEIPT_DIVERGED',
          'A journaled authority audit receipt differs from the external ledger.',
        );
      }
      return journal;
    }
    if (eventType === 'cas' || eventType === 'grant-consume') {
      options.testBeforeAudit?.(eventType);
    }
    const entry = recordAuthorityAuditEvent(scope, eventInput).ledger;
    const update = {
      state: journal.state,
      updatedAt: exactDate(now).toISOString(),
      [field]: entry.recordDigest,
    } as Partial<AuthorityCommitJournal> & {
      state: AuthorityCommitJournalState;
      updatedAt: string;
    };
    return transitionJournal(
      session.gitCommonDirectory,
      journal,
      journal.state,
      update,
    );
  }

  function transactionAuditEventInput(
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    eventType: TransactionAuditEvent,
  ): AuthorityAuditEventInput {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { requireCommitHash, recoveryError } = boundServices;

    const commitHash = requireCommitHash(journal);
    const occurredAt = auditEventTimestamp(journal, eventType);
    if (occurredAt === null) {
      throw recoveryError(
        'AUTHORITY_AUDIT_STATE_INVALID',
        'Authority audit event is missing its durable transaction timestamp.',
      );
    }
    const targetRef = `refs/heads/${session.branch}`;
    const grantDigest = prefixedDigest(session.grantDigest);
    if (session.candidateBundleDigest === null) {
      throw recoveryError(
        'AUTHORITY_AUDIT_STATE_INVALID',
        'A v2 authority audit event requires its exact immutable candidate digest.',
      );
    }
    const candidateBundleDigest = prefixedDigest(session.candidateBundleDigest);
    const basePrestateDigest = auditValueDigest({
      schemaVersion: 1,
      kind: 'authority-apply-prestate.v1',
      targetRef,
      baseCommit: journal.baseCommit,
      expectedRefGeneration: session.expectedRefGeneration,
    });
    const appliedPoststateDigest = auditValueDigest({
      schemaVersion: 1,
      kind: 'authority-apply-poststate.v1',
      targetRef,
      commitHash,
      resultTree: journal.expectedTree,
      refGeneration:
        session.expectedRefGeneration === null
          ? null
          : session.expectedRefGeneration + 1,
    });
    const rolledBackPoststateDigest = auditValueDigest({
      schemaVersion: 1,
      kind: 'authority-rollback-poststate.v1',
      targetRef,
      commitHash: journal.baseCommit,
      resultTree: session.baselineTree,
      refGeneration:
        session.expectedRefGeneration === null
          ? null
          : session.expectedRefGeneration + 2,
    });
    const prestateDigest =
      eventType === 'cas' || eventType === 'grant-consume'
        ? basePrestateDigest
        : appliedPoststateDigest;
    const poststateDigest =
      eventType === 'rollback'
        ? rolledBackPoststateDigest
        : appliedPoststateDigest;
    const outcome = auditResult(session, journal, eventType, commitHash);
    return {
      eventType,
      occurredAt,
      idempotencyKey: auditValueDigest({
        schemaVersion: 1,
        kind: 'authority-audit-idempotency.v1',
        eventType,
        sessionId: session.sessionId,
        grantDigest,
        commitHash,
      }),
      grantDigest,
      candidateBundleDigest,
      prestateDigest,
      poststateDigest,
      actor: { kind: 'human', identity: session.signer },
      taskId: session.mandateBinding?.mandateTaskId ?? null,
      changeId: session.changeId,
      workflowId: null,
      command: {
        name: `authority.${eventType}`,
        argvDigest: outcome.outcomeDigest,
      },
      providerInvocation: null,
      externalEffect: null,
      result: outcome.result,
      outcomeDigest: outcome.outcomeDigest,
      errorCode: eventType === 'error' ? 'AUTHORITY_TRANSACTION_FAILED' : null,
    };
  }

  function auditResult(
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    eventType: TransactionAuditEvent,
    commitHash: string,
  ): Pick<AuthorityAuditEventInput, 'result' | 'outcomeDigest'> {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { recoveryError } = boundServices;

    const common = {
      schemaVersion: 1,
      eventType,
      grantId: session.grantId,
      commitHash,
      changedPaths: journal.allowedPaths,
    };
    if (eventType === 'error' || eventType === 'rollback') {
      if (journal.reason === null) {
        throw recoveryError(
          'AUTHORITY_AUDIT_STATE_INVALID',
          'Rollback audit events require their durable failure reason digest.',
        );
      }
      const reasonDigest = auditValueDigest({
        schemaVersion: 1,
        kind: 'authority-failure-reason.v1',
        reason: journal.reason,
      });
      return {
        result: eventType === 'error' ? 'failed' : 'rolled-back',
        outcomeDigest: auditValueDigest({
          ...common,
          kind:
            eventType === 'error'
              ? 'authority-poststate-error-result.v1'
              : 'authority-rollback-result.v1',
          reasonDigest,
          ...(eventType === 'rollback'
            ? { rollbackTo: journal.baseCommit }
            : {}),
        }),
      };
    }
    return {
      result: 'succeeded',
      outcomeDigest: auditValueDigest({
        ...common,
        kind:
          eventType === 'cas'
            ? 'authority-cas-result.v1'
            : eventType === 'poststate'
              ? 'authority-poststate-result.v1'
              : 'authority-grant-consume-result.v1',
      }),
    };
  }

  function auditEventTimestamp(
    journal: AuthorityCommitJournal,
    eventType: TransactionAuditEvent,
  ): string | null {
    switch (eventType) {
      case 'cas':
        return journal.refUpdatedAt;
      case 'poststate':
        return journal.poststateVerifiedAt;
      case 'grant-consume':
        return journal.consumedAt;
      case 'error':
        return journal.rollbackStartedAt;
      case 'rollback':
        return journal.rolledBackAt;
    }
  }

  function auditReceiptField(
    eventType: TransactionAuditEvent,
  ): AuditReceiptField {
    switch (eventType) {
      case 'cas':
        return 'casAuditRecordDigest';
      case 'poststate':
        return 'poststateAuditRecordDigest';
      case 'grant-consume':
        return 'consumeAuditRecordDigest';
      case 'error':
        return 'errorAuditRecordDigest';
      case 'rollback':
        return 'rollbackAuditRecordDigest';
    }
  }

  function auditRecordMatches(
    entry: AuthorityAuditLedgerEntry,
    input: AuthorityAuditAppendInput,
  ): boolean {
    const { record } = entry;
    return (
      record.eventType === input.eventType &&
      record.occurredAt === input.occurredAt &&
      record.idempotencyKey === input.idempotencyKey &&
      record.grantDigest === input.grantDigest &&
      record.candidateBundleDigest === input.candidateBundleDigest &&
      record.prestateDigest === input.prestateDigest &&
      record.poststateDigest === input.poststateDigest &&
      record.result === input.result &&
      record.resultDigest === input.resultDigest
    );
  }

  function assertAppliedTransactionPoststate(
    repositoryRoot: string,
    targetRef: string,
    commitHash: string,
    expectedTree: string,
  ): void {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { runGit, recoveryError } = boundServices;

    const observedRef = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      targetRef,
    ]).trim();
    const observedTree = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${commitHash}^{tree}`,
    ]).trim();
    if (observedRef !== commitHash || observedTree !== expectedTree) {
      throw recoveryError(
        'AUTHORITY_POSTSTATE_VERIFICATION_FAILED',
        'The applied authority ref or result tree differs from its exact journaled poststate.',
      );
    }
  }

  function assertRolledBackTransactionPoststate(
    repositoryRoot: string,
    targetRef: string,
    baseCommit: string,
    baselineTree: string,
  ): void {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { runGit, recoveryError } = boundServices;

    const observedRef = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      targetRef,
    ]).trim();
    const observedTree = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${baseCommit}^{tree}`,
    ]).trim();
    if (observedRef !== baseCommit || observedTree !== baselineTree) {
      throw recoveryError(
        'AUTHORITY_ROLLBACK_POSTSTATE_DIVERGED',
        'The rolled-back authority ref or tree differs from its exact journaled poststate.',
      );
    }
  }

  function auditValueDigest(value: unknown): Sha256Digest {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { digest, canonicalJson } = boundServices;

    return `sha256:${digest(canonicalJson(value))}`;
  }

  function prefixedDigest(value: string): Sha256Digest {
    const boundServices: MaintainerRecoveryAuditBindings = bindings();
    const { recoveryError } = boundServices;

    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw recoveryError(
        'AUTHORITY_AUDIT_STATE_INVALID',
        'Authority audit binding requires an exact SHA-256 digest.',
      );
    }
    return `sha256:${value}`;
  }
  return {
    ensurePortableApplicationReceipt,
    authorityAuditScopeForJournal,
    ensureTransactionAuditReceipt,
    assertAppliedTransactionPoststate,
    assertRolledBackTransactionPoststate,
  };
}
