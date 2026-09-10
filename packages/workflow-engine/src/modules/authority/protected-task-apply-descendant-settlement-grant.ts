/**
 * Settles the prepared child-Grant tree before recovering its protected-
 * task parent.
 *
 * Invariants:
 * - Prepared descendants are settled leaf-first, ordered by descending
 *   depth then challengeId.
 * - assertSettlementObservation derives the phase from the descendant
 *   states and rejects any observation whose reported phase disagrees.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import {
  assertPreparedGrantDescendantTreeV1,
  type PreparedGrantDescendantNodeV1,
  type PreparedGrantDescendantTreeV1,
} from './grant-parent-binding.ts';
import {
  grantHasExactKeys,
  grantSha256,
  GRANT_SHA256_DIGEST,
} from './grant-primitives.ts';
import {
  assertProtectedTaskApplyRecoveryGrantRequiredDetails,
  type ProtectedTaskApplyRecoveryAction,
} from './protected-task-apply-recovery-grant.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
  type TransitionObservationContext,
} from './grant-transition-registry.ts';

export const PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_TRANSITION_ID =
  'task.protected-apply.settle-descendants.v1' as const;

export type ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1 =
  Readonly<{
    schemaVersion: 1;
    kind: 'protected-task-apply-descendant-settlement-grant-required.v1';
    action: ProtectedTaskApplyRecoveryAction;
    changeId: string;
    taskId: string;
    sessionId: string;
    transactionId: string;
    transactionDigest: string;
    transactionPhase: 'checks-running' | 'checked';
    parentChallengeId: string;
    parentOperationId: string;
    parentApprovalSubjectDigest: `sha256:${string}`;
    parentStateBindingDigest: `sha256:${string}`;
    parentParametersDigest: `sha256:${string}`;
    preparedDescendantTree: PreparedGrantDescendantTreeV1;
    reason: string;
  }>;

export type ProtectedTaskApplyDescendantSettlementParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-descendant-settlement.v1';
  repositoryId: string;
  action: ProtectedTaskApplyRecoveryAction;
  changeId: string;
  taskId: string;
  sessionId: string;
  transactionId: string;
  transactionDigest: string;
  transactionPhase: 'checks-running' | 'checked';
  parentChallengeId: string;
  parentOperationId: string;
  parentApprovalSubjectDigest: `sha256:${string}`;
  parentStateBindingDigest: `sha256:${string}`;
  parentParametersDigest: `sha256:${string}`;
  preparedDescendantTree: PreparedGrantDescendantTreeV1;
  reason: string;
  stateBindingDigest: `sha256:${string}`;
}>;

export type PreparedDescendantSettlementStateV1 = Readonly<{
  node: PreparedGrantDescendantNodeV1;
  state: 'prepared' | 'settled';
}>;

export type ProtectedTaskApplyDescendantSettlementObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-descendant-settlement-observation.v1';
  phase: 'prepared' | 'settling' | 'settled';
  repositoryId: string;
  action: ProtectedTaskApplyRecoveryAction;
  changeId: string;
  taskId: string;
  sessionId: string;
  transactionId: string;
  transactionDigest: string;
  transactionPhase: 'checks-running' | 'checked';
  parentChallengeId: string;
  parentOperationId: string;
  parentApprovalSubjectDigest: `sha256:${string}`;
  parentStateBindingDigest: `sha256:${string}`;
  parentParametersDigest: `sha256:${string}`;
  preparedDescendantTree: PreparedGrantDescendantTreeV1;
  reason: string;
  descendants: readonly PreparedDescendantSettlementStateV1[];
}>;

export type ProtectedTaskApplyDescendantSettlementGrantPort = Readonly<{
  observe(
    parameters: ProtectedTaskApplyDescendantSettlementParametersV1,
    context?: TransitionObservationContext,
  ): ProtectedTaskApplyDescendantSettlementObservationV1;
}>;

export const PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_PARAMETER_SCHEMA_DIGEST =
  grantSha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'protected-task-apply-descendant-settlement.schema.v1',
      required: [
        'repositoryId',
        'action',
        'changeId',
        'taskId',
        'sessionId',
        'transactionId',
        'transactionDigest',
        'transactionPhase',
        'parentChallengeId',
        'parentOperationId',
        'parentApprovalSubjectDigest',
        'parentStateBindingDigest',
        'parentParametersDigest',
        'preparedDescendantTree',
        'reason',
        'stateBindingDigest',
      ],
    }),
  );

export const PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_CONSEQUENCE_DIGEST =
  grantSha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'protected-task-apply-descendant-settlement-consequence.v1',
      effect: 'terminalize-exact-prepared-descendants-before-parent-recovery',
      parentTransitionApplied: false,
      descendantEffectsPreservedTruthfully: true,
    }),
  );

export function createProtectedTaskApplyDescendantSettlementGrantRequest(
  candidate: ProtectedTaskApplyDescendantSettlementObservationV1,
  proposedReason: string,
): GrantRequestInput {
  const observation = assertSettlementObservation(candidate);
  if (
    observation.phase !== 'prepared' ||
    observation.preparedDescendantTree.nodes.length === 0
  ) {
    throw settlementStateChanged(
      'No exact prepared descendants remain for settlement.',
    );
  }
  const stateBinding = settlementStateBinding(observation);
  const parameters = parametersFromObservation(
    observation,
    stateBinding.digest,
  );
  return Object.freeze({
    sourceModuleId: 'task-finalization-recovery',
    failureCode: 'protected-task-apply-descendant-settlement-required',
    facts: protectedTaskApplyDescendantSettlementFacts(parameters),
    stateBinding,
    candidates: Object.freeze([
      Object.freeze({
        transitionId: PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze([
          observation.action === 'cancel'
            ? 'settle-descendants-before-protected-cancel'
            : 'settle-descendants-before-protected-cancel-and-abort',
        ]),
        reasonRequired: true,
        proposedReason: exactText(proposedReason),
      }),
    ]),
  });
}

export function protectedTaskApplyDescendantSettlementTransitionDefinitions(
  port: ProtectedTaskApplyDescendantSettlementGrantPort,
): readonly TransitionDefinition<ProtectedTaskApplyDescendantSettlementParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_TRANSITION_ID,
      parameterSchemaDigest:
        PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest:
        PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertSettlementParameters,
      renderTrustedChoice(
        parameters: ProtectedTaskApplyDescendantSettlementParametersV1,
      ) {
        return Object.freeze({
          title: `Settle ${parameters.preparedDescendantTree.nodes.length} prepared child Grant(s) before protected task recovery`,
          consequences: Object.freeze([
            `Terminalize only descendants bound by tree ${parameters.preparedDescendantTree.treeDigest}.`,
            'Record unchanged child transitions as not applied; preserve changed or unavailable effect state truthfully.',
            `Do not cancel parent ${parameters.parentChallengeId}; retry the requested ${parameters.action} after settlement.`,
          ]),
        });
      },
      preparedDescendantTree(
        parameters: ProtectedTaskApplyDescendantSettlementParametersV1,
      ) {
        return assertSettlementParameters(parameters).preparedDescendantTree;
      },
      observeState(
        parameters: ProtectedTaskApplyDescendantSettlementParametersV1,
        context?: TransitionObservationContext,
      ) {
        return settlementStateBinding(
          assertMatchingObservation(
            port.observe(assertSettlementParameters(parameters), context),
            parameters,
          ),
        );
      },
      async execute(
        context: AuthorizedTransitionContext<ProtectedTaskApplyDescendantSettlementParametersV1>,
      ) {
        const parameters = assertSettlementParameters(context.parameters);
        const settle = context.settlePreparedDescendant;
        if (settle === undefined) {
          throw workflowError(
            'GRANT_DESCENDANT_SETTLEMENT_CAPABILITY_MISSING',
            'Grant Core did not provide the exact descendant settlement capability.',
            ExitCode.guard,
          );
        }
        context.assertLifecycleOwned();
        const before = assertMatchingObservation(
          port.observe(parameters, {
            challengeId: context.challengeId,
            operationId: context.operationId,
          }),
          parameters,
        );
        if (before.phase !== 'prepared' && !context.recovered) {
          throw grantTransitionPreconditionChanged(
            'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_ALREADY_STARTED',
            'Prepared descendant settlement started before this Grant executed.',
          );
        }
        if (
          before.phase === 'prepared' &&
          settlementStateBinding(before).digest !==
            parameters.stateBindingDigest
        ) {
          throw grantTransitionPreconditionChanged(
            'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_STATE_CHANGED',
            'Prepared descendant tree changed before settlement.',
          );
        }
        const stateById = new Map(
          before.descendants.map((entry) => [entry.node.challengeId, entry]),
        );
        const leafFirst = [...parameters.preparedDescendantTree.nodes].sort(
          (left, right) =>
            right.depth - left.depth ||
            left.challengeId.localeCompare(right.challengeId),
        );
        for (const node of leafFirst) {
          if (stateById.get(node.challengeId)?.state === 'settled') continue;
          context.assertLifecycleOwned();
          await settle(node);
        }
        context.assertLifecycleOwned();
        const after = assertMatchingObservation(
          port.observe(parameters, {
            challengeId: context.challengeId,
            operationId: context.operationId,
          }),
          parameters,
        );
        if (after.phase !== 'settled') {
          throw workflowError(
            'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_INCOMPLETE',
            'Exact prepared descendant settlement did not reach a terminal state.',
            ExitCode.verification,
          );
        }
        return Object.freeze({
          outcome: 'completed' as const,
          details: Object.freeze({
            schemaVersion: 1,
            kind: 'protected-task-apply-descendant-settlement-completed.v1',
            parentChallengeId: parameters.parentChallengeId,
            descendantTreeDigest: parameters.preparedDescendantTree.treeDigest,
            settledChallengeIds: leafFirst.map(
              ({ challengeId }) => challengeId,
            ),
            nextAction: parameters.action,
          }),
        });
      },
    }),
  ]);
}

export function protectedTaskApplyDescendantSettlementGrantRequired(
  input: Omit<
    ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
    'schemaVersion' | 'kind'
  >,
) {
  const details =
    assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails({
      schemaVersion: 1,
      kind: 'protected-task-apply-descendant-settlement-grant-required.v1',
      ...input,
    });
  return workflowError(
    'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_GRANT_REQUIRED',
    'Prepared child Grants require one exact settlement Grant before protected task recovery.',
    ExitCode.staleState,
    { details },
  );
}

export function assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails(
  value: unknown,
): ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'action',
      'changeId',
      'taskId',
      'sessionId',
      'transactionId',
      'transactionDigest',
      'transactionPhase',
      'parentChallengeId',
      'parentOperationId',
      'parentApprovalSubjectDigest',
      'parentStateBindingDigest',
      'parentParametersDigest',
      'preparedDescendantTree',
      'reason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !==
      'protected-task-apply-descendant-settlement-grant-required.v1'
  ) {
    throw settlementInvalid();
  }
  const base = assertProtectedTaskApplyRecoveryGrantRequiredDetails({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-grant-required.v1',
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
  const tree = assertPreparedGrantDescendantTreeV1(
    value.preparedDescendantTree,
  );
  if (
    tree.rootChallengeId !== base.parentChallengeId ||
    tree.nodes.length === 0
  ) {
    throw settlementInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-descendant-settlement-grant-required.v1',
    action: base.action,
    changeId: base.changeId,
    taskId: base.taskId,
    sessionId: base.sessionId,
    transactionId: base.transactionId,
    transactionDigest: base.transactionDigest,
    transactionPhase: base.transactionPhase,
    parentChallengeId: base.parentChallengeId,
    parentOperationId: base.parentOperationId,
    parentApprovalSubjectDigest: base.parentApprovalSubjectDigest,
    parentStateBindingDigest: base.parentStateBindingDigest,
    parentParametersDigest: base.parentParametersDigest,
    preparedDescendantTree: tree,
    reason: base.reason,
  });
}

export function assertSettlementParameters(
  value: unknown,
): ProtectedTaskApplyDescendantSettlementParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repositoryId',
      'action',
      'changeId',
      'taskId',
      'sessionId',
      'transactionId',
      'transactionDigest',
      'transactionPhase',
      'parentChallengeId',
      'parentOperationId',
      'parentApprovalSubjectDigest',
      'parentStateBindingDigest',
      'parentParametersDigest',
      'preparedDescendantTree',
      'reason',
      'stateBindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-descendant-settlement.v1' ||
    typeof value.repositoryId !== 'string' ||
    typeof value.stateBindingDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.stateBindingDigest)
  ) {
    throw settlementInvalid();
  }
  const details =
    assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails({
      schemaVersion: 1,
      kind: 'protected-task-apply-descendant-settlement-grant-required.v1',
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
      preparedDescendantTree: value.preparedDescendantTree,
      reason: value.reason,
    });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-descendant-settlement.v1',
    repositoryId: exactText(value.repositoryId),
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
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
  });
}

export function settlementStateBinding(
  candidate: ProtectedTaskApplyDescendantSettlementObservationV1,
): StateBinding {
  const observation = assertSettlementObservation(candidate);
  return Object.freeze({
    kind: 'protected-task-apply-descendant-settlement-state.v1',
    digest: grantSha256(canonicalJson(observation)),
  });
}

function assertSettlementObservation(
  value: unknown,
): ProtectedTaskApplyDescendantSettlementObservationV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'phase',
      'repositoryId',
      'action',
      'changeId',
      'taskId',
      'sessionId',
      'transactionId',
      'transactionDigest',
      'transactionPhase',
      'parentChallengeId',
      'parentOperationId',
      'parentApprovalSubjectDigest',
      'parentStateBindingDigest',
      'parentParametersDigest',
      'preparedDescendantTree',
      'reason',
      'descendants',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !==
      'protected-task-apply-descendant-settlement-observation.v1' ||
    !['prepared', 'settling', 'settled'].includes(String(value.phase)) ||
    !Array.isArray(value.descendants)
  ) {
    throw settlementInvalid();
  }
  const parameters = assertSettlementParameters({
    schemaVersion: 1,
    kind: 'protected-task-apply-descendant-settlement.v1',
    repositoryId: value.repositoryId,
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
    preparedDescendantTree: value.preparedDescendantTree,
    reason: value.reason,
    stateBindingDigest: `sha256:${'0'.repeat(64)}`,
  });
  const descendants = value.descendants.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !grantHasExactKeys(entry, ['node', 'state']) ||
      !['prepared', 'settled'].includes(String(entry.state)) ||
      canonicalJson(entry.node) !==
        canonicalJson(parameters.preparedDescendantTree.nodes[index])
    ) {
      throw settlementInvalid();
    }
    return Object.freeze({
      node: parameters.preparedDescendantTree.nodes[index]!,
      state: entry.state as 'prepared' | 'settled',
    });
  });
  if (descendants.length !== parameters.preparedDescendantTree.nodes.length) {
    throw settlementInvalid();
  }
  const derivedPhase = descendants.every(({ state }) => state === 'prepared')
    ? 'prepared'
    : descendants.every(({ state }) => state === 'settled')
      ? 'settled'
      : 'settling';
  if (derivedPhase !== value.phase) throw settlementInvalid();
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-descendant-settlement-observation.v1',
    phase: derivedPhase,
    ...protectedTaskApplyDescendantSettlementFacts(parameters),
    descendants: Object.freeze(descendants),
  });
}

function parametersFromObservation(
  observation: ProtectedTaskApplyDescendantSettlementObservationV1,
  stateBindingDigest: `sha256:${string}`,
): ProtectedTaskApplyDescendantSettlementParametersV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-descendant-settlement.v1',
    ...protectedTaskApplyDescendantSettlementFacts(observation),
    stateBindingDigest,
  });
}

export function protectedTaskApplyDescendantSettlementFacts(
  value:
    | ProtectedTaskApplyDescendantSettlementObservationV1
    | ProtectedTaskApplyDescendantSettlementParametersV1,
) {
  return Object.freeze({
    repositoryId: value.repositoryId,
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
    preparedDescendantTree: value.preparedDescendantTree,
    reason: value.reason,
  });
}

function assertMatchingObservation(
  candidate: ProtectedTaskApplyDescendantSettlementObservationV1,
  parameters: ProtectedTaskApplyDescendantSettlementParametersV1,
) {
  const observation = assertSettlementObservation(candidate);
  if (
    canonicalJson(protectedTaskApplyDescendantSettlementFacts(observation)) !==
    canonicalJson(
      protectedTaskApplyDescendantSettlementFacts(
        assertSettlementParameters(parameters),
      ),
    )
  ) {
    throw grantTransitionPreconditionChanged(
      'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_STATE_CHANGED',
      'Prepared descendant settlement identity changed.',
    );
  }
  return observation;
}

function settlementStateChanged(message: string) {
  return workflowError(
    'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_STATE_CHANGED',
    message,
    ExitCode.staleState,
  );
}

function settlementInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_INVALID',
    'Protected task Apply descendant settlement value is invalid.',
    ExitCode.guard,
  );
}

function exactText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 1024 ||
    /\p{Cc}/u.test(value)
  ) {
    throw settlementInvalid();
  }
  return value;
}
