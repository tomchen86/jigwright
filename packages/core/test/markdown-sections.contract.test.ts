import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  hasExactMarkdownRegion,
  MarkdownRegionBoundsError,
  markdownHeadings,
  markdownLines,
  spliceMarkdownRegion,
} from '../src/markdown-sections.ts';

test('region splicing preserves code-unit offsets, CRLF and untouched suffix bytes', () => {
  const current = '😀\r\nOLD\r\n尾';
  assert.equal(
    spliceMarkdownRegion(current, { start: 4, end: 7 }, '新'),
    '😀\r\n新\r\n尾',
  );
  assert.equal(
    spliceMarkdownRegion(current, { start: 0, end: 0 }, '!'),
    `!${current}`,
  );
  for (const region of [
    { start: -1, end: 2 },
    { start: 2, end: 1 },
    { start: 0.5, end: 1 },
    { start: 0, end: NaN },
    { start: Infinity, end: Infinity },
    { start: 0, end: current.length + 1 },
  ])
    assert.throws(
      () => spliceMarkdownRegion(current, region, ''),
      MarkdownRegionBoundsError,
    );
});

test('exact-region checks re-locate the candidate and preserve locator error identity', () => {
  const observed: string[] = [];
  const locate = (value: string) => {
    observed.push(value);
    return { start: 2, end: 5 };
  };
  assert.equal(hasExactMarkdownRegion('😀NEW尾', 'NEW', locate), true);
  assert.equal(hasExactMarkdownRegion('😀OLD尾', 'NEW', locate), false);
  assert.deepEqual(observed, ['😀NEW尾', '😀OLD尾']);
  assert.equal(
    hasExactMarkdownRegion('body', 'body', () => null),
    false,
  );
  assert.equal(
    hasExactMarkdownRegion('body', 'body', () => undefined as never),
    false,
  );
  const failure = new Error('format-specific locator failure');
  assert.throws(
    () =>
      hasExactMarkdownRegion('body', 'body', () => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

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
