import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProjectionService,
  locateProjectionRegion,
  spliceProjectionRegion,
} from '../src/modules/projection/projection-service.ts';
import {
  engineProjectionDefinitions,
  projectionDefinitions,
  isEngineProjectionPathForTransition,
} from '../src/modules/projection/engine-projection-registry.ts';

test('projection catalog keeps readable output separate from exact transition-owned ledger paths', () => {
  assert.deepEqual(
    projectionDefinitions().map(({ id }) => id),
    [
      'semantic.binding-index',
      'documents.spec-map',
      'documents.coverage',
      'documents.requirements',
      'handoff.current-and-next-steps',
      'investigation.why-ledger',
      'registry.backlog',
      'registry.inventory',
      'registry.work-history',
      'guidance.agent-section',
    ],
  );
  assert.deepEqual(
    engineProjectionDefinitions().map(({ path }) => path),
    ['workflow/semantic-ledger/index.json', 'docs/CURRENT_AND_NEXT_STEPS.md'],
  );
  const object = `workflow/semantic-ledger/objects/sha256/ab/${'c'.repeat(62)}.json`;
  assert.equal(isEngineProjectionPathForTransition(object, 'plan'), true);
  assert.equal(isEngineProjectionPathForTransition(object, 'archive'), false);
  for (const candidate of [
    object.replace('/ab/', '/zz/'),
    object.replace('.json', '.md'),
    'docs/COVERAGE.md',
  ]) {
    assert.equal(isEngineProjectionPathForTransition(candidate, 'plan'), false);
  }
});

test('guidance projection preserves outside bytes and independently detects drift', () => {
  const files = new Map<string, string>([['AGENTS.md', '# Mine\r\n\r\n']]);
  let body = 'Preserve exact originalText.';
  const events: string[] = [];
  const service = createProjectionService(
    [
      {
        id: 'guidance.agent-section',
        source: () => [{ path: 'AGENTS.md', content: body }],
      },
    ],
    {
      read: (path) => files.get(path) ?? null,
      write: (path, content) => {
        events.push('write');
        files.set(path, content);
      },
      beforeWrite: () => {
        events.push('diff');
      },
    },
  );
  assert.equal(service.status()[0]!.state, 'removed');
  assert.equal(service.project('guidance.agent-section')[0]!.changed, false);
  service.project('guidance.agent-section', {
    install: true,
    heading: '## Jigwright',
  });
  const installed = files.get('AGENTS.md')!;
  assert.ok(installed.startsWith('# Mine\r\n\r\n'));
  assert.deepEqual(events, ['diff', 'write']);
  assert.equal(service.validate('guidance.agent-section')[0]!.state, 'current');
  files.set(
    'AGENTS.md',
    installed.replace('## Jigwright', '## My renamed rules'),
  );
  assert.equal(service.validate('guidance.agent-section')[0]!.state, 'current');
  body = 'Use the workflow guide.';
  assert.equal(service.validate('guidance.agent-section')[0]!.state, 'drifted');
  service.project('guidance.agent-section');
  const refreshed = files.get('AGENTS.md')!;
  const region = locateProjectionRegion(refreshed, 'guidance.agent-section')!;
  assert.equal(service.remove('guidance.agent-section')[0]!.changed, true);
  assert.equal(
    files.get('AGENTS.md'),
    refreshed.slice(0, region.start) + refreshed.slice(region.end),
  );
  assert.ok(files.get('AGENTS.md')!.includes('## My renamed rules'));
  service.project('guidance.agent-section');
  assert.equal(service.status()[0]!.state, 'removed');
});

test('marker examples are ignored and a forged digest never hides edited content', () => {
  const files = new Map<string, string>();
  const service = createProjectionService(
    [
      {
        id: 'guidance.agent-section',
        source: () => [{ path: 'AGENTS.md', content: 'One rule.' }],
      },
    ],
    {
      read: (path) => files.get(path) ?? null,
      write: (path, content) => {
        files.set(path, content);
      },
    },
  );
  service.project('guidance.agent-section', { install: true });
  const original = files.get('AGENTS.md')!;
  const example = '```md\n' + original + '\n```\n';
  files.set(
    'AGENTS.md',
    example + original.replace('One rule.', 'An edited rule.'),
  );
  assert.equal(service.status()[0]!.state, 'drifted');
  service.project('guidance.agent-section');
  assert.equal(files.get('AGENTS.md'), example + original);
});

test('all diffs precede writes, source errors prevent partial projection, engine remove is forbidden', () => {
  const events: string[] = [];
  const files = new Map<string, string>();
  const service = createProjectionService(
    [
      {
        id: 'registry.backlog',
        source: () => [{ path: 'docs/BACKLOG.md', content: 'Backlog\n' }],
      },
      {
        id: 'guidance.agent-section',
        source: () => [
          { path: 'A.md', content: 'Rules' },
          { path: 'B.md', content: 'Rules' },
        ],
      },
    ],
    {
      read: (path) => files.get(path) ?? null,
      write: (path, content) => {
        events.push(`write:${path}`);
        files.set(path, content);
      },
      beforeWrite: ({ path }) => {
        events.push(`diff:${path}`);
      },
    },
  );
  service.project('guidance.agent-section', { install: true });
  assert.deepEqual(events, [
    'diff:A.md',
    'diff:B.md',
    'write:A.md',
    'write:B.md',
  ]);
  service.project('registry.backlog');
  assert.equal(service.validate('registry.backlog')[0]!.state, 'current');
  assert.throws(() => service.remove('registry.backlog'), /user-declared/);
  assert.throws(
    () =>
      createProjectionService(
        [
          {
            id: 'guidance.agent-section',
            source: () => [
              { path: 'A.md', content: 'Rules' },
              { path: 'A.md', content: 'Other' },
            ],
          },
        ],
        {
          read: () => null,
          write: () => {
            throw new Error('unexpected write');
          },
        },
      ).project('guidance.agent-section'),
    /Duplicate/,
  );
});

test('region splice preserves CRLF, suffix and absent final newline exactly', () => {
  assert.equal(
    spliceProjectionRegion('a\r\nOLD\r\nz', { start: 3, end: 6 }, 'NEW'),
    'a\r\nNEW\r\nz',
  );
  assert.throws(
    () => spliceProjectionRegion('text', { start: -1, end: 2 }, ''),
    /region/,
  );
});

test('diff callbacks cannot overwrite a concurrently changed target', () => {
  let current = 'Before';
  let writes = 0;
  const service = createProjectionService(
    [
      {
        id: 'registry.backlog',
        source: () => [{ path: 'docs/BACKLOG.md', content: 'After' }],
      },
    ],
    {
      read: () => current,
      beforeWrite: () => {
        current = 'Someone else edited this.';
      },
      write: () => {
        writes += 1;
      },
    },
  );
  assert.throws(() => service.project('registry.backlog'), /changed after/);
  assert.equal(writes, 0);
  assert.equal(current, 'Someone else edited this.');
});

test('missing whole-file targets with empty output are still created', () => {
  let written: string | null = null;
  const service = createProjectionService(
    [
      {
        id: 'registry.backlog',
        source: () => [{ path: 'docs/BACKLOG.md', content: '' }],
      },
    ],
    {
      read: () => written,
      write: (_path, content) => {
        written = content;
      },
    },
  );
  assert.equal(service.project('registry.backlog')[0]!.changed, true);
  assert.equal(written, '');
});

test('install rejects fenced candidate markers before diff or write', () => {
  for (const fence of [
    '```markdown\nUnclosed example',
    '~~~\nUnclosed example',
  ]) {
    const events: string[] = [];
    const service = createProjectionService(
      [
        {
          id: 'guidance.agent-section',
          source: () => [
            { path: 'A.md', content: 'Rules' },
            { path: 'B.md', content: 'Rules' },
          ],
        },
      ],
      {
        read: (path) => (path === 'B.md' ? fence : '# Safe target\n'),
        beforeWrite: () => {
          events.push('diff');
        },
        write: () => {
          events.push('write');
        },
      },
    );
    assert.throws(
      () => service.project('guidance.agent-section', { install: true }),
      /candidate region/,
    );
    assert.deepEqual(events, []);
  }
});

test('engine source paths require the catalog target or explicit resolved adapter targets', () => {
  const events: string[] = [];
  const io = {
    read: () => null,
    write: (path: string) => {
      events.push(path);
    },
  };
  assert.throws(
    () =>
      createProjectionService(
        [
          {
            id: 'registry.backlog',
            source: () => [{ path: 'wrong.md', content: 'Wrong' }],
          },
        ],
        io,
      ).project('registry.backlog'),
    /approved target/,
  );
  assert.throws(
    () =>
      createProjectionService(
        [
          {
            id: 'registry.backlog',
            targetPaths: ['approved.md'],
            source: () => [{ path: 'wrong.md', content: 'Wrong' }],
          },
        ],
        io,
      ).project('registry.backlog'),
    /approved target/,
  );
  assert.deepEqual(events, []);
  createProjectionService(
    [
      {
        id: 'registry.work-history',
        targetPaths: ['history/2025.md', 'history/2026.md'],
        source: () => [
          { path: 'history/2026.md', content: '2026' },
          { path: 'history/2025.md', content: '2025' },
        ],
      },
    ],
    io,
  ).project('registry.work-history');
  assert.deepEqual(events, ['history/2026.md', 'history/2025.md']);
});

test('a later target edited during an earlier write is not overwritten', () => {
  const files = new Map<string, string>();
  const written: string[] = [];
  const service = createProjectionService(
    [
      {
        id: 'guidance.agent-section',
        source: () => [
          { path: 'A.md', content: 'Rules' },
          { path: 'B.md', content: 'Rules' },
        ],
      },
    ],
    {
      read: (path) => files.get(path) ?? null,
      write: (path, content) => {
        written.push(path);
        files.set(path, content);
        if (path === 'A.md') files.set('B.md', 'Concurrent edit');
      },
    },
  );
  assert.throws(
    () => service.project('guidance.agent-section', { install: true }),
    /changed after/,
  );
  assert.deepEqual(written, ['A.md']);
  assert.equal(files.get('B.md'), 'Concurrent edit');
});
