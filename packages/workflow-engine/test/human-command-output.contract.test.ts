import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHumanCommandResult } from '../src/entrypoints/cli/human-command-output.ts';

test('main and packaged init front doors use prose while --json remains structured', () => {
  const cli = fileURLToPath(
    new URL('../src/entrypoints/cli/workflow-cli.ts', import.meta.url),
  );
  const launcher = fileURLToPath(
    new URL('../bootstrap/jigwright-cli.mjs', import.meta.url),
  );
  const failure = spawnSync(process.execPath, [cli, 'not-a-workflow-command'], {
    encoding: 'utf8',
  });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Unknown workflow command/);
  assert.throws(() => JSON.parse(failure.stderr));
  const jsonFailure = spawnSync(
    process.execPath,
    [cli, 'not-a-workflow-command', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(jsonFailure.stderr).ok, false);
  const help = spawnSync(process.execPath, [launcher, 'init', '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Init\n/);
  assert.match(help.stdout, /jigwright init/);
  const jsonHelp = spawnSync(
    process.execPath,
    [launcher, 'init', '--help', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(jsonHelp.status, 0, jsonHelp.stderr);
  assert.equal(JSON.parse(jsonHelp.stdout).ok, true);
  assert.match(JSON.parse(jsonHelp.stdout).result.usage, /jigwright init/);
});

test('human output preserves original wording and exposes readable state rather than opaque identities', () => {
  const sourceId = `SRC-${'a'.repeat(64)}`;
  const originalText = `  原話\r\n包含使用者自己說的 ${sourceId}\n`;
  const rendered = renderHumanCommandResult({
    command: 'source',
    ok: true,
    result: {
      source: {
        id: sourceId,
        text: originalText,
        semanticAuthor: 'maintainer',
        textDigest: `sha256:${'b'.repeat(64)}`,
      },
    },
  });
  assert.ok(rendered.includes(originalText));
  assert.equal(rendered.split(sourceId).length, 2);
  assert.equal(rendered.includes('textDigest'), false);
  assert.equal(rendered.includes('"ok"'), false);
  assert.match(rendered, /maintainer/);
});

test('human Fail-Grant output preserves its question, choices and executable next step', () => {
  const command = 'pnpm workflow grant inspect request-example --json';
  const rendered = renderHumanCommandResult({
    command: 'finalize',
    ok: true,
    result: {
      kind: 'workflow-fail-grant-required.v1',
      status: 'grant-required',
      message: 'The module explanation needs a disposition.',
      choices: [
        {
          label: 'Still valid',
          description: 'Confirm the existing explanation.',
        },
        { label: 'Later', description: 'Record the deferred document update.' },
      ],
    },
    nextSteps: [{ command, reason: 'Review the exact document decision.' }],
  });
  assert.match(rendered, /The module explanation needs a disposition\./);
  assert.match(rendered, /Still valid/);
  assert.match(rendered, /Later/);
  assert.ok(rendered.includes(command));
  assert.equal(rendered.includes('completed'), false);
});

test('human projection output reports changed paths and omits large internal before/after payloads', () => {
  const rendered = renderHumanCommandResult({
    command: 'guidance',
    ok: true,
    result: {
      targets: [
        {
          path: 'AGENTS.md',
          changed: true,
          state: 'current',
          before: 'old internal body',
          after: 'new internal body',
          expectedDigest: `sha256:${'b'.repeat(64)}`,
        },
      ],
    },
  });
  assert.match(rendered, /AGENTS\.md/);
  assert.match(rendered, /current/);
  assert.doesNotMatch(rendered, /internal body|sha256/);
});
