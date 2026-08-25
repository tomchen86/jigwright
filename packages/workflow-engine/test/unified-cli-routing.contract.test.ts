import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureRepository, sourceRepositoryRoot } from './fixture.ts';

test('package CLI dispatches against an explicit external repository root', () => {
  const repository = createExternalRepositoryFixture();
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

function createExternalRepositoryFixture(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-external-repository-'),
  );
  runFixtureGit(repository, ['init', '-b', 'feature']);
  runFixtureGit(repository, ['config', 'user.email', 'jigwright@example.test']);
  runFixtureGit(repository, ['config', 'user.name', 'Jigwright Test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'openspec/specs'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'workflow/config.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repositoryName: 'external-fixture',
        changeRoot: 'openspec/changes',
        runtimeDirectory: 'workflow-engine',
        protectedBranches: ['main', 'master'],
        branchTemplate: 'work/{changeId}',
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'openspec/specs/README.md'),
    '# External consumer fixture\n',
  );
  runFixtureGit(repository, ['add', '.']);
  runFixtureGit(repository, [
    'commit',
    '-m',
    'Initialize external consumer fixture',
  ]);
  return repository;
}

function runFixtureGit(repository: string, argv: string[]): void {
  const result = spawnSync('git', argv, {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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

test('legacy and human-resolution revoke routes require an explicit reason', () => {
  const repository = createFixtureRepository();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  try {
    for (const command of [
      ['maintainer', 'revoke'],
      ['maintainer', 'resolution-revoke'],
    ]) {
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
    'packages/workflow-engine/src/cli.ts',
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
