import assert from 'node:assert/strict';
import { builtInProviderAdapters } from '../src/composition-root/built-in-provider-adapter-production.ts';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { extractProviderRepairFailure } from '../src/runtime/storage-journal/provider-execution-governance.ts';
import { createProviderRunnerForTesting } from '../src/runtime/provider-execution/provider-runner.ts';
import { sourceRepositoryRoot } from './fixture.ts';
import {
  PROVIDER_SCHEMA,
  createRunnerFixture,
  semanticOutput,
  siblingRunnerInput,
  bindRunnerInputToInvestigationOwner,
  successfulProbe,
  claudeRunnerHost,
  codexRunnerHost,
  writeProviderSlot,
  isWorkflowError,
} from './provider-adapter-fixture.ts';

test('runner enforces native output, aggregate limit, and executable identity', () => {
  for (const [name, execute, code] of [
    [
      'malformed wrapper',
      () => successfulProbe('not-json'),
      'PROVIDER_NATIVE_OUTPUT_INVALID',
    ],
    [
      'non-zero process',
      () => ({ ...successfulProbe(''), exitCode: 7 }),
      'PROVIDER_PROCESS_NONZERO',
    ],
    [
      'aggregate output',
      () => successfulProbe('x'.repeat(1_048_577)),
      'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    try {
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            builtInProviderAdapters,
            claudeRunnerHost(execute),
          ).run(fixture.input, {
            platform: 'darwin',
          }),
        (error) => isWorkflowError(error, code),
        name,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('malformed native output yields bounded redacted repair feedback', () => {
  const fixture = createRunnerFixture();
  const malformed = 'not-json secret-that-must-not-enter-repair-evidence';
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          builtInProviderAdapters,
          claudeRunnerHost(() => successfulProbe(malformed)),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'schema');
        assert.deepEqual(repair.previousOutput, {
          kind: 'provider-native-output-unavailable',
          reasonCode: 'NATIVE_JSON_PARSE_FAILED',
        });
        assert.deepEqual(repair.validationErrors, [
          {
            path: '/',
            code: 'NATIVE_JSON_PARSE_FAILED',
            message:
              'Provider native output was not valid JSON; return one complete object matching the target schema.',
          },
        ]);
        const encoded = canonicalJson(repair);
        assert.ok(Buffer.byteLength(encoded, 'utf8') < 300_000);
        assert.equal(encoded.includes(malformed), false);
        assert.equal(encoded.includes('secret-that-must-not-enter'), false);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('missing Codex semantic payload yields the same bounded repair contract', () => {
  const fixture = createRunnerFixture('codex');
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          builtInProviderAdapters,
          codexRunnerHost(() => successfulProbe('{"type":"turn.completed"}\n')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.deepEqual(repair.previousOutput, {
          kind: 'provider-native-output-unavailable',
          reasonCode: 'NATIVE_JSON_PARSE_FAILED',
        });
        assert.deepEqual(
          repair.validationErrors.map(({ path, code }) => ({ path, code })),
          [{ path: '/', code: 'NATIVE_JSON_PARSE_FAILED' }],
        );
        assert.ok(Buffer.byteLength(canonicalJson(repair), 'utf8') < 300_000);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('real runner returns bounded structured schema feedback for a repair Attempt', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          builtInProviderAdapters,
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: {
                  reference: 7,
                  terms: [],
                },
              }),
            ),
          ),
        ).run(
          {
            ...fixture.input,
            outputValidator: {
              ...fixture.input.outputValidator,
              validate: () => false,
            },
          },
          { platform: 'darwin' },
        ),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'schema');
        assert.deepEqual(repair.previousOutput, {
          reference: 7,
          terms: [],
        });
        assert.deepEqual(
          repair.validationErrors.map(({ path, code }) => ({ path, code })),
          [{ path: '/reference', code: 'TYPE_STRING_REQUIRED' }],
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('real runner distinguishes semantic feedback after structural validation passes', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          builtInProviderAdapters,
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            ),
          ),
        ).run(
          {
            ...fixture.input,
            outputValidator: {
              ...fixture.input.outputValidator,
              validate: () => false,
            },
          },
          { platform: 'darwin' },
        ),
      (error) => {
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'semantic');
        assert.deepEqual(repair.validationErrors, [
          {
            path: '/',
            code: 'SEMANTIC_VALIDATION_FAILED',
            message:
              'Output matched the structural schema but failed the bound semantic validator.',
          },
        ]);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('Codex semantic output file and normalized output count toward the aggregate cap', () => {
  const fixture = createRunnerFixture('codex', 1024);
  try {
    const oversized = {
      reference: fixture.request.invocationId,
      terms: [{ kind: 'symbol', value: 'x'.repeat(1500) }],
    };
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          builtInProviderAdapters,
          codexRunnerHost((input) => {
            const outputIndex = input.args.indexOf('--output-last-message');
            assert.ok(outputIndex >= 0);
            fs.writeFileSync(
              input.args[outputIndex + 1]!,
              JSON.stringify(oversized),
            );
            return successfulProbe('{"type":"turn.completed"}\n');
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('provider concurrency is bounded repository-wide and slots release in finally', () => {
  const fixture = createRunnerFixture();
  const outerInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-provider-concurrency-outer',
  );
  const second = bindRunnerInputToInvestigationOwner(
    siblingRunnerInput(fixture, 'invocation-adapter-second'),
    'investigation-provider-concurrency-second',
  );
  const third = bindRunnerInputToInvestigationOwner(
    siblingRunnerInput(fixture, 'invocation-adapter-third'),
    'investigation-provider-concurrency-third',
  );
  let thirdLaunches = 0;
  try {
    const thirdRunner = createProviderRunnerForTesting(
      builtInProviderAdapters,
      claudeRunnerHost(() => {
        thirdLaunches += 1;
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(third.request),
          }),
        );
      }),
    );
    const secondRunner = createProviderRunnerForTesting(
      builtInProviderAdapters,
      claudeRunnerHost(() => {
        assert.throws(
          () => thirdRunner.run(third, { platform: 'darwin' }),
          (error) => isWorkflowError(error, 'PROVIDER_CONCURRENCY_LIMIT'),
        );
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(second.request),
          }),
        );
      }),
    );
    const outerRunner = createProviderRunnerForTesting(
      builtInProviderAdapters,
      claudeRunnerHost(() => {
        const nested = secondRunner.run(second, { platform: 'darwin' });
        assert.equal(nested.assurance, 'unchanged-governed-projection');
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        );
      }),
    );

    const outer = outerRunner.run(outerInput, { platform: 'darwin' });
    assert.equal(outer.assurance, 'unchanged-governed-projection');
    assert.equal(thirdLaunches, 0);

    const afterRelease = thirdRunner.run(third, { platform: 'darwin' });
    assert.equal(afterRelease.assurance, 'unchanged-governed-projection');
    assert.equal(thirdLaunches, 1);
  } finally {
    fixture.cleanup();
  }
});

test('provider concurrency reclaims dead owners and honors a lowered limit', () => {
  const reclaimable = createRunnerFixture();
  try {
    writeProviderSlot(reclaimable.repository, 0, 999_999_991);
    writeProviderSlot(reclaimable.repository, 1, 999_999_992);
    const report = createProviderRunnerForTesting(
      builtInProviderAdapters,
      claudeRunnerHost(() =>
        successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(reclaimable.request),
          }),
        ),
      ),
    ).run(reclaimable.input, { platform: 'darwin' });
    assert.equal(report.assurance, 'unchanged-governed-projection');
  } finally {
    reclaimable.cleanup();
  }

  const lowered = createRunnerFixture('claude', 1_048_576, 1);
  try {
    writeProviderSlot(lowered.repository, 1, process.pid);
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          builtInProviderAdapters,
          claudeRunnerHost(() => successfulProbe('')),
        ).run(lowered.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_CONCURRENCY_LIMIT'),
    );
  } finally {
    lowered.cleanup();
  }
});

test('tracked policy is managed-lifecycle-only and diagnostic remains non-launching', () => {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  assert.equal(policy.schemaVersion, 4);
  assert.equal(policy.mode, 'managed-read-only');
  assert.equal(policy.launchPolicy, 'lifecycle-only');

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/ai-adapter-policy.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(schema.properties.schemaVersion.const, 4);
  assert.equal(schema.properties.mode.const, 'managed-read-only');
  assert.equal(schema.properties.launchPolicy.const, 'lifecycle-only');
});
