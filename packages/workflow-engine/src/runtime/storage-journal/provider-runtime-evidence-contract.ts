/**
 * Validates provider runtime evidence, lifecycle shapes, policies, and semantic output.
 *
 * Invariants:
 * - Requests, leases, completion receipts, and purpose-specific outputs remain exactly bound.
 * - Terminal and nonterminal evidence keep their existing admission and failure rules.
 *
 * Depends on: provider contracts, output validators, policy parsing, and private record value checks.
 * Failure modes: unbound provider output is accepted or valid execution evidence becomes unreadable.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
} from '../../modules/assurance/plan-review.ts';
import {
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import { type AgentRuntimeCompletionReceipt } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  validateBlindSurveyOutput,
} from '../../modules/provider-orchestration/blind-survey-output.ts';
import { assertReadOnlyProbe } from '../../modules/provider-orchestration/execution-core.ts';
import {
  type ProviderInvocationRequest,
  type ProviderProcessResult,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  assertAgentRuntimeCompletionReceipt,
  assertProviderProcessResult,
} from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
} from '../../modules/provider-orchestration/task-strategy-implementation-output.ts';
import { parseAiAdapterPolicyDocument } from '../provider-execution/ai-adapter-policy.ts';
import {
  assertDurableProviderExecutionBudgetAuthority,
  validateProviderExecutionBudgetAuthority,
} from '../provider-execution/provider-execution-policy-authority.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';
import {
  deepFreeze,
  hasExactKeys,
  isDigest,
  isRecord,
  isTaskMandateBinding,
  isTimestamp,
  providerInvocationUnsafe,
  sha256,
} from './investigation-store-values.ts';

export type ProviderInvocationLifecycleProjection = Readonly<{
  invocationId: string;
  investigationId: string;
  ownerInvestigationId: string;
  changeId: string;
  purpose: 'survey' | 'plan-review' | 'task-diff-review';
  attempt: number;
  revision: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  policySnapshot: 'recorded';
  requestDigest: string;
  manifestDigest: string;
  nonce: string;
  failureKind: 'retryable' | 'repository-reconciliation-required' | null;
  leaseGeneration: number;
  lease: Readonly<{
    generation: number;
    workerId: string;
    tokenDigest: string;
    acquiredAt: string;
    expiresAt: string;
  }> | null;
}>;

export type ProviderInvocationLifecycleScan = Readonly<{
  projections: readonly ProviderInvocationLifecycleProjection[];
  unsafeInvocations: readonly Readonly<{
    invocationId: string;
    ownerInvestigationId: string | null;
    observationDigest: string;
  }>[];
}>;

export type ProviderInvocationRuntimeEvidence = Readonly<{
  invocationId: string;
  revision: number;
  leaseGeneration: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  manifestDigest: string;
  updatedAt: string;
  result: ProviderProcessResult | null;
  runtimeReceipt: AgentRuntimeCompletionReceipt | null;
}>;

export function assertProviderInvocationRuntimeEvidence(
  value: unknown,
  request: ProviderInvocationRequest,
  makeError: () => WorkflowError,
): ProviderInvocationRuntimeEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'invocationId',
      'investigationId',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'attempt',
      'revision',
      'state',
      'providerId',
      'purpose',
      'requestDigest',
      'manifestDigest',
      'leaseGeneration',
      'lease',
      'result',
      'failure',
      ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
        ? ['runtimeReceipt']
        : []),
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.invocationId !== request.invocationId ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(
      String(value.state),
    ) ||
    value.providerId !== request.providerId ||
    value.purpose !== request.purpose ||
    value.requestDigest !== request.requestDigest ||
    !isDigest(value.manifestDigest) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 0 ||
    !isProviderInvocationLifecycleLease(value.lease) ||
    !isProviderInvocationFailureShape(value.failure) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw makeError();
  }
  try {
    assertInvocationId(value.invocationId);
    assertInvestigationId(value.investigationId);
    assertChangeId(value.changeId);
  } catch {
    throw makeError();
  }
  const result =
    value.state === 'succeeded'
      ? assertProviderProcessResult(
          request,
          value.result,
          providerLifecycleOutputValidator(request, makeError),
          makeError,
        )
      : null;
  const runtimeReceipt = Object.prototype.hasOwnProperty.call(
    value,
    'runtimeReceipt',
  )
    ? assertAgentRuntimeCompletionReceipt(value.runtimeReceipt, makeError)
    : null;
  if (
    (value.state === 'prepared' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'leased' &&
      (value.lease === null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'succeeded' &&
      (value.lease !== null || result === null || value.failure !== null)) ||
    (value.state === 'failed' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure === null)) ||
    (value.lease !== null &&
      value.lease.generation !== value.leaseGeneration) ||
    (runtimeReceipt !== null &&
      (runtimeReceipt.terminalState !== value.state ||
        runtimeReceipt.invocationId !== value.invocationId ||
        runtimeReceipt.requestDigest !== value.requestDigest ||
        runtimeReceipt.terminalRevision !== value.revision ||
        runtimeReceipt.leaseGeneration !== value.leaseGeneration ||
        (runtimeReceipt.schemaVersion === 4 &&
          runtimeReceipt.failureCode !==
            (value.state === 'failed'
              ? (value.failure as { code: string }).code
              : null))))
  ) {
    throw makeError();
  }
  return deepFreeze({
    invocationId: value.invocationId,
    revision: value.revision,
    leaseGeneration: value.leaseGeneration,
    state: value.state,
    manifestDigest: value.manifestDigest,
    updatedAt: value.updatedAt,
    result,
    runtimeReceipt,
  } as ProviderInvocationRuntimeEvidence);
}

function providerLifecycleOutputValidator(
  request: ProviderInvocationRequest,
  makeError: () => WorkflowError,
): Readonly<{ validate(value: unknown): boolean }> {
  return Object.freeze({
    validate(value: unknown): boolean {
      try {
        assertHostWrapperSemanticOutput(request, value, makeError);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function assertHostWrapperSemanticOutput(
  request: ProviderInvocationRequest,
  value: unknown,
  makeError: () => WorkflowError,
): void {
  try {
    if (request.purpose === 'survey') {
      if (
        canonicalJson(request.outputSchema) !==
          canonicalJson(BLIND_SURVEY_OUTPUT_SCHEMA) ||
        !validateBlindSurveyOutput(value, request.invocationId)
      ) {
        throw makeError();
      }
      return;
    }
    if (request.purpose === 'plan-review') {
      if (
        canonicalJson(request.outputSchema) !==
          canonicalJson(PLAN_REVIEW_OUTPUT_SCHEMA) ||
        PLAN_REVIEW_OUTPUT_VALIDATOR.validate(value) !== true
      ) {
        throw makeError();
      }
      return;
    }
    if (request.purpose === 'task-diff-review') {
      const continuation =
        canonicalJson(request.outputSchema) ===
        canonicalJson(TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA);
      if (
        continuation
          ? TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR.validate(value) !==
            true
          : canonicalJson(request.outputSchema) !==
              canonicalJson(TASK_DIFF_REVIEW_OUTPUT_SCHEMA) ||
            TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(value) !== true
      ) {
        throw makeError();
      }
      return;
    }
    if (
      request.purpose !== 'task-implementation' ||
      canonicalJson(request.outputSchema) !==
        canonicalJson(TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA) ||
      TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR.validate(value) !== true
    ) {
      throw makeError();
    }
  } catch {
    throw makeError();
  }
}

export function isProviderInvocationFailureShape(value: unknown): value is {
  kind: 'retryable' | 'repository-reconciliation-required';
  code: string;
  message: string;
  executionKind?: string;
  retryAfterMs?: number;
  probe?: unknown;
} | null {
  const hasExecutionKind =
    isRecord(value) && Object.hasOwn(value, 'executionKind');
  const hasRetryAfter = isRecord(value) && Object.hasOwn(value, 'retryAfterMs');
  const hasProbe = isRecord(value) && Object.hasOwn(value, 'probe');
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'kind',
        'code',
        'message',
        ...(hasExecutionKind ? ['executionKind'] : []),
        ...(hasRetryAfter ? ['retryAfterMs'] : []),
        ...(hasProbe ? ['probe'] : []),
      ]) &&
      (value.kind === 'retryable' ||
        value.kind === 'repository-reconciliation-required') &&
      typeof value.code === 'string' &&
      value.code.length > 0 &&
      typeof value.message === 'string' &&
      value.message.length > 0 &&
      (!hasExecutionKind ||
        PROVIDER_EXECUTION_FAILURE_KINDS.has(String(value.executionKind))) &&
      (!hasRetryAfter ||
        (Number.isSafeInteger(value.retryAfterMs) &&
          (value.retryAfterMs as number) >= 0 &&
          (value.retryAfterMs as number) <= 86_400_000)) &&
      (!hasProbe || isReadOnlyProbeShape(value.probe)) &&
      hasProbe === (value.executionKind === 'probe-transient') &&
      Buffer.byteLength(canonicalJson(value), 'utf8') <= 16_384)
  );
}

function isReadOnlyProbeShape(value: unknown): boolean {
  try {
    assertReadOnlyProbe(value);
    return true;
  } catch {
    return false;
  }
}

const PROVIDER_EXECUTION_FAILURE_KINDS = new Set([
  'provider-timeout',
  'network',
  'rate-limit',
  'provider-process-crash',
  'worker-crash',
  'lease-expiry',
  'temporary-file-lock',
  'provider-capacity',
  'stdout-truncated',
  'process-nonzero',
  'json-parse',
  'schema-mismatch',
  'missing-required-field',
  'citation-out-of-range',
  'probe-transient',
  'needs-user-decision',
  'state-corruption',
  'unknown-side-effect',
]);

export function assertProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  value: unknown,
  request: ProviderInvocationRequest,
): void {
  if (
    !isRecord(value) ||
    value.kind !== 'provider-execution-policy-snapshot' ||
    value.invocationId !== request.invocationId ||
    value.requestDigest !== request.requestDigest ||
    value.policyDigest !== request.policyDigest ||
    typeof value.policyDocument !== 'string' ||
    ![2, 3].includes(value.schemaVersion as number) ||
    !hasExactKeys(value, [
      'accountingDigest',
      'attemptReservation',
      ...(value.schemaVersion === 3 ? ['authority'] : []),
      'invocationId',
      'kind',
      'policyDigest',
      'policyDocument',
      'requestDigest',
      'retryAccounting',
      'schemaVersion',
    ])
  ) {
    throw providerInvocationUnsafe();
  }
  try {
    const loaded = parseAiAdapterPolicyDocument(value.policyDocument);
    if (
      loaded.digest !== value.policyDigest ||
      request.limits.aggregateOutputBytes >
        loaded.policy.limits.aggregateOutputBytes
    ) {
      throw providerInvocationUnsafe();
    }
    if (value.schemaVersion === 3) {
      if (loaded.policy.schemaVersion !== 4) {
        throw providerInvocationUnsafe();
      }
      const authority = validateProviderExecutionBudgetAuthority(
        request,
        loaded as ReturnType<typeof parseAiAdapterPolicyDocument>,
        value.authority,
      );
      assertDurableProviderExecutionBudgetAuthority(paths.root, authority);
    } else if (request.limits.timeoutMs > loaded.policy.limits.timeoutMs) {
      throw providerInvocationUnsafe();
    }
    if (value.schemaVersion === 2 || value.schemaVersion === 3) {
      if (!isRecord(value.attemptReservation)) {
        throw providerInvocationUnsafe();
      }
      const attemptReservation = {
        runtimeMs: request.limits.timeoutMs,
        providerCostMicros:
          loaded.policy.retryAccounting.reservations[request.providerId]
            .providerCostMicros,
        providerTokens:
          loaded.policy.retryAccounting.reservations[request.providerId]
            .providerTokens,
      };
      if (
        canonicalJson(value.retryAccounting) !==
          canonicalJson(loaded.policy.retryAccounting) ||
        canonicalJson(value.attemptReservation) !==
          canonicalJson(attemptReservation) ||
        value.accountingDigest !==
          sha256(
            canonicalJson({
              schemaVersion: 1,
              kind: 'provider-retry-accounting-snapshot',
              invocationId: request.invocationId,
              requestDigest: request.requestDigest,
              policyDigest: request.policyDigest,
              retryAccounting: loaded.policy.retryAccounting,
              attemptReservation,
            }),
          )
      ) {
        throw providerInvocationUnsafe();
      }
    }
  } catch {
    throw providerInvocationUnsafe();
  }
}

export function isProviderInvocationLifecycleLease(
  value: unknown,
): value is NonNullable<ProviderInvocationLifecycleProjection['lease']> | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'generation',
        'workerId',
        'tokenDigest',
        'acquiredAt',
        'expiresAt',
      ]) &&
      Number.isSafeInteger(value.generation) &&
      (value.generation as number) > 0 &&
      typeof value.workerId === 'string' &&
      value.workerId.length > 0 &&
      isDigest(value.tokenDigest) &&
      isTimestamp(value.acquiredAt) &&
      isTimestamp(value.expiresAt) &&
      Date.parse(value.expiresAt) > Date.parse(value.acquiredAt))
  );
}
