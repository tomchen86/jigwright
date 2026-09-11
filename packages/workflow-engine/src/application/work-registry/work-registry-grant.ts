/** Coordinates protected registry transitions through required registry operations. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, WorkflowError } from '../../foundation/errors/errors.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from '../../modules/authority/grant-core.ts';
import {
  freezeGrantCanonical,
  grantSha256,
} from '../../modules/authority/grant-primitives.ts';
import type {
  TransitionDefinition,
  TransitionOutcome,
} from '../../modules/authority/grant-transition-registry.ts';
import { grantTransitionPreconditionChanged } from '../../modules/authority/grant-transition-registry.ts';
import type {
  WorkItemPromotionGrantBindingV1,
  WorkItemPromotionTestHooks,
  WorkItemReviewV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';
import {
  APPROVAL_REASON_CODE,
  assertCurrentBinding,
  assertPromotionParameters,
  assertReview,
  assertReviewParameters,
  boundedReason,
  exactChangeId,
  exactDigest,
  exactWorkItemId,
  grantInvalid,
  isPromotionSurveyPreconditionError,
  PROMOTION_TRANSITION_ID,
  promotionStateBinding,
  promotionSurveyBinding,
  renderPromotionChoice,
  renderReviewChoice,
  REVIEW_TRANSITION_ID,
  type PromotionParametersV1,
  type ReviewParametersV1,
  type WorkRegistryGrantFactsV1,
} from './work-registry-grant-policy.ts';
import { workItemDigest } from '../../modules/governance-intake/work-registry-record.ts';
import type { createWorkRegistryQueries } from './work-registry-queries.ts';
import type { createWorkRegistryWriteService } from './work-registry.ts';
export function createWorkRegistryGrantService(
  registry: Pick<
    ReturnType<typeof createWorkRegistryWriteService>,
    | 'applyWorkItemReview'
    | 'hasExactWorkItemPromotionReceipt'
    | 'observeWorkItemPromotionPreparationBinding'
    | 'prepareWorkItemPromotionFromBinding'
    | 'promoteWorkItem'
    | 'workItemPromotionPreparationMatches'
  > &
    Pick<ReturnType<typeof createWorkRegistryQueries>, 'showWorkItem'>,
) {
  const {
    applyWorkItemReview,
    hasExactWorkItemPromotionReceipt,
    observeWorkItemPromotionPreparationBinding,
    prepareWorkItemPromotionFromBinding,
    promoteWorkItem,
    showWorkItem,
    workItemPromotionPreparationMatches,
  } = registry;
  function createWorkRegistryReviewGrantRequest(
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

  function createWorkRegistryPromotionGrantRequest(
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

  function workRegistryGrantTransitionDefinitions(
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
        ? promotionStateBinding(
            itemBinding.digest,
            parameters.preparationBinding,
          )
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

  function observeWorkItem(
    repositoryRoot: string,
    workItemId: string,
  ): StateBinding {
    return {
      kind: 'work-registry-item.v1',
      digest: workItemDigest(showWorkItem(repositoryRoot, workItemId)),
    };
  }
  return {
    createWorkRegistryReviewGrantRequest,
    createWorkRegistryPromotionGrantRequest,
    workRegistryGrantTransitionDefinitions,
  };
}
