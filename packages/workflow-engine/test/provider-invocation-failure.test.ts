import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProviderInvocationFailure } from '../src/modules/provider-orchestration/provider-invocation-failure.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';

const probe = { kind: 'file-read', target: 'src/input.ts', timeoutMs: 1_000 };
const errorFor = (
  code: string,
  details?: Record<string, unknown>,
  message = 'Observed failure.',
) => workflowError(code, message, ExitCode.verification, { details });

for (const code of [
  'PROVIDER_CONTEXT_STALE_OR_WRONG',
  'PROVIDER_ACCEPTANCE_BINDING_STALE',
  'PROVIDER_REPAIR_AUTHORITY_STALE',
  'PROVIDER_INVOCATION_TERMINALLY_RESOLVED',
  'EXECUTION_CONTEXT_CAS_MISMATCH',
  'EXECUTION_CONTEXT_STALE_EPOCH',
  'EXECUTION_CONTEXT_STALE_MANIFEST',
]) {
  test(`${code} preserves reconciliation facts even with retry and probe details`, () => {
    assert.deepEqual(
      classifyProviderInvocationFailure(
        errorFor(code, { retryAfterMs: 0, probe }),
      ),
      {
        kind: 'repository-reconciliation-required',
        code,
        message: `Provider invocation failed durably (${code}): Observed failure.`,
        executionKind: 'unknown-side-effect',
        retryAfterMs: 0,
      },
    );
  });
}

for (const [code, executionKind] of [
  ['PROVIDER_TIMEOUT', 'provider-timeout'],
  ['NETWORK_TRANSIENT', 'network'],
  ['PROVIDER_RATE_LIMIT', 'rate-limit'],
  ['PROVIDER_PROCESS_CRASH', 'provider-process-crash'],
  ['PROVIDER_UNAVAILABLE', 'provider-capacity'],
  ['PROVIDER_CAPACITY', 'provider-capacity'],
  ['PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'stdout-truncated'],
  ['PROVIDER_PROCESS_NONZERO', 'process-nonzero'],
  ['PROVIDER_NATIVE_OUTPUT_INVALID', 'schema-mismatch'],
  ['OUTPUT_JSON_PARSE_FAILED', 'json-parse'],
  ['OUTPUT_SCHEMA_MISMATCH', 'schema-mismatch'],
  ['OUTPUT_REQUIRED_FIELD_MISSING', 'missing-required-field'],
  ['OUTPUT_CITATION_OUT_OF_RANGE', 'citation-out-of-range'],
  ['ENVIRONMENT_PROBE_TRANSIENT', 'probe-transient'],
  ['NEEDS_USER_DECISION', 'needs-user-decision'],
  ['STATE_CORRUPTION', 'state-corruption'],
  ['PROVIDER_WORKER_UNEXPECTED_FAILURE', 'worker-crash'],
] as const) {
  test(`${code} preserves its exact execution failure kind`, () => {
    assert.deepEqual(
      classifyProviderInvocationFailure(errorFor(code, { probe })),
      {
        kind: 'retryable',
        code,
        message: `Provider invocation failed durably (${code}): Observed failure.`,
        executionKind,
        ...(code === 'ENVIRONMENT_PROBE_TRANSIENT' ? { probe } : {}),
      },
    );
  });
}

test('unmapped and cancellation codes do not acquire a guessed execution kind', () => {
  for (const code of [
    'CUSTOM_NETWORK_FAILURE',
    'PROVIDER_INVOCATION_LEASE_EXPIRED',
    'PROVIDER_PROCESS_CANCELLED',
    'AGENT_RUNTIME_V1_CANCELLED',
    'provider_timeout',
  ]) {
    const failure = classifyProviderInvocationFailure(
      errorFor(code, { probe, retryAfterMs: 23 }),
    );
    assert.equal(failure.code, code);
    assert.equal(failure.kind, 'retryable');
    assert.equal(failure.retryAfterMs, 23);
    assert.equal(Object.hasOwn(failure, 'executionKind'), false);
    assert.equal(Object.hasOwn(failure, 'probe'), false);
  }
});

test('only WorkflowError supplies code and details while other throws retain their reason', () => {
  const lookalike = {
    code: 'PROVIDER_RATE_LIMIT',
    details: { probe, retryAfterMs: 3 },
    toString: () => 'lookalike reason',
  };
  for (const [thrown, reason] of [
    [new TypeError('adapter failed'), 'TypeError: adapter failed'],
    [lookalike, 'lookalike reason'],
    ['raw reason', 'raw reason'],
    [null, 'null'],
    [undefined, 'undefined'],
    [17, '17'],
    [Symbol('failure'), 'Symbol(failure)'],
  ] as const) {
    assert.deepEqual(classifyProviderInvocationFailure(thrown), {
      kind: 'retryable',
      code: 'PROVIDER_WORKER_UNEXPECTED_FAILURE',
      message: `Provider invocation failed durably (PROVIDER_WORKER_UNEXPECTED_FAILURE): ${reason}`,
      executionKind: 'worker-crash',
    });
  }
});

test('durable reason preserves text with original whitespace, empty and UTF-16 bounds', () => {
  assert.equal(
    classifyProviderInvocationFailure(
      errorFor('CUSTOM', undefined, ' \n alpha\t beta  '),
    ).message,
    'Provider invocation failed durably (CUSTOM): alpha beta',
  );
  assert.equal(
    classifyProviderInvocationFailure(errorFor('CUSTOM', undefined, ' \n\t '))
      .message,
    'Provider invocation failed durably (CUSTOM).',
  );
  assert.equal(
    classifyProviderInvocationFailure('').message,
    'Provider invocation failed durably (PROVIDER_WORKER_UNEXPECTED_FAILURE).',
  );
  assert.equal(
    classifyProviderInvocationFailure(
      errorFor('CUSTOM', undefined, 'x'.repeat(513)),
    ).message,
    `Provider invocation failed durably (CUSTOM): ${'x'.repeat(512)}`,
  );
  assert.equal(
    classifyProviderInvocationFailure(
      errorFor('CUSTOM', undefined, 'x'.repeat(511) + '😀z'),
    ).message,
    `Provider invocation failed durably (CUSTOM): ${'x'.repeat(511)}\ud83d`,
  );
});

for (const value of [0, 86_400_000]) {
  test(`Retry-After accepts inclusive endpoint ${value}`, () => {
    const failure = classifyProviderInvocationFailure(
      errorFor('CUSTOM', { retryAfterMs: value }),
    );
    assert.equal(Object.hasOwn(failure, 'retryAfterMs'), true);
    assert.equal(failure.retryAfterMs, value);
  });
}

test('Retry-After rejects noninteger, nonnumeric and out-of-range values without own fields', () => {
  for (const value of [
    -1,
    86_400_001,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1000',
    null,
    undefined,
  ]) {
    assert.equal(
      Object.hasOwn(
        classifyProviderInvocationFailure(
          errorFor('PROVIDER_RATE_LIMIT', { retryAfterMs: value }),
        ),
        'retryAfterMs',
      ),
      false,
    );
  }
});

test('exact probe is admitted as a new frozen value and input remains untouched', () => {
  const original = { ...probe };
  const failure = classifyProviderInvocationFailure(
    errorFor('ENVIRONMENT_PROBE_TRANSIENT', { probe: original }),
  );
  assert.deepEqual(failure.probe, original);
  assert.notEqual(failure.probe, original);
  assert.equal(Object.isFrozen(failure.probe), true);
  assert.equal(Object.isFrozen(failure), false);
  assert.equal(Object.isFrozen(original), false);
});

test('missing or invalid probes cannot produce probe-transient evidence', () => {
  for (const candidate of [
    undefined,
    null,
    { ...probe, kind: 'run-command' },
    { ...probe, target: '../outside' },
    { ...probe, timeoutMs: 0 },
    { ...probe, timeoutMs: 30_001 },
    { ...probe, extra: true },
    { kind: 'file-read', timeoutMs: 1_000 },
  ]) {
    const failure = classifyProviderInvocationFailure(
      errorFor('ENVIRONMENT_PROBE_TRANSIENT', { probe: candidate }),
    );
    assert.equal(failure.kind, 'retryable');
    assert.equal(Object.hasOwn(failure, 'probe'), false);
    assert.equal(Object.hasOwn(failure, 'executionKind'), false);
  }
});

test('the first probe property read remains outside the catch', () => {
  const failure = new Error('first probe getter failed');
  const error = errorFor('ENVIRONMENT_PROBE_TRANSIENT', {
    get probe() {
      throw failure;
    },
  });
  assert.throws(
    () => classifyProviderInvocationFailure(error),
    (actual) => actual === failure,
  );
});

test('a second probe property read failure is swallowed at the original codec boundary', () => {
  let reads = 0;
  const error = errorFor('ENVIRONMENT_PROBE_TRANSIENT', {
    get probe() {
      if (++reads === 2) throw new Error('second probe getter failed');
      return probe;
    },
  });
  const failure = classifyProviderInvocationFailure(error);
  assert.equal(reads, 2);
  assert.equal(Object.hasOwn(failure, 'executionKind'), false);
  assert.equal(Object.hasOwn(failure, 'probe'), false);
});

test('codec property failures become absent probe evidence', () => {
  const failure = classifyProviderInvocationFailure(
    errorFor('ENVIRONMENT_PROBE_TRANSIENT', {
      probe: {
        get kind() {
          throw new Error('probe kind failed');
        },
        timeoutMs: 1_000,
      },
    }),
  );
  assert.equal(Object.hasOwn(failure, 'executionKind'), false);
  assert.equal(Object.hasOwn(failure, 'probe'), false);
});

test('irrelevant probe is still read twice before Retry-After and then omitted', () => {
  const events: string[] = [];
  const failure = classifyProviderInvocationFailure(
    errorFor('PROVIDER_TIMEOUT', {
      get probe() {
        events.push('probe');
        return probe;
      },
      get retryAfterMs() {
        events.push('retry-after');
        return 3;
      },
    }),
  );
  assert.deepEqual(events, ['probe', 'probe', 'retry-after']);
  assert.equal(Object.hasOwn(failure, 'probe'), false);
  assert.equal(failure.retryAfterMs, 3);
});

test('Retry-After getter errors propagate instead of silently dropping evidence', () => {
  const failure = new Error('retry-after getter failed');
  assert.throws(
    () =>
      classifyProviderInvocationFailure(
        errorFor('PROVIDER_RATE_LIMIT', {
          get retryAfterMs() {
            throw failure;
          },
        }),
      ),
    (actual) => actual === failure,
  );
});
