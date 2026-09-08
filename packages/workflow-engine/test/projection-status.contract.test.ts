import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectProjectionStatus } from '../src/composition-root/projection-status-production.ts';
import { installAgentGuidance } from '../src/modules/adoption/agent-guidance.ts';
import { projectionDefinitions } from '../src/modules/projection/engine-projection-registry.ts';

test('status covers every declaration, observes drift, and does not repair documents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-status-'));
  try {
    fs.mkdirSync(path.join(root, 'workflow'));
    fs.mkdirSync(path.join(root, 'openspec/changes'), { recursive: true });
    for (const name of ['config.json', 'repository-consumer.json'])
      fs.copyFileSync(
        new URL(`../../../workflow/${name}`, import.meta.url),
        path.join(root, 'workflow', name),
      );
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      '# User rules\r\nPreserve me.\r\n',
    );
    installAgentGuidance(root, ['AGENTS.md'], { onDiff() {} });
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nOutside text');
    const before = fs.readFileSync(path.join(root, 'AGENTS.md'));
    const status = inspectProjectionStatus(root);
    assert.deepEqual(
      status.map(({ id }) => id),
      projectionDefinitions().map(({ id }) => id),
    );
    assert.equal(
      status.find(({ id }) => id === 'guidance.agent-section')?.state,
      'current',
    );
    assert.deepEqual(fs.readFileSync(path.join(root, 'AGENTS.md')), before);
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      before.toString().replace('R-000:', 'Altered:'),
    );
    const drift = inspectProjectionStatus(root).find(
      ({ id }) => id === 'guidance.agent-section',
    );
    assert.equal(drift?.targets[0]?.state, 'drifted');
    assert.match(
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      /Altered:/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public CLI routes guidance and advertises its commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-cli-'));
  try {
    assert.equal(
      spawnSync('git', ['init', '--quiet'], { cwd: root }).status,
      0,
    );
    const cli = new URL('../src/cli.ts', import.meta.url);
    const execute = (...args: string[]) => {
      const output = spawnSync(
        process.execPath,
        ['--experimental-strip-types', cli.pathname, ...args, '--json'],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(output.status, 0, output.stderr);
      return JSON.parse(output.stdout);
    };
    assert.equal(
      execute('guidance', 'install').result.confirmationRequired,
      true,
    );
    assert.equal(
      execute('guidance', 'install', 'AGENTS.md').result.targets[0].state,
      'current',
    );
    assert.equal(
      execute('guidance', 'status').result.targets[0].state,
      'current',
    );
    assert.equal(
      execute('guidance', 'remove').result.targets[0].state,
      'removed',
    );
    assert.equal(
      execute('guidance', 'refresh').result.targets[0].state,
      'removed',
    );
    assert.equal(
      execute('guide').guide.commands.filter((command: { id: string }) =>
        command.id.startsWith('guidance-'),
      ).length,
      4,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
