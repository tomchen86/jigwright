import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blindSurveyOutputValidator,
  matchesPersistedProviderOutputSchema,
  providerOutputSchemaGeneration,
  providerOutputValidator,
  semanticContract,
} from '../src/modules/assurance/provider-output-contract.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/provider-orchestration/blind-survey-output.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const contracts = [
  [
    'survey',
    BLIND_SURVEY_OUTPUT_SCHEMA,
    BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
    null,
  ],
  [
    'plan-review',
    PLAN_REVIEW_OUTPUT_SCHEMA,
    PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
    PLAN_REVIEW_OUTPUT_VALIDATOR,
  ],
  [
    'task-diff-review',
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  ],
  [
    'task-diff-review',
    TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  ],
  [
    'task-implementation',
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  ],
] as const;

function request(
  purpose: ProviderInvocationRequest['purpose'],
  outputSchema: ProviderInvocationRequest['outputSchema'],
) {
  // Schema selection consumes these facts from an already admitted request.
  return {
    invocationId: 'survey-one',
    purpose,
    outputSchema,
  } as ProviderInvocationRequest;
}

const unsupported = (message: string) => (error: unknown) =>
  error instanceof WorkflowError &&
  error.code === 'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED' &&
  error.message === message;
const schemaError = unsupported(
  'Provider invocation does not reference a code-owned output schema.',
);
const semanticError = unsupported(
  'Provider invocation does not reference a code-owned semantic contract.',
);

for (const [purpose, descriptor, schema, validator] of contracts) {
  test(`${descriptor.id}: selects exact code-owned references and rejects each mismatched schema field`, () => {
    const observed = request(purpose, descriptor);
    assert.equal(providerOutputSchemaGeneration(observed), 'code-owned');
    const selected = semanticContract(observed);
    assert.equal(selected.schema, schema);
    if (validator !== null) {
      assert.equal(selected.validator, validator);
      assert.equal(providerOutputValidator(observed), validator);
    } else {
      const value = {
        reference: observed.invocationId,
        terms: [{ kind: 'symbol', value: 'runWorker' }],
      };
      assert.equal(selected.validator.validate(value), true);
      assert.equal(providerOutputValidator(observed).validate(value), true);
    }
    assert.equal(
      matchesPersistedProviderOutputSchema(descriptor, descriptor),
      true,
    );
    for (const field of ['id', 'version', 'digest'] as const) {
      const altered = {
        ...descriptor,
        [field]: field === 'version' ? 99 : 'unsupported',
      };
      const invalid = request(purpose, altered);
      assert.equal(
        matchesPersistedProviderOutputSchema(altered, descriptor),
        false,
      );
      assert.throws(() => semanticContract(invalid), semanticError);
      assert.throws(() => providerOutputSchemaGeneration(invalid), schemaError);
      assert.throws(() => providerOutputValidator(invalid), schemaError);
    }
  });
}

test('unknown purpose and the two unsupported contracts remain distinct', () => {
  const observed = request(
    'unknown' as ProviderInvocationRequest['purpose'],
    BLIND_SURVEY_OUTPUT_SCHEMA,
  );
  assert.throws(() => semanticContract(observed), semanticError);
  assert.throws(() => providerOutputValidator(observed), schemaError);
  assert.throws(
    () =>
      blindSurveyOutputValidator(
        request('plan-review', PLAN_REVIEW_OUTPUT_SCHEMA),
      ),
    schemaError,
  );
});

test('survey admission repeats schema verification and validator reads the original request identity late', () => {
  let digestReads = 0;
  const observed = request('survey', {
    ...BLIND_SURVEY_OUTPUT_SCHEMA,
    get digest() {
      return ++digestReads === 1
        ? BLIND_SURVEY_OUTPUT_SCHEMA.digest
        : 'changed-after-selection';
    },
  });
  assert.throws(() => semanticContract(observed), schemaError);
  assert.equal(digestReads, 2);

  observed.outputSchema = BLIND_SURVEY_OUTPUT_SCHEMA;
  const validator = semanticContract(observed).validator;
  observed.invocationId = 'survey-two';
  const terms = [{ kind: 'symbol', value: 'runWorker' }];
  assert.equal(validator.validate({ reference: 'survey-one', terms }), false);
  assert.equal(validator.validate({ reference: 'survey-two', terms }), true);
});

test('schema comparison preserves short-circuit field reads', () => {
  const observed = {
    id: 'wrong',
    get version(): number {
      return assert.fail('id mismatch must short circuit version');
    },
    get digest(): string {
      return assert.fail('id mismatch must short circuit digest');
    },
  };
  assert.equal(
    matchesPersistedProviderOutputSchema(observed, BLIND_SURVEY_OUTPUT_SCHEMA),
    false,
  );
  assert.throws(
    () => semanticContract(request('survey', observed)),
    semanticError,
  );
});
