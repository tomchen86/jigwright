/**
 * Binds protected task recovery Grants to current transactions and terminal
 * outcomes.
 *
 * Invariants:
 * - Recovery must publish the requested cancelled or aborted state and
 *   cancellation record.
 */
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { cancelProtectedTaskApplyRecoveryUnderGrant } from './finalization-production.ts';
import { readProtectedFinalizeCancellation } from '../application/finalize/finalize-cancellation.ts';
import { abortSessionAfterProtectedTaskApplyRecoveryUnderGrant } from '../application/execute-task/session.ts';
import { getSession } from '../runtime/repository-observation/workflow-session-context.ts';
import {
  approvalSubjectDigest,
  type GrantChallenge,
} from '../modules/authority/grant-core.ts';
import {
  assertProtectedTaskApplyRecoveryAuthorization,
  assertProtectedTaskApplyRecoveryGrantRequiredDetails,
  assertProtectedTaskApplyRecoveryParameters,
  PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID,
  type ProtectedTaskApplyRecoveryGrantPort,
  type ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
  type ProtectedTaskApplyRecoveryObservationV1,
  type ProtectedTaskApplyRecoveryParametersV1,
} from '../modules/authority/protected-task-apply-recovery-grant.ts';
import {
  assertProtectedTaskApplyParameters,
  PROTECTED_TASK_APPLY_TRANSITION_ID,
} from '../modules/authority/protected-task-apply-grant.ts';
import { grantSha256 } from '../modules/authority/grant-primitives.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import { loadWorkflowConfig } from '../runtime/repository-observation/workflow-configuration.ts';
import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import {
  readFinalizeTransaction,
  type FinalizeTransaction,
} from '../runtime/repository-transaction/finalize-transaction.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../runtime/storage-journal/grant-store.ts';
import {
  type GrantRecord,
  type PreparedGrantRecord,
} from '../modules/authority/grant-records.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';

export function createProductionProtectedTaskApplyRecoveryGrantPort(
  cwd: string,
): ProtectedTaskApplyRecoveryGrantPort {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  return Object.freeze({
    observe(parameters: ProtectedTaskApplyRecoveryParametersV1) {
      return observeCurrentProtectedTaskApplyRecovery(
        repositoryRoot,
        parameters,
      );
    },
    recover(context, candidateAuthorization) {
      const parameters = assertProtectedTaskApplyRecoveryParameters(
        context.parameters,
      );
      const authorization = assertProtectedTaskApplyRecoveryAuthorization(
        candidateAuthorization,
      );
      context.assertLifecycleOwned();
      assertPreparedRecoveryGrant(
        repositoryRoot,
        parameters,
        authorization.challengeId,
        authorization.operationId,
        authorization.approvalSubjectDigest,
      );
      context.assertLifecycleOwned();
      cancelProtectedTaskApplyRecoveryUnderGrant(
        repositoryRoot,
        parameters,
        authorization,
        context.assertLifecycleOwned,
      );
      context.assertLifecycleOwned();
      if (parameters.action === 'cancel-and-abort') {
        abortSessionAfterProtectedTaskApplyRecoveryUnderGrant(
          repositoryRoot,
          parameters,
          context.assertLifecycleOwned,
        );
      }
      context.assertLifecycleOwned();
      const after = observeCurrentProtectedTaskApplyRecovery(
        repositoryRoot,
        parameters,
      );
      if (
        after.cancellationRecordDigest === null ||
        (parameters.action === 'cancel'
          ? after.phase !== 'cancelled'
          : after.phase !== 'aborted')
      ) {
        throw workflowError(
          'PROTECTED_TASK_APPLY_RECOVERY_RESULT_INVALID',
          'Protected task Apply recovery did not publish its exact terminal state.',
          ExitCode.verification,
        );
      }
      return Object.freeze({
        phase:
          parameters.action === 'cancel'
            ? ('cancelled' as const)
            : ('aborted' as const),
        cancellationRecordDigest: after.cancellationRecordDigest,
      });
    },
  });
}

export function observeCurrentProtectedTaskApplyRecovery(
  cwd: string,
  candidate: ProtectedTaskApplyRecoveryParametersV1,
): ProtectedTaskApplyRecoveryObservationV1 {
  const parameters = assertProtectedTaskApplyRecoveryParameters(candidate);
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const parent = createFileGrantRecordStore(
    grantStorePaths(runtime.root),
  ).readGrantRecord(parameters.parentChallengeId);
  assertExactPreparedParent(git.repositoryRoot, parent, parameters);
  const session = getSession(git.repositoryRoot, parameters.sessionId);
  if (
    session.changeId !== parameters.changeId ||
    session.taskId !== parameters.taskId
  ) {
    throw recoveryStateChanged('The protected task session identity changed.');
  }
  const active = readFinalizeTransaction(runtime.root, parameters.sessionId);
  const cancellation = readProtectedFinalizeCancellation(
    runtime.root,
    parameters.sessionId,
    parameters.parentChallengeId,
  );
  if (active !== null) {
    assertExactTransaction(active, parameters);
    if (session.state !== 'active') {
      throw recoveryStateChanged(
        'The protected task session became terminal before cancellation.',
      );
    }
    return observation(
      parameters,
      cancellation === null ? 'in-progress' : 'cancellation-in-progress',
      cancellation?.recordDigest ?? null,
    );
  }
  if (
    cancellation?.phase !== 'completed' ||
    cancellation.cancelledAt === null
  ) {
    throw recoveryStateChanged(
      'The exact protected finalize transaction disappeared without a completed cancellation.',
    );
  }
  assertExactTransaction(cancellation.transaction, parameters);
  if (cancellation.reason !== parameters.reason) {
    throw recoveryStateChanged(
      'The protected finalize cancellation reason changed.',
    );
  }
  const phase =
    parameters.action === 'cancel'
      ? session.state === 'active'
        ? 'cancelled'
        : null
      : session.state === 'active'
        ? 'cancellation-completed'
        : session.state === 'aborted' &&
            session.abortReason === parameters.reason
          ? 'aborted'
          : null;
  if (phase === null) {
    throw recoveryStateChanged(
      'The task session state does not match the exact recovery action.',
    );
  }
  return observation(parameters, phase, cancellation.recordDigest);
}

export function observeCurrentProtectedTaskApplyRecoveryRequest(
  cwd: string,
  candidate: ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
): ProtectedTaskApplyRecoveryObservationV1 {
  const details =
    assertProtectedTaskApplyRecoveryGrantRequiredDetails(candidate);
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const parent = createFileGrantRecordStore(
    grantStorePaths(runtime.root),
  ).readGrantRecord(details.parentChallengeId);
  if (
    parent.state !== 'prepared' ||
    parent.operationId !== details.parentOperationId ||
    approvalSubjectDigest(parent.approvalSubject) !==
      details.parentApprovalSubjectDigest ||
    parent.challenge.stateBinding.digest !== details.parentStateBindingDigest ||
    parent.challenge.choices.length !== 1 ||
    parent.challenge.choices[0]!.transitionId !==
      PROTECTED_TASK_APPLY_TRANSITION_ID ||
    grantSha256(canonicalJson(parent.challenge.choices[0]!.parameters)) !==
      details.parentParametersDigest
  ) {
    throw recoveryStateChanged(
      'The prepared protected Apply parent changed before recovery Grant creation.',
    );
  }
  const parentParameters = assertProtectedTaskApplyParameters(
    parent.challenge.choices[0]!.parameters,
  );
  if (
    parentParameters.changeId !== details.changeId ||
    parentParameters.taskId !== details.taskId ||
    parentParameters.sessionId !== details.sessionId ||
    repositoryIdAtBaseline(
      git.repositoryRoot,
      parentParameters.baseline.head,
    ) !== parentParameters.repositoryId
  ) {
    throw recoveryStateChanged(
      'The protected Apply parent no longer owns this recovery request.',
    );
  }
  const session = getSession(git.repositoryRoot, details.sessionId);
  const transaction = readFinalizeTransaction(runtime.root, details.sessionId);
  const cancellation = readProtectedFinalizeCancellation(
    runtime.root,
    details.sessionId,
    details.parentChallengeId,
  );
  if (
    session.state !== 'active' ||
    session.changeId !== details.changeId ||
    session.taskId !== details.taskId ||
    transaction === null ||
    cancellation !== null
  ) {
    throw recoveryStateChanged(
      'The protected finalize transaction is no longer awaiting a fresh recovery Grant.',
    );
  }
  assertExactTransactionDetails(transaction, details);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-observation.v1',
    phase: 'in-progress',
    repositoryId: parentParameters.repositoryId,
    action: details.action,
    changeId: details.changeId,
    taskId: details.taskId,
    sessionId: details.sessionId,
    transactionId: details.transactionId,
    transactionDigest: details.transactionDigest,
    transactionPhase: details.transactionPhase,
    parentChallengeId: details.parentChallengeId,
    parentOperationId: details.parentOperationId,
    parentApprovalSubjectDigest: details.parentApprovalSubjectDigest,
    parentStateBindingDigest: details.parentStateBindingDigest,
    parentParametersDigest: details.parentParametersDigest,
    reason: details.reason,
    cancellationRecordDigest: null,
  });
}

export function protectedTaskApplyRecoveryParentContinuation(
  cwd: string,
  challenge: GrantChallenge,
): Readonly<{ parentChallengeId: string }> | null {
  const reference = protectedTaskApplyRecoveryParentReference(challenge);
  if (reference === null) return null;
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const parent = readRepositoryGrantRecord(
    repositoryRoot,
    reference.parameters.parentChallengeId,
  );
  assertExactPreparedParent(repositoryRoot, parent, reference.parameters);
  return Object.freeze({
    parentChallengeId: reference.parameters.parentChallengeId,
  });
}

export function protectedTaskApplyRecoveryParentReference(
  challenge: GrantChallenge,
): Readonly<{
  parentChallengeId: string;
  parameters: ProtectedTaskApplyRecoveryParametersV1;
}> | null {
  if (
    challenge.sourceModuleId !== 'task-finalization-recovery' ||
    challenge.failureCode !== 'protected-task-apply-cancellation-required'
  ) {
    return null;
  }
  if (
    challenge.choices.length !== 1 ||
    challenge.choices[0]!.transitionId !==
      PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID
  ) {
    throw recoveryContinuationInvalid();
  }
  const parameters = assertProtectedTaskApplyRecoveryParameters(
    challenge.choices[0]!.parameters,
  );
  if (
    challenge.stateBinding.kind !== 'protected-task-apply-recovery-state.v1' ||
    challenge.stateBinding.digest !== parameters.stateBindingDigest ||
    canonicalJson(challenge.facts) !== canonicalJson(recoveryFacts(parameters))
  ) {
    throw recoveryContinuationInvalid();
  }
  return Object.freeze({
    parentChallengeId: parameters.parentChallengeId,
    parameters,
  });
}

function assertPreparedRecoveryGrant(
  repositoryRoot: string,
  parameters: ProtectedTaskApplyRecoveryParametersV1,
  challengeId: string,
  operationId: string,
  approvalDigest: string,
): PreparedGrantRecord {
  const record = readRepositoryGrantRecord(repositoryRoot, challengeId);
  if (
    record.state !== 'prepared' ||
    record.operationId !== operationId ||
    approvalSubjectDigest(record.approvalSubject) !== approvalDigest ||
    record.challenge.stateBinding.kind !==
      'protected-task-apply-recovery-state.v1' ||
    record.challenge.stateBinding.digest !== parameters.stateBindingDigest ||
    record.challenge.choices.length !== 1 ||
    record.challenge.choices[0]!.transitionId !==
      PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID ||
    canonicalJson(record.challenge.choices[0]!.parameters) !==
      canonicalJson(parameters) ||
    canonicalJson(record.challenge.facts) !==
      canonicalJson(recoveryFacts(parameters))
  ) {
    throw recoveryStateChanged(
      'The prepared protected Apply recovery Grant changed.',
    );
  }
  return record;
}

function assertExactPreparedParent(
  repositoryRoot: string,
  record: GrantRecord,
  parameters: ProtectedTaskApplyRecoveryParametersV1,
): asserts record is PreparedGrantRecord {
  const choice = record.challenge.choices[0];
  if (
    record.state !== 'prepared' ||
    record.challenge.challengeId !== parameters.parentChallengeId ||
    record.operationId !== parameters.parentOperationId ||
    approvalSubjectDigest(record.approvalSubject) !==
      parameters.parentApprovalSubjectDigest ||
    record.challenge.stateBinding.digest !==
      parameters.parentStateBindingDigest ||
    record.challenge.choices.length !== 1 ||
    choice?.transitionId !== PROTECTED_TASK_APPLY_TRANSITION_ID ||
    grantSha256(canonicalJson(choice.parameters)) !==
      parameters.parentParametersDigest
  ) {
    throw recoveryStateChanged('The prepared protected Apply parent changed.');
  }
  const parentParameters = assertProtectedTaskApplyParameters(
    choice.parameters,
  );
  if (
    parentParameters.repositoryId !== parameters.repositoryId ||
    parentParameters.changeId !== parameters.changeId ||
    parentParameters.taskId !== parameters.taskId ||
    parentParameters.sessionId !== parameters.sessionId ||
    repositoryIdAtBaseline(repositoryRoot, parentParameters.baseline.head) !==
      parameters.repositoryId
  ) {
    throw recoveryStateChanged(
      'The protected Apply parent does not own this recovery request.',
    );
  }
}

function assertExactTransaction(
  transaction: FinalizeTransaction,
  parameters: ProtectedTaskApplyRecoveryParametersV1,
): void {
  const parent = transaction.protectedApply;
  if (
    transaction.changeId !== parameters.changeId ||
    transaction.taskId !== parameters.taskId ||
    transaction.sessionId !== parameters.sessionId ||
    transaction.transactionId !== parameters.transactionId ||
    transaction.recordDigest !== parameters.transactionDigest ||
    transaction.phase !== parameters.transactionPhase ||
    parent?.challengeId !== parameters.parentChallengeId ||
    parent.operationId !== parameters.parentOperationId ||
    parent.approvalSubjectDigest !== parameters.parentApprovalSubjectDigest ||
    parent.stateBindingDigest !== parameters.parentStateBindingDigest ||
    parent.parametersDigest !== parameters.parentParametersDigest
  ) {
    throw recoveryStateChanged(
      'The exact protected finalize transaction changed.',
    );
  }
}

function assertExactTransactionDetails(
  transaction: FinalizeTransaction,
  details: ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
): void {
  const parent = transaction.protectedApply;
  if (
    transaction.changeId !== details.changeId ||
    transaction.taskId !== details.taskId ||
    transaction.sessionId !== details.sessionId ||
    transaction.transactionId !== details.transactionId ||
    transaction.recordDigest !== details.transactionDigest ||
    transaction.phase !== details.transactionPhase ||
    parent?.challengeId !== details.parentChallengeId ||
    parent.operationId !== details.parentOperationId ||
    parent.approvalSubjectDigest !== details.parentApprovalSubjectDigest ||
    parent.stateBindingDigest !== details.parentStateBindingDigest ||
    parent.parametersDigest !== details.parentParametersDigest
  ) {
    throw recoveryStateChanged(
      'The exact protected finalize transaction changed before recovery Grant creation.',
    );
  }
}

function observation(
  parameters: ProtectedTaskApplyRecoveryParametersV1,
  phase: ProtectedTaskApplyRecoveryObservationV1['phase'],
  cancellationRecordDigest: string | null,
): ProtectedTaskApplyRecoveryObservationV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-observation.v1',
    phase,
    ...recoveryFacts(parameters),
    cancellationRecordDigest,
  });
}

function recoveryFacts(parameters: ProtectedTaskApplyRecoveryParametersV1) {
  return Object.freeze({
    repositoryId: parameters.repositoryId,
    action: parameters.action,
    changeId: parameters.changeId,
    taskId: parameters.taskId,
    sessionId: parameters.sessionId,
    transactionId: parameters.transactionId,
    transactionDigest: parameters.transactionDigest,
    transactionPhase: parameters.transactionPhase,
    parentChallengeId: parameters.parentChallengeId,
    parentOperationId: parameters.parentOperationId,
    parentApprovalSubjectDigest: parameters.parentApprovalSubjectDigest,
    parentStateBindingDigest: parameters.parentStateBindingDigest,
    parentParametersDigest: parameters.parentParametersDigest,
    reason: parameters.reason,
  });
}

function readRepositoryGrantRecord(
  repositoryRoot: string,
  challengeId: string,
) {
  const git = discoverRepository(repositoryRoot);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return createFileGrantRecordStore(
    grantStorePaths(runtime.root),
  ).readGrantRecord(challengeId);
}

function repositoryIdAtBaseline(
  repositoryRoot: string,
  baselineHead: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${baselineHead}:workflow/maintainer-policy.json`,
      ]),
    );
  } catch {
    throw recoveryStateChanged(
      'The baseline maintainer policy is unavailable for protected recovery.',
    );
  }
  return parseMaintainerPolicy(value).repository.id;
}

function recoveryStateChanged(message: string) {
  return workflowError(
    'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
    message,
    ExitCode.staleState,
  );
}

function recoveryContinuationInvalid() {
  return workflowError(
    'GRANT_CONTINUATION_INVALID',
    'Protected task Apply recovery does not match its exact parent Grant.',
    ExitCode.guard,
  );
}
