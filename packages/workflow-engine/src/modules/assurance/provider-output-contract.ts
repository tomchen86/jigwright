/** Code-owned semantic schemas and validators for provider execution and durable results. */
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ProviderInvocationRequest } from '../provider-orchestration/provider-contracts.ts';
import type { ProviderOutputSchemaGeneration } from '../provider-orchestration/provider-invocation-lifecycle.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  validateBlindSurveyOutput,
} from '../provider-orchestration/blind-survey-output.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from './plan-review.ts';
import {
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from './task-diff-review-artifact.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
} from '../provider-orchestration/task-strategy-provider-contract.ts';

function providerOutputSchemaUnsupported() {
  return workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned output schema.',
    ExitCode.verification,
  );
}

function codeOwnedProviderOutputSchema(request: ProviderInvocationRequest) {
  if (request.purpose === 'survey') {
    return BLIND_SURVEY_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'plan-review') {
    return PLAN_REVIEW_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'task-diff-review') {
    if (
      request.outputSchema.id === TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id
    ) {
      return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA;
    }
    return TASK_DIFF_REVIEW_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'task-implementation') {
    return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA;
  }
  throw providerOutputSchemaUnsupported();
}

export function providerOutputSchemaGeneration(
  request: ProviderInvocationRequest,
): ProviderOutputSchemaGeneration {
  const codeOwned = codeOwnedProviderOutputSchema(request);
  if (
    request.outputSchema.id !== codeOwned.id ||
    request.outputSchema.version !== codeOwned.version ||
    request.outputSchema.digest !== codeOwned.digest
  ) {
    throw providerOutputSchemaUnsupported();
  }
  return 'code-owned';
}

export function matchesPersistedProviderOutputSchema(
  observed: ProviderInvocationRequest['outputSchema'],
  current: Readonly<{ id: string; version: number; digest: string }>,
): boolean {
  return (
    observed.id === current.id &&
    observed.version === current.version &&
    observed.digest === current.digest
  );
}

export function blindSurveyOutputValidator(request: ProviderInvocationRequest) {
  if (
    request.purpose !== 'survey' ||
    providerOutputSchemaGeneration(request) !== 'code-owned'
  ) {
    throw providerOutputSchemaUnsupported();
  }
  return {
    ...BLIND_SURVEY_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      return validateBlindSurveyOutput(value, request.invocationId);
    },
  };
}

export function providerOutputValidator(request: ProviderInvocationRequest) {
  if (providerOutputSchemaGeneration(request) !== 'code-owned') {
    throw providerOutputSchemaUnsupported();
  }
  if (request.purpose === 'survey') {
    return blindSurveyOutputValidator(request);
  }
  if (request.purpose === 'plan-review') {
    return PLAN_REVIEW_OUTPUT_VALIDATOR;
  }
  if (request.purpose === 'task-diff-review') {
    if (
      request.outputSchema.id ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id &&
      request.outputSchema.version ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version &&
      request.outputSchema.digest ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest
    ) {
      return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR;
    }
    return TASK_DIFF_REVIEW_OUTPUT_VALIDATOR;
  }
  if (request.purpose === 'task-implementation') {
    return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR;
  }
  throw providerOutputSchemaUnsupported();
}

export function semanticContract(request: ProviderInvocationRequest) {
  if (
    request.purpose === 'survey' &&
    request.outputSchema.id === BLIND_SURVEY_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === BLIND_SURVEY_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === BLIND_SURVEY_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
      validator: blindSurveyOutputValidator(request),
    };
  }
  if (
    request.purpose === 'plan-review' &&
    request.outputSchema.id === PLAN_REVIEW_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === PLAN_REVIEW_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === PLAN_REVIEW_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
      validator: PLAN_REVIEW_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-diff-review' &&
    request.outputSchema.id ===
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id &&
    request.outputSchema.version ===
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest ===
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-diff-review' &&
    request.outputSchema.id === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-implementation' &&
    request.outputSchema.id === TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.id &&
    request.outputSchema.version ===
      TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest ===
      TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
    };
  }
  throw workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned semantic contract.',
    ExitCode.verification,
  );
}
