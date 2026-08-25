import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { markdownHeadings, markdownLines } from '../src/markdown-sections.ts';

test('markdown section parsing preserves source offsets and ignores fenced examples', () => {
  const markdown = [
    '## Intro ##\r\n',
    '```md\r\n',
    '# hidden\r\n',
    '```\r\n',
    '  ### Visible ###  \r\n',
    '~~~\n',
    '## also hidden\n',
    '~~~~\n',
    'Tail',
  ].join('');

  assert.deepEqual(markdownHeadings(markdown), [
    { start: markdown.indexOf('## Intro'), level: 2, canonical: '## Intro' },
    {
      start: markdown.indexOf('  ### Visible'),
      level: 3,
      canonical: '### Visible',
    },
  ]);

  const lines = markdownLines(markdown);
  assert.equal(lines.map((line) => line.raw).join(''), markdown);
  assert.equal(lines.find((line) => line.text === '# hidden')?.fenced, true);
  assert.equal(
    lines.find((line) => line.text === '## also hidden')?.fenced,
    true,
  );
  assert.deepEqual(
    lines.filter((line) => !line.fenced).map((line) => line.start),
    [
      markdown.indexOf('## Intro'),
      markdown.indexOf('  ### Visible'),
      markdown.indexOf('Tail'),
    ],
  );
});

test('a shorter fence does not close a longer fenced example', () => {
  const markdown = [
    '~~~~\n',
    '# hidden\n',
    '~~~\n',
    '## still hidden\n',
    '~~~~\n',
    '# shown\n',
  ].join('');

  assert.deepEqual(markdownHeadings(markdown), [
    {
      start: markdown.indexOf('# shown'),
      level: 1,
      canonical: '# shown',
    },
  ]);
});

test('@jigwright/core publishes markdown sections as a public neutral contract', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../package.json'),
      'utf8',
    ),
  ) as { exports?: Record<string, string> };

  assert.equal(
    manifest.exports?.['./markdown-sections'],
    './src/markdown-sections.ts',
  );
});
