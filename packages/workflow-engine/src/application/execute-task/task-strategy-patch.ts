/** Complete implementation patch admission, import, adoption and restoration policy. */
import crypto from 'node:crypto';
import { resolveActorIdentity } from '../../modules/authority/actor-identity.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { matchesAllowedPath } from '../../foundation/repository-path/repository-path.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../../modules/planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyPatchChange,
  TaskStrategyPatchCurrentBinding,
  TaskStrategyPatchImplementer,
  TaskStrategyPatchImportReceipt,
  TaskStrategyPatchRecord,
  TaskStrategyPatchReservation,
} from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import {
  createCurrentTaskStrategyCorrectionSubject,
  type TaskStrategyCorrectionReader,
} from './task-strategy-correction.ts';
import { prepareTaskStrategyPatchRecord } from '../../modules/assurance/task-strategy-patch-record.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type { TaskStrategyPatchOperations } from './task-strategy-patch-operations.ts';
import type {
  TaskStrategyPatchCrashPhase,
  TaskStrategyPatchValidation,
  ImportedTaskStrategyPatch,
  CallerTaskStrategyPatchInput,
  TaskStrategyPatchImportInput,
  LocalTaskStrategyPatchAdoptionOptions,
  ProviderTaskStrategyPatchValidationInput,
  ProviderTaskStrategyPatchImportInput,
  CallerTaskStrategyPatchValidationInput,
  CallerTaskStrategyPatchImportInput,
} from '../../modules/assurance/task-strategy-patch-contract.ts';
export type {
  TaskStrategyPatchValidation,
  ImportedTaskStrategyPatch,
} from '../../modules/assurance/task-strategy-patch-contract.ts';

export function createTaskStrategyPatchService(
  operations: TaskStrategyPatchOperations,
  correction: TaskStrategyCorrectionReader,
) {
  const MAX_PATCH_BYTES = 8 * 1024 * 1024;

  const MAX_PATCH_PATHS = 1024;

  type SealedLocalPatchAuthority = Readonly<{
    kind: 'sealed-local';
    implementer: Exclude<
      TaskStrategyPatchImplementer,
      {
        providerId: null;
      }
    >;
    sourceTree: string;
  }>;

  function validateTaskStrategyPatch(
    cwd: string,
    requestedSessionId: string,
    input: CallerTaskStrategyPatchInput,
  ): TaskStrategyPatchValidation {
    return validateTaskStrategyPatchWithAuthority(
      cwd,
      requestedSessionId,
      input,
    );
  }

  function validateTaskStrategyProviderPatch(
    cwd: string,
    requestedSessionId: string,
    input: ProviderTaskStrategyPatchValidationInput,
  ): TaskStrategyPatchValidation {
    return validateTaskStrategyPatchWithAuthority(
      cwd,
      requestedSessionId,
      input,
    );
  }

  function validateTaskStrategyCallerPatch(
    cwd: string,
    requestedSessionId: string,
    input: CallerTaskStrategyPatchValidationInput,
  ): TaskStrategyPatchValidation {
    return validateTaskStrategyPatchWithAuthority(
      cwd,
      requestedSessionId,
      input,
    );
  }

  function validateTaskStrategyPatchWithAuthority(
    cwd: string,
    requestedSessionId: string,
    input:
      | CallerTaskStrategyPatchInput
      | ProviderTaskStrategyPatchValidationInput
      | ProviderTaskStrategyPatchImportInput
      | CallerTaskStrategyPatchValidationInput
      | CallerTaskStrategyPatchImportInput,
    sealedLocalAuthority?: SealedLocalPatchAuthority,
  ): TaskStrategyPatchValidation {
    const patchBytes = normalizePatchBytes(input.patch);
    const inspection = operations.session.inspect(cwd, requestedSessionId);
    const task = executionTask(inspection);
    const transaction = operations
      .observeJournal(
        inspection.git.gitCommonDirectory,
        inspection.contract.config.runtimeDirectory,
      )
      .correction.readTransaction(inspection.session.sessionId);
    if (
      transaction === null ||
      transaction.phase !== 'red-sealed' ||
      transaction.changeId !== inspection.session.changeId ||
      transaction.taskId !== inspection.session.taskId ||
      transaction.strategy !== task.strategy ||
      transaction.taskContractDigest !== sha256(canonicalJson(task)) ||
      canonicalJson(transaction.baseline) !==
        canonicalJson(inspection.session.baseline)
    ) {
      throw workflowError(
        'TASK_STRATEGY_RED_REQUIRED',
        'Patch validation requires the exact current engine-sealed RED transaction.',
        ExitCode.verification,
      );
    }
    const authority = resolvePatchImplementer(
      inspection,
      transaction,
      input,
      sha256(patchBytes),
      sealedLocalAuthority,
    );
    if (
      task.strategy === 'cross-agent-tdd' &&
      authority.implementer.providerId === transaction.author.providerId &&
      !authority.allowsSameProvider
    ) {
      throw workflowError(
        'TASK_STRATEGY_IMPLEMENTER_REQUIRED',
        'Cross-agent TDD requires the implementation patch to come from a fresh session.',
        ExitCode.guard,
        {
          details: {
            redAuthor: transaction.author.providerId,
            redAuthorSessionId: transaction.sessionId,
          },
          recovery:
            'Use a session-independent implementer or an exact bounded collaboration grant.',
        },
      );
    }
    if (
      task.strategy === 'tdd-single-agent' &&
      canonicalJson(authority.implementer) !== canonicalJson(transaction.author)
    ) {
      throw workflowError(
        'TASK_STRATEGY_IMPLEMENTER_REQUIRED',
        'Single-agent TDD binds implementation authority to the sealed RED author.',
        ExitCode.guard,
      );
    }
    const projection = operations.repository.applyPatchToIsolatedTree(
      inspection.git.repositoryRoot,
      authority.sourceTree,
      patchBytes,
    );
    const current = operations.session.previewCandidate(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    );
    if (
      current.tree !== authority.sourceTree &&
      (sealedLocalAuthority === undefined ||
        current.tree !== projection.candidateTree)
    ) {
      throw workflowError(
        'TASK_STRATEGY_RED_STALE',
        'The task worktree changed after RED sealing and before isolated patch validation.',
        ExitCode.staleState,
      );
    }
    if (
      projection.changedPaths.length === 0 ||
      projection.changedPaths.length > MAX_PATCH_PATHS
    ) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_INVALID',
        'The implementation patch produced no bounded tree delta.',
        ExitCode.verification,
      );
    }
    const frozen = new Set(transaction.red.files.map(({ path }) => path));
    const frozenChanges = projection.changedPaths.filter((entry) =>
      frozen.has(entry),
    );
    if (frozenChanges.length > 0) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_FROZEN_PATH',
        'The implementation patch modifies an engine-sealed RED test or fixture.',
        ExitCode.verification,
        { details: { paths: frozenChanges } },
      );
    }
    const scopeEscapes = projection.changedPaths.filter(
      (entry) =>
        !task.implementationPathScopes.some((scope) =>
          matchesAllowedPath(entry, scope),
        ),
    );
    if (scopeEscapes.length > 0) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_SCOPE_INVALID',
        'The implementation patch escapes the reviewed implementation scopes.',
        ExitCode.verification,
        { details: { paths: scopeEscapes } },
      );
    }
    const changes = projection.changedPaths.map((changedPath) => ({
      path: changedPath,
      before: operations.repository.readRegularTreeEntry(
        inspection.git.repositoryRoot,
        authority.sourceTree,
        changedPath,
      ),
      after: operations.repository.readRegularTreeEntry(
        inspection.git.repositoryRoot,
        projection.candidateTree,
        changedPath,
      ),
    }));
    return Object.freeze({
      schemaVersion: 1,
      kind: 'task-strategy-patch-validation.v1',
      sessionId: inspection.session.sessionId,
      strategy: task.strategy,
      sourceTree: authority.sourceTree,
      candidateTree: projection.candidateTree,
      patchDigest: sha256(patchBytes),
      changedPaths: Object.freeze(projection.changedPaths),
      changes: Object.freeze(changes),
      implementer: Object.freeze(authority.implementer),
    });
  }

  function importTaskStrategyPatch(
    cwd: string,
    requestedSessionId: string,
    input: TaskStrategyPatchImportInput,
  ): ImportedTaskStrategyPatch {
    return operations.locks.runSessionOperation(cwd, requestedSessionId, () =>
      importTaskStrategyPatchUnlocked(cwd, requestedSessionId, input),
    );
  }

  /**
   * Bind an already-present single-agent implementation to the same durable
   * patch record/receipt used by provider imports. The sealed RED author is the
   * implementation identity; ambient resume actors cannot replace it.
   */
  function adoptCurrentTaskStrategyImplementation(
    cwd: string,
    requestedSessionId: string,
    options: LocalTaskStrategyPatchAdoptionOptions = {},
  ): ImportedTaskStrategyPatch | null {
    const initial = operations.session.loadActive(cwd, requestedSessionId);
    return operations.locks.repository(initial.runtime, (assertOwned) =>
      operations.locks.session(initial.runtime, requestedSessionId, () => {
        assertOwned();
        const inspection = operations.session.inspect(cwd, requestedSessionId);
        const task = executionTask(inspection);
        const journal = operations.observeJournal(
          inspection.git.gitCommonDirectory,
          inspection.contract.config.runtimeDirectory,
        );
        const transaction = journal.correction.readTransaction(
          inspection.session.sessionId,
        );
        if (
          task.strategy !== 'tdd-single-agent' ||
          transaction === null ||
          transaction.strategy !== 'tdd-single-agent'
        ) {
          throw workflowError(
            'TASK_STRATEGY_LOCAL_ADOPTION_NOT_APPLICABLE',
            'Only an exact engine-sealed single-agent TDD transaction can adopt local implementation bytes.',
            ExitCode.guard,
          );
        }
        const current = operations.session.previewCandidate(
          inspection.git.repositoryRoot,
          inspection.session.baseline.head,
          [...inspection.changedPaths],
        );
        if (current.tree === transaction.red.candidateTree) return null;
        const patch = operations.repository.createBinaryPatch(
          inspection.git.repositoryRoot,
          transaction.red.candidateTree,
          current.tree,
        );
        const imported = importTaskStrategyPatchUnlocked(
          cwd,
          requestedSessionId,
          {
            patch,
            ...(options.testCrashAfter === undefined
              ? {}
              : { testCrashAfter: options.testCrashAfter }),
          },
          {
            kind: 'sealed-local',
            implementer: Object.freeze(structuredClone(transaction.author)),
            sourceTree: transaction.red.candidateTree,
          },
        );
        assertOwned();
        return imported;
      }),
    );
  }

  /**
   * Bind a local single-agent correction already present in the worktree. The
   * preceding failed candidate is the new immutable patch source; prior patch
   * records remain append-only provenance and are never replaced.
   */
  function adoptCurrentTaskStrategyCorrection(
    cwd: string,
    requestedSessionId: string,
    options: LocalTaskStrategyPatchAdoptionOptions = {},
  ): ImportedTaskStrategyPatch | null {
    const initial = operations.session.loadActive(cwd, requestedSessionId);
    return operations.locks.repository(initial.runtime, (assertOwned) =>
      operations.locks.session(initial.runtime, requestedSessionId, () => {
        assertOwned();
        const inspection = operations.session.inspect(cwd, requestedSessionId);
        const journal = operations.observeJournal(
          inspection.git.gitCommonDirectory,
          inspection.contract.config.runtimeDirectory,
        );
        const task = executionTask(inspection);
        const projection =
          correction.resolveCurrentTaskStrategyCorrection(inspection);
        const transaction = projection.transaction;
        const failure = projection.failure;
        if (
          task.strategy !== 'tdd-single-agent' ||
          transaction.strategy !== 'tdd-single-agent' ||
          failure === null ||
          projection.exhausted
        ) {
          throw workflowError(
            'TASK_STRATEGY_CORRECTION_NOT_APPLICABLE',
            'Only a current bounded single-agent GREEN failure can adopt local correction bytes.',
            ExitCode.guard,
          );
        }
        const correctionState = projection.correctionState;
        if (
          correctionState === null ||
          correctionState.state !== 'correction-required'
        ) {
          throw workflowError(
            'TASK_STRATEGY_CORRECTION_NOT_APPLICABLE',
            'The current GREEN failure has no resumable correction-round authority.',
            ExitCode.guard,
          );
        }
        const current = operations.session.previewCandidate(
          inspection.git.repositoryRoot,
          inspection.session.baseline.head,
          [...inspection.changedPaths],
        );
        if (current.tree === failure.candidateTree) return null;
        const patch = operations.repository.createBinaryPatch(
          inspection.git.repositoryRoot,
          failure.candidateTree,
          current.tree,
        );
        const correctionSubject = createCurrentTaskStrategyCorrectionSubject(
          transaction,
          failure,
          correctionState.round,
        );
        const reservationAuthority = Object.freeze({
          kind: 'sealed-local' as const,
          author: Object.freeze(structuredClone(transaction.author)),
        });
        journal.correction.reserve({
          sessionId: inspection.session.sessionId,
          round: correctionState.round,
          policy: operations.correctionPolicy,
          predecessorFailure: failure,
          correctionSubjectDigest: correctionSubject.subjectDigest,
          redSourceTree: transaction.red.candidateTree,
          authority: reservationAuthority,
          createdAt: operations.clock.now().toISOString(),
        });
        const imported = importTaskStrategyPatchUnlocked(
          cwd,
          requestedSessionId,
          {
            patch,
            ...(options.testCrashAfter === undefined
              ? {}
              : { testCrashAfter: options.testCrashAfter }),
          },
          {
            kind: 'sealed-local',
            implementer: Object.freeze(structuredClone(transaction.author)),
            sourceTree: failure.candidateTree,
          },
        );
        const resultAuthority = Object.freeze({
          kind: 'sealed-local' as const,
          author: Object.freeze(structuredClone(transaction.author)),
        });
        journal.correction.publishResult({
          sessionId: inspection.session.sessionId,
          currentRedTransactionDigest: transaction.recordDigest,
          round: correctionState.round,
          correctionSubjectDigest: correctionSubject.subjectDigest,
          authority: resultAuthority,
          patchResult: {
            sourceTree: imported.record.sourceTree,
            targetCandidateTree: imported.record.candidateTree,
            patchRecordDigest: imported.record.recordDigest,
            patchDigest: imported.record.patchDigest,
          },
          createdAt: imported.receipt.importedAt,
        });
        journal.correction.publishImport({
          sessionId: inspection.session.sessionId,
          currentRedTransactionDigest: transaction.recordDigest,
          round: correctionState.round,
          correctionSubjectDigest: correctionSubject.subjectDigest,
          authority: resultAuthority,
          importReceipt: {
            patchRecordDigest: imported.record.recordDigest,
            patchDigest: imported.record.patchDigest,
            receiptDigest: imported.receipt.receiptDigest,
            candidateTree: imported.record.candidateTree,
          },
          currentPatchHead: {
            bindingDigest: imported.binding.bindingDigest,
            recordDigest: imported.record.recordDigest,
            patchDigest: imported.record.patchDigest,
            receiptDigest: imported.receipt.receiptDigest,
          },
          importedAt: imported.receipt.importedAt,
        });
        assertOwned();
        return imported;
      }),
    );
  }

  /**
   * Restore only the exact implementation delta of the current RED lineage.
   * This is the mutation step used by RED revision while the repository and
   * session lifecycle locks are already held. Durable patch records remain
   * immutable provenance; replay accepts only the exact candidate or source
   * tree and never overwrites ambient bytes.
   */
  function restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock(
    cwd: string,
    requestedSessionId: string,
    transaction: TaskStrategyTransaction,
    assertOwned: () => void,
  ): TaskStrategyPatchRecord | null {
    assertOwned();
    let inspection = operations.session.inspect(cwd, requestedSessionId);
    const journal = operations.observeJournal(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    );
    const currentTree = () =>
      operations.session.previewCandidate(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        [...inspection.changedPaths],
      ).tree;
    const projection =
      correction.resolveCurrentTaskStrategyCorrection(inspection);
    if (projection.transaction.recordDigest !== transaction.recordDigest) {
      throw patchStale();
    }
    const records: TaskStrategyPatchRecord[] = [];
    let sourceTree = transaction.red.candidateTree;
    while (true) {
      const binding = journal.patch.readCurrentBinding(
        inspection.session.sessionId,
        sourceTree,
      );
      if (binding === null) break;
      const record = journal.patch.readRecord(
        inspection.session.sessionId,
        binding.patchDigest,
        sourceTree,
      );
      const reservation = journal.patch.readReservation(
        inspection.session.sessionId,
        sourceTree,
      );
      const receipt = journal.patch.readImportReceipt(
        inspection.session.sessionId,
        binding.patchDigest,
        sourceTree,
      );
      if (
        record === null ||
        reservation === null ||
        receipt === null ||
        record.sourceTree !== sourceTree
      ) {
        throw workflowError(
          'TASK_STRATEGY_PATCH_STATE_CORRUPT',
          'The current implementation lineage has no exact patch authority.',
          ExitCode.staleState,
        );
      }
      assertPatchStateRelations(record, reservation, receipt, binding);
      records.push(record);
      sourceTree = record.candidateTree;
      if (projection.head?.record.recordDigest === record.recordDigest) break;
      if (records.length > 64) throw patchStale();
    }
    if (records.length === 0) {
      if (currentTree() !== transaction.red.candidateTree) throw patchStale();
      return null;
    }
    if (records.at(-1)?.recordDigest !== projection.head?.record.recordDigest) {
      throw patchStale();
    }
    const observedBoundary = currentTree();
    if (observedBoundary === transaction.red.candidateTree) return records[0]!;
    const remainingHead = records.findLastIndex(
      (record) => record.candidateTree === observedBoundary,
    );
    if (remainingHead < 0) throw patchStale();
    for (const record of records.slice(0, remainingHead + 1).reverse()) {
      const observedTree = currentTree();
      const changedEntries = record.changes.map((change) => ({
        change,
        observed: operations.repository.readRegularTreeEntry(
          inspection.git.repositoryRoot,
          observedTree,
          change.path,
        ),
      }));
      const alreadyRestored = changedEntries.every(
        ({ change, observed }) =>
          canonicalJson(observed) === canonicalJson(change.before),
      );
      if (!alreadyRestored) {
        if (
          changedEntries.some(
            ({ change, observed }) =>
              canonicalJson(observed) !== canonicalJson(change.after),
          )
        ) {
          throw patchStale();
        }
        operations.repository.applyPatchToWorktree(
          inspection.git.repositoryRoot,
          Buffer.from(record.patchBase64, 'base64'),
          true,
        );
        assertOwned();
        inspection = operations.session.inspectExpected(
          cwd,
          requestedSessionId,
          inspection.session,
        );
      }
      if (currentTree() !== record.sourceTree) throw patchStale();
    }
    return records[0]!;
  }

  function importTaskStrategyProviderPatch(
    cwd: string,
    requestedSessionId: string,
    input: ProviderTaskStrategyPatchImportInput,
  ): ImportedTaskStrategyPatch {
    return operations.locks.runSessionOperation(cwd, requestedSessionId, () =>
      importTaskStrategyPatchUnlocked(cwd, requestedSessionId, input),
    );
  }

  function importTaskStrategyProviderPatchUnderLifecycleLock(
    cwd: string,
    requestedSessionId: string,
    input: ProviderTaskStrategyPatchImportInput,
    assertOwned: () => void,
  ): ImportedTaskStrategyPatch {
    assertOwned();
    const imported = importTaskStrategyPatchUnlocked(
      cwd,
      requestedSessionId,
      input,
    );
    assertOwned();
    return imported;
  }

  function importTaskStrategyCallerPatchUnderLifecycleLock(
    cwd: string,
    requestedSessionId: string,
    input: CallerTaskStrategyPatchImportInput,
    assertOwned: () => void,
  ): ImportedTaskStrategyPatch {
    assertOwned();
    const imported = importTaskStrategyPatchUnlocked(
      cwd,
      requestedSessionId,
      input,
    );
    assertOwned();
    return imported;
  }

  function importTaskStrategyPatchUnlocked(
    cwd: string,
    requestedSessionId: string,
    input: Readonly<{
      patch: string | Buffer;
      explicitActor?: string;
      environment?: NodeJS.ProcessEnv;
      implementationResultBindingDigest?: string;
      implementationSubjectDigest?: string;
      callerImplementationBindingDigest?: string;
      testCrashAfter?: TaskStrategyPatchCrashPhase;
    }>,
    sealedLocalAuthority?: SealedLocalPatchAuthority,
  ): ImportedTaskStrategyPatch {
    const patchBytes = normalizePatchBytes(input.patch);
    const patchDigest = sha256(patchBytes);
    let inspection = operations.session.inspect(cwd, requestedSessionId);
    const task = executionTask(inspection);
    const journal = operations.observeJournal(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    );
    const transaction = journal.correction.readTransaction(
      inspection.session.sessionId,
    );
    const implementer = resolvePatchImplementer(
      inspection,
      transaction,
      input,
      patchDigest,
      sealedLocalAuthority,
    );
    let reservation = journal.patch.readReservation(
      inspection.session.sessionId,
      implementer.sourceTree,
    );
    if (reservation !== null && reservation.patchDigest !== patchDigest) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_RESERVATION_CONFLICT',
        'Another exact implementation patch is already prepared for this session.',
        ExitCode.conflict,
        { details: { reservedPatchDigest: reservation.patchDigest } },
      );
    }
    let record = journal.patch.readRecord(
      inspection.session.sessionId,
      patchDigest,
      implementer.sourceTree,
    );
    if (record === null) {
      const validation = validateTaskStrategyPatchWithAuthority(
        cwd,
        requestedSessionId,
        input,
        sealedLocalAuthority,
      );
      const preparedRecord = prepareTaskStrategyPatchRecord({
        sessionId: inspection.session.sessionId,
        changeId: inspection.session.changeId,
        taskId: inspection.session.taskId,
        strategy: validation.strategy,
        sourceTree: validation.sourceTree,
        candidateTree: validation.candidateTree,
        taskContractDigest: sha256(canonicalJson(task)),
        patchDigest,
        patchBase64: patchBytes.toString('base64'),
        changedPaths: [...validation.changedPaths],
        changes: [...validation.changes],
        implementer: implementer.implementer,
        createdAt:
          reservation?.createdAt ?? operations.clock.now().toISOString(),
      });
      if (reservation === null) {
        reservation = journal.patch.reserve({
          sessionId: preparedRecord.sessionId,
          patchDigest: preparedRecord.patchDigest,
          recordDigest: preparedRecord.recordDigest,
          sourceTree: preparedRecord.sourceTree,
          candidateTree: preparedRecord.candidateTree,
          createdAt: preparedRecord.createdAt,
        });
        assertPatchStateRelations(preparedRecord, reservation, null, null);
        maybeInterrupt(input.testCrashAfter, 'reservation-persisted');
      } else {
        assertPatchStateRelations(preparedRecord, reservation, null, null);
      }
      record = journal.patch.persistRecord(preparedRecord);
      maybeInterrupt(input.testCrashAfter, 'record-persisted');
    } else {
      if (reservation === null) {
        throw workflowError(
          'TASK_STRATEGY_PATCH_STATE_CORRUPT',
          'A durable patch record exists without its preceding reservation.',
          ExitCode.staleState,
        );
      }
      if (transaction === null) throw patchStale();
      assertPatchRecordCurrent(
        record,
        inspection,
        task,
        transaction,
        implementer.implementer,
        patchBytes,
        implementer.sourceTree,
      );
      assertPatchStateRelations(record, reservation, null, null);
    }
    assertPatchStateRelations(record, reservation, null, null);
    let receipt = journal.patch.readImportReceipt(
      inspection.session.sessionId,
      patchDigest,
      record.sourceTree,
    );
    let binding = journal.patch.readCurrentBinding(
      inspection.session.sessionId,
      record.sourceTree,
    );
    assertPatchStateRelations(record, reservation, receipt, binding);
    let currentTree = operations.session.previewCandidate(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    ).tree;
    if (receipt !== null && binding !== null) {
      if (currentTree !== record.candidateTree) throw patchStale();
      return Object.freeze({ record, reservation, receipt, binding });
    }
    if (currentTree === record.sourceTree) {
      if (sealedLocalAuthority !== undefined) throw patchStale();
      operations.repository.applyPatchToWorktree(
        inspection.git.repositoryRoot,
        Buffer.from(record.patchBase64, 'base64'),
      );
      inspection = operations.session.inspectExpected(
        cwd,
        requestedSessionId,
        inspection.session,
      );
      currentTree = operations.session.previewCandidate(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        [...inspection.changedPaths],
      ).tree;
      if (currentTree !== record.candidateTree) throw patchStale();
      maybeInterrupt(input.testCrashAfter, 'patch-applied');
    } else if (currentTree !== record.candidateTree) {
      throw patchStale();
    }
    const importedAt =
      receipt?.importedAt ?? operations.clock.now().toISOString();
    if (receipt === null) {
      receipt = journal.patch.createImportReceipt(
        {
          recordDigest: record.recordDigest,
          sessionId: record.sessionId,
          patchDigest: record.patchDigest,
          candidateTree: record.candidateTree,
          importedAt,
        },
        record.sourceTree,
      );
      maybeInterrupt(input.testCrashAfter, 'receipt-persisted');
    }
    binding ??= journal.patch.createCurrentBinding(
      {
        sessionId: record.sessionId,
        patchDigest: record.patchDigest,
        recordDigest: record.recordDigest,
        receiptDigest: receipt.receiptDigest,
        candidateTree: record.candidateTree,
        createdAt: importedAt,
      },
      record.sourceTree,
    );
    assertPatchStateRelations(record, reservation, receipt, binding);
    return Object.freeze({ record, reservation, receipt, binding });
  }

  function resolvePatchImplementer(
    inspection: SessionInspection,
    transaction: TaskStrategyTransaction | null,
    input:
      | CallerTaskStrategyPatchInput
      | ProviderTaskStrategyPatchValidationInput
      | ProviderTaskStrategyPatchImportInput
      | CallerTaskStrategyPatchValidationInput
      | CallerTaskStrategyPatchImportInput,
    patchDigest: string,
    sealedLocalAuthority?: SealedLocalPatchAuthority,
  ): Readonly<{
    implementer: TaskStrategyPatchImplementer;
    allowsSameProvider: boolean;
    sourceTree: string;
  }> {
    if (transaction === null) {
      throw workflowError(
        'TASK_STRATEGY_RED_REQUIRED',
        'Patch import requires the exact current engine-sealed RED transaction.',
        ExitCode.verification,
      );
    }
    if (sealedLocalAuthority !== undefined) {
      if (
        transaction.strategy !== 'tdd-single-agent' ||
        canonicalJson(sealedLocalAuthority.implementer) !==
          canonicalJson(transaction.author)
      ) {
        throw patchAuthorityStale();
      }
      return Object.freeze({
        implementer: sealedLocalAuthority.implementer,
        allowsSameProvider: true,
        sourceTree: sealedLocalAuthority.sourceTree,
      });
    }
    const journal = operations.observeJournal(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    );
    if ('callerImplementer' in input) {
      const subject = resolveCallerImplementationSubject(
        inspection,
        transaction,
        input.implementationSubjectDigest,
      );
      if (subject.subjectDigest !== input.implementationSubjectDigest) {
        throw patchAuthorityStale();
      }
      return Object.freeze({
        implementer: Object.freeze(structuredClone(input.callerImplementer)),
        allowsSameProvider: true,
        sourceTree: subject.sourceTree,
      });
    }
    if ('implementationReservationDigest' in input) {
      const reservation = journal.implementation.readReservation(
        inspection.session.sessionId,
        input.implementationSubjectDigest,
      );
      const attempt =
        reservation === null
          ? null
          : journal.implementation.readCurrentAttempt(reservation);
      if (
        reservation === null ||
        attempt === null ||
        reservation.recordDigest !== input.implementationReservationDigest ||
        reservation.subject.transactionDigest !== transaction.recordDigest ||
        !implementationSubjectSourceCurrent(
          inspection,
          transaction,
          reservation.subject,
        ) ||
        attempt.assignment.providerId === null ||
        attempt.assignment.sessionId === null
      ) {
        throw patchAuthorityStale();
      }
      return Object.freeze({
        implementer: Object.freeze({
          providerId: attempt.assignment.providerId,
          assurance: 'adapter-assigned' as const,
        }),
        allowsSameProvider:
          attempt.assignment.sessionId !== transaction.sessionId ||
          ('grantId' in attempt.assignment &&
            attempt.assignment.degradedForm === 'same-provider-fresh-session'),
        sourceTree: reservation.subject.sourceTree,
      });
    }
    if ('implementationResultBindingDigest' in input) {
      const reservation = journal.implementation.readReservation(
        inspection.session.sessionId,
        input.implementationSubjectDigest,
      );
      const binding = journal.implementation.readResult(
        inspection.session.sessionId,
        input.implementationSubjectDigest,
      );
      const attempt =
        reservation === null || binding === null
          ? null
          : journal.implementation.readAttempt(
              reservation,
              binding.invocationId,
            );
      const currentAttempt =
        reservation === null
          ? null
          : journal.implementation.readCurrentAttempt(reservation);
      if (
        binding === null ||
        reservation === null ||
        attempt === null ||
        currentAttempt === null ||
        binding.bindingDigest !== input.implementationResultBindingDigest ||
        reservation.subject.transactionDigest !== transaction.recordDigest ||
        !implementationSubjectSourceCurrent(
          inspection,
          transaction,
          reservation.subject,
        ) ||
        binding.subjectDigest !== reservation.subject.subjectDigest ||
        canonicalJson(binding.roleResult.assignment) !==
          canonicalJson(attempt.assignment) ||
        currentAttempt.request.invocationId !== attempt.request.invocationId ||
        binding.output.sessionId !== inspection.session.sessionId ||
        binding.output.sourceTree !== reservation.subject.sourceTree ||
        binding.output.patchDigest !== patchDigest ||
        binding.roleResult.providerInvocation === null ||
        binding.roleResult.assignment.providerId === null ||
        binding.roleResult.assignment.sessionId === null
      ) {
        throw patchAuthorityStale();
      }
      return Object.freeze({
        implementer: Object.freeze({
          providerId: binding.roleResult.assignment.providerId,
          assurance: 'adapter-assigned' as const,
        }),
        allowsSameProvider:
          binding.roleResult.assignment.sessionId !== transaction.sessionId ||
          (binding.roleResult.form === 'granted-same-provider' &&
            binding.roleResult.grantUse?.degradedForm ===
              'same-provider-fresh-session'),
        sourceTree: reservation.subject.sourceTree,
      });
    }
    if ('callerImplementationBindingDigest' in input) {
      const binding = journal.implementation.readCallerResult(
        inspection.session.sessionId,
        input.implementationSubjectDigest,
      );
      const reservation = journal.implementation.readCallerReservation(
        inspection.session.sessionId,
        input.implementationSubjectDigest,
      );
      const participant = binding?.roleResult.participant;
      const assignment = binding?.roleResult.assignment;
      if (
        binding === null ||
        reservation === null ||
        binding.bindingDigest !== input.callerImplementationBindingDigest ||
        binding.subjectDigest !== reservation.subjectDigest ||
        reservation.subjectDigest !== input.implementationSubjectDigest ||
        resolveCallerImplementationSubject(
          inspection,
          transaction,
          input.implementationSubjectDigest,
        ).subjectDigest !== reservation.subjectDigest ||
        binding.output.sessionId !== inspection.session.sessionId ||
        binding.output.sourceTree !== reservation.output.sourceTree ||
        binding.output.patchDigest !== patchDigest ||
        binding.roleResult.form !== 'granted-caller-supplied' ||
        participant === undefined ||
        participant.providerId !== null ||
        participant.principalId === null ||
        participant.identityAssurance === 'maintainer-signed' ||
        assignment === undefined ||
        !('grantId' in assignment) ||
        assignment.degradedForm !== 'caller-supplied'
      ) {
        throw patchAuthorityStale();
      }
      return Object.freeze({
        implementer: Object.freeze({
          providerId: null,
          principalId: participant.principalId,
          assurance: participant.identityAssurance,
          degradedForm: 'caller-supplied' as const,
          grantId: assignment.grantId,
        }),
        allowsSameProvider: true,
        sourceTree: reservation.output.sourceTree,
      });
    }
    const actor = resolveActorIdentity({
      ...(input.explicitActor === undefined
        ? {}
        : { explicitActor: input.explicitActor }),
      environment: input.environment ?? operations.environment(),
    });
    if (actor.outcome !== 'resolved') {
      throw workflowError(
        actor.code,
        'Patch import requires one exact implementation actor.',
        ExitCode.guard,
      );
    }
    return Object.freeze({
      implementer: Object.freeze(actor.actor),
      allowsSameProvider: false,
      sourceTree: transaction.red.candidateTree,
    });
  }

  function resolveCallerImplementationSubject(
    inspection: SessionInspection,
    transaction: TaskStrategyTransaction,
    expectedSubjectDigest: string,
  ) {
    const authority =
      correction.resolveCurrentTaskStrategyImplementationAuthority(
        inspection,
        correction.resolveCurrentTaskStrategyCorrection(inspection),
      );
    if (
      authority.subject.transactionDigest !== transaction.recordDigest ||
      authority.subject.subjectDigest !== expectedSubjectDigest
    ) {
      throw patchAuthorityStale();
    }
    return authority.subject;
  }

  function implementationSubjectSourceCurrent(
    inspection: SessionInspection,
    transaction: TaskStrategyTransaction,
    subject: TaskStrategyImplementationSubject,
  ): boolean {
    if (subject.correction === undefined) {
      return subject.sourceTree === transaction.red.candidateTree;
    }
    const journal = operations.observeJournal(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    );
    const projection =
      correction.resolveCurrentTaskStrategyCorrection(inspection);
    const expectedRound = subject.correction.round;
    const failure =
      projection.failure !== null &&
      projection.completedCorrectionRounds + 1 === expectedRound
        ? projection.failure
        : projection.head !== null &&
            projection.completedCorrectionRounds === expectedRound &&
            projection.head.record.sourceTree === subject.sourceTree
          ? journal.correction.readFailure(
              inspection.session.sessionId,
              subject.sourceTree,
            )
          : null;
    return (
      failure !== null &&
      subject.sourceTree === failure.candidateTree &&
      subject.correction.greenFailureRecordDigest === failure.recordDigest &&
      subject.correction.greenFailureSubjectDigest === failure.subjectDigest &&
      subject.correction.candidateTree === failure.candidateTree &&
      subject.correction.failingCheckFingerprint ===
        failure.failingCheck.failureFingerprint &&
      canonicalJson(subject.correction.currentPatchHead) ===
        canonicalJson(failure.currentPatchHead)
    );
  }

  function patchAuthorityStale() {
    return workflowError(
      'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
      'The implementation patch does not match its exact current provider result authority.',
      ExitCode.staleState,
    );
  }

  function assertPatchRecordCurrent(
    record: TaskStrategyPatchRecord,
    inspection: SessionInspection,
    task: CrossAgentTddExecution | TddSingleAgentExecution,
    transaction: NonNullable<TaskStrategyTransaction | null>,
    implementer: TaskStrategyPatchImplementer,
    patchBytes: Buffer,
    expectedSourceTree: string,
  ): void {
    if (
      record.sessionId !== inspection.session.sessionId ||
      record.changeId !== inspection.session.changeId ||
      record.taskId !== inspection.session.taskId ||
      record.strategy !== task.strategy ||
      record.sourceTree !== expectedSourceTree ||
      record.candidateTree === record.sourceTree ||
      record.taskContractDigest !== sha256(canonicalJson(task)) ||
      record.patchDigest !== sha256(patchBytes) ||
      record.patchBase64 !== patchBytes.toString('base64') ||
      canonicalJson(record.implementer) !== canonicalJson(implementer)
    ) {
      throw patchStale();
    }
  }

  function assertPatchStateRelations(
    record: TaskStrategyPatchRecord,
    reservation: TaskStrategyPatchReservation,
    receipt: TaskStrategyPatchImportReceipt | null,
    binding: TaskStrategyPatchCurrentBinding | null,
  ): void {
    if (
      reservation.sessionId !== record.sessionId ||
      reservation.patchDigest !== record.patchDigest ||
      reservation.recordDigest !== record.recordDigest ||
      reservation.sourceTree !== record.sourceTree ||
      reservation.candidateTree !== record.candidateTree ||
      reservation.createdAt !== record.createdAt ||
      (receipt !== null &&
        (receipt.recordDigest !== record.recordDigest ||
          receipt.sessionId !== record.sessionId ||
          receipt.patchDigest !== record.patchDigest ||
          receipt.candidateTree !== record.candidateTree)) ||
      (binding !== null &&
        (receipt === null ||
          binding.sessionId !== record.sessionId ||
          binding.patchDigest !== record.patchDigest ||
          binding.recordDigest !== record.recordDigest ||
          binding.receiptDigest !== receipt.receiptDigest ||
          binding.candidateTree !== record.candidateTree ||
          binding.createdAt !== receipt.importedAt))
    ) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_STATE_CORRUPT',
        'Task strategy patch reservation, record, receipt, and current binding disagree.',
        ExitCode.staleState,
      );
    }
  }

  function maybeInterrupt(
    requested: TaskStrategyPatchCrashPhase | undefined,
    phase: TaskStrategyPatchCrashPhase,
  ): void {
    if (requested === phase) {
      throw new SimulatedTaskStrategyPatchInterruption(phase);
    }
  }

  class SimulatedTaskStrategyPatchInterruption extends Error {
    constructor(phase: string) {
      super(`Simulated task strategy patch interruption after ${phase}.`);
    }
  }

  function patchStale() {
    return workflowError(
      'TASK_STRATEGY_PATCH_STALE',
      'The durable implementation patch no longer matches the exact session, actor, or task candidate tree.',
      ExitCode.staleState,
    );
  }

  function executionTask(
    inspection: SessionInspection,
  ): CrossAgentTddExecution | TddSingleAgentExecution {
    const task =
      inspection.contract.execution?.tasks[inspection.session.taskId];
    if (
      task?.strategy !== 'cross-agent-tdd' &&
      task?.strategy !== 'tdd-single-agent'
    ) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_NOT_APPLICABLE',
        'The active task does not admit a TDD implementation patch.',
        ExitCode.guard,
      );
    }
    return task;
  }

  function normalizePatchBytes(value: string | Buffer): Buffer {
    const patchBytes = typeof value === 'string' ? Buffer.from(value) : value;
    if (patchBytes.length === 0 || patchBytes.length > MAX_PATCH_BYTES) {
      throw workflowError(
        'TASK_STRATEGY_PATCH_INVALID',
        'The implementation patch is empty or exceeds the bounded byte limit.',
        ExitCode.verification,
        {
          details: {
            patchBytes: patchBytes.length,
            maxPatchBytes: MAX_PATCH_BYTES,
          },
        },
      );
    }
    return patchBytes;
  }

  function sha256(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
  return {
    validateTaskStrategyPatch,
    validateTaskStrategyProviderPatch,
    validateTaskStrategyCallerPatch,
    importTaskStrategyPatch,
    adoptCurrentTaskStrategyImplementation,
    adoptCurrentTaskStrategyCorrection,
    restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock,
    importTaskStrategyProviderPatch,
    importTaskStrategyProviderPatchUnderLifecycleLock,
    importTaskStrategyCallerPatchUnderLifecycleLock,
  };
}
