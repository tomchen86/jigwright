import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import {
  grantHasExactKeys,
  grantSha256,
  GRANT_UUID_V4,
} from './grant-primitives.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
} from './grant-transition-registry.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID =
  'task.protected-apply.cancel-recovery.v1' as const;

export type ProtectedTaskApplyRecoveryAction = 'cancel' | 'cancel-and-abort';

export type ProtectedTaskApplyRecoveryGrantRequiredDetailsV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-recovery-grant-required.v1';
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
  reason: string;
}>;

export type ProtectedTaskApplyRecoveryAuthorizationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-recovery-authorization.v1';
  transitionId: typeof PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID;
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  stateBindingDigest: `sha256:${string}`;
  parametersDigest: `sha256:${string}`;
  parentChallengeId: string;
  parentOperationId: string;
  parentApprovalSubjectDigest: `sha256:${string}`;
  parentStateBindingDigest: `sha256:${string}`;
  parentParametersDigest: `sha256:${string}`;
  action: ProtectedTaskApplyRecoveryAction;
}>;

export type ProtectedTaskApplyRecoveryObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-recovery-observation.v1';
  phase:
    | 'in-progress'
    | 'cancellation-in-progress'
    | 'cancellation-completed'
    | 'cancelled'
    | 'aborted';
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
  reason: string;
  cancellationRecordDigest: string | null;
}>;

export type ProtectedTaskApplyRecoveryParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-recovery.v1';
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
  reason: string;
  stateBindingDigest: `sha256:${string}`;
}>;

export type ProtectedTaskApplyRecoveryGrantPort = Readonly<{
  observe(
    parameters: ProtectedTaskApplyRecoveryParametersV1,
  ): ProtectedTaskApplyRecoveryObservationV1;
  recover(
    context: AuthorizedTransitionContext<ProtectedTaskApplyRecoveryParametersV1>,
    authorization: ProtectedTaskApplyRecoveryAuthorizationBinding,
  ): Readonly<{
    phase: 'cancelled' | 'aborted';
    cancellationRecordDigest: string;
  }>;
}>;

export const PROTECTED_TASK_APPLY_RECOVERY_PARAMETER_SCHEMA_DIGEST =
  grantSha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'protected-task-apply-recovery.schema.v1',
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
        'reason',
        'stateBindingDigest',
      ],
    }),
  );

export const PROTECTED_TASK_APPLY_RECOVERY_CONSEQUENCE_DIGEST = grantSha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-consequence.v1',
    effect: 'cancel-one-exact-protected-finalize-transaction',
    actions: ['cancel', 'cancel-and-abort'],
    projectionRestored: true,
    parentApplyOutcome: 'failed',
    factualCheckResultsPreserved: true,
  }),
);

export function createProtectedTaskApplyRecoveryGrantRequest(
  candidate: ProtectedTaskApplyRecoveryObservationV1,
  proposedReason: string,
): GrantRequestInput {
  const observation = assertProtectedTaskApplyRecoveryObservation(candidate);
  if (
    observation.phase !== 'in-progress' ||
    observation.cancellationRecordDigest !== null
  ) {
    throw workflowError(
      'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
      'The exact protected finalize transaction is no longer awaiting recovery.',
      ExitCode.staleState,
    );
  }
  const stateBinding = protectedTaskApplyRecoveryStateBinding(observation);
  const parameters = parametersFromObservation(
    observation,
    stateBinding.digest,
  );
  return Object.freeze({
    sourceModuleId: 'task-finalization-recovery',
    failureCode: 'protected-task-apply-cancellation-required',
    facts: Object.freeze({
      repositoryId: observation.repositoryId,
      action: observation.action,
      changeId: observation.changeId,
      taskId: observation.taskId,
      sessionId: observation.sessionId,
      transactionId: observation.transactionId,
      transactionDigest: observation.transactionDigest,
      transactionPhase: observation.transactionPhase,
      parentChallengeId: observation.parentChallengeId,
      parentOperationId: observation.parentOperationId,
      parentApprovalSubjectDigest: observation.parentApprovalSubjectDigest,
      parentStateBindingDigest: observation.parentStateBindingDigest,
      parentParametersDigest: observation.parentParametersDigest,
      reason: observation.reason,
    }),
    stateBinding,
    candidates: Object.freeze([
      Object.freeze({
        transitionId: PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze([
          observation.action === 'cancel'
            ? 'cancel-exact-protected-task-apply'
            : 'cancel-and-abort-exact-protected-task-apply',
        ]),
        reasonRequired: true,
        proposedReason: exactText(proposedReason),
      }),
    ]),
  });
}

export function protectedTaskApplyRecoveryGrantTransitionDefinitions(
  port: ProtectedTaskApplyRecoveryGrantPort,
): readonly TransitionDefinition<ProtectedTaskApplyRecoveryParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID,
      parameterSchemaDigest:
        PROTECTED_TASK_APPLY_RECOVERY_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: PROTECTED_TASK_APPLY_RECOVERY_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      validateParameters: assertProtectedTaskApplyRecoveryParameters,
      renderTrustedChoice(parameters: ProtectedTaskApplyRecoveryParametersV1) {
        return Object.freeze({
          title:
            parameters.action === 'cancel'
              ? `Cancel protected task ${parameters.taskId} finalize recovery`
              : `Cancel protected task ${parameters.taskId} finalize and abort its session`,
          consequences: Object.freeze([
            `Restore only the projection and index owned by finalize transaction ${parameters.transactionId}.`,
            'Record the prepared protected Apply as failed by explicit cancellation; never relabel it completed.',
            parameters.action === 'cancel'
              ? `Leave session ${parameters.sessionId} active for a fresh exact finalize candidate.`
              : `Abort session ${parameters.sessionId} only after its exact finalize projection is restored.`,
          ]),
        });
      },
      observeState(parameters: ProtectedTaskApplyRecoveryParametersV1) {
        return protectedTaskApplyRecoveryStateBinding(
          assertMatchingObservation(
            port.observe(
              assertProtectedTaskApplyRecoveryParameters(parameters),
            ),
            parameters,
          ),
        );
      },
      async execute(
        context: AuthorizedTransitionContext<ProtectedTaskApplyRecoveryParametersV1>,
      ) {
        const parameters = assertProtectedTaskApplyRecoveryParameters(
          context.parameters,
        );
        context.assertLifecycleOwned();
        const before = assertMatchingObservation(
          port.observe(parameters),
          parameters,
        );
        if (before.phase === 'in-progress') {
          if (
            protectedTaskApplyRecoveryStateBinding(before).digest !==
            parameters.stateBindingDigest
          ) {
            throw grantTransitionPreconditionChanged(
              'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
              'The exact protected finalize transaction changed before recovery.',
            );
          }
          context.assertLifecycleOwned();
          port.recover(
            { ...context, parameters },
            recoveryAuthorization(context, parameters),
          );
        } else if (
          before.phase === 'cancellation-in-progress' ||
          before.phase === 'cancellation-completed'
        ) {
          if (!context.recovered) {
            throw grantTransitionPreconditionChanged(
              'PROTECTED_TASK_APPLY_RECOVERY_ALREADY_STARTED',
              'Protected task Apply recovery started before this Grant executed.',
            );
          }
          context.assertLifecycleOwned();
          port.recover(
            { ...context, parameters },
            recoveryAuthorization(context, parameters),
          );
        } else if (!context.recovered) {
          throw grantTransitionPreconditionChanged(
            'PROTECTED_TASK_APPLY_RECOVERY_ALREADY_APPLIED',
            'Protected task Apply recovery was already applied before this Grant executed.',
          );
        }
        context.assertLifecycleOwned();
        const after = assertMatchingObservation(
          port.observe(parameters),
          parameters,
        );
        const expectedPhase =
          parameters.action === 'cancel' ? 'cancelled' : 'aborted';
        if (
          after.phase !== expectedPhase ||
          after.cancellationRecordDigest === null
        ) {
          throw workflowError(
            'PROTECTED_TASK_APPLY_RECOVERY_RESULT_INVALID',
            'Protected task Apply recovery did not publish its exact terminal facts.',
            ExitCode.verification,
          );
        }
        return Object.freeze({
          outcome: 'completed' as const,
          details: Object.freeze({
            schemaVersion: 1,
            kind: 'protected-task-apply-recovery-completed.v1',
            action: parameters.action,
            sessionId: parameters.sessionId,
            transactionId: parameters.transactionId,
            cancellationRecordDigest: after.cancellationRecordDigest,
            parentChallengeId: parameters.parentChallengeId,
          }),
        });
      },
    }),
  ]);
}

export function protectedTaskApplyRecoveryStateBinding(
  value: ProtectedTaskApplyRecoveryObservationV1,
): StateBinding {
  const observation = assertProtectedTaskApplyRecoveryObservation(value);
  return Object.freeze({
    kind: 'protected-task-apply-recovery-state.v1',
    digest: grantSha256(canonicalJson(observation)),
  });
}

export function protectedTaskApplyRecoveryGrantRequired(
  input: Readonly<{
    action: ProtectedTaskApplyRecoveryAction;
    changeId: string;
    taskId: string;
    sessionId: string;
    transactionId: string;
    transactionDigest: string;
    transactionPhase: string;
    protectedApply: Readonly<{
      challengeId: string;
      operationId: string;
      approvalSubjectDigest: `sha256:${string}`;
      stateBindingDigest: `sha256:${string}`;
      parametersDigest: `sha256:${string}`;
    }>;
    reason: string;
  }>,
) {
  const details = assertProtectedTaskApplyRecoveryGrantRequiredDetails({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-grant-required.v1',
    action: input.action,
    changeId: input.changeId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    transactionId: input.transactionId,
    transactionDigest: input.transactionDigest,
    transactionPhase: input.transactionPhase,
    parentChallengeId: input.protectedApply.challengeId,
    parentOperationId: input.protectedApply.operationId,
    parentApprovalSubjectDigest: input.protectedApply.approvalSubjectDigest,
    parentStateBindingDigest: input.protectedApply.stateBindingDigest,
    parentParametersDigest: input.protectedApply.parametersDigest,
    reason: input.reason,
  });
  return workflowError(
    'PROTECTED_TASK_APPLY_RECOVERY_GRANT_REQUIRED',
    `Protected task Apply ${input.action} requires an exact recovery Grant.`,
    ExitCode.staleState,
    { details },
  );
}

export function assertProtectedTaskApplyRecoveryGrantRequiredDetails(
  value: unknown,
): ProtectedTaskApplyRecoveryGrantRequiredDetailsV1 {
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
      'reason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-recovery-grant-required.v1' ||
    !['cancel', 'cancel-and-abort'].includes(String(value.action)) ||
    !['checks-running', 'checked'].includes(String(value.transactionPhase)) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.transactionId !== 'string' ||
    !DIGEST.test(value.transactionId) ||
    typeof value.transactionDigest !== 'string' ||
    !DIGEST.test(value.transactionDigest) ||
    typeof value.parentChallengeId !== 'string' ||
    !GRANT_UUID_V4.test(value.parentChallengeId) ||
    typeof value.parentOperationId !== 'string' ||
    !GRANT_UUID_V4.test(value.parentOperationId) ||
    typeof value.parentApprovalSubjectDigest !== 'string' ||
    !SHA256.test(value.parentApprovalSubjectDigest) ||
    typeof value.parentStateBindingDigest !== 'string' ||
    !SHA256.test(value.parentStateBindingDigest) ||
    typeof value.parentParametersDigest !== 'string' ||
    !SHA256.test(value.parentParametersDigest)
  ) {
    throw recoveryDetailsInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-grant-required.v1',
    action: value.action as ProtectedTaskApplyRecoveryAction,
    changeId: exactText(value.changeId),
    taskId: exactText(value.taskId),
    sessionId: exactText(value.sessionId),
    transactionId: exactText(value.transactionId),
    transactionDigest: value.transactionDigest,
    transactionPhase: value.transactionPhase as 'checks-running' | 'checked',
    parentChallengeId: exactText(value.parentChallengeId),
    parentOperationId: exactText(value.parentOperationId),
    parentApprovalSubjectDigest:
      value.parentApprovalSubjectDigest as `sha256:${string}`,
    parentStateBindingDigest:
      value.parentStateBindingDigest as `sha256:${string}`,
    parentParametersDigest: value.parentParametersDigest as `sha256:${string}`,
    reason: exactText(value.reason),
  });
}

export function assertProtectedTaskApplyRecoveryParameters(
  value: unknown,
): ProtectedTaskApplyRecoveryParametersV1 {
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
      'reason',
      'stateBindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-recovery.v1'
  ) {
    throw recoveryParametersInvalid();
  }
  const details = assertProtectedTaskApplyRecoveryGrantRequiredDetails({
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
  if (
    typeof value.repositoryId !== 'string' ||
    typeof value.stateBindingDigest !== 'string' ||
    !SHA256.test(value.stateBindingDigest)
  ) {
    throw recoveryParametersInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery.v1',
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
    reason: details.reason,
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
  });
}

export function assertProtectedTaskApplyRecoveryAuthorization(
  value: unknown,
): ProtectedTaskApplyRecoveryAuthorizationBinding {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'transitionId',
      'challengeId',
      'operationId',
      'approvalSubjectDigest',
      'stateBindingDigest',
      'parametersDigest',
      'parentChallengeId',
      'parentOperationId',
      'parentApprovalSubjectDigest',
      'parentStateBindingDigest',
      'parentParametersDigest',
      'action',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-recovery-authorization.v1' ||
    value.transitionId !== PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID ||
    typeof value.challengeId !== 'string' ||
    !GRANT_UUID_V4.test(value.challengeId) ||
    typeof value.operationId !== 'string' ||
    !GRANT_UUID_V4.test(value.operationId) ||
    typeof value.parentChallengeId !== 'string' ||
    !GRANT_UUID_V4.test(value.parentChallengeId) ||
    typeof value.parentOperationId !== 'string' ||
    !GRANT_UUID_V4.test(value.parentOperationId) ||
    typeof value.parentApprovalSubjectDigest !== 'string' ||
    !SHA256.test(value.parentApprovalSubjectDigest) ||
    typeof value.parentStateBindingDigest !== 'string' ||
    !SHA256.test(value.parentStateBindingDigest) ||
    typeof value.parentParametersDigest !== 'string' ||
    !SHA256.test(value.parentParametersDigest) ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !SHA256.test(value.approvalSubjectDigest) ||
    typeof value.stateBindingDigest !== 'string' ||
    !SHA256.test(value.stateBindingDigest) ||
    typeof value.parametersDigest !== 'string' ||
    !SHA256.test(value.parametersDigest) ||
    !['cancel', 'cancel-and-abort'].includes(String(value.action))
  ) {
    throw recoveryAuthorizationInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-authorization.v1',
    transitionId: PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID,
    challengeId: value.challengeId,
    operationId: value.operationId,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
    parametersDigest: value.parametersDigest as `sha256:${string}`,
    parentChallengeId: value.parentChallengeId,
    parentOperationId: value.parentOperationId,
    parentApprovalSubjectDigest:
      value.parentApprovalSubjectDigest as `sha256:${string}`,
    parentStateBindingDigest:
      value.parentStateBindingDigest as `sha256:${string}`,
    parentParametersDigest: value.parentParametersDigest as `sha256:${string}`,
    action: value.action as ProtectedTaskApplyRecoveryAction,
  });
}

function assertProtectedTaskApplyRecoveryObservation(
  value: unknown,
): ProtectedTaskApplyRecoveryObservationV1 {
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
      'reason',
      'cancellationRecordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-recovery-observation.v1' ||
    ![
      'in-progress',
      'cancellation-in-progress',
      'cancellation-completed',
      'cancelled',
      'aborted',
    ].includes(String(value.phase)) ||
    (value.cancellationRecordDigest !== null &&
      (typeof value.cancellationRecordDigest !== 'string' ||
        !DIGEST.test(value.cancellationRecordDigest)))
  ) {
    throw recoveryObservationInvalid();
  }
  const details = assertProtectedTaskApplyRecoveryGrantRequiredDetails({
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
  const phase = value.phase as ProtectedTaskApplyRecoveryObservationV1['phase'];
  const cancellationRecordDigest = value.cancellationRecordDigest as
    string | null;
  if (
    (phase === 'in-progress' && cancellationRecordDigest !== null) ||
    (phase !== 'in-progress' && cancellationRecordDigest === null) ||
    (details.action === 'cancel' && phase === 'aborted') ||
    (details.action === 'cancel' && phase === 'cancellation-completed') ||
    (details.action === 'cancel-and-abort' && phase === 'cancelled') ||
    typeof value.repositoryId !== 'string'
  ) {
    throw recoveryObservationInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-observation.v1',
    phase,
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
    reason: details.reason,
    cancellationRecordDigest,
  });
}

function parametersFromObservation(
  observation: ProtectedTaskApplyRecoveryObservationV1,
  stateBindingDigest: `sha256:${string}`,
): ProtectedTaskApplyRecoveryParametersV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery.v1',
    repositoryId: observation.repositoryId,
    action: observation.action,
    changeId: observation.changeId,
    taskId: observation.taskId,
    sessionId: observation.sessionId,
    transactionId: observation.transactionId,
    transactionDigest: observation.transactionDigest,
    transactionPhase: observation.transactionPhase,
    parentChallengeId: observation.parentChallengeId,
    parentOperationId: observation.parentOperationId,
    parentApprovalSubjectDigest: observation.parentApprovalSubjectDigest,
    parentStateBindingDigest: observation.parentStateBindingDigest,
    parentParametersDigest: observation.parentParametersDigest,
    reason: observation.reason,
    stateBindingDigest,
  });
}

function assertMatchingObservation(
  value: ProtectedTaskApplyRecoveryObservationV1,
  parameters: ProtectedTaskApplyRecoveryParametersV1,
): ProtectedTaskApplyRecoveryObservationV1 {
  const observation = assertProtectedTaskApplyRecoveryObservation(value);
  const identity = recoveryIdentity(observation);
  const expected = recoveryIdentity(parameters);
  if (canonicalJson(identity) !== canonicalJson(expected)) {
    throw grantTransitionPreconditionChanged(
      'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
      'Protected task Apply recovery identity changed before execution.',
    );
  }
  return observation;
}

function recoveryIdentity(
  value:
    | ProtectedTaskApplyRecoveryObservationV1
    | ProtectedTaskApplyRecoveryParametersV1,
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
    reason: value.reason,
  });
}

function recoveryAuthorization(
  context: AuthorizedTransitionContext<ProtectedTaskApplyRecoveryParametersV1>,
  parameters: ProtectedTaskApplyRecoveryParametersV1,
): ProtectedTaskApplyRecoveryAuthorizationBinding {
  return assertProtectedTaskApplyRecoveryAuthorization({
    schemaVersion: 1,
    kind: 'protected-task-apply-recovery-authorization.v1',
    transitionId: PROTECTED_TASK_APPLY_RECOVERY_TRANSITION_ID,
    challengeId: context.challengeId,
    operationId: context.operationId,
    approvalSubjectDigest: context.approvalSubjectDigest,
    stateBindingDigest: parameters.stateBindingDigest,
    parametersDigest: grantSha256(canonicalJson(parameters)),
    parentChallengeId: parameters.parentChallengeId,
    parentOperationId: parameters.parentOperationId,
    parentApprovalSubjectDigest: parameters.parentApprovalSubjectDigest,
    parentStateBindingDigest: parameters.parentStateBindingDigest,
    parentParametersDigest: parameters.parentParametersDigest,
    action: parameters.action,
  });
}

function exactText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 1024 ||
    /\p{Cc}/u.test(value)
  ) {
    throw recoveryDetailsInvalid();
  }
  return value;
}

function recoveryParametersInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_RECOVERY_PARAMETERS_INVALID',
    'Protected task Apply recovery parameters are invalid.',
    ExitCode.guard,
  );
}

function recoveryObservationInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_RECOVERY_OBSERVATION_INVALID',
    'Protected task Apply recovery observation is invalid.',
    ExitCode.guard,
  );
}

function recoveryAuthorizationInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_RECOVERY_AUTHORIZATION_INVALID',
    'Protected task Apply recovery authorization is invalid.',
    ExitCode.guard,
  );
}

function recoveryDetailsInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_RECOVERY_DETAILS_INVALID',
    'Protected task Apply recovery details are invalid.',
    ExitCode.guard,
  );
}
