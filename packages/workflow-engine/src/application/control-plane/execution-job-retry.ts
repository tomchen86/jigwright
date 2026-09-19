/**
 * Routes explained job retries to the planning lifecycle that owns them.
 *
 * Invariants:
 * - Preview never reserves or dispatches provider work.
 * - Submit rechecks the same admission and retains native replay bindings.
 */
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import crypto from 'node:crypto';
import { readProviderInvocationRequest } from '../../runtime/storage-journal/provider-invocation-store.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../../runtime/repository-observation/investigation-runtime-context.ts';
import {
  loadAiAdapterPolicy,
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
} from '../../runtime/provider-policy/ai-adapter-policy.ts';
import {
  inspectExecutionJob,
  inspectProviderExecutionJobSource,
} from '../../runtime/provider-execution/execution-runtime.ts';
import { authorizeAutomaticProviderRetry } from '../../modules/provider-orchestration/provider-retry-decision.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  parseProviderRetryExplanation,
  defaultProviderRetryExplanation,
} from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import type { ExecutionReplacementProposePort } from './execution-replacement.ts';
export type ExecutionJobRetryDependencies = ExecutionReplacementProposePort & {
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader;
};
import {
  assertProviderRetryEnvelope,
  assertPlanReviewRetryEnvelope,
} from '../propose/propose-input.ts';
import type {
  ProviderRetryEnvelope,
  PlanReviewRetryEnvelope,
  ProposeResumeOptions,
} from '../propose/propose-types.ts';
import {
  previewExecutionReplacementRequest,
  requestExecutionReplacement,
} from './execution-replacement.ts';

type RetryInput = ProviderRetryEnvelope | PlanReviewRetryEnvelope;

export function previewExecutionJobRetry(
  dependencies: ExecutionJobRetryDependencies,
  cwd: string,
  jobId: string,
  options: {
    timeoutMs?: number;
    collaborationGrantValidation?: ProposeResumeOptions['collaborationGrantValidation'];
  } = {},
) {
  const inspection = inspectExecutionJob(cwd, jobId);
  const source = inspectProviderExecutionJobSource(cwd, jobId);
  if (
    source.record.purpose !== 'survey' &&
    source.record.purpose !== 'plan-review'
  ) {
    return {
      status: 'blocked' as const,
      reasonCode: 'EXECUTION_RETRY_OWNER_UNSUPPORTED',
      inputTemplate: null,
    };
  }
  if (
    source.record.state !== 'failed' ||
    source.record.failure?.kind !== 'retryable'
  ) {
    return {
      status: 'blocked' as const,
      reasonCode: 'EXECUTION_RETRY_NOT_AVAILABLE',
      inputTemplate: null,
    };
  }
  let template: RetryInput;
  try {
    const status = dependencies.getProposeStatus(
      cwd,
      source.record.investigationId,
      options.collaborationGrantValidation,
    );
    template =
      source.record.purpose === 'survey'
        ? dependencies.createProviderRetryEnvelope(cwd, status, {
            acknowledgeProviderCost: true,
          })
        : dependencies.createPlanReviewRetryEnvelope(cwd, status, {
            acknowledgeProviderCost: true,
          });
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return {
      status: 'blocked' as const,
      reasonCode: error.code,
      inputTemplate: null,
    };
  }
  const timeoutMs = options.timeoutMs ?? source.request.limits.timeoutMs;
  const inputTemplate: RetryInput = {
    ...template,
    timeoutMs,
    retryExplanation: {
      failureReason: source.record.failure.message,
      plannedAction: '',
    },
  };
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000
  ) {
    throw workflowError(
      'EXECUTION_REPLACEMENT_TIMEOUT_INVALID',
      'Retry timeout must be a bounded positive integer.',
      ExitCode.usage,
    );
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
  const {
    schemaVersion,
    requestDigest,
    roleAssignmentDigest,
    retryExplanation,
    ...prior
  } = source.request;
  const identity = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        jobId,
        invocationId: source.record.invocationId,
        timeoutMs,
      }),
    )
    .digest('hex');
  const candidate = createProviderInvocationRequest({
    ...prior,
    invocationId: `invocation-retry-preview-${identity}`,
    nonce: `retry-preview-${identity}`,
    policyDigest: policy.digest,
    limits: {
      timeoutMs: Math.min(timeoutMs, policy.policy.limits.timeoutMs),
      aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
    },
    retryExplanation: defaultProviderRetryExplanation(source.record.failure),
  });
  const authorization = authorizeAutomaticProviderRetry(
    dependencies.readProviderRetryAccountingEvidence(
      context.runtime,
      source.record,
      source.request,
    ),
    {
      failed: source.record,
      failedRequest: source.request,
      replacementRequest: candidate,
      replacementExecutionPolicy: policy,
      dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
      boundedGrantRequest: inspection.latestFailure?.decision.requiredGrant,
      now: new Date().toISOString(),
    },
  );
  const decision = authorization.decision;
  if (decision.requiredGrant !== undefined) {
    return {
      status: 'grant-required' as const,
      reasonCode: decision.reasonCode,
      inputTemplate,
      grantRequest: previewExecutionReplacementRequest(
        dependencies,
        cwd,
        jobId,
        {
          timeoutMs,
        },
      ),
    };
  }
  if (timeoutMs > policy.policy.limits.timeoutMs) {
    return {
      status: 'blocked' as const,
      reasonCode: 'PROVIDER_POLICY_TIMEOUT_EXCEEDED',
      inputTemplate,
    };
  }
  return {
    status:
      decision.retryable && decision.automatic
        ? ('ready' as const)
        : ('blocked' as const),
    reasonCode: decision.reasonCode,
    inputTemplate,
  };
}

export function requestExecutionJobRetry(
  dependencies: ExecutionJobRetryDependencies,
  cwd: string,
  jobId: string,
  value: unknown,
  options: ProposeResumeOptions = {},
) {
  let input = parseRetryInput(value);
  parseProviderRetryExplanation(input.retryExplanation);
  const source = inspectProviderExecutionJobSource(cwd, jobId);
  if (
    source.record.investigationId !== input.investigationId ||
    source.record.changeId !== input.changeId ||
    (source.record.purpose === 'survey'
      ? input.kind !== 'provider-retry'
      : source.record.purpose !== 'plan-review' ||
        input.kind !== 'plan-review-retry')
  ) {
    throw staleRetry();
  }
  if (input.timeoutMs === undefined) {
    const context = loadInvestigationRuntimeContext(cwd);
    input = {
      ...input,
      timeoutMs: readProviderInvocationRequest(
        context.runtime,
        input.failedInvocation.invocationId,
      ).limits.timeoutMs,
    };
  }
  // A replacement already published for this input is reconciled by its owner.
  // Do not reinterpret replay as a request to retry the latest Attempt again.
  if (source.record.invocationId !== input.failedInvocation.invocationId) {
    return {
      status: 'retried' as const,
      result: dependencies.resumePropose(cwd, input.changeId, input, options),
    };
  }
  const preview = previewExecutionJobRetry(dependencies, cwd, jobId, {
    timeoutMs: input.timeoutMs,
    collaborationGrantValidation: options.collaborationGrantValidation,
  });
  const binding = (envelope: RetryInput) => {
    const { timeoutMs, retryExplanation, ...identity } = envelope;
    return identity;
  };
  if (
    preview.inputTemplate === null ||
    canonicalJson(binding(input)) !==
      canonicalJson(binding(preview.inputTemplate))
  )
    throw staleRetry();
  if (preview.status === 'grant-required') {
    return {
      status: 'grant-required' as const,
      ...requestExecutionReplacement(dependencies, cwd, jobId, {
        timeoutMs: input.timeoutMs ?? source.request.limits.timeoutMs,
        retryExplanation: input.retryExplanation,
      }),
    };
  }
  if (preview.status !== 'ready') {
    throw workflowError(
      preview.reasonCode,
      'The retry is not currently admitted.',
      ExitCode.guard,
    );
  }
  return {
    status: 'retried' as const,
    result: dependencies.resumePropose(cwd, input.changeId, input, options),
  };
}

function parseRetryInput(value: unknown): RetryInput {
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'provider-retry'
  ) {
    return assertProviderRetryEnvelope(value);
  }
  return assertPlanReviewRetryEnvelope(value);
}

function staleRetry() {
  return workflowError(
    'EXECUTION_RETRY_INPUT_STALE',
    'The retry input does not match this Job and failed Attempt.',
    ExitCode.staleState,
  );
}
