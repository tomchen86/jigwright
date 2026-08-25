import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  OpenSpecArchiveProjectionError,
  assertSpecDeltaScenarioPreservation,
  verifyArchiveDeltaOutcomes,
  verifyProjectedSpecDeltaOutcome,
  type OpenSpecArchiveProjectionReader,
} from '../src/archive-projection.ts';

const CHANGE_ID = 'demo-change';
const DELTA_PATH = 'openspec/changes/demo-change/specs/demo/spec.md';
const BASE_PATH = 'openspec/specs/demo/spec.md';
const BASE = [
  '# Demo',
  '',
  '### Requirement: Existing',
  '',
  'Old.',
  '',
  '#### Scenario: Kept',
  '',
  '- THEN old',
  '',
  '### Requirement: Remove Me',
  '',
  'Remove.',
  '',
  '### Requirement: Rename Me',
  '',
  'Rename.',
].join('\n');
const DELTA = [
  '# Delta',
  '',
  '## ADDED Requirements',
  '',
  '### Requirement: Added',
  '',
  'New.',
  '',
  '#### Scenario: Added works',
  '',
  '- THEN new',
  '',
  '## MODIFIED Requirements',
  '',
  '### Requirement: Existing',
  '',
  'New.',
  '',
  '#### Scenario: Kept',
  '',
  '- THEN revised',
  '',
  '## REMOVED Requirements',
  '',
  '### Requirement: Remove Me',
  '',
  '## RENAMED Requirements',
  '',
  '- FROM: `### Requirement: Rename Me`',
  '- TO: `### Requirement: Renamed`',
].join('\n');
const AFTER = [
  '# Demo',
  '',
  '### Requirement: Existing',
  '',
  'New.',
  '',
  '#### Scenario: Kept',
  '',
  '- THEN revised',
  '',
  '### Requirement: Added',
  '',
  'New.',
  '',
  '#### Scenario: Added works',
  '',
  '- THEN new',
  '',
  '### Requirement: Renamed',
  '',
  'Rename.',
].join('\n');
const TOTALS = { added: 1, modified: 1, removed: 1, renamed: 1 };

test('OpenSpec archive projection reads exact paths and preserves totals and digest bytes', () => {
  const observed: string[] = [];
  const reader = fixtureReader(
    new Map([
      [`base:${DELTA_PATH}`, DELTA],
      [`base:${BASE_PATH}`, BASE],
      [`projected:${BASE_PATH}`, AFTER],
    ]),
    new Map([[DELTA_PATH, DELTA]]),
    observed,
  );

  assert.deepEqual(
    verifyArchiveDeltaOutcomes(
      reader,
      { changeId: CHANGE_ID, head: 'base' },
      {
        baseSpecPaths: [BASE_PATH],
        tree: 'projected',
        totals: TOTALS,
      },
    ),
    {
      totals: TOTALS,
      promotedSpecDigests: {
        [BASE_PATH]:
          '689e7663a9b6b61b793e4a09fe00aa17101e52d44960a1b44493d474ba2610e0',
      },
    },
  );
  assert.deepEqual(observed, [
    `pinned:base:${DELTA_PATH}`,
    `pinned:projected:${BASE_PATH}`,
    `pinned:base:${BASE_PATH}`,
  ]);

  assert.deepEqual(
    assertSpecDeltaScenarioPreservation(
      reader,
      'base',
      'openspec/changes',
      CHANGE_ID,
      [DELTA_PATH],
      new Date('2026-08-21T00:00:00.000Z'),
    ),
    {
      status: 'passed',
      validatedAt: '2026-08-21T00:00:00.000Z',
      validatedBaseCommit: 'base',
      validatedBaseSpecDigests: {
        [BASE_PATH]:
          '15f266ed143bb0db65902891fb6880ace420bfb2b3034dec2fbed2234eff11d5',
      },
      validatorVersion: 'spec-delta-preflight-v2',
    },
  );
});

test('OpenSpec archive projection exposes typed facts without owning workflow errors', () => {
  const inapplicable = [
    '## MODIFIED Requirements',
    '',
    '### Requirement: Missing',
  ].join('\n');
  assert.throws(
    () => verifyProjectedSpecDeltaOutcome('demo', BASE, inapplicable, AFTER),
    (error) => {
      assert.equal(error instanceof OpenSpecArchiveProjectionError, true);
      const projection = error as OpenSpecArchiveProjectionError;
      assert.equal(projection.code, 'SPEC_DELTA_NOT_APPLICABLE');
      assert.equal(
        projection.message,
        'Delta for demo declares operations the current base cannot accept: modified "Missing" — Requirement is not present in the base specification.',
      );
      assert.deepEqual(projection.details, {
        capability: 'demo',
        faults: [
          {
            operation: 'modified',
            requirement: 'Missing',
            reason: 'Requirement is not present in the base specification.',
          },
        ],
      });
      return true;
    },
  );

  assert.throws(() => {
    const renamedScenarioDelta = DELTA.replace(
      '#### Scenario: Kept',
      '#### Scenario: Renamed',
    );
    const renamedScenarioAfter = AFTER.replace(
      '#### Scenario: Kept',
      '#### Scenario: Renamed',
    );
    return verifyProjectedSpecDeltaOutcome(
      'demo',
      BASE,
      renamedScenarioDelta,
      renamedScenarioAfter,
    );
  }, isProjectionError('SPEC_SCENARIO_PRESERVATION_FAILED'));
});

test('OpenSpec archive package owns no Git, currentness, CLI, or transition authority', () => {
  const source = fs.readFileSync(
    new URL('../src/archive-projection.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /workflowError|ExitCode|child_process|execFile|spawn|update-ref|writeFile|renameSync|transition authority/i,
  );
  assert.match(source, /readPinnedText/);
  assert.match(source, /readCurrentText/);
});

function fixtureReader(
  pinned: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  observed: string[],
): OpenSpecArchiveProjectionReader {
  return {
    readPinnedText(revision, relativePath) {
      observed.push(`pinned:${revision}:${relativePath}`);
      return pinned.get(`${revision}:${relativePath}`);
    },
    readCurrentText(relativePath) {
      observed.push(`current:${relativePath}`);
      return current.get(relativePath);
    },
  };
}

function isProjectionError(code: string) {
  return (error: unknown): boolean =>
    error instanceof OpenSpecArchiveProjectionError && error.code === code;
}
