import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isArchiveName,
  isArchiveUtcDate,
  nextArchiveUtcDate,
} from '../src/modules/planning-provider/archive-destination.ts';

test('archive dates accept exact valid four-digit UTC calendar dates', () => {
  for (const value of [
    '0000-02-29',
    '0099-12-31',
    '2000-02-29',
    '2024-02-29',
    '2026-10-24',
    '9999-12-31',
  ]) {
    assert.equal(isArchiveUtcDate(value), true, value);
  }
  for (const value of [
    '',
    '1900-02-29',
    '2023-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-2-01',
    '26-02-01',
    '+002026-02-01',
    '2026-02-01T00:00:00.000Z',
    ' 2026-02-01',
    '2026-02-01\n',
  ]) {
    assert.equal(isArchiveUtcDate(value), false, JSON.stringify(value));
  }
});

test('archive next-day calculation preserves leap, month and year boundaries', () => {
  const cases = [
    ['2024-02-28', '2024-02-29'],
    ['2024-02-29', '2024-03-01'],
    ['1900-02-28', '1900-03-01'],
    ['2000-02-28', '2000-02-29'],
    ['2026-04-30', '2026-05-01'],
    ['2026-12-31', '2027-01-01'],
    ['0099-12-31', '0100-01-01'],
    // Preserve the existing ISO-prefix result at the four-digit year ceiling.
    ['9999-12-31', '+010000-01'],
  ] as const;
  for (const [before, after] of cases) {
    assert.equal(nextArchiveUtcDate(before), after, before);
  }
});

test('archive names bind the calendar date and exact change suffix without path normalization', () => {
  assert.equal(isArchiveName('2024-02-29-demo-change', 'demo-change'), true);
  for (const value of [
    '2023-02-29-demo-change',
    '2026-04-31-demo-change',
    '2026-2-01-demo-change',
    '2026-02-01-other-change',
    '2026-02-01-demo-change-extra',
    'prefix-2026-02-01-demo-change',
    'openspec/changes/archive/2026-02-01-demo-change',
    '../2026-02-01-demo-change',
    '2026-02-01-demo-change/',
    '2026-02-01-demo-change/tasks.md',
    '2026-02-01-demo-change\\tasks.md',
  ]) {
    assert.equal(isArchiveName(value, 'demo-change'), false, value);
  }
});

test('archive name extraction preserves the existing literal suffix and end-anchor semantics', () => {
  const changeId = 'demo.+(x)[a]{b}|c$^?\\';
  assert.equal(isArchiveName('2026-02-01-' + changeId, changeId), true);
  assert.equal(isArchiveName('2026-02-01-demo-anything', changeId), false);
  // Change-ID admission stays with callers; the name matcher treats it literally.
  assert.equal(isArchiveName('2026-02-01-', ''), true);
  assert.equal(isArchiveName('2026-02-01-branch/id', 'branch/id'), true);
  assert.equal(isArchiveName('2026-02-01-demo\n', 'demo'), false);
  assert.equal(isArchiveName('2026-02-01-demo\r\n', 'demo'), false);
  assert.equal(isArchiveName('2026-02-01-demo\nextra', 'demo'), false);
});
