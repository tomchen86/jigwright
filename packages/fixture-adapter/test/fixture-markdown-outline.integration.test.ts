import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectFixtureMarkdown } from '../src/fixture-markdown-outline.ts';

test('fixture adapter builds an outline from the public neutral markdown contract', () => {
  const markdown = [
    '# Fixture\n',
    '\n',
    '```md\n',
    '## fenced example\n',
    '```\n',
    '## Result ##\n',
    'body\n',
  ].join('');

  assert.deepEqual(inspectFixtureMarkdown(markdown), {
    headings: [
      { start: 0, level: 1, canonical: '# Fixture' },
      {
        start: markdown.indexOf('## Result'),
        level: 2,
        canonical: '## Result',
      },
    ],
    visibleLines: ['# Fixture', '', '## Result ##', 'body'],
  });
});
