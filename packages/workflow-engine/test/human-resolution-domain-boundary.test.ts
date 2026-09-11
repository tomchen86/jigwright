import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInvestigationHumanActionBlockerFactory } from '../src/modules/investigation/domain/human-resolution-contract.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

test('HumanResolution codecs and canonical session DTOs have complete pure closures', () => {
  for (const owner of [
    'authority/maintainer-grant-contracts',
    'investigation/domain/human-resolution-contract',
    'investigation/domain/investigation-session-types',
    'investigation/domain/investigation-checkpoint-contract',
    'investigation/domain/investigation-session-contract',
    'investigation/domain/human-resolution-journal-contract',
    'investigation/domain/human-resolution-grant-publication-contract',
    'investigation/domain/investigation-store-values',
    'investigation/domain/human-resolution-values',
  ]) {
    assertPureDependencyClosure(
      fileURLToPath(new URL(`../src/modules/${owner}.ts`, import.meta.url)),
    );
  }
});

test('human-action blocker clock remains lazy, after validation, and overridable at the original phase', () => {
  const calls: string[] = [];
  const createBlocker = createInvestigationHumanActionBlockerFactory(() => {
    calls.push('clock');
    return new Date('2026-08-18T04:00:00.000Z');
  });
  assert.deepEqual(calls, []);
  assert.throws(
    () =>
      createBlocker({
        reasonCode: '',
        blockedTransition: 'admit-plan-review',
        facts: {},
      }),
    { code: 'HUMAN_RESOLUTION_INVALID' },
  );
  assert.deepEqual(calls, []);
  const input = {
    reasonCode: 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED',
    blockedTransition: 'admit-plan-review',
    facts: { remaining: 0 },
  };
  const first = createBlocker(input);
  assert.equal(first.enteredAt, '2026-08-18T04:00:00.000Z');
  assert.deepEqual(calls, ['clock']);
  assert.deepEqual(
    first.availableResolutions.map((x) => x.kind),
    [
      'resume-with-capability',
      'close-input',
      'waive-assurance',
      'abort',
      'quarantine',
      'supersede',
    ],
  );
  const explicit = createBlocker({
    ...input,
    now: new Date('2026-08-19T04:00:00.000Z'),
  });
  assert.equal(explicit.enteredAt, '2026-08-19T04:00:00.000Z');
  assert.deepEqual(calls, ['clock']);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.facts));
});
