/** Reservation, dispatch, observation and terminal publication under the lifecycle lock. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import {
  PUBLISH_TRANSACTION_ENV,
  type ExternalEffectAuditEventType,
  type ExternalEffectObservation,
  type ExternalEffectGrantInspection,
  type ExternalEffectTransitionOptions,
  type TerminalState,
  type TerminalRecord,
  type StoreState,
  inspectionFromState,
  assertTransactionId,
  assertObservationClock,
  expired,
  exactDate,
  assertUuid,
  assertUuidForPublish,
  assertReason,
  sha256,
  stateConflict,
  publishTransactionRequired,
  publishTransactionInvalid,
} from '../../modules/authority/external-effect-grant.ts';

import {
  createTransactionRecord,
  replaceTransactionDigest,
  createObservation,
  canonicalAvailable,
  canonicalTransaction,
  canonicalTerminal,
} from '../../modules/authority/external-effect-grant-records.ts';
import { auditInput } from '../../modules/authority/external-effect-grant-audit.ts';
import { type MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import { type ExternalEffectGrantContext } from './external-effect-grant-context.ts';

export function createExternalEffectGrantTransaction({
  discoverRepository,
  externalEffectStorePaths,
  withRepositoryLifecycleOperation,
  readStoreState,
  validateEnvelopeForRepository,
  emitAudit,
  createPrivateFileAtomic,
  grantPath,
  unlinkIfExact,
  storedExternalEffectRefusalBinding,
  refusalAuditOptions,
  replacePrivateFileAtomic,
  withAuthorityRefusalAudit,
  resolveSourceOid,
  clockNow,
  newTransactionEntropy,
}: Pick<
  ExternalEffectGrantContext,
  | 'discoverRepository'
  | 'externalEffectStorePaths'
  | 'withRepositoryLifecycleOperation'
  | 'readStoreState'
  | 'validateEnvelopeForRepository'
  | 'emitAudit'
  | 'createPrivateFileAtomic'
  | 'grantPath'
  | 'unlinkIfExact'
  | 'storedExternalEffectRefusalBinding'
  | 'refusalAuditOptions'
  | 'replacePrivateFileAtomic'
  | 'withAuthorityRefusalAudit'
  | 'resolveSourceOid'
  | 'clockNow'
  | 'newTransactionEntropy'
>) {
  function reserveExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const state = readStoreState(paths, grantId);
      validateEnvelopeForRepository(
        repository.repositoryRoot,
        state.record.envelope,
        options.signer,
      );
      if (state.kind === 'terminal' || state.kind === 'transaction') {
        return inspectionFromState(state, now);
      }
      if (expired(state.record.envelope.payload, now)) {
        return terminalize(
          repository.repositoryRoot,
          paths,
          state,
          'expired',
          now,
          'Grant expired before reservation.',
          options,
          assertOwned,
        );
      }
      const transaction = createTransactionRecord(
        state.record,
        grantId,
        now,
        newTransactionEntropy(),
      );
      assertOwned();
      emitAudit(
        repository.repositoryRoot,
        options,
        auditInput(
          transaction.envelope,
          transaction.grantDigest,
          'grant-reserved',
          now,
          { transactionId: transaction.transactionId, result: 'reserved' },
        ),
      );
      assertOwned();
      createPrivateFileAtomic(
        grantPath(paths.transactions, grantId),
        canonicalTransaction(transaction),
      );
      unlinkIfExact(
        grantPath(paths.available, grantId),
        canonicalAvailable(state.record),
      );
      assertOwned();
      return inspectionFromState(
        { kind: 'transaction', record: transaction },
        now,
      );
    });
  }

  function markExternalEffectDispatchIssued(
    cwd: string,
    requestedGrantId: string,
    requestedTransactionId: string,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantInspection {
    return transitionTransaction(
      cwd,
      requestedGrantId,
      requestedTransactionId,
      options,
      'dispatch-issued',
    );
  }

  function recordExternalEffectObservation(
    cwd: string,
    requestedGrantId: string,
    requestedTransactionId: string,
    requestedObservation: Omit<
      ExternalEffectObservation,
      | 'schemaVersion'
      | 'kind'
      | 'grantId'
      | 'transactionId'
      | 'idempotencyKey'
      | 'receiptDigest'
    >,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const transactionId = assertUuid(requestedTransactionId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const state = readStoreState(paths, grantId);
      validateEnvelopeForRepository(
        repository.repositoryRoot,
        state.record.envelope,
        options.signer,
      );
      return withAuthorityRefusalAudit(
        storedExternalEffectRefusalBinding(
          repository.repositoryRoot,
          state.record.envelope,
          state.record.grantDigest,
          'external-effect.observation',
          { transactionId, requestedObservation },
        ),
        refusalAuditOptions(now, options),
        () => {
          if (state.kind === 'terminal') return inspectionFromState(state, now);
          if (state.kind !== 'transaction') throw stateConflict();
          assertTransactionId(state.record, transactionId);
          if (state.record.phase === 'effect-observed') {
            const expected = createObservation(
              state.record,
              requestedObservation,
            );
            if (
              canonicalJson(expected) !==
              canonicalJson(state.record.observation)
            ) {
              throw stateConflict();
            }
            return inspectionFromState(state, now);
          }
          if (state.record.phase !== 'dispatch-issued') throw stateConflict();
          const observation = createObservation(
            state.record,
            requestedObservation,
          );
          assertObservationClock(observation, state.record, now);
          const next = replaceTransactionDigest({
            ...state.record,
            phase: 'effect-observed',
            effectObservedAt: observation.observedAt,
            observation,
          });
          assertOwned();
          emitAudit(
            repository.repositoryRoot,
            options,
            auditInput(
              next.envelope,
              next.grantDigest,
              'effect-observed',
              now,
              {
                transactionId,
                poststateDigest: observation.poststateDigest,
                result: 'observed',
              },
            ),
          );
          assertOwned();
          replacePrivateFileAtomic(
            grantPath(paths.transactions, grantId),
            canonicalTransaction(next),
          );
          assertOwned();
          return inspectionFromState(
            { kind: 'transaction', record: next },
            now,
          );
        },
      );
    });
  }

  function consumeExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    requestedTransactionId: string,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const transactionId = assertUuid(requestedTransactionId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const state = readStoreState(paths, grantId);
      validateEnvelopeForRepository(
        repository.repositoryRoot,
        state.record.envelope,
        options.signer,
      );
      return withAuthorityRefusalAudit(
        storedExternalEffectRefusalBinding(
          repository.repositoryRoot,
          state.record.envelope,
          state.record.grantDigest,
          'external-effect.consume',
          { transactionId },
        ),
        refusalAuditOptions(now, options),
        () => {
          if (state.kind === 'terminal') return inspectionFromState(state, now);
          if (
            state.kind !== 'transaction' ||
            state.record.phase !== 'effect-observed' ||
            !state.record.observation
          ) {
            throw stateConflict();
          }
          assertTransactionId(state.record, transactionId);
          return terminalize(
            repository.repositoryRoot,
            paths,
            state,
            'consumed',
            now,
            null,
            options,
            assertOwned,
          );
        },
      );
    });
  }

  function terminalizeExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    requestedTransactionId: string,
    state: 'failed' | 'manual-reconciliation',
    reason: string,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const transactionId = assertUuid(requestedTransactionId);
    const terminalReason = assertReason(reason);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const current = readStoreState(paths, grantId);
      validateEnvelopeForRepository(
        repository.repositoryRoot,
        current.record.envelope,
        options.signer,
      );
      return withAuthorityRefusalAudit(
        storedExternalEffectRefusalBinding(
          repository.repositoryRoot,
          current.record.envelope,
          current.record.grantDigest,
          'external-effect.terminalize',
          { transactionId, state, terminalReason },
        ),
        refusalAuditOptions(now, options),
        () => {
          if (current.kind === 'terminal')
            return inspectionFromState(current, now);
          if (current.kind !== 'transaction') throw stateConflict();
          assertTransactionId(current.record, transactionId);
          if (current.record.phase === 'effect-observed') throw stateConflict();
          return terminalize(
            repository.repositoryRoot,
            paths,
            current,
            state,
            now,
            terminalReason,
            options,
            assertOwned,
          );
        },
      );
    });
  }

  function assertActivePublishTransaction(
    cwd: string,
    hookArgs: string[],
    environment: NodeJS.ProcessEnv = process.env,
    signer?: MaintainerSignerProvider,
  ): ExternalEffectGrantInspection {
    const token = environment[PUBLISH_TRANSACTION_ENV];
    if (!token) throw publishTransactionRequired();
    const separator = token.indexOf('.');
    if (separator < 1) throw publishTransactionInvalid();
    const grantId = assertUuidForPublish(token.slice(0, separator));
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    let state: StoreState;
    try {
      state = readStoreState(paths, grantId);
      validateEnvelopeForRepository(
        repository.repositoryRoot,
        state.record.envelope,
        signer,
      );
    } catch {
      throw publishTransactionInvalid();
    }
    if (
      state.kind !== 'transaction' ||
      state.record.phase !== 'dispatch-issued' ||
      state.record.transactionToken !== token ||
      state.record.envelope.payload.effectKind !== 'publish-git-ref' ||
      state.record.envelope.payload.target.kind !== 'git-ref' ||
      hookArgs.length !== 2 ||
      hookArgs[0] !== state.record.envelope.payload.target.remoteName ||
      hookArgs[1] !== state.record.envelope.payload.target.remoteUrl
    ) {
      throw publishTransactionInvalid();
    }
    const target = state.record.envelope.payload.target;
    const resolved = resolveSourceOid(
      repository.repositoryRoot,
      target.sourceOid,
    );
    if (resolved !== target.sourceOid || repository.head !== target.sourceOid) {
      throw publishTransactionInvalid();
    }
    return inspectionFromState(state, clockNow());
  }

  function transitionTransaction(
    cwd: string,
    requestedGrantId: string,
    requestedTransactionId: string,
    options: ExternalEffectTransitionOptions,
    phase: 'dispatch-issued',
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const transactionId = assertUuid(requestedTransactionId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const state = readStoreState(paths, grantId);
      validateEnvelopeForRepository(
        repository.repositoryRoot,
        state.record.envelope,
        options.signer,
      );
      if (state.kind === 'terminal') return inspectionFromState(state, now);
      if (state.kind !== 'transaction') throw stateConflict();
      assertTransactionId(state.record, transactionId);
      if (
        state.record.phase === phase ||
        state.record.phase === 'effect-observed'
      ) {
        return inspectionFromState(state, now);
      }
      if (state.record.phase !== 'reserved') throw stateConflict();
      if (expired(state.record.envelope.payload, now)) {
        return terminalize(
          repository.repositoryRoot,
          paths,
          state,
          'expired',
          now,
          'Grant expired before dispatch.',
          options,
          assertOwned,
        );
      }
      const next = replaceTransactionDigest({
        ...state.record,
        phase,
        dispatchIssuedAt: now.toISOString(),
      });
      assertOwned();
      emitAudit(
        repository.repositoryRoot,
        options,
        auditInput(next.envelope, next.grantDigest, 'dispatch-issued', now, {
          transactionId,
          result: 'issued',
        }),
      );
      assertOwned();
      replacePrivateFileAtomic(
        grantPath(paths.transactions, grantId),
        canonicalTransaction(next),
      );
      assertOwned();
      return inspectionFromState({ kind: 'transaction', record: next }, now);
    });
  }

  function terminalize(
    repositoryRoot: string,
    paths: ReturnType<typeof externalEffectStorePaths>,
    state: StoreState,
    terminalState: TerminalState,
    now: Date,
    reason: string | null,
    auditOptions: ExternalEffectTransitionOptions,
    assertOwned: () => void,
  ): ExternalEffectGrantInspection {
    if (state.kind === 'terminal') return inspectionFromState(state, now);
    const previousRecordDigest = state.record.recordDigest;
    const observation =
      state.kind === 'transaction' ? state.record.observation : null;
    const transactionId =
      state.kind === 'transaction' ? state.record.transactionId : null;
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: 'external-effect-terminal' as const,
      grantDigest: state.record.grantDigest,
      envelope: state.record.envelope,
      transactionId,
      state: terminalState,
      observation,
      terminalAt: now.toISOString(),
      reason,
      previousRecordDigest,
    };
    const terminal: TerminalRecord = {
      ...withoutDigest,
      receiptDigest: sha256(canonicalJson(withoutDigest)),
    };
    const eventType: ExternalEffectAuditEventType =
      terminalState === 'consumed'
        ? 'grant-consumed'
        : terminalState === 'revoked'
          ? 'grant-revoked'
          : terminalState === 'expired'
            ? 'grant-expired'
            : terminalState === 'failed'
              ? 'grant-failed'
              : 'manual-reconciliation';
    assertOwned();
    emitAudit(
      repositoryRoot,
      auditOptions,
      auditInput(terminal.envelope, terminal.grantDigest, eventType, now, {
        transactionId,
        poststateDigest: observation?.poststateDigest ?? null,
        result: terminalState,
        reason,
      }),
    );
    assertOwned();
    createPrivateFileAtomic(
      grantPath(paths.terminal, terminal.envelope.payload.grantId),
      canonicalTerminal(terminal),
    );
    if (state.kind === 'available') {
      unlinkIfExact(
        grantPath(paths.available, terminal.envelope.payload.grantId),
        canonicalAvailable(state.record),
      );
    }
    assertOwned();
    return inspectionFromState(
      { kind: 'terminal', record: terminal, reconciliation: null },
      now,
    );
  }
  return {
    reserveExternalEffectGrant,
    markExternalEffectDispatchIssued,
    recordExternalEffectObservation,
    consumeExternalEffectGrant,
    terminalizeExternalEffectGrant,
    assertActivePublishTransaction,
    terminalize,
  };
}
export type ExternalEffectGrantTransaction = ReturnType<
  typeof createExternalEffectGrantTransaction
>;
