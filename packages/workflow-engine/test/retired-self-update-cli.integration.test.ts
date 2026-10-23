import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { harnessBootstrapProduction } from '../bootstrap/harness-bootstrap-production.ts';
import { createAuthorityCommands } from '../src/entrypoints/cli/authority-management-cli.ts';
import { createHarnessBootstrapCli } from '../src/entrypoints/cli/harness-bootstrap-cli.ts';
import { createFixtureRepository, git } from './fixture.ts';

const retiredCommands = [
  ['produce', 'candidate'],
  ['approve-and-apply', 'candidate', '--task', 'task'],
  ['recover', 'grant'],
  ['initialize'],
  ['status', 'grant'],
  ['classify', '--request', '{}'],
];
function commands() {
  return createAuthorityCommands(
    {} as Parameters<typeof createAuthorityCommands>[0],
  );
}
function noBootstrapDependencies(): never {
  throw new Error('A retired route must not construct authority dependencies.');
}

test('retired self-update commands reject before repository observation or authority assembly', () => {
  const missingRepository = path.join(
    os.tmpdir(),
    'nonexistent-self-update-repository',
  );
  for (const args of retiredCommands) {
    assert.throws(
      () =>
        commands().dispatchAuthorityCommand(
          ['control-plane', ...args],
          missingRepository,
          noBootstrapDependencies,
        ),
      {
        code: 'CONTROL_PLANE_UPDATER_COMMAND_UNSUPPORTED',
      },
    );
  }
});

test('retired self-update commands leave empty and prepared consumer state and Git unchanged', () => {
  for (const prepared of [false, true]) {
    const repository = createFixtureRepository();
    try {
      const stateRoot = path.join(
        repository,
        '.git/workflow-engine/intervention-control',
      );
      if (prepared) {
        fs.mkdirSync(path.join(stateRoot, 'control-updates'), {
          recursive: true,
          mode: 0o700,
        });
        // Deliberate legacy residue: retired routes must not interpret or advance it.
        fs.writeFileSync(
          path.join(stateRoot, 'control-updates/prepared.json'),
          '{"transaction":{"state":"PREPARED"}}\n',
          { mode: 0o600 },
        );
      }
      const before = treeSnapshot(repository);
      const head = git(repository, ['rev-parse', 'HEAD']);
      const index = fs.readFileSync(path.join(repository, '.git/index'));
      for (const args of retiredCommands) {
        assert.throws(
          () =>
            commands().dispatchAuthorityCommand(
              ['control-plane', ...args],
              repository,
              noBootstrapDependencies,
            ),
          {
            code: 'CONTROL_PLANE_UPDATER_COMMAND_UNSUPPORTED',
          },
        );
      }
      assert.deepEqual(treeSnapshot(repository), before);
      assert.deepEqual(
        fs.readFileSync(path.join(repository, '.git/index')),
        index,
      );
      assert.equal(git(repository, ['rev-parse', 'HEAD']), head);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

function treeSnapshot(root: string): Array<[string, number, string]> {
  const files: Array<[string, number, string]> = [];
  function visit(directory: string) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else
        files.push([
          path.relative(root, absolute),
          fs.lstatSync(absolute).mode & 0o777,
          fs.readFileSync(absolute).toString('base64'),
        ]);
    }
  }
  visit(root);
  return files;
}

test('sealed bootstrap rejects retired global rollback before repository or signer access', () => {
  const { runHarnessBootstrapCli } = createHarnessBootstrapCli(
    harnessBootstrapProduction,
  );
  const originalWrite = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const status = runHarnessBootstrapCli(
      ['control-plane', 'rollback', 'retired-grant', '--json'],
      '/not/a/repository',
    );
    assert.notEqual(status, 0);
    assert.equal(
      JSON.parse(output).error.code,
      'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});
