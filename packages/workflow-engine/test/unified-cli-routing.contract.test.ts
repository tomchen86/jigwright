import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExitCode } from '../src/foundation/errors/errors.ts';
import { runCli, runCliAsync } from '../bootstrap/workflow-engine-host.ts';
import type { ExecutionJobInspection } from '../src/runtime/provider-execution/execution-runtime.ts';
import { createFixtureRepository, sourceRepositoryRoot } from './fixture.ts';

test('package CLI dispatches against an explicit external repository root', () => {
  const repository = createFixtureRepository();
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/jigwright-cli.mjs',
        ),
        '--repository-root',
        repository,
        'doctor',
        '--json',
      ],
      { cwd: sourceRepositoryRoot, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      command: string;
      repository: { root: string };
    };
    assert.equal(payload.command, 'doctor');
    assert.equal(payload.repository.root, fs.realpathSync(repository));
    assert.notEqual(
      payload.repository.root,
      fs.realpathSync(sourceRepositoryRoot),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('package CLI fails closed on an invalid external repository root', () => {
  const launcher = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/jigwright-cli.mjs',
  );
  for (const requestedRoot of [
    'relative-consumer',
    path.join(sourceRepositoryRoot, 'package.json'),
    path.join(os.tmpdir(), 'missing-jigwright-consumer'),
  ]) {
    const result = spawnSync(
      process.execPath,
      [launcher, '--repository-root', requestedRoot, 'doctor', '--json'],
      { cwd: sourceRepositoryRoot, encoding: 'utf8' },
    );

    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
      'JIGWRIGHT_REPOSITORY_ROOT_INVALID',
    );
  }
});

test('main CLI routes human intervention through the durable bootstrap surface', () => {
  const repository = createFixtureRepository();
  const auditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'unified-cli-audit-')),
  );
  fs.chmodSync(auditRoot, 0o700);
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'change',
        'intervene',
        'demo-change',
        '--reason',
        'Repair the harness engine.',
        '--audit-root',
        auditRoot,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 14, result.stderr);
    assert.equal(
      (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
      'HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          repository,
          '.git/workflow-engine/intervention-control/maintenance-grants',
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test('main CLI routes engine artifact builds through persisted intervention state', () => {
  const repository = createFixtureRepository();
  const auditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'unified-build-audit-')),
  );
  fs.chmodSync(auditRoot, 0o700);
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'engine',
        'build-artifact',
        path.join(repository, 'packages/workflow-engine/dist/engine'),
        '--for',
        'demo-change',
        '--protocol-version',
        '3',
        '--policy-schema-version',
        '2',
        '--audit-root',
        auditRoot,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 11, result.stderr);
    assert.equal(
      (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
      'INTERVENTION_PERSISTENCE_NOT_FOUND',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test('main CLI accepts the family-neutral audited grant revoke surface', () => {
  const repository = createFixtureRepository();
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'grant',
        'revoke',
        '77777777-7777-4777-8777-777777777777',
        '--reason',
        'No longer required.',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 10, result.stderr);
    assert.equal(
      (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
      'GRANT_NOT_FOUND',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('human-resolution revoke requires an explicit reason', () => {
  const repository = createFixtureRepository();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  try {
    for (const command of [['maintainer', 'resolution-revoke']]) {
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          ...command,
          '77777777-7777-4777-8777-777777777777',
          '--json',
        ],
        { cwd: repository, encoding: 'utf8' },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.equal(
        (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
        'INVALID_USAGE',
      );
      assert.match(result.stderr, /--reason/);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('main CLI exposes the bounded provider retry pump and durable schedule queries', () => {
  const repository = createFixtureRepository();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  try {
    const pump = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'job',
        'retry-pump',
        '--limit',
        '10',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(pump.status, 0, pump.stderr);
    assert.deepEqual((JSON.parse(pump.stdout) as { result: unknown }).result, {
      schemaVersion: 1,
      kind: 'provider-retry-schedule-pump',
      inspected: 0,
      due: 0,
      processed: 0,
      scheduleIds: [],
    });

    for (const action of ['retry-schedules', 'retry-receipts']) {
      const query = spawnSync(
        process.execPath,
        ['--experimental-strip-types', cli, 'job', action, '--json'],
        { cwd: repository, encoding: 'utf8' },
      );
      assert.equal(query.status, 0, query.stderr);
      assert.deepEqual(
        (JSON.parse(query.stdout) as { result: unknown }).result,
        [],
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('job watch is async-only, streams one terminal envelope, and is advertised in help', async () => {
  const repository = createFixtureRepository();
  const jobId = 'job-watch-terminal-fixture';
  const terminal = {
    schemaVersion: 1,
    runtimeStatus: 'completed',
  } as ExecutionJobInspection;
  const calls: Array<{ cwd: string; jobId: string }> = [];
  let stdout = '';
  const exitCode = await runCliAsync(
    ['job', 'watch', jobId, '--json'],
    repository,
    {
      watchJob: async function* (cwd, requestedJobId) {
        calls.push({ cwd, jobId: requestedJobId });
        yield terminal;
      },
      writeStdout(chunk) {
        stdout += chunk;
      },
    },
  );
  try {
    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [{ cwd: repository, jobId }]);
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), {
      command: 'job',
      action: 'watch',
      ok: true,
      result: terminal,
    });

    const originalStderrWrite = process.stderr.write;
    let stderr = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(
        runCli(['job', 'watch', jobId, '--json'], repository),
        ExitCode.usage,
      );
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    const failure = JSON.parse(stderr) as {
      error: { code: string; message: string };
    };
    assert.equal(failure.error.code, 'INVALID_USAGE');
    assert.match(failure.error.message, /job <list\|status/u);

    const help = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'help',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(
      (JSON.parse(help.stdout) as { usage: string }).usage,
      /pnpm workflow job watch <job-id> \[--json\]/u,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
