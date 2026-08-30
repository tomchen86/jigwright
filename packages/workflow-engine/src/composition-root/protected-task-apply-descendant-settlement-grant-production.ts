import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import type { GrantChallenge } from '../modules/authority/grant-core.ts';
import {
  assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails,
  assertSettlementParameters,
  PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_TRANSITION_ID,
  protectedTaskApplyDescendantSettlementFacts,
  type ProtectedTaskApplyDescendantSettlementGrantPort,
  type ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
  type ProtectedTaskApplyDescendantSettlementObservationV1,
  type ProtectedTaskApplyDescendantSettlementParametersV1,
} from '../modules/authority/protected-task-apply-descendant-settlement-grant.ts';
import type { TransitionObservationContext } from '../modules/authority/grant-transition-registry.ts';
import { loadWorkflowConfig } from '../adapters/consumer/repository/work-registry/contracts.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  grantRecordDigest,
  grantStorePaths,
  inspectPreparedGrantDescendantTree,
  readGrantRecord,
  type GrantRecord,
  type PreparedGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';
import { observeCurrentProtectedTaskApplyRecoveryRequest } from './protected-task-apply-recovery-grant-production.ts';

export function createProductionProtectedTaskApplyDescendantSettlementGrantPort(
  cwd: string,
): ProtectedTaskApplyDescendantSettlementGrantPort {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  return Object.freeze({
    observe(parameters, context) {
      return observeCurrentProtectedTaskApplyDescendantSettlement(
        repositoryRoot,
        parameters,
        context,
      );
    },
  });
}

export function observeCurrentProtectedTaskApplyDescendantSettlementRequest(
  cwd: string,
  candidate: ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
): ProtectedTaskApplyDescendantSettlementObservationV1 {
  const details =
    assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails(candidate);
  const base = observeCurrentProtectedTaskApplyRecoveryRequest(
    cwd,
    recoveryDetails(details),
  );
  const { paths, parent } = settlementRuntime(cwd, details.parentChallengeId);
  const currentTree = inspectPreparedGrantDescendantTree(paths, parent);
  if (
    canonicalJson(currentTree) !== canonicalJson(details.preparedDescendantTree)
  ) {
    throw settlementChanged(
      'Prepared descendant tree changed before Grant creation.',
    );
  }
  return settlementObservation(
    {
      schemaVersion: 1,
      kind: 'protected-task-apply-descendant-settlement.v1',
      repositoryId: base.repositoryId,
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
      preparedDescendantTree: details.preparedDescendantTree,
      reason: details.reason,
      stateBindingDigest: `sha256:${'0'.repeat(64)}`,
    },
    details.preparedDescendantTree.nodes.map((node) => ({
      node,
      state: 'prepared' as const,
    })),
  );
}

export function observeCurrentProtectedTaskApplyDescendantSettlement(
  cwd: string,
  candidate: ProtectedTaskApplyDescendantSettlementParametersV1,
  context?: TransitionObservationContext,
): ProtectedTaskApplyDescendantSettlementObservationV1 {
  const parameters = assertSettlementParameters(candidate);
  const base = observeCurrentProtectedTaskApplyRecoveryRequest(
    cwd,
    recoveryDetails(parameters),
  );
  if (base.repositoryId !== parameters.repositoryId) {
    throw settlementChanged('Repository identity changed during settlement.');
  }
  const { paths, parent } = settlementRuntime(
    cwd,
    parameters.parentChallengeId,
  );
  if (
    grantRecordDigest(parent) !==
    parameters.preparedDescendantTree.rootPreparedRecordDigest
  ) {
    throw settlementChanged('Prepared parent Grant changed during settlement.');
  }
  const descendants = parameters.preparedDescendantTree.nodes.map((node) => {
    const record = readGrantRecord(paths, node.challengeId);
    if (record.state === 'prepared') {
      assertExactPreparedNode(record, node);
      return Object.freeze({ node, state: 'prepared' as const });
    }
    if (record.state !== 'failed') {
      throw settlementChanged(
        `Prepared descendant ${node.challengeId} was terminalized by another operation.`,
      );
    }
    if (
      context?.operationId === null ||
      context?.operationId === undefined ||
      context.challengeId.length === 0 ||
      !matchesSettlementOutcome(
        record,
        context,
        parameters.preparedDescendantTree.treeDigest,
        node.preparedRecordDigest,
      )
    ) {
      throw settlementChanged(
        `Prepared descendant ${node.challengeId} was terminalized by another operation.`,
      );
    }
    return Object.freeze({ node, state: 'settled' as const });
  });
  if (descendants.every(({ state }) => state === 'prepared')) {
    const currentTree = inspectPreparedGrantDescendantTree(paths, parent);
    if (
      canonicalJson(currentTree) !==
      canonicalJson(parameters.preparedDescendantTree)
    ) {
      throw settlementChanged(
        'Prepared descendant tree changed before settlement.',
      );
    }
  }
  return settlementObservation(parameters, descendants);
}

export function protectedTaskApplyDescendantSettlementContinuation(
  challenge: GrantChallenge,
): Readonly<{
  parentChallengeId: string;
  descendantChallengeIds: readonly string[];
}> | null {
  if (
    challenge.sourceModuleId !== 'task-finalization-recovery' ||
    challenge.failureCode !==
      'protected-task-apply-descendant-settlement-required'
  ) {
    return null;
  }
  const choice = challenge.choices[0];
  if (
    challenge.choices.length !== 1 ||
    choice?.transitionId !==
      PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_TRANSITION_ID
  ) {
    throw settlementContinuationInvalid();
  }
  const parameters = assertSettlementParameters(choice.parameters);
  if (
    challenge.stateBinding.kind !==
      'protected-task-apply-descendant-settlement-state.v1' ||
    challenge.stateBinding.digest !== parameters.stateBindingDigest ||
    canonicalJson(challenge.facts) !==
      canonicalJson(protectedTaskApplyDescendantSettlementFacts(parameters))
  ) {
    throw settlementContinuationInvalid();
  }
  return Object.freeze({
    parentChallengeId: parameters.parentChallengeId,
    descendantChallengeIds: Object.freeze(
      parameters.preparedDescendantTree.nodes.map(
        ({ challengeId }) => challengeId,
      ),
    ),
  });
}

function settlementRuntime(cwd: string, parentChallengeId: string) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const paths = grantStorePaths(runtime.root);
  const parent = readGrantRecord(paths, parentChallengeId);
  if (parent.state !== 'prepared') {
    throw settlementChanged('Protected Apply parent is no longer prepared.');
  }
  return Object.freeze({ paths, parent });
}

function assertExactPreparedNode(
  record: PreparedGrantRecord,
  node: ProtectedTaskApplyDescendantSettlementParametersV1['preparedDescendantTree']['nodes'][number],
): void {
  if (
    record.challenge.challengeId !== node.challengeId ||
    record.challenge.challengeDigest !== node.challengeDigest ||
    record.operationId !== node.operationId ||
    record.challenge.stateBinding.digest !== node.stateBindingDigest ||
    grantRecordDigest(record) !== node.preparedRecordDigest ||
    !isRecord(record.challenge.facts) ||
    canonicalJson(record.challenge.facts.parentGrantBinding) !==
      canonicalJson(node.parentBinding)
  ) {
    throw settlementChanged(
      `Prepared descendant ${node.challengeId} changed before settlement.`,
    );
  }
}

function matchesSettlementOutcome(
  record: GrantRecord,
  context: TransitionObservationContext,
  treeDigest: string,
  preparedRecordDigest: string,
): boolean {
  if (record.state !== 'failed') return false;
  const details = record.outcome.details;
  return (
    isRecord(details) &&
    details.kind === 'grant-transition-cancelled-by-ancestor-recovery.v1' &&
    details.outerChallengeId === context.challengeId &&
    details.outerOperationId === context.operationId &&
    details.descendantTreeDigest === treeDigest &&
    details.preparedRecordDigest === preparedRecordDigest
  );
}

function settlementObservation(
  parameters: ProtectedTaskApplyDescendantSettlementParametersV1,
  descendants: ProtectedTaskApplyDescendantSettlementObservationV1['descendants'],
): ProtectedTaskApplyDescendantSettlementObservationV1 {
  const phase = descendants.every(({ state }) => state === 'prepared')
    ? 'prepared'
    : descendants.every(({ state }) => state === 'settled')
      ? 'settled'
      : 'settling';
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-descendant-settlement-observation.v1',
    phase,
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
    preparedDescendantTree: parameters.preparedDescendantTree,
    reason: parameters.reason,
    descendants: Object.freeze([...descendants]),
  });
}

function recoveryDetails(
  value:
    | ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1
    | ProtectedTaskApplyDescendantSettlementParametersV1,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'protected-task-apply-recovery-grant-required.v1' as const,
    action: value.action,
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    transactionId: value.transactionId,
    transactionDigest: value.transactionDigest,
    transactionPhase: value.transactionPhase,
    parentChallengeId: value.parentChallengeId,
    parentOperationId: value.parentOperationId,
    parentApprovalSubjectDigest: value.parentApprovalSubjectDigest,
    parentStateBindingDigest: value.parentStateBindingDigest,
    parentParametersDigest: value.parentParametersDigest,
    reason: value.reason,
  });
}

function settlementChanged(message: string) {
  return workflowError(
    'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_STATE_CHANGED',
    message,
    ExitCode.staleState,
  );
}

function settlementContinuationInvalid() {
  return workflowError(
    'GRANT_CONTINUATION_INVALID',
    'Protected task Apply descendant settlement continuation is invalid.',
    ExitCode.guard,
  );
}
