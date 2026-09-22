import {
  sha256,
  parseObservedCheckFailure,
  type CheckEvidence,
} from '../src/foundation/check-evidence/check-evidence.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckRegistryPortV1 } from '@jigwright/core/check-registry-port';
import {
  runRequiredChecks,
  runRegisteredCheck,
} from '../src/application/assurance/check-execution.ts';
import type {
  CheckExecutionPort,
  CheckRepositoryValidation,
  CheckCheckoutObservation,
} from '../src/modules/assurance/check-execution-port.ts';

const repository = {
  repositoryRoot: '/fixture',
  head: 'head',
  statusEntryCount: 0,
};
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

function fixture() {
  const events: string[] = [];
  const state = {
    databaseError: false,
    pinFailure: '',
    executionFailure: '',
    failedOutcome: '',
    passed: [] as CheckEvidence[],
    observation: {
      head: 'head',
      statusEntryCount: 0,
      fingerprint: 'same',
    } as CheckCheckoutObservation,
    afterExecution() {},
  };
  const registry: CheckRegistryPortV1 = {
    contractVersion: 'jigwright.check-registry-port.v1',
    load(root) {
      assert.equal(root, '/fixture');
      events.push('load');
      return {
        schemaVersion: 1,
        checks: {
          first: { command: ['node', 'first.mjs'], destructiveDatabase: false },
          second: {
            command: ['node', 'second.mjs'],
            destructiveDatabase: true,
          },
        },
      };
    },
  };
  const execution: CheckExecutionPort = {
    preflightDatabase() {
      events.push('database');
      if (state.databaseError) throw new Error('no disposable database');
      return 'redacted database';
    },
    pin(check, databaseIdentity) {
      events.push(`pin:${check.checkId}`);
      if (state.pinFailure === check.checkId) throw new Error('pin failed');
      assert.equal(
        databaseIdentity,
        check.definition.destructiveDatabase ? 'redacted database' : undefined,
      );
      return {
        runner: {
          runner: check.definition.command[1]!,
          executable: check.definition.command[0]!,
          args: check.definition.command.slice(1),
          digest: 'digest',
        },
        execute() {
          events.push(`run:${check.checkId}`);
          if (state.executionFailure === check.checkId)
            throw new Error('check failed');
          state.afterExecution();
          if (state.failedOutcome === check.checkId) {
            const body = {
              checkId: check.checkId,
              outcome: 'failed' as const,
              exitCode: 7,
              stdoutDigest: sha256(''),
              stderrDigest: sha256(''),
              stdoutExcerpt: '',
              stderrExcerpt: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              runner: check.definition.command[1]!,
              runnerDigest: sha256('runner'),
            };
            return parseObservedCheckFailure({
              ...body,
              failureFingerprint: sha256(canonicalJson(body)),
            });
          }
          const evidence: CheckEvidence = {
            checkId: check.checkId,
            outcome: 'passed',
            exitCode: 0,
            runner: check.definition.command[1]!,
            runnerDigest: 'digest',
            destructiveDatabase: check.definition.destructiveDatabase,
            ...(databaseIdentity ? { databaseIdentity } : {}),
          };
          state.passed.push(evidence);
          return evidence;
        },
      };
    },
  };
  const validation: CheckRepositoryValidation = {
    observe(head) {
      assert.equal(head, 'head');
      events.push('observe');
      return { ...state.observation };
    },
    validate(mode, head) {
      assert.equal(head, 'head');
      events.push(`validate:${mode}`);
    },
  };
  return { events, state, registry, execution, validation };
}

for (const mode of ['live-current-ref', 'immutable-head'] as const) {
  test(`shared checks preflight once, pin all runners and retain ${mode} validation`, () => {
    const f = fixture();
    const evidence = runRequiredChecks(
      '/fixture',
      'head',
      ['first', 'second'],
      f.registry,
      f.execution,
      f.validation,
      mode,
    );
    assert.deepEqual(f.events, [
      'load',
      'database',
      'pin:first',
      'pin:second',
      'observe',
      'run:first',
      'observe',
      'run:second',
      'observe',
      `validate:${mode}`,
    ]);
    assert.deepEqual(
      evidence.map((e) => e.checkId),
      ['first', 'second'],
    );
    assert.equal(evidence[0], f.state.passed[0]);
    assert.equal(evidence[1], f.state.passed[1]);
    assert.equal(evidence[0]!.databaseIdentity, undefined);
    assert.equal(evidence[1]!.databaseIdentity, 'redacted database');
  });
}

test('failed database preflight or later runner pin starts no checks', () => {
  for (const failure of ['database', 'pin'] as const) {
    const f = fixture();
    if (failure === 'database') f.state.databaseError = true;
    else f.state.pinFailure = 'second';
    assert.throws(
      () =>
        runRequiredChecks(
          '/fixture',
          'head',
          ['first', 'second'],
          f.registry,
          f.execution,
          f.validation,
          'immutable-head',
        ),
      /no disposable database|pin failed/,
    );
    assert.deepEqual(
      f.events,
      failure === 'database'
        ? ['load', 'database']
        : ['load', 'database', 'pin:first', 'pin:second'],
    );
  }
});

test('nonzero execution stops later checks and final validation', () => {
  const f = fixture();
  f.state.executionFailure = 'first';
  assert.throws(
    () =>
      runRequiredChecks(
        '/fixture',
        'head',
        ['first', 'second'],
        f.registry,
        f.execution,
        f.validation,
        'live-current-ref',
      ),
    /check failed/,
  );
  assert.deepEqual(f.events, [
    'load',
    'database',
    'pin:first',
    'pin:second',
    'observe',
    'run:first',
  ]);
});

for (const mutation of ['head', 'statusEntryCount', 'fingerprint'] as const) {
  test(`changed ${mutation} after one check refuses subsequent execution`, () => {
    const f = fixture();
    f.state.afterExecution = () => {
      f.state.observation = {
        ...f.state.observation,
        [mutation]: mutation === 'statusEntryCount' ? 1 : 'changed',
      };
    };
    assert.throws(
      () =>
        runRequiredChecks(
          '/fixture',
          'head',
          ['first', 'second'],
          f.registry,
          f.execution,
          f.validation,
          'immutable-head',
        ),
      hasCode('CI_CHECK_MUTATED_WORKTREE'),
    );
    assert.deepEqual(f.events, [
      'load',
      'database',
      'pin:first',
      'pin:second',
      'observe',
      'run:first',
      'observe',
    ]);
  });
}

test('empty selection still observes and validates the immutable head without database access', () => {
  const f = fixture();
  assert.deepEqual(
    runRequiredChecks(
      '/fixture',
      'head',
      [],
      f.registry,
      f.execution,
      f.validation,
      'immutable-head',
    ),
    [],
  );
  assert.deepEqual(f.events, ['load', 'observe', 'validate:immutable-head']);
});

test('registered check uses the shared run and validates the current live repository', () => {
  const f = fixture();
  const result = runRegisteredCheck(
    repository,
    'first',
    f.registry,
    f.execution,
    f.validation,
  );
  assert.equal(result.head, 'head');
  assert.equal(result.check.checkId, 'first');
  assert.deepEqual(f.events, [
    'load',
    'load',
    'pin:first',
    'observe',
    'run:first',
    'observe',
    'validate:live-current-ref',
  ]);
});

test('registered checks refuse dirty, unknown and destructive selections before execution', () => {
  for (const failure of ['dirty', 'unknown', 'destructive'] as const) {
    const f = fixture();
    const input =
      failure === 'dirty' ? { ...repository, statusEntryCount: 1 } : repository;
    const check = failure === 'unknown' ? 'absent' : 'second';
    const code =
      failure === 'dirty'
        ? 'STANDALONE_CHECK_DIRTY_WORKTREE'
        : failure === 'unknown'
          ? 'CI_CHECK_UNKNOWN'
          : 'STANDALONE_DESTRUCTIVE_CHECK';
    assert.throws(
      () =>
        runRegisteredCheck(input, check, f.registry, f.execution, f.validation),
      hasCode(code),
    );
    assert.deepEqual(f.events, failure === 'dirty' ? [] : ['load']);
  }
});

test('ordinary failed outcome throws CHECK_FAILED before CI observes a mutated checkout', () => {
  const f = fixture();
  f.state.failedOutcome = 'first';
  f.state.afterExecution = () => {
    f.state.observation = { ...f.state.observation, fingerprint: 'changed' };
  };
  assert.throws(
    () =>
      runRequiredChecks(
        '/fixture',
        'head',
        ['first', 'second'],
        f.registry,
        f.execution,
        f.validation,
        'immutable-head',
      ),
    (error: unknown) => {
      assert.ok(hasCode('CHECK_FAILED')(error));
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Required check first exited non-zero.');
      assert.equal((error as Error & { exitCode: number }).exitCode, 13);
      assert.deepEqual((error as Error & { details: unknown }).details, {
        checkId: 'first',
        exitCode: 7,
        signal: null,
      });
      return true;
    },
  );
  assert.deepEqual(f.events, [
    'load',
    'database',
    'pin:first',
    'pin:second',
    'observe',
    'run:first',
  ]);
});

test('selected check order and duplicates are preserved without unnecessary database access', () => {
  const f = fixture();
  const result = runRequiredChecks(
    '/fixture',
    'head',
    ['first', 'first'],
    f.registry,
    f.execution,
    f.validation,
    'immutable-head',
  );
  assert.deepEqual(
    result.map(({ checkId }) => checkId),
    ['first', 'first'],
  );
  assert.deepEqual(f.events, [
    'load',
    'pin:first',
    'pin:first',
    'observe',
    'run:first',
    'observe',
    'run:first',
    'observe',
    'validate:immutable-head',
  ]);
});
