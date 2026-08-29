import type { CentralGrantRequestInputV1 } from '@jigwright/core/central-grant-port';

import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  AuthorizedTransitionContext,
  TransitionDefinition,
} from '../authority/grant-transition-registry.ts';
import { observeChangeRoutingContinuationState } from './change-routing.ts';
import {
  CHANGE_ROUTING_CONTINUATION_CONSEQUENCE_DIGEST,
  CHANGE_ROUTING_CONTINUATION_PARAMETER_SCHEMA_DIGEST,
  CHANGE_ROUTING_CONTINUATION_TRANSITION_ID,
} from './change-routing-grant-contract.ts';

type ChangeRoutingContinuationParameters = Readonly<{
  changeId: string;
  sourceDigest: `sha256:${string}`;
}>;

export function changeRoutingGrantTransitionDefinitions(
  repositoryRoot: string,
): readonly TransitionDefinition<ChangeRoutingContinuationParameters>[] {
  const definition: TransitionDefinition<ChangeRoutingContinuationParameters> =
    Object.freeze({
      transitionId: CHANGE_ROUTING_CONTINUATION_TRANSITION_ID,
      parameterSchemaDigest:
        CHANGE_ROUTING_CONTINUATION_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: CHANGE_ROUTING_CONTINUATION_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      validateParameters: parseContinuationParameters,
      renderTrustedChoice(parameters: ChangeRoutingContinuationParameters) {
        return Object.freeze({
          title: `Continue parked or manually blocked change ${parameters.changeId}`,
          consequences: Object.freeze([
            'The exact protected routing record may return to ready without becoming focused.',
          ]),
        });
      },
      observeState(parameters: ChangeRoutingContinuationParameters) {
        const observed = observeChangeRoutingContinuationState(
          repositoryRoot,
          parameters.changeId,
        );
        if (observed.sourceDigest !== parameters.sourceDigest) {
          throw workflowError(
            'CHANGE_ROUTING_GRANT_STATE_CHANGED',
            'The controlled routing source changed after the continuation challenge was issued.',
            ExitCode.staleState,
          );
        }
        return Object.freeze({
          kind: observed.kind,
          digest: observed.digest,
        });
      },
      async execute(
        context: AuthorizedTransitionContext<ChangeRoutingContinuationParameters>,
      ) {
        context.assertLifecycleOwned();
        const observed = observeChangeRoutingContinuationState(
          repositoryRoot,
          context.parameters.changeId,
        );
        if (observed.sourceDigest !== context.parameters.sourceDigest) {
          throw workflowError(
            'CHANGE_ROUTING_GRANT_STATE_CHANGED',
            'The controlled routing source changed before continuation authorization completed.',
            ExitCode.staleState,
          );
        }
        return Object.freeze({
          outcome: 'completed' as const,
          details: Object.freeze({
            authorized: true,
            changeId: context.parameters.changeId,
            sourceDigest: context.parameters.sourceDigest,
            autoFocus: false,
          }),
        });
      },
    });
  return Object.freeze([definition]);
}

export function createChangeRoutingContinuationGrantRequest(
  repositoryRoot: string,
  changeId: string,
  proposedReason: string,
  expected?: Readonly<{
    sourceDigest: `sha256:${string}`;
    stateBindingDigest: `sha256:${string}`;
  }>,
): CentralGrantRequestInputV1 {
  const observed = observeChangeRoutingContinuationState(
    repositoryRoot,
    changeId,
  );
  if (
    expected !== undefined &&
    (observed.sourceDigest !== expected.sourceDigest ||
      observed.digest !== expected.stateBindingDigest)
  ) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The protected routing record changed before its exact Central Grant challenge was created.',
      ExitCode.staleState,
    );
  }
  return Object.freeze({
    sourceModuleId: 'change-routing',
    failureCode: 'protected-continuation-required',
    facts: Object.freeze({
      changeId,
      sourceDigest: observed.sourceDigest,
      disposition: observed.record.disposition,
      reason: observed.record.reason,
      taskId: observed.record.taskId,
      blocker: observed.record.blocker,
    }),
    stateBinding: Object.freeze({
      kind: observed.kind,
      digest: observed.digest,
    }),
    candidates: Object.freeze([
      Object.freeze({
        transitionId: CHANGE_ROUTING_CONTINUATION_TRANSITION_ID,
        parameters: Object.freeze({
          changeId,
          sourceDigest: observed.sourceDigest,
        }),
        allowedReasonCodes: Object.freeze(['manual-continuation-reviewed']),
        reasonRequired: true,
        proposedReason,
      }),
    ]),
  });
}

function parseContinuationParameters(
  value: unknown,
): ChangeRoutingContinuationParameters {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !== 'changeId\0sourceDigest' ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.sourceDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.sourceDigest)
  ) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_PARAMETERS_INVALID',
      'Change-routing continuation parameters are invalid.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    changeId: value.changeId,
    sourceDigest: value.sourceDigest as `sha256:${string}`,
  });
}
