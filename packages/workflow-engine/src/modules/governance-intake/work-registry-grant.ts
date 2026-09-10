/**
 * Creates and validates protected Work Registry review and promotion Grant
 * transitions.
 *
 * Invariants:
 * - Review and promotion Grants must bind the current Work Item digest.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from '../authority/grant-core.ts';
import {
  freezeGrantCanonical,
  grantHasExactKeys,
  grantSha256,
} from '../authority/grant-primitives.ts';
import type {
  TransitionDefinition,
  TransitionOutcome,
} from '../authority/grant-transition-registry.ts';
import { grantTransitionPreconditionChanged } from '../authority/grant-transition-registry.ts';
import {
  applyWorkItemReview,
  hasExactWorkItemPromotionReceipt,
  observeWorkItemPromotionPreparationBinding,
  prepareWorkItemPromotionFromBinding,
  promoteWorkItem,
  showWorkItem,
  workItemDigest,
  workItemPromotionPreparationMatches,
  type WorkItemPromotionGrantBindingV1,
  type WorkItemPromotionPreparationBindingV1,
  type WorkItemPromotionSurveyBindingV1,
  type WorkItemPromotionSurveyV1,
  type WorkItemPromotionTestHooks,
  type WorkItemReviewV1,
} from './work-registry.ts';

const REVIEW_TRANSITION_ID = 'work-registry.review.v1';
const PROMOTION_TRANSITION_ID = 'work-registry.promote.v1';
const APPROVAL_REASON_CODE = 'approve-work-registry-transition';
const WORK_ITEM_ID = /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

type ReviewParametersV1 = Readonly<{
  schemaVersion: 1;
  workItemId: string;
  review: WorkItemReviewV1;
  stateBindingDigest: `sha256:${string}`;
}>;

type PromotionParametersV1 = Readonly<{
  schemaVersion: 1;
  workItemId: string;
  changeId: string;
  expectedDigest: `sha256:${string}`;
  preparationBinding: WorkItemPromotionPreparationBindingV1;
  stateBindingDigest: `sha256:${string}`;
}>;

type WorkRegistryGrantFactsV1 = Readonly<{
  schemaVersion: 1;
  workflowKind: 'work-registry';
  action: 'review' | 'promote';
  workItemId: string;
  changeId: string | null;
}>;

export function createWorkRegistryReviewGrantRequest(
  input: Readonly<{
    repositoryRoot: string;
    workItemId: string;
    review: WorkItemReviewV1;
    proposedReason: string;
  }>,
): GrantRequestInput<WorkRegistryGrantFactsV1> {
  const workItemId = exactWorkItemId(input.workItemId);
  const review = assertReview(input.review);
  const stateBinding = observeWorkItem(input.repositoryRoot, workItemId);
  if (review.expectedDigest !== stateBinding.digest) {
    throw grantInvalid(
      'WORK_REGISTRY_GRANT_STALE',
      'Protected Work Registry review no longer matches the current item.',
      ExitCode.conflict,
    );
  }
  return freezeGrantCanonical({
    sourceModuleId: 'work-registry',
    failureCode: 'work-registry.protected-transition',
    facts: {
      schemaVersion: 1,
      workflowKind: 'work-registry',
      action: 'review',
      workItemId,
      changeId: null,
    },
    stateBinding,
    candidates: [
      {
        transitionId: REVIEW_TRANSITION_ID,
        parameters: {
          schemaVersion: 1,
          workItemId,
          review,
          stateBindingDigest: stateBinding.digest,
        },
        allowedReasonCodes: [APPROVAL_REASON_CODE],
        reasonRequired: true,
        proposedReason: boundedReason(input.proposedReason),
      },
    ],
  });
}

export function createWorkRegistryPromotionGrantRequest(
  input: Readonly<{
    repositoryRoot: string;
    workItemId: string;
    changeId: string;
    expectedDigest: string;
    proposedReason: string;
  }>,
): GrantRequestInput<WorkRegistryGrantFactsV1> {
  const workItemId = exactWorkItemId(input.workItemId);
  const changeId = exactChangeId(input.changeId);
  const expectedDigest = exactDigest(input.expectedDigest);
  const itemBinding = observeWorkItem(input.repositoryRoot, workItemId);
  if (expectedDigest !== itemBinding.digest) {
    throw grantInvalid(
      'WORK_REGISTRY_GRANT_STALE',
      'Protected Work Registry promotion no longer matches the current item.',
      ExitCode.conflict,
    );
  }
  const preparationBinding = observeWorkItemPromotionPreparationBinding(
    input.repositoryRoot,
    workItemId,
    changeId,
  );
  const stateBinding = promotionStateBinding(
    expectedDigest,
    preparationBinding,
  );
  return freezeGrantCanonical({
    sourceModuleId: 'work-registry',
    failureCode: 'work-registry.protected-transition',
    facts: {
      schemaVersion: 1,
      workflowKind: 'work-registry',
      action: 'promote',
      workItemId,
      changeId,
    },
    stateBinding,
    candidates: [
      {
        transitionId: PROMOTION_TRANSITION_ID,
        parameters: {
          schemaVersion: 1,
          workItemId,
          changeId,
          expectedDigest,
          preparationBinding,
          stateBindingDigest: stateBinding.digest,
        },
        allowedReasonCodes: [APPROVAL_REASON_CODE],
        reasonRequired: true,
        proposedReason: boundedReason(input.proposedReason),
      },
    ],
  });
}

export function workRegistryGrantTransitionDefinitions(
  repositoryRoot: string,
  now: () => string = () => new Date().toISOString(),
  testHooks: WorkItemPromotionTestHooks = {},
): readonly [
  TransitionDefinition<ReviewParametersV1>,
  TransitionDefinition<PromotionParametersV1>,
] {
  return [
    Object.freeze({
      transitionId: REVIEW_TRANSITION_ID,
      parameterSchemaDigest: grantSha256(
        canonicalJson({ schema: 'work-registry-review-parameters.v1' }),
      ),
      consequenceDigest: grantSha256(canonicalJson(renderReviewChoice())),
      resolutionKind: 'non-retry' as const,
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertReviewParameters,
      renderTrustedChoice: renderReviewChoice,
      observeState(parameters) {
        return observeWorkItem(repositoryRoot, parameters.workItemId);
      },
      async execute(context): Promise<TransitionOutcome> {
        context.assertLifecycleOwned();
        assertCurrentBinding(
          observeWorkItem(repositoryRoot, context.parameters.workItemId),
          context.parameters.stateBindingDigest,
        );
        context.assertLifecycleOwned();
        const item = applyWorkItemReview(
          repositoryRoot,
          context.parameters.workItemId,
          context.parameters.review,
          now,
        );
        return {
          outcome: 'completed',
          details: {
            action: 'review',
            workItemId: item.id,
            stage: item.stage,
            lane: item.lane,
          },
        };
      },
    }),
    Object.freeze({
      transitionId: PROMOTION_TRANSITION_ID,
      parameterSchemaDigest: grantSha256(
        canonicalJson({
          schema: 'work-registry-promotion-parameters.v1',
          required: [
            'changeId',
            'expectedDigest',
            'preparationBinding',
            'schemaVersion',
            'stateBindingDigest',
            'workItemId',
          ],
        }),
      ),
      consequenceDigest: grantSha256(canonicalJson(renderPromotionChoice())),
      resolutionKind: 'non-retry' as const,
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertPromotionParameters,
      renderTrustedChoice: renderPromotionChoice,
      observeState(parameters) {
        return observeWorkItemPromotionState(repositoryRoot, parameters);
      },
      async execute(context): Promise<TransitionOutcome> {
        const grantBinding: WorkItemPromotionGrantBindingV1 = {
          schemaVersion: 1,
          challengeId: context.challengeId,
          operationId: context.operationId,
          approvalSubjectDigest: context.approvalSubjectDigest,
          surveyBinding: promotionSurveyBinding(
            context.parameters.preparationBinding,
          ),
        };
        context.assertLifecycleOwned();
        if (
          context.recovered &&
          hasExactWorkItemPromotionReceipt(
            repositoryRoot,
            context.parameters.workItemId,
            context.parameters.changeId,
            context.parameters.expectedDigest,
            grantBinding,
          )
        ) {
          context.assertLifecycleOwned();
          return {
            outcome: 'completed',
            details: {
              action: 'promote',
              workItemId: context.parameters.workItemId,
              changeId: context.parameters.changeId,
            },
          };
        }
        const authorizedState = observeWorkItemPromotionState(
          repositoryRoot,
          context.parameters,
        );
        assertCurrentBinding(
          authorizedState,
          context.parameters.stateBindingDigest,
        );
        context.assertLifecycleOwned();
        try {
          prepareWorkItemPromotionFromBinding(
            repositoryRoot,
            context.parameters.workItemId,
            context.parameters.changeId,
            context.parameters.preparationBinding,
          );
        } catch (error) {
          if (isPromotionSurveyPreconditionError(error)) {
            throw grantTransitionPreconditionChanged(
              'WORK_REGISTRY_GRANT_STALE',
              'Work Registry promotion preparation changed after Grant approval.',
            );
          }
          throw error;
        }
        context.assertLifecycleOwned();
        let promoted: ReturnType<typeof promoteWorkItem>;
        try {
          promoted = promoteWorkItem(
            repositoryRoot,
            context.parameters.workItemId,
            context.parameters.changeId,
            now,
            context.parameters.expectedDigest,
            testHooks,
            grantBinding,
          );
        } catch (error) {
          if (isPromotionSurveyPreconditionError(error)) {
            throw grantTransitionPreconditionChanged(
              'WORK_REGISTRY_GRANT_STALE',
              'Work Registry promotion survey changed after Grant approval.',
            );
          }
          throw error;
        }
        return {
          outcome: 'completed',
          details: {
            action: 'promote',
            workItemId: promoted.item.id,
            changeId: context.parameters.changeId,
          },
        };
      },
    }),
  ];
}

function observeWorkItemPromotionState(
  repositoryRoot: string,
  parameters: PromotionParametersV1,
): StateBinding {
  const itemBinding = observeWorkItem(repositoryRoot, parameters.workItemId);
  try {
    const actual = observeWorkItemPromotionPreparationBinding(
      repositoryRoot,
      parameters.workItemId,
      parameters.changeId,
    );
    return workItemPromotionPreparationMatches(
      parameters.preparationBinding,
      actual,
    )
      ? promotionStateBinding(itemBinding.digest, parameters.preparationBinding)
      : promotionStateBinding(itemBinding.digest, actual);
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return {
      kind: 'work-registry-promotion-state.v1',
      digest: grantSha256(
        canonicalJson({
          schemaVersion: 1,
          kind: 'work-registry-promotion-state-unavailable.v1',
          itemDigest: itemBinding.digest,
          errorCode: error.code,
        }),
      ),
    };
  }
}

function promotionStateBinding(
  itemDigest: string,
  preparationBinding: WorkItemPromotionPreparationBindingV1,
): StateBinding {
  return {
    kind: 'work-registry-promotion-state.v1',
    digest: grantSha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'work-registry-promotion-state.v1',
        itemDigest: exactDigest(itemDigest),
        preparationBinding,
      }),
    ),
  };
}

function isPromotionSurveyPreconditionError(
  error: unknown,
): error is WorkflowError {
  return (
    error instanceof WorkflowError &&
    [
      'WORK_REGISTRY_GRANT_STALE',
      'WORK_REGISTRY_INVALID',
      'WORK_REGISTRY_SURVEY_REQUIRED',
    ].includes(error.code)
  );
}

function observeWorkItem(
  repositoryRoot: string,
  workItemId: string,
): StateBinding {
  return {
    kind: 'work-registry-item.v1',
    digest: workItemDigest(showWorkItem(repositoryRoot, workItemId)),
  };
}

function assertCurrentBinding(
  observed: StateBinding,
  expectedDigest: string,
): void {
  if (observed.digest !== expectedDigest) {
    throw grantTransitionPreconditionChanged(
      'WORK_REGISTRY_GRANT_STALE',
      'Work Registry state changed before the protected transition executed.',
    );
  }
}

function assertReviewParameters(value: unknown): ReviewParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'review',
      'schemaVersion',
      'stateBindingDigest',
      'workItemId',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw grantParametersInvalid();
  }
  const workItemId = exactWorkItemId(value.workItemId);
  const review = assertReview(value.review);
  const stateBindingDigest = exactDigest(value.stateBindingDigest);
  if (review.expectedDigest !== stateBindingDigest) {
    throw grantParametersInvalid();
  }
  return { schemaVersion: 1, workItemId, review, stateBindingDigest };
}

function assertPromotionParameters(value: unknown): PromotionParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'changeId',
      'expectedDigest',
      'preparationBinding',
      'schemaVersion',
      'stateBindingDigest',
      'workItemId',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw grantParametersInvalid();
  }
  const expectedDigest = exactDigest(value.expectedDigest);
  const stateBindingDigest = exactDigest(value.stateBindingDigest);
  const preparationBinding = assertPromotionPreparationBinding(
    value.preparationBinding,
  );
  if (
    promotionStateBinding(expectedDigest, preparationBinding).digest !==
    stateBindingDigest
  ) {
    throw grantParametersInvalid();
  }
  return {
    schemaVersion: 1,
    workItemId: exactWorkItemId(value.workItemId),
    changeId: exactChangeId(value.changeId),
    expectedDigest,
    preparationBinding,
    stateBindingDigest,
  };
}

function assertPromotionPreparationBinding(
  value: unknown,
): WorkItemPromotionPreparationBindingV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !grantHasExactKeys(value, [
      'changeTarget',
      'schemaVersion',
      'sourceRefsDigest',
      'surveyPreparation',
    ])
  ) {
    throw grantParametersInvalid();
  }
  const sourceRefsDigest = exactDigest(value.sourceRefsDigest);
  const changeTarget = assertPromotionChangeTarget(value.changeTarget);
  const surveyPreparation = assertPromotionSurveyPreparation(
    value.surveyPreparation,
  );
  if (
    surveyPreparation.binding.kind === 'not-required' &&
    surveyPreparation.binding.sourceRefsDigest !== sourceRefsDigest
  ) {
    throw grantParametersInvalid();
  }
  return {
    schemaVersion: 1,
    changeTarget,
    sourceRefsDigest,
    surveyPreparation,
  };
}

function assertPromotionChangeTarget(
  value: unknown,
): WorkItemPromotionPreparationBindingV1['changeTarget'] {
  if (!isRecord(value)) throw grantParametersInvalid();
  if (value.kind === 'absent-change' && grantHasExactKeys(value, ['kind'])) {
    return { kind: 'absent-change' };
  }
  if (
    value.kind === 'existing-change' &&
    grantHasExactKeys(value, [
      'directoryMode',
      'entries',
      'kind',
      'originDigest',
    ]) &&
    Number.isInteger(value.directoryMode) &&
    typeof value.directoryMode === 'number' &&
    value.directoryMode >= 0 &&
    value.directoryMode <= 0o777 &&
    Array.isArray(value.entries) &&
    (value.originDigest === null || typeof value.originDigest === 'string')
  ) {
    const entries = value.entries.map(assertPromotionChangeEntry);
    if (
      entries.some((entry, index) =>
        index === 0 ? false : entries[index - 1]!.path >= entry.path,
      )
    ) {
      throw grantParametersInvalid();
    }
    return {
      kind: 'existing-change',
      directoryMode: value.directoryMode,
      entries,
      originDigest:
        value.originDigest === null ? null : exactDigest(value.originDigest),
    };
  }
  throw grantParametersInvalid();
}

function assertPromotionChangeEntry(
  value: unknown,
): Extract<
  WorkItemPromotionPreparationBindingV1['changeTarget'],
  { kind: 'existing-change' }
>['entries'][number] {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.startsWith('/') ||
    value.path.includes('\\') ||
    /[\0\r\n]/u.test(value.path) ||
    value.path
      .split('/')
      .some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) ||
    typeof value.mode !== 'number' ||
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o777
  ) {
    throw grantParametersInvalid();
  }
  if (
    value.kind === 'directory' &&
    grantHasExactKeys(value, ['kind', 'mode', 'path'])
  ) {
    return { path: value.path, kind: 'directory', mode: value.mode };
  }
  if (
    value.kind === 'file' &&
    grantHasExactKeys(value, ['digest', 'kind', 'mode', 'path'])
  ) {
    return {
      path: value.path,
      kind: 'file',
      mode: value.mode,
      digest: exactDigest(value.digest),
    };
  }
  throw grantParametersInvalid();
}

function assertPromotionSurveyPreparation(
  value: unknown,
): WorkItemPromotionPreparationBindingV1['surveyPreparation'] {
  if (!isRecord(value)) throw grantParametersInvalid();
  if (
    value.kind === 'current-survey' &&
    grantHasExactKeys(value, ['binding', 'kind'])
  ) {
    const binding = assertPromotionSurveyBinding(value.binding);
    if (binding.kind !== 'current-survey') throw grantParametersInvalid();
    return { kind: 'current-survey', binding };
  }
  if (
    value.kind === 'not-required' &&
    grantHasExactKeys(value, ['binding', 'kind'])
  ) {
    const binding = assertPromotionSurveyBinding(value.binding);
    if (binding.kind !== 'not-required') throw grantParametersInvalid();
    return { kind: 'not-required', binding };
  }
  if (
    value.kind === 'create-current-survey' &&
    grantHasExactKeys(value, ['binding', 'kind', 'survey'])
  ) {
    const binding = assertPromotionSurveyBinding(value.binding);
    if (binding.kind !== 'current-survey') throw grantParametersInvalid();
    const survey = assertPromotionSurvey(value.survey);
    if (grantSha256(`${canonicalJson(survey)}\n`) !== binding.digest) {
      throw grantParametersInvalid();
    }
    return { kind: 'create-current-survey', binding, survey };
  }
  throw grantParametersInvalid();
}

function assertPromotionSurvey(value: unknown): WorkItemPromotionSurveyV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'changeId',
      'emptyReason',
      'schemaVersion',
      'surveyedCommit',
      'symbols',
      'workItemId',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.workItemId !== 'string' ||
    !WORK_ITEM_ID.test(value.workItemId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.surveyedCommit !== 'string' ||
    !/^[0-9a-f]{40,64}$/u.test(value.surveyedCommit) ||
    !Array.isArray(value.symbols) ||
    value.symbols.length !== 0 ||
    value.emptyReason !==
      'The agent-authored premise declares no structured repository symbols.'
  ) {
    throw grantParametersInvalid();
  }
  return {
    schemaVersion: 1,
    workItemId: value.workItemId as `WORK-${string}`,
    changeId: value.changeId,
    surveyedCommit: value.surveyedCommit,
    symbols: [],
    emptyReason: value.emptyReason,
  };
}

function promotionSurveyBinding(
  preparationBinding: WorkItemPromotionPreparationBindingV1,
): WorkItemPromotionSurveyBindingV1 {
  return preparationBinding.surveyPreparation.binding;
}

function assertPromotionSurveyBinding(
  value: unknown,
): WorkItemPromotionSurveyBindingV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw grantParametersInvalid();
  }
  if (
    value.kind === 'current-survey' &&
    grantHasExactKeys(value, ['digest', 'kind', 'schemaVersion'])
  ) {
    return {
      schemaVersion: 1,
      kind: 'current-survey',
      digest: exactDigest(value.digest),
    };
  }
  if (
    value.kind === 'not-required' &&
    grantHasExactKeys(value, [
      'kind',
      'reason',
      'schemaVersion',
      'sourceRefsDigest',
    ]) &&
    value.reason === 'pure-maintainer-sources'
  ) {
    return {
      schemaVersion: 1,
      kind: 'not-required',
      reason: 'pure-maintainer-sources',
      sourceRefsDigest: exactDigest(value.sourceRefsDigest),
    };
  }
  throw grantParametersInvalid();
}

function assertReview(value: unknown): WorkItemReviewV1 {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw grantParametersInvalid();
  }
  if (
    value.action === 'accept' &&
    grantHasExactKeys(value, ['action', 'expectedDigest', 'summary']) &&
    typeof value.summary === 'string' &&
    value.summary.length > 0 &&
    Buffer.byteLength(value.summary, 'utf8') <= 2_000 &&
    !value.summary.includes('\0')
  ) {
    return {
      action: 'accept',
      expectedDigest: exactDigest(value.expectedDigest),
      summary: value.summary,
    };
  }
  if (
    value.action === 'prioritize' &&
    grantHasExactKeys(value, [
      'action',
      'blockedBy',
      'expectedDigest',
      'lane',
    ]) &&
    ['now', 'next', 'later', 'icebox'].includes(String(value.lane)) &&
    Array.isArray(value.blockedBy) &&
    value.blockedBy.every((entry) => typeof entry === 'string')
  ) {
    const blockedBy = value.blockedBy.map(exactWorkItemId).sort();
    if (new Set(blockedBy).size !== blockedBy.length) {
      throw grantParametersInvalid();
    }
    return {
      action: 'prioritize',
      expectedDigest: exactDigest(value.expectedDigest),
      lane: value.lane as 'now' | 'next' | 'later' | 'icebox',
      blockedBy,
    };
  }
  if (
    value.action === 'decline' &&
    grantHasExactKeys(value, ['action', 'expectedDigest', 'outcome']) &&
    ['declined', 'duplicate', 'obsolete'].includes(String(value.outcome))
  ) {
    return {
      action: 'decline',
      expectedDigest: exactDigest(value.expectedDigest),
      outcome: value.outcome as 'declined' | 'duplicate' | 'obsolete',
    };
  }
  throw grantParametersInvalid();
}

function renderReviewChoice() {
  return {
    title: 'Apply the exact reviewed Work Registry transition',
    consequences: [
      'Changes only the digest-bound Work Item through the registered review transition.',
    ],
  };
}

function renderPromotionChoice() {
  return {
    title: 'Promote the exact reviewed Work Item',
    consequences: [
      'Atomically links the eligible Work Item, immutable Sources, and current change origin.',
    ],
  };
}

function exactWorkItemId(value: unknown): string {
  if (typeof value !== 'string' || !WORK_ITEM_ID.test(value)) {
    throw grantParametersInvalid();
  }
  return value;
}

function exactChangeId(value: unknown): string {
  if (typeof value !== 'string' || !CHANGE_ID.test(value)) {
    throw grantParametersInvalid();
  }
  return value;
}

function exactDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw grantParametersInvalid();
  }
  return value as `sha256:${string}`;
}

function boundedReason(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 2_048 ||
    /[\0\r\n]/.test(value)
  ) {
    throw grantParametersInvalid();
  }
  return value;
}

function grantParametersInvalid() {
  return grantInvalid(
    'WORK_REGISTRY_GRANT_PARAMETERS_INVALID',
    'Work Registry Grant parameters are invalid.',
    ExitCode.usage,
  );
}

function grantInvalid(code: string, message: string, exitCode: 2 | 11) {
  return workflowError(code, message, exitCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
