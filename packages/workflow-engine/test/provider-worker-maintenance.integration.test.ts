import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import {
  listProviderWorkerMaintenanceWarnings,
  recordProviderWorkerTerminalWarning,
} from '../src/runtime/storage-journal/provider-worker-maintenance.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';

function fixture(t: TestContext, state: 'succeeded' | 'failed' = 'succeeded') {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-warning-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = investigationRuntimePaths(directory, 'workflow-engine');
  // Journal consumes these admitted terminal fields, not unrelated invocation details.
  const terminal = Object.freeze({
    invocationId: 'invocation-warning',
    revision: 7,
    state,
    updatedAt: '2030-08-29T02:00:00.000Z',
  }) as ProviderInvocationRecord;
  const warnings: unknown[][] = [];
  t.mock.method(
    process,
    'emitWarning',
    function (this: unknown, ...args: unknown[]) {
      assert.equal(this, process);
      warnings.push(args);
    },
  );
  return { directory, runtime, terminal, warnings };
}

for (const state of ['succeeded', 'failed'] as const) {
  test(`warning records exact ${state} facts with fresh observation and durable replay deduplication`, (t) => {
    const f = fixture(t, state);
    const original = { ...f.terminal };
    const error = workflowError(
      'RETENTION_FIXTURE_FAILURE',
      'private original failure',
      ExitCode.verification,
    );
    const otherRuntime = investigationRuntimePaths(
      f.directory,
      'second-runtime',
    );
    let current = f.runtime;
    const observations: string[] = [];
    function observe(this: unknown, cwd: string) {
      assert.equal(this, undefined);
      observations.push(cwd);
      return current;
    }
    assert.equal(observations.length, 0);
    assert.equal(fs.existsSync(f.runtime.root), false);
    assert.equal(
      recordProviderWorkerTerminalWarning(
        observe,
        '/repo',
        f.terminal,
        'retention-maintenance',
        error,
      ),
      undefined,
    );
    const [warning] = listProviderWorkerMaintenanceWarnings(f.runtime);
    assert.ok(warning);
    assert.deepEqual(
      { ...warning, warningId: '<identity>' },
      {
        schemaVersion: 1,
        kind: 'provider-worker-maintenance-warning',
        warningId: '<identity>',
        operation: 'retention-maintenance',
        invocationId: f.terminal.invocationId,
        terminalRevision: 7,
        terminalState: state,
        errorCode: 'RETENTION_FIXTURE_FAILURE',
        message:
          'Provider worker retention-maintenance failed after the terminal outcome was durable (RETENTION_FIXTURE_FAILURE).',
        occurredAt: f.terminal.updatedAt,
      },
    );
    assert.match(warning.warningId, /^sha256:[0-9a-f]{64}$/u);
    recordProviderWorkerTerminalWarning(
      observe,
      '/repo',
      f.terminal,
      'retention-maintenance',
      error,
    );
    assert.deepEqual(listProviderWorkerMaintenanceWarnings(f.runtime), [
      warning,
    ]);
    current = otherRuntime;
    recordProviderWorkerTerminalWarning(
      observe,
      '/fresh-repo',
      f.terminal,
      'retention-maintenance',
      error,
    );
    assert.deepEqual(listProviderWorkerMaintenanceWarnings(otherRuntime), [
      warning,
    ]);
    assert.deepEqual(observations, ['/repo', '/repo', '/fresh-repo']);
    assert.equal(f.warnings.length, 0);
    assert.deepEqual(f.terminal, original);
  });
}

test('ordinary maintenance errors retain the existing safe durable classification', (t) => {
  const f = fixture(t);
  recordProviderWorkerTerminalWarning(
    () => f.runtime,
    '/repo',
    f.terminal,
    'automatic-retry',
    new Error('private original failure'),
  );
  const [warning] = listProviderWorkerMaintenanceWarnings(f.runtime);
  assert.equal(warning?.errorCode, 'PROVIDER_WORKER_MAINTENANCE_UNEXPECTED');
  assert.equal(
    warning?.message,
    'Provider worker automatic-retry failed after the terminal outcome was durable (PROVIDER_WORKER_MAINTENANCE_UNEXPECTED).',
  );
  assert.equal(f.warnings.length, 0);
});

for (const workflowFailure of [false, true]) {
  test(`observer ${workflowFailure ? 'WorkflowError' : 'ordinary error'} uses the original process fallback`, (t) => {
    const f = fixture(t, 'failed');
    const warningError = workflowFailure
      ? workflowError(
          'OBSERVATION_FIXTURE_FAILURE',
          'private observer detail',
          ExitCode.verification,
        )
      : new Error('private observer detail');
    let observations = 0;
    recordProviderWorkerTerminalWarning(
      function (this: unknown, cwd) {
        assert.equal(this, undefined);
        assert.equal(cwd, '/fresh-repo');
        observations++;
        throw warningError;
      },
      '/fresh-repo',
      f.terminal,
      'retry-schedule-pump',
      workflowError(
        'ORIGINAL_FAILURE',
        'private original detail',
        ExitCode.verification,
      ),
    );
    const code = workflowFailure
      ? 'OBSERVATION_FIXTURE_FAILURE'
      : 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE';
    assert.deepEqual(f.warnings, [
      [
        `Provider worker retry-schedule-pump failed after durable failed; its warning journal also failed (${code}).`,
        {
          code: 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE',
          type: 'ProviderWorkerMaintenanceWarning',
        },
      ],
    ]);
    assert.equal(observations, 1);
    assert.equal(fs.existsSync(f.runtime.root), false);
  });
}

test('a real unsafe private journal emits the fallback and keeps the terminal unchanged', (t) => {
  const f = fixture(t);
  const original = { ...f.terminal };
  const maintenanceDirectory = path.join(
    f.runtime.root,
    'provider-worker-maintenance',
  );
  fs.mkdirSync(maintenanceDirectory, { recursive: true, mode: 0o700 });
  const obstruction = path.join(maintenanceDirectory, 'warnings');
  fs.writeFileSync(obstruction, 'not a directory', { mode: 0o600 });
  let observations = 0;
  recordProviderWorkerTerminalWarning(
    () => {
      observations++;
      return f.runtime;
    },
    '/repo',
    f.terminal,
    'retention-maintenance',
    new Error('private original detail'),
  );
  assert.equal(observations, 1);
  assert.deepEqual(f.warnings, [
    [
      'Provider worker retention-maintenance failed after durable succeeded; its warning journal also failed (PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE).',
      {
        code: 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE',
        type: 'ProviderWorkerMaintenanceWarning',
      },
    ],
  ]);
  assert.equal(fs.readFileSync(obstruction, 'utf8'), 'not a directory');
  assert.deepEqual(f.terminal, original);
});

test('the process warning method is read late and its own error escapes unchanged', (t) => {
  const f = fixture(t);
  const sentinel = new Error('process warning failed');
  let emitted = 0;
  assert.throws(
    () =>
      recordProviderWorkerTerminalWarning(
        () => {
          t.mock.method(process, 'emitWarning', function (this: unknown) {
            assert.equal(this, process);
            emitted++;
            throw sentinel;
          });
          throw new Error('observer failed');
        },
        '/repo',
        f.terminal,
        'automatic-retry',
        new Error('original failure'),
      ),
    (error) => error === sentinel,
  );
  assert.equal(emitted, 1);
  assert.equal(f.warnings.length, 0);
  assert.equal(fs.existsSync(f.runtime.root), false);
});
