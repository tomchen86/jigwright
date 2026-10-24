import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_GUIDANCE_CONFIG,
  guidanceSuggestions,
  installAgentGuidance,
  readAgentGuidanceTargets,
  refreshAgentGuidance,
  removeAgentGuidance,
  statusAgentGuidance,
} from '../src/composition-root/agent-guidance-production.ts';
import { dispatchAgentGuidanceCommand } from '../src/entrypoints/cli/agent-guidance-cli.ts';
import { captureGovernanceSource } from '../src/composition-root/governance-sources-production.ts';

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-guidance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const quiet = { onDiff: () => {} };

test('configured owner Sources are projected verbatim and remain the sole wording authority', (t) => {
  const root = fixture(t);
  const source = captureGovernanceSource(root, {
    semanticAuthor: 'maintainer',
    capturedBy: 'test',
    capturedAt: '2026-09-08T00:00:00.000Z',
    contextRef: 'direct-human:test',
    text: '### Product purpose\n\n  原話\r\n不改寫\n',
    supersedes: null,
  }).source;
  fs.writeFileSync(
    path.join(root, AGENT_GUIDANCE_CONFIG),
    JSON.stringify({
      targets: [],
      sourceRefs: [source.id],
    }),
  );
  installAgentGuidance(root, ['AGENTS.md'], quiet);
  const projected = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(projected.includes(source.text));
  assert.equal(projected.includes(source.id), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, AGENT_GUIDANCE_CONFIG), 'utf8'))
      .sourceRefs,
    [source.id],
  );
  assert.equal(statusAgentGuidance(root).targets[0].state, 'current');
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    projected.replace('原話', '改寫'),
  );
  assert.equal(statusAgentGuidance(root).targets[0].state, 'drifted');
  refreshAgentGuidance(root, quiet);
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    projected,
  );
});

test('install without explicit targets only suggests existing conventional files', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Personal rules\n');
  fs.writeFileSync(path.join(root, 'GEMINI.md'), 'Gemini rules');
  fs.writeFileSync(path.join(root, 'OTHER.md'), 'Other');
  assert.deepEqual(guidanceSuggestions(root), ['AGENTS.md', 'GEMINI.md']);
  const before = fs.readdirSync(root);
  const result = installAgentGuidance(root, [], quiet);
  assert.equal(result.confirmationRequired, true);
  assert.deepEqual(result.suggestions, ['AGENTS.md', 'GEMINI.md']);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(fs.existsSync(path.join(root, AGENT_GUIDANCE_CONFIG)), false);
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    '# Personal rules\n',
  );
});

test('explicit install projects identical rules, keeps path-keyed labels, and previews before any write', (t) => {
  const root = fixture(t);
  const initial = '# Personal rules\r\nKeep these bytes.\r\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), initial);
  const previews: string[] = [];
  const result = installAgentGuidance(
    root,
    ['AGENTS.md', { path: '.qwen/AGENTS.md', label: 'qwen' }],
    {
      onDiff(diff) {
        assert.equal(
          fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
          initial,
        );
        assert.equal(fs.existsSync(path.join(root, '.qwen/AGENTS.md')), false);
        assert.equal(
          fs.existsSync(path.join(root, AGENT_GUIDANCE_CONFIG)),
          false,
        );
        previews.push(diff);
      },
    },
  );
  assert.equal(previews.length, 3);
  assert.match(previews[0], /\+\+\+ b\/workflow\/agent-guidance.json/u);
  assert.match(previews[1], /^--- a\/AGENTS\.md\n\+\+\+ b\/AGENTS\.md/mu);
  assert.equal(result.targets.length, 2);
  const first = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const second = fs.readFileSync(path.join(root, '.qwen/AGENTS.md'), 'utf8');
  assert.ok(first.startsWith(initial));
  assert.equal(
    first.slice(first.indexOf('## Jigwright')),
    second.slice(second.indexOf('## Jigwright')),
  );
  assert.match(
    first,
    /<!-- jigwright:region id=guidance\.agent-section v=\d+ digest=sha256:[a-f\d]{64} -->/u,
  );
  assert.match(first, /originalText/u);
  assert.deepEqual(readAgentGuidanceTargets(root), [
    { path: 'AGENTS.md' },
    { path: '.qwen/AGENTS.md', label: 'qwen' },
  ]);
  installAgentGuidance(
    root,
    [{ path: '.qwen/AGENTS.md', label: 'renamed' }],
    quiet,
  );
  assert.deepEqual(readAgentGuidanceTargets(root), [
    { path: 'AGENTS.md' },
    { path: '.qwen/AGENTS.md', label: 'renamed' },
  ]);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), first);
});

test('status recomputes drift without writes, refresh respects renamed headings, and remove preserves outside bytes', (t) => {
  const root = fixture(t);
  installAgentGuidance(root, ['AGENTS.md'], quiet);
  const target = path.join(root, 'AGENTS.md');
  let content = fs
    .readFileSync(target, 'utf8')
    .replace('## Jigwright', '## My local heading');
  content = `prefix\r\n${content}suffix\r\n`;
  fs.writeFileSync(target, content);
  const markerStart = content.indexOf('<!-- jigwright:region');
  const markerEnd =
    content.indexOf('<!-- /jigwright:region -->') +
    '<!-- /jigwright:region -->'.length;
  const outside = content.slice(0, markerStart) + content.slice(markerEnd);
  assert.equal(statusAgentGuidance(root).targets[0].state, 'current');
  fs.writeFileSync(target, content.replace('originalText', 'changedText'));
  const tampered = fs.readFileSync(target, 'utf8');
  const config = fs.readFileSync(
    path.join(root, AGENT_GUIDANCE_CONFIG),
    'utf8',
  );
  assert.equal(statusAgentGuidance(root).targets[0].state, 'drifted');
  assert.equal(fs.readFileSync(target, 'utf8'), tampered);
  assert.equal(
    fs.readFileSync(path.join(root, AGENT_GUIDANCE_CONFIG), 'utf8'),
    config,
  );
  const changes = refreshAgentGuidance(root, quiet);
  assert.equal(changes.targets[0].changed, true);
  assert.equal(fs.readFileSync(target, 'utf8'), content);
  removeAgentGuidance(root, quiet);
  assert.equal(fs.readFileSync(target, 'utf8'), outside);
  assert.equal(statusAgentGuidance(root).targets[0].state, 'removed');
  refreshAgentGuidance(root, quiet);
  assert.equal(fs.readFileSync(target, 'utf8'), outside);
});

test('deleted markers mean removed and refresh never reinstalls them', (t) => {
  const root = fixture(t);
  installAgentGuidance(root, ['AGENTS.md'], quiet);
  const target = path.join(root, 'AGENTS.md');
  const closingRemoved = fs
    .readFileSync(target, 'utf8')
    .replace('<!-- /jigwright:region -->', '');
  fs.writeFileSync(target, closingRemoved);
  assert.equal(statusAgentGuidance(root).targets[0].state, 'removed');
  refreshAgentGuidance(root, quiet);
  assert.equal(fs.readFileSync(target, 'utf8'), closingRemoved);
  const content = fs
    .readFileSync(target, 'utf8')
    .replace(/<!--[^\n]+-->\n?/gu, '');
  fs.writeFileSync(target, content);
  assert.equal(statusAgentGuidance(root).targets[0].state, 'removed');
  refreshAgentGuidance(root, quiet);
  assert.equal(fs.readFileSync(target, 'utf8'), content);
  fs.unlinkSync(target);
  refreshAgentGuidance(root, quiet);
  assert.equal(fs.existsSync(target), false);
});

test('all targets and configuration paths are preflighted before writes', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'original');
  for (const invalid of [
    'settings.json',
    '../outside.md',
    '/tmp/outside.md',
    '.git/AGENTS.md',
  ]) {
    assert.throws(() =>
      installAgentGuidance(root, ['AGENTS.md', invalid], quiet),
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      'original',
    );
    assert.equal(fs.existsSync(path.join(root, AGENT_GUIDANCE_CONFIG)), false);
  }
  fs.mkdirSync(path.join(root, 'folder.md'));
  assert.throws(() =>
    installAgentGuidance(root, ['AGENTS.md', 'folder.md'], quiet),
  );
  fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'LINK.md'));
  assert.throws(() =>
    installAgentGuidance(root, ['AGENTS.md', 'LINK.md'], quiet),
  );
  fs.symlinkSync(root, path.join(root, 'workflow'));
  assert.throws(() => installAgentGuidance(root, ['AGENTS.md'], quiet));
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'original',
  );
});

test('invalid UTF-8 and malformed regions abort multi-target install before any file or config write', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'original');
  const invalid = Buffer.from([0xff, 0x61]);
  fs.writeFileSync(path.join(root, 'BROKEN.md'), invalid);
  assert.throws(
    () => installAgentGuidance(root, ['AGENTS.md', 'BROKEN.md'], quiet),
    /UTF-8/u,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'BROKEN.md')), invalid);
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'original',
  );
  assert.equal(fs.existsSync(path.join(root, AGENT_GUIDANCE_CONFIG)), false);
  fs.writeFileSync(
    path.join(root, 'BROKEN.md'),
    '<!-- jigwright:region id=guidance.agent-section v=bad -->\n',
  );
  assert.throws(
    () => installAgentGuidance(root, ['AGENTS.md', 'BROKEN.md'], quiet),
    /Malformed/u,
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'original',
  );
  assert.equal(fs.existsSync(path.join(root, AGENT_GUIDANCE_CONFIG)), false);
});

test('guidance CLI validates command syntax before changing files', (t) => {
  const root = fixture(t);
  assert.throws(
    () =>
      dispatchAgentGuidanceCommand(
        ['install', '--provider', 'claude'],
        root,
        quiet,
      ),
    /Usage:/u,
  );
  assert.throws(
    () => dispatchAgentGuidanceCommand(['refresh', 'AGENTS.md'], root, quiet),
    /Usage:/u,
  );
  assert.throws(() => dispatchAgentGuidanceCommand([], root, quiet), /Usage:/u);
  assert.equal(
    dispatchAgentGuidanceCommand(['install'], root, quiet).confirmationRequired,
    true,
  );
  assert.equal(fs.existsSync(path.join(root, AGENT_GUIDANCE_CONFIG)), false);
});

test('install preserves concurrent target configuration edits made during preview', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'AGENTS.md');
  const configPath = path.join(root, AGENT_GUIDANCE_CONFIG);
  fs.writeFileSync(target, 'original');
  const concurrentConfig = '{"targets":[{"path":"OTHER.md"}]}\n';
  assert.throws(
    () =>
      installAgentGuidance(root, ['AGENTS.md'], {
        onDiff() {
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, concurrentConfig);
        },
      }),
    /configuration changed/u,
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), concurrentConfig);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});
