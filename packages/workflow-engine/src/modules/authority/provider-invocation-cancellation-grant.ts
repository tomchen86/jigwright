/**
 * Defines exact cancellation Grants for prepared or leased provider
 * invocations.
 *
 * Invariants:
 * - A cancellation binding's bindingDigest must re-derive from the
 *   namespaced canonical body with bindingDigest removed.
 * - Cancellation completes only when the invocation is terminal with its
 *   worker fence absent.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import {
  freezeGrantCanonical,
  grantHasExactKeys,
  grantSha256,
  GRANT_SHA256_DIGEST,
} from './grant-primitives.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
  type TransitionObservationContext,
} from './grant-transition-registry.ts';

const RAW_DIGEST = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_CANCELLATION_REASON_BYTES = 4_096;

export const PROVIDER_INVOCATION_CANCELLATION_TRANSITION_ID =
  'provider.invocation.cancel.v1' as const;

export type ProviderInvocationCancellationBindingV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-cancellation-binding.v1';
  invocationId: string;
  requestDigest: string;
  manifestDigest: string;
  invocationRecordDigest: `sha256:${string}`;
  expectedRevision: number;
  expectedState: 'prepared' | 'leased';
  leaseGeneration: number;
  leaseTokenDigest: string | null;
  workerFenceDigest: `sha256:${string}` | null;
  bindingDigest: `sha256:${string}`;
}>;

export type ProviderInvocationCancellationParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-cancellation.v1';
  repositoryId: string;
  binding: ProviderInvocationCancellationBindingV1;
  reason: string;
  stateBindingDigest: `sha256:${string}`;
}>;

export type ProviderInvocationCancellationRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-cancellation-request.v1';
  binding: ProviderInvocationCancellationBindingV1;
  grantChallengeId: string;
  grantOperationId: string;
  grantRecordDigest: `sha256:${string}`;
  reason: string;
  requestedAt: string;
  requestDigest: `sha256:${string}`;
}>;

export type ProviderInvocationCancellationObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-cancellation-observation.v1';
  phase: 'active' | 'cancellation-requested' | 'terminal';
  repositoryId: string;
  binding: ProviderInvocationCancellationBindingV1;
  reason: string;
  cancellationRequestDigest: `sha256:${string}` | null;
  terminal: Readonly<{
    state: 'succeeded' | 'failed';
    revision: number;
    failureCode: string | null;
  }> | null;
  workerFencePresent: boolean;
}>;

export type ProviderInvocationCancellationGrantPort = Readonly<{
  observe(
    parameters: ProviderInvocationCancellationParametersV1,
    context?: TransitionObservationContext,
  ): ProviderInvocationCancellationObservationV1;
  cancel(
    context: AuthorizedTransitionContext<ProviderInvocationCancellationParametersV1>,
  ): Promise<ProviderInvocationCancellationObservationV1>;
}>;

export const PROVIDER_INVOCATION_CANCELLATION_PARAMETER_SCHEMA_DIGEST =
  grantSha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-invocation-cancellation.schema.v1',
      required: ['repositoryId', 'binding', 'reason', 'stateBindingDigest'],
    }),
  );

export const PROVIDER_INVOCATION_CANCELLATION_CONSEQUENCE_DIGEST = grantSha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'provider-invocation-cancellation-consequence.v1',
    effect: 'cancel-one-exact-provider-invocation',
    preparedDisposition: 'failed-before-launch',
    leasedDisposition: 'abort-signal-process-group',
    naturalTerminalRace: 'preserve-actual-terminal-facts',
    workerFence: 'must-be-absent-before-completion',
  }),
);

export function createProviderInvocationCancellationGrantRequest(
  candidate: ProviderInvocationCancellationObservationV1,
  proposedReason: string,
): GrantRequestInput {
  const observation =
    assertProviderInvocationCancellationObservation(candidate);
  if (observation.phase !== 'active') {
    throw cancellationStateChanged(
      'Provider invocation is no longer awaiting a fresh cancellation Grant.',
    );
  }
  const stateBinding = providerInvocationCancellationStateBinding(observation);
  const parameters = freezeGrantCanonical({
    schemaVersion: 1 as const,
    kind: 'provider-invocation-cancellation.v1' as const,
    repositoryId: observation.repositoryId,
    binding: observation.binding,
    reason: exactText(observation.reason),
    stateBindingDigest: stateBinding.digest,
  });
  return freezeGrantCanonical({
    sourceModuleId: 'provider-runtime',
    failureCode: 'provider-invocation-cancellation-required',
    facts: {
      repositoryId: parameters.repositoryId,
      invocationId: parameters.binding.invocationId,
      bindingDigest: parameters.binding.bindingDigest,
      reason: parameters.reason,
    },
    stateBinding,
    candidates: [
      {
        transitionId: PROVIDER_INVOCATION_CANCELLATION_TRANSITION_ID,
        parameters,
        allowedReasonCodes: ['cancel-exact-provider-invocation'],
        reasonRequired: true,
        proposedReason: exactText(proposedReason),
      },
    ],
  });
}

export function providerInvocationCancellationTransitionDefinitions(
  port: ProviderInvocationCancellationGrantPort,
): readonly TransitionDefinition<ProviderInvocationCancellationParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: PROVIDER_INVOCATION_CANCELLATION_TRANSITION_ID,
      parameterSchemaDigest:
        PROVIDER_INVOCATION_CANCELLATION_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: PROVIDER_INVOCATION_CANCELLATION_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertProviderInvocationCancellationParameters,
      renderTrustedChoice(
        parameters: ProviderInvocationCancellationParametersV1,
      ) {
        return Object.freeze({
          title: `Cancel provider invocation ${parameters.binding.invocationId}`,
          consequences: Object.freeze([
            parameters.binding.expectedState === 'prepared'
              ? 'Fail the exact prepared invocation before launch.'
              : 'Request cancellation of the exact leased worker and its provider process group.',
            'Preserve a natural success or failure if it wins the terminal race.',
            'Do not complete until the invocation is terminal and its exact worker fence is absent.',
          ]),
        });
      },
      observeState(
        parameters: ProviderInvocationCancellationParametersV1,
        context?: TransitionObservationContext,
      ) {
        return providerInvocationCancellationStateBinding(
          assertMatchingObservation(
            port.observe(
              assertProviderInvocationCancellationParameters(parameters),
              context,
            ),
            parameters,
          ),
        );
      },
      async execute(
        context: AuthorizedTransitionContext<ProviderInvocationCancellationParametersV1>,
      ) {
        const parameters = assertProviderInvocationCancellationParameters(
          context.parameters,
        );
        context.assertLifecycleOwned();
        const before = assertMatchingObservation(
          port.observe(parameters, {
            challengeId: context.challengeId,
            operationId: context.operationId,
          }),
          parameters,
        );
        if (
          before.phase === 'active' &&
          providerInvocationCancellationStateBinding(before).digest !==
            parameters.stateBindingDigest
        ) {
          throw grantTransitionPreconditionChanged(
            'PROVIDER_INVOCATION_CANCELLATION_STATE_CHANGED',
            'Provider invocation changed before cancellation.',
          );
        }
        if (before.phase === 'cancellation-requested' && !context.recovered) {
          throw grantTransitionPreconditionChanged(
            'PROVIDER_INVOCATION_CANCELLATION_ALREADY_STARTED',
            'Provider cancellation started before this Grant executed.',
          );
        }
        const after = assertMatchingObservation(
          before.phase === 'terminal'
            ? before
            : await port.cancel({ ...context, parameters }),
          parameters,
        );
        context.assertLifecycleOwned();
        if (
          after.phase !== 'terminal' ||
          after.terminal === null ||
          after.workerFencePresent
        ) {
          throw workflowError(
            'PROVIDER_INVOCATION_CANCELLATION_INCOMPLETE',
            'Provider cancellation did not reach truthful terminal quiescence.',
            ExitCode.verification,
          );
        }
        return Object.freeze({
          outcome: 'completed' as const,
          details: freezeGrantCanonical({
            schemaVersion: 1,
            kind: 'provider-invocation-cancellation-completed.v1',
            invocationId: parameters.binding.invocationId,
            terminal: after.terminal,
            cancellationRequestDigest: after.cancellationRequestDigest,
          }),
        });
      },
    }),
  ]);
}

export function providerInvocationCancellationStateBinding(
  candidate: ProviderInvocationCancellationObservationV1,
): StateBinding {
  const observation =
    assertProviderInvocationCancellationObservation(candidate);
  return Object.freeze({
    kind: 'provider-invocation-cancellation-state.v1',
    digest: grantSha256(canonicalJson(observation)),
  });
}

export function assertProviderInvocationCancellationBindingV1(
  value: unknown,
): ProviderInvocationCancellationBindingV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'manifestDigest',
      'invocationRecordDigest',
      'expectedRevision',
      'expectedState',
      'leaseGeneration',
      'leaseTokenDigest',
      'workerFenceDigest',
      'bindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-cancellation-binding.v1' ||
    typeof value.invocationId !== 'string' ||
    value.invocationId.length === 0 ||
    !RAW_DIGEST.test(String(value.requestDigest)) ||
    !RAW_DIGEST.test(String(value.manifestDigest)) ||
    !GRANT_SHA256_DIGEST.test(String(value.invocationRecordDigest)) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 ||
    (value.expectedState !== 'prepared' && value.expectedState !== 'leased') ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 0 ||
    !nullableRawDigest(value.leaseTokenDigest) ||
    !nullableSha256(value.workerFenceDigest) ||
    !GRANT_SHA256_DIGEST.test(String(value.bindingDigest))
  ) {
    throw cancellationInvalid();
  }
  const preparedBindingValid =
    value.expectedState === 'prepared' &&
    value.leaseTokenDigest === null &&
    value.workerFenceDigest === null;
  const leasedBindingValid =
    value.expectedState === 'leased' &&
    (value.leaseGeneration as number) > 0 &&
    value.leaseTokenDigest !== null &&
    value.workerFenceDigest !== null;
  if (!preparedBindingValid && !leasedBindingValid) {
    throw cancellationInvalid();
  }
  const body = { ...value };
  delete body.bindingDigest;
  if (
    value.bindingDigest !==
    grantSha256(
      `workflow.provider-invocation-cancellation-binding.v1\n${canonicalJson(body)}`,
    )
  ) {
    throw cancellationInvalid();
  }
  return freezeGrantCanonical(value) as ProviderInvocationCancellationBindingV1;
}

export function assertProviderInvocationCancellationRequestV1(
  value: unknown,
): ProviderInvocationCancellationRequestV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'binding',
      'grantChallengeId',
      'grantOperationId',
      'grantRecordDigest',
      'reason',
      'requestedAt',
      'requestDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-cancellation-request.v1' ||
    typeof value.grantChallengeId !== 'string' ||
    !UUID_V4.test(value.grantChallengeId) ||
    typeof value.grantOperationId !== 'string' ||
    !UUID_V4.test(value.grantOperationId) ||
    typeof value.grantRecordDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.grantRecordDigest) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    Buffer.byteLength(value.reason, 'utf8') > MAX_CANCELLATION_REASON_BYTES ||
    typeof value.requestedAt !== 'string' ||
    !exactIsoTimestamp(value.requestedAt) ||
    typeof value.requestDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.requestDigest)
  ) {
    throw cancellationInvalid();
  }
  const binding = assertProviderInvocationCancellationBindingV1(value.binding);
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-invocation-cancellation-request.v1' as const,
    binding,
    grantChallengeId: value.grantChallengeId,
    grantOperationId: value.grantOperationId,
    grantRecordDigest: value.grantRecordDigest as `sha256:${string}`,
    reason: value.reason,
    requestedAt: value.requestedAt,
  };
  if (
    value.requestDigest !==
    grantSha256(
      `workflow.provider-invocation-cancellation-request.v1\n${canonicalJson(body)}`,
    )
  ) {
    throw cancellationInvalid();
  }
  return freezeGrantCanonical({
    ...body,
    requestDigest: value.requestDigest as `sha256:${string}`,
  }) as ProviderInvocationCancellationRequestV1;
}

export function assertProviderInvocationCancellationParameters(
  value: unknown,
): ProviderInvocationCancellationParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repositoryId',
      'binding',
      'reason',
      'stateBindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-cancellation.v1' ||
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.length === 0 ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    Buffer.byteLength(value.reason, 'utf8') > MAX_CANCELLATION_REASON_BYTES ||
    !GRANT_SHA256_DIGEST.test(String(value.stateBindingDigest))
  ) {
    throw cancellationInvalid();
  }
  const binding = assertProviderInvocationCancellationBindingV1(value.binding);
  return freezeGrantCanonical({
    ...value,
    binding,
  }) as ProviderInvocationCancellationParametersV1;
}

export function assertProviderInvocationCancellationObservation(
  value: unknown,
): ProviderInvocationCancellationObservationV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'phase',
      'repositoryId',
      'binding',
      'reason',
      'cancellationRequestDigest',
      'terminal',
      'workerFencePresent',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-cancellation-observation.v1' ||
    !['active', 'cancellation-requested', 'terminal'].includes(
      String(value.phase),
    ) ||
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.length === 0 ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    !nullableSha256(value.cancellationRequestDigest) ||
    !terminalObservation(value.terminal) ||
    typeof value.workerFencePresent !== 'boolean'
  ) {
    throw cancellationInvalid();
  }
  const binding = assertProviderInvocationCancellationBindingV1(value.binding);
  const phaseValid =
    (value.phase === 'active' &&
      value.cancellationRequestDigest === null &&
      value.terminal === null) ||
    (value.phase === 'cancellation-requested' &&
      value.cancellationRequestDigest !== null &&
      value.terminal === null) ||
    (value.phase === 'terminal' && value.terminal !== null);
  if (!phaseValid) throw cancellationInvalid();
  return freezeGrantCanonical({
    ...value,
    binding,
  }) as ProviderInvocationCancellationObservationV1;
}

function assertMatchingObservation(
  candidate: ProviderInvocationCancellationObservationV1,
  parameters: ProviderInvocationCancellationParametersV1,
): ProviderInvocationCancellationObservationV1 {
  const observation =
    assertProviderInvocationCancellationObservation(candidate);
  if (
    observation.repositoryId !== parameters.repositoryId ||
    observation.reason !== parameters.reason ||
    canonicalJson(observation.binding) !== canonicalJson(parameters.binding)
  ) {
    throw cancellationStateChanged(
      'Provider cancellation observation no longer matches its exact Grant.',
    );
  }
  return observation;
}

function terminalObservation(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      grantHasExactKeys(value, ['state', 'revision', 'failureCode']) &&
      (value.state === 'succeeded' || value.state === 'failed') &&
      Number.isSafeInteger(value.revision) &&
      (value.revision as number) > 0 &&
      ((value.state === 'succeeded' && value.failureCode === null) ||
        (value.state === 'failed' &&
          typeof value.failureCode === 'string' &&
          value.failureCode.length > 0)))
  );
}

function nullableRawDigest(value: unknown): boolean {
  return (
    value === null || (typeof value === 'string' && RAW_DIGEST.test(value))
  );
}

function nullableSha256(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' && GRANT_SHA256_DIGEST.test(value))
  );
}

function exactText(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw cancellationInvalid();
  }
  return value;
}

function exactIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cancellationInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_CANCELLATION_INVALID',
    'Provider invocation cancellation contract is invalid.',
    ExitCode.guard,
  );
}

function cancellationStateChanged(message: string) {
  return workflowError(
    'PROVIDER_INVOCATION_CANCELLATION_STATE_CHANGED',
    message,
    ExitCode.staleState,
  );
}
