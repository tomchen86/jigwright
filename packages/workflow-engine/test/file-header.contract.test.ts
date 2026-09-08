import assert from 'node:assert/strict';
import test from 'node:test';

import { extractFileHeader } from '../src/modules/source/file-header.ts';

test('wrapped responsibility and invariant text preserve logical bullet numbering', () => {
  assert.deepEqual(
    extractFileHeader(
      [
        '/**',
        ' * Reads the current contract',
        ' * from a pinned source.',
        ' *',
        ' * Invariants:',
        ' * - The first promise',
        ' *   continues here.',
        ' * - The second promise stays second.',
        ' * Depends on: old prose.',
        ' * This is not an invariant.',
        ' */',
      ].join('\n'),
    ),
    {
      responsibility: 'Reads the current contract from a pinned source.',
      invariants: [
        'The first promise continues here.',
        'The second promise stays second.',
      ],
      startLine: 1,
      endLine: 11,
    },
  );
});

test('file headers expose responsibility, ordered invariants, and source lines', () => {
  const source = [
    '/**',
    ' * Preserves the selected wording.',
    ' *',
    ' * Invariants:',
    ' * - [Exact wording] Never normalize the text.',
    ' * - An observation remains a Finding.',
    ' */',
    'export const value = 1;',
  ].join('\n');
  assert.deepEqual(extractFileHeader(source), {
    responsibility: 'Preserves the selected wording.',
    invariants: [
      '[Exact wording] Never normalize the text.',
      'An observation remains a Finding.',
    ],
    startLine: 1,
    endLine: 7,
  });
  assert.deepEqual(
    extractFileHeader(`\uFEFF${source.replaceAll('\n', '\r\n')}`),
    extractFileHeader(source),
  );
});

test('header extraction stays shallow and never turns missing prose into a gate', () => {
  assert.equal(extractFileHeader('export const value = 1;'), null);
  assert.equal(
    extractFileHeader('export const value = 1;\n/** Later comment. */'),
    null,
  );
  assert.equal(extractFileHeader('/** Unclosed header'), null);
  assert.deepEqual(
    extractFileHeader('/** Responsibility only. */')?.invariants,
    [],
  );
  assert.deepEqual(
    extractFileHeader(
      '/**\n * Responsibility.\n * invariants:\n * - Wrong format.\n */',
    )?.invariants,
    [],
  );
  assert.deepEqual(
    extractFileHeader(
      '/**\n * Responsibility.\n * Invariants:\n * - First.\n *\n * Depends on: old prose.\n * - Not an invariant.\n * Failure modes: old prose.\n */',
    )?.invariants,
    ['First.'],
  );
});
