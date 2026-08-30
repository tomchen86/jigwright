import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from './task-mandate.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import { grantHasExactKeys, grantSha256 } from './grant-primitives.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
  type TransitionObservationContext,
} from './grant-transition-registry.ts';

export const PROTECTED_TASK_APPLY_TRANSITION_ID =
  'task.protected-apply.finalize.v1' as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type ProtectedTaskApplyFailureDetailsV1 = Readonly<{
  changeId: string;
  taskId: string;
  mandateTaskId: string;
  changedPaths: readonly string[];
  roles: readonly string[];
  matchedPatterns: readonly string[];
  unclassifiedScope: boolean;
}>;

export type ProtectedTaskApplyObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-observation.v1';
  phase: 'pending' | 'in-progress' | 'cancelled' | 'completed';
  repositoryId: string;
  changeId: string;
  sessionId: string;
  taskId: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding;
  changedPaths: readonly string[];
  commitMessage: string;
  fullGate: boolean;
  stateFingerprint: `sha256:${string}`;
  transactionId: string | null;
  commitHash: string | null;
  authorization: ProtectedTaskApplyFailureDetailsV1 | null;
}>;

export type ProtectedTaskApplyFinalizationParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-finalization.v1';
  repositoryId: string;
  changeId: string;
  sessionId: string;
  taskId: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding;
  changedPaths: readonly string[];
  commitMessage: string;
  fullGate?: true;
  stateBindingDigest: `sha256:${string}`;
}>;

export type ProtectedTaskApplyGrantPort = Readonly<{
  observe(
    parameters: ProtectedTaskApplyFinalizationParametersV1,
    parentChallengeId?: string,
  ): ProtectedTaskApplyObservationV1;
  finalize(
    context: AuthorizedTransitionContext<ProtectedTaskApplyFinalizationParametersV1>,
  ): Readonly<{
    sessionId: string;
    transactionId: string;
    commitHash: string;
  }>;
}>;

export const PROTECTED_TASK_APPLY_PARAMETER_SCHEMA_DIGEST = grantSha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'protected-task-apply-finalization.schema.v1',
    required: [
      'repositoryId',
      'changeId',
      'sessionId',
      'taskId',
      'branch',
      'baseline',
      'mandateBinding',
      'changedPaths',
      'commitMessage',
      'stateBindingDigest',
    ],
    optional: ['fullGate'],
  }),
);

export const PROTECTED_TASK_APPLY_CONSEQUENCE_DIGEST = grantSha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'protected-task-apply-finalization-consequence.v1',
    effect: 'finalize-one-exact-protected-task-diff',
    ordinaryChecksBypass: false,
    taskDiffReviewBypass: false,
    taskMandateBypass: false,
    staleStateBypass: false,
  }),
);

export function createProtectedTaskApplyGrantRequest(
  candidate: ProtectedTaskApplyObservationV1,
  failure: ProtectedTaskApplyFailureDetailsV1,
  proposedReason: string,
): GrantRequestInput {
  const observation = assertProtectedTaskApplyObservation(candidate);
  const details = assertProtectedTaskApplyFailureDetails(failure);
  if (
    observation.phase !== 'pending' ||
    observation.transactionId !== null ||
    observation.commitHash !== null ||
    observation.authorization === null ||
    canonicalJson(observation.authorization) !== canonicalJson(details) ||
    details.changeId !== observation.changeId ||
    details.taskId !== observation.taskId ||
    details.mandateTaskId !== observation.mandateBinding.mandateTaskId ||
    canonicalJson(details.changedPaths) !==
      canonicalJson(observation.changedPaths)
  ) {
    throw workflowError(
      'PROTECTED_TASK_APPLY_STATE_CHANGED',
      'The protected task no longer matches the exact Apply refusal.',
      ExitCode.staleState,
    );
  }
  const stateBinding = protectedTaskApplyStateBinding(observation);
  const parameters = parametersFromObservation(
    observation,
    stateBinding.digest,
  );
  return Object.freeze({
    sourceModuleId: 'task-finalization',
    failureCode: 'protected-task-apply-required',
    facts: Object.freeze({
      repositoryId: observation.repositoryId,
      changeId: observation.changeId,
      sessionId: observation.sessionId,
      taskId: observation.taskId,
      mandateBinding: observation.mandateBinding,
      changedPaths: observation.changedPaths,
      roles: details.roles,
      matchedPatterns: details.matchedPatterns,
      unclassifiedScope: details.unclassifiedScope,
    }),
    stateBinding,
    candidates: Object.freeze([
      Object.freeze({
        transitionId: PROTECTED_TASK_APPLY_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze([
          'approve-exact-protected-task-apply',
        ]),
        reasonRequired: true,
        proposedReason: exactText(proposedReason, 'proposed reason'),
      }),
    ]),
  });
}

export function protectedTaskApplyGrantTransitionDefinitions(
  port: ProtectedTaskApplyGrantPort,
): readonly TransitionDefinition<ProtectedTaskApplyFinalizationParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: PROTECTED_TASK_APPLY_TRANSITION_ID,
      parameterSchemaDigest: PROTECTED_TASK_APPLY_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: PROTECTED_TASK_APPLY_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      validateParameters: assertProtectedTaskApplyParameters,
      renderTrustedChoice(
        parameters: ProtectedTaskApplyFinalizationParametersV1,
      ) {
        return Object.freeze({
          title: `Finalize protected task ${parameters.taskId} for ${parameters.changeId}`,
          consequences: Object.freeze([
            `Apply only the exact ${parameters.changedPaths.length}-path task diff bound to session ${parameters.sessionId}.`,
            'Run the ordinary checked finalize, TaskDiffReview, projection, staging, and managed-commit transaction without bypass.',
            'Any change to the Task Mandate, branch, baseline, worktree, changed paths, or commit subject requires a fresh Grant.',
          ]),
        });
      },
      observeState(
        parameters: ProtectedTaskApplyFinalizationParametersV1,
        observationContext?: TransitionObservationContext,
      ) {
        const exact = assertProtectedTaskApplyParameters(parameters);
        return protectedTaskApplyStateBinding(
          assertMatchingObservation(
            port.observe(exact, observationContext?.challengeId),
            exact,
          ),
        );
      },
      async execute(
        context: AuthorizedTransitionContext<ProtectedTaskApplyFinalizationParametersV1>,
      ) {
        const parameters = assertProtectedTaskApplyParameters(
          context.parameters,
        );
        context.assertLifecycleOwned();
        const before = assertMatchingObservation(
          port.observe(parameters, context.challengeId),
          parameters,
        );
        if (before.phase === 'cancelled') {
          if (!context.recovered || before.transactionId === null) {
            throw grantTransitionPreconditionChanged(
              'PROTECTED_TASK_APPLY_RECOVERY_UNEXPECTED',
              'Protected task Apply was cancelled before this Grant execution.',
            );
          }
          return cancelledOutcome(before);
        }
        const beforeBinding = protectedTaskApplyStateBinding(before);
        if (
          before.phase === 'pending' &&
          beforeBinding.digest !== parameters.stateBindingDigest
        ) {
          throw grantTransitionPreconditionChanged(
            'PROTECTED_TASK_APPLY_STATE_CHANGED',
            'The exact protected task candidate changed before Apply execution.',
          );
        }
        if (before.phase === 'in-progress' && !context.recovered) {
          throw grantTransitionPreconditionChanged(
            'PROTECTED_TASK_APPLY_TRANSACTION_UNEXPECTED',
            'A finalize transaction appeared before the protected Apply decision executed.',
          );
        }
        if (before.phase === 'completed') {
          if (!context.recovered || before.commitHash === null) {
            throw grantTransitionPreconditionChanged(
              'PROTECTED_TASK_APPLY_ALREADY_COMPLETED',
              'The protected task was already committed before this Grant execution.',
            );
          }
          return completedOutcome(before);
        }
        context.assertLifecycleOwned();
        const result = await port.finalize({ ...context, parameters });
        context.assertLifecycleOwned();
        const after = assertMatchingObservation(
          port.observe(parameters, context.challengeId),
          parameters,
        );
        if (
          after.phase !== 'completed' ||
          after.commitHash === null ||
          after.commitHash !== result.commitHash ||
          after.transactionId !== result.transactionId ||
          after.sessionId !== result.sessionId
        ) {
          throw workflowError(
            'PROTECTED_TASK_APPLY_RESULT_INVALID',
            'The exact protected task finalization did not publish its committed poststate.',
            ExitCode.verification,
          );
        }
        return completedOutcome(after);
      },
    }),
  ]);
}

export function protectedTaskApplyStateBinding(
  value: ProtectedTaskApplyObservationV1,
): StateBinding {
  const observation = assertProtectedTaskApplyObservation(value);
  return Object.freeze({
    kind: 'protected-task-apply-state.v1',
    digest: grantSha256(
      canonicalJson({
        schemaVersion: observation.schemaVersion,
        kind: observation.kind,
        phase: observation.phase,
        repositoryId: observation.repositoryId,
        changeId: observation.changeId,
        sessionId: observation.sessionId,
        taskId: observation.taskId,
        branch: observation.branch,
        baseline: observation.baseline,
        mandateBinding: observation.mandateBinding,
        changedPaths: observation.changedPaths,
        commitMessage: observation.commitMessage,
        fullGate: observation.fullGate,
        stateFingerprint: observation.stateFingerprint,
        transactionId: observation.transactionId,
        commitHash: observation.commitHash,
      }),
    ),
  });
}

export function assertProtectedTaskApplyParameters(
  value: unknown,
): ProtectedTaskApplyFinalizationParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(
      value,
      value.fullGate === true
        ? [
            'schemaVersion',
            'kind',
            'repositoryId',
            'changeId',
            'sessionId',
            'taskId',
            'branch',
            'baseline',
            'mandateBinding',
            'changedPaths',
            'commitMessage',
            'fullGate',
            'stateBindingDigest',
          ]
        : [
            'schemaVersion',
            'kind',
            'repositoryId',
            'changeId',
            'sessionId',
            'taskId',
            'branch',
            'baseline',
            'mandateBinding',
            'changedPaths',
            'commitMessage',
            'stateBindingDigest',
          ],
    ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-finalization.v1' ||
    typeof value.repositoryId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.sessionId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.commitMessage !== 'string' ||
    typeof value.stateBindingDigest !== 'string' ||
    !SHA256.test(value.stateBindingDigest)
  ) {
    throw parametersInvalid();
  }
  const baseline = exactBaseline(value.baseline);
  const mandateBinding = exactMandateBinding(value.mandateBinding);
  if (mandateBinding.changeId !== value.changeId) throw parametersInvalid();
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-finalization.v1',
    repositoryId: exactText(value.repositoryId, 'repository ID'),
    changeId: value.changeId,
    sessionId: exactText(value.sessionId, 'session ID'),
    taskId: exactText(value.taskId, 'task ID'),
    branch: exactText(value.branch, 'branch'),
    baseline,
    mandateBinding,
    changedPaths: exactPaths(value.changedPaths),
    commitMessage: exactText(value.commitMessage, 'commit message'),
    ...(value.fullGate === true ? { fullGate: true as const } : {}),
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
  });
}

function assertProtectedTaskApplyObservation(
  value: unknown,
): ProtectedTaskApplyObservationV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'phase',
      'repositoryId',
      'changeId',
      'sessionId',
      'taskId',
      'branch',
      'baseline',
      'mandateBinding',
      'changedPaths',
      'commitMessage',
      'fullGate',
      'stateFingerprint',
      'transactionId',
      'commitHash',
      'authorization',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-observation.v1' ||
    !['pending', 'in-progress', 'cancelled', 'completed'].includes(
      String(value.phase),
    ) ||
    typeof value.repositoryId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.sessionId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.commitMessage !== 'string' ||
    typeof value.fullGate !== 'boolean' ||
    typeof value.stateFingerprint !== 'string' ||
    !SHA256.test(value.stateFingerprint) ||
    (value.transactionId !== null && typeof value.transactionId !== 'string') ||
    (value.commitHash !== null &&
      (typeof value.commitHash !== 'string' ||
        !COMMIT_OID.test(value.commitHash)))
  ) {
    throw observationInvalid();
  }
  const authorization =
    value.authorization === null
      ? null
      : assertProtectedTaskApplyFailureDetails(value.authorization);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-observation.v1',
    phase: value.phase as ProtectedTaskApplyObservationV1['phase'],
    repositoryId: exactText(value.repositoryId, 'repository ID'),
    changeId: value.changeId,
    sessionId: exactText(value.sessionId, 'session ID'),
    taskId: exactText(value.taskId, 'task ID'),
    branch: exactText(value.branch, 'branch'),
    baseline: exactBaseline(value.baseline),
    mandateBinding: exactMandateBinding(value.mandateBinding),
    changedPaths: exactPaths(value.changedPaths),
    commitMessage: exactText(value.commitMessage, 'commit message'),
    fullGate: value.fullGate,
    stateFingerprint: value.stateFingerprint as `sha256:${string}`,
    transactionId:
      value.transactionId === null
        ? null
        : exactText(value.transactionId, 'transaction ID'),
    commitHash: value.commitHash as string | null,
    authorization,
  });
}

function assertProtectedTaskApplyFailureDetails(
  value: unknown,
): ProtectedTaskApplyFailureDetailsV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'changeId',
      'taskId',
      'mandateTaskId',
      'changedPaths',
      'roles',
      'matchedPatterns',
      'unclassifiedScope',
    ]) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    typeof value.mandateTaskId !== 'string' ||
    typeof value.unclassifiedScope !== 'boolean'
  ) {
    throw observationInvalid();
  }
  return Object.freeze({
    changeId: value.changeId,
    taskId: exactText(value.taskId, 'task ID'),
    mandateTaskId: exactText(value.mandateTaskId, 'mandate task ID'),
    changedPaths: exactPaths(value.changedPaths),
    roles: exactStringArray(value.roles, 'roles'),
    matchedPatterns: exactStringArray(value.matchedPatterns, 'patterns'),
    unclassifiedScope: value.unclassifiedScope,
  });
}

function parametersFromObservation(
  observation: ProtectedTaskApplyObservationV1,
  stateBindingDigest: `sha256:${string}`,
): ProtectedTaskApplyFinalizationParametersV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-finalization.v1',
    repositoryId: observation.repositoryId,
    changeId: observation.changeId,
    sessionId: observation.sessionId,
    taskId: observation.taskId,
    branch: observation.branch,
    baseline: observation.baseline,
    mandateBinding: observation.mandateBinding,
    changedPaths: observation.changedPaths,
    commitMessage: observation.commitMessage,
    ...(observation.fullGate ? { fullGate: true as const } : {}),
    stateBindingDigest,
  });
}

function assertMatchingObservation(
  value: ProtectedTaskApplyObservationV1,
  parameters: ProtectedTaskApplyFinalizationParametersV1,
): ProtectedTaskApplyObservationV1 {
  const observation = assertProtectedTaskApplyObservation(value);
  const identity = {
    repositoryId: observation.repositoryId,
    changeId: observation.changeId,
    sessionId: observation.sessionId,
    taskId: observation.taskId,
    branch: observation.branch,
    baseline: observation.baseline,
    mandateBinding: observation.mandateBinding,
    changedPaths: observation.changedPaths,
    commitMessage: observation.commitMessage,
    fullGate: observation.fullGate,
  };
  const expected = {
    repositoryId: parameters.repositoryId,
    changeId: parameters.changeId,
    sessionId: parameters.sessionId,
    taskId: parameters.taskId,
    branch: parameters.branch,
    baseline: parameters.baseline,
    mandateBinding: parameters.mandateBinding,
    changedPaths: parameters.changedPaths,
    commitMessage: parameters.commitMessage,
    fullGate: parameters.fullGate === true,
  };
  if (canonicalJson(identity) !== canonicalJson(expected)) {
    throw grantTransitionPreconditionChanged(
      'PROTECTED_TASK_APPLY_STATE_CHANGED',
      'The protected task identity changed before exact Apply execution.',
    );
  }
  return observation;
}

function completedOutcome(observation: ProtectedTaskApplyObservationV1) {
  return Object.freeze({
    outcome: 'completed' as const,
    details: Object.freeze({
      schemaVersion: 1,
      kind: 'protected-task-apply-finalized.v1',
      sessionId: observation.sessionId,
      transactionId: observation.transactionId,
      commitHash: observation.commitHash,
    }),
  });
}

function cancelledOutcome(observation: ProtectedTaskApplyObservationV1) {
  return Object.freeze({
    outcome: 'failed' as const,
    details: Object.freeze({
      schemaVersion: 1,
      kind: 'protected-task-apply-cancelled.v1',
      sessionId: observation.sessionId,
      transactionId: observation.transactionId,
      cancellationStateFingerprint: observation.stateFingerprint,
      transitionCompleted: false,
    }),
  });
}

function exactBaseline(
  value: unknown,
): Readonly<{ head: string; tree: string }> {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, ['head', 'tree']) ||
    typeof value.head !== 'string' ||
    !COMMIT_OID.test(value.head) ||
    typeof value.tree !== 'string' ||
    !COMMIT_OID.test(value.tree)
  ) {
    throw parametersInvalid();
  }
  return Object.freeze({ head: value.head, tree: value.tree });
}

function exactMandateBinding(value: unknown): TaskMandateBinding {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    typeof value.mandateId !== 'string' ||
    typeof value.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string'
  ) {
    throw parametersInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    mandateTaskId: exactText(value.mandateTaskId, 'mandate task ID'),
    mandateId: exactText(value.mandateId, 'mandate ID'),
    mandateDigest: value.mandateDigest,
    changeId: value.changeId,
    externalAuditRoot: exactText(
      value.externalAuditRoot,
      'external audit root',
    ),
  });
}

function exactPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw observationInvalid();
  const paths = value.map((entry) => exactText(entry, 'changed path'));
  if (
    paths.some(
      (entry) =>
        entry.startsWith('/') ||
        entry.includes('\\') ||
        entry.split('/').some((segment) => segment === '' || segment === '..'),
    ) ||
    new Set(paths).size !== paths.length ||
    canonicalJson(paths) !== canonicalJson([...paths].sort())
  ) {
    throw observationInvalid();
  }
  return Object.freeze(paths);
}

function exactStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw observationInvalid();
  const entries = value.map((entry) => exactText(entry, label));
  if (new Set(entries).size !== entries.length) throw observationInvalid();
  return Object.freeze(entries);
}

function exactText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 4096 ||
    /\p{Cc}/u.test(value)
  ) {
    throw workflowError(
      'PROTECTED_TASK_APPLY_VALUE_INVALID',
      `Protected task Apply ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function parametersInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_PARAMETERS_INVALID',
    'Protected task Apply transition parameters are invalid.',
    ExitCode.guard,
  );
}

function observationInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_OBSERVATION_INVALID',
    'Protected task Apply observation is invalid.',
    ExitCode.guard,
  );
}
