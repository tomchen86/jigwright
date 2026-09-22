import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createProviderWorkerLauncher,
  type ProviderDispatcherHost,
} from '../src/runtime/provider-execution/provider-worker-launcher.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';

const input = {
  repositoryRoot: '/canonical/repository',
  invocationId: 'stored-invocation',
};

test('detached launcher binds the real bootstrap command and current environment only at launch', () => {
  const calls: Parameters<ProviderDispatcherHost['spawn']>[] = [];
  let unrefs = 0;
  const launcher = createProviderWorkerLauncher({
    spawn(...args) {
      calls.push(args);
      assert.equal(args[2].env, process.env);
      return {
        pid: 4321,
        unref() {
          unrefs += 1;
        },
      };
    },
  });
  assert.equal(calls.length, 0);
  const originalEnvironment = process.env;
  const lateEnvironment = {
    ...originalEnvironment,
    PROVIDER_DISPATCH_TEST_MARKER: 'late',
  };
  try {
    process.env = lateEnvironment;
    assert.equal(launcher(input), 4321);
    assert.equal(calls.length, 1);
    const [executable, args, options] = calls[0]!;
    assert.equal(executable, process.execPath);
    const entry = path.resolve(
      import.meta.dirname,
      '../bootstrap/workflow-engine-host.ts',
    );
    assert.equal(fs.existsSync(entry), true);
    assert.deepEqual(args, [
      '--experimental-strip-types',
      entry,
      'provider-worker',
      input.invocationId,
      '--json',
    ]);
    assert.deepEqual(options, {
      cwd: input.repositoryRoot,
      detached: true,
      stdio: 'ignore',
      env: lateEnvironment,
    });
    assert.equal(options.env, lateEnvironment);
    assert.equal(unrefs, 1);
    process.env = {
      ...originalEnvironment,
      PROVIDER_DISPATCH_TEST_MARKER: 'later',
    };
    assert.equal(launcher(input), 4321);
    assert.equal(calls[1]![2].env, process.env);
    assert.notEqual(calls[1]![2].env, calls[0]![2].env);
    assert.equal(unrefs, 2);
  } finally {
    process.env = originalEnvironment;
  }
});

for (const pid of [
  undefined,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`invalid detached pid ${String(pid)} refuses dispatch without unref`, () => {
    let unrefs = 0;
    const launcher = createProviderWorkerLauncher({
      spawn() {
        return {
          pid,
          unref() {
            unrefs += 1;
          },
        };
      },
    });
    assert.throws(
      () => launcher(input),
      (error) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, 'PROVIDER_WORKER_DISPATCH_FAILED');
        assert.equal(
          error.message,
          'The lifecycle-owned provider worker could not be dispatched.',
        );
        assert.equal(error.exitCode, ExitCode.verification);
        return true;
      },
    );
    assert.equal(unrefs, 0);
  });
}

for (const stage of ['spawn', 'unref'] as const) {
  test(`${stage} failure propagates the exact host exception`, () => {
    const failure = new Error(`${stage} sentinel`);
    let unrefs = 0;
    const launcher = createProviderWorkerLauncher({
      spawn() {
        if (stage === 'spawn') throw failure;
        return {
          pid: 1,
          unref() {
            unrefs += 1;
            throw failure;
          },
        };
      },
    });
    assert.throws(
      () => launcher(input),
      (error) => error === failure,
    );
    assert.equal(unrefs, stage === 'spawn' ? 0 : 1);
  });
}
