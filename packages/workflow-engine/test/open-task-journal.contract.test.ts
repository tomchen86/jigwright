import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  createPreparedOpenTaskJournal,
  parseOpenTaskJournal,
  advanceOpenTaskJournalPhase,
  assertOpenTaskCompletionPhase,
  exactOpenTaskTimestamp,
  assertOpenTaskMandateTaskId,
  exactOpenTaskRetryCommand,
} from '../src/modules/lifecycle/open-task-journal.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

// Fixed vectors calculated independently with sorted-key JSON and SHA-256.
// Neither expected bytes nor expected identities call the implementation.
const ORDINARY_BYTES =
  '{"authorizationPolicyDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baselineTree":"4444444444444444444444444444444444444444","branch":"work/demo-change","changeId":"demo-change","changedPaths":["openspec/changes/demo-change/tasks.md"],"completedAt":null,"createdAt":"2026-10-24T10:00:00.000Z","gitCommonDirectory":"/repository/.git","kind":"open-task-transaction.v2","mandateBinding":null,"mandateTaskId":null,"parentCommit":"1111111111111111111111111111111111111111","parentTree":"2222222222222222222222222222222222222222","phase":"prepared","planningCommit":"3333333333333333333333333333333333333333","reportId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","repositoryRoot":"/repository","schemaVersion":2,"sessionId":"session-one","taskId":"1.1","transactionId":"714375a8e91e4462179bfad7fc236ce584e174afe227c5a0a72dcdf8f4143bf3","worktree":"/repository"}\n';
const MANDATE_BYTES =
  '{"authorizationPolicyDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baselineTree":"4444444444444444444444444444444444444444","branch":"work/demo-change","changeId":"demo-change","changedPaths":["openspec/changes/demo-change/tasks.md"],"completedAt":null,"createdAt":"2026-10-24T10:00:00.000Z","gitCommonDirectory":"/repository/.git","kind":"open-task-transaction.v2","mandateBinding":{"changeId":"demo-change","externalAuditRoot":"/audit","mandateDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","mandateId":"12345678-1234-4234-8234-123456789abc","mandateTaskId":"mandate-one","schemaVersion":1},"mandateTaskId":"mandate-one","parentCommit":"1111111111111111111111111111111111111111","parentTree":"2222222222222222222222222222222222222222","phase":"prepared","planningCommit":"3333333333333333333333333333333333333333","reportId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","repositoryRoot":"/repository","schemaVersion":2,"sessionId":"session-one","taskId":"1.1","transactionId":"94274741ee7bb605c2365cc8f1240d651a58f821a058c6fc2c7f7ae1ec2368e0","worktree":"/repository"}\n';

function input(mandated = false) {
  return {
    changeId: 'demo-change',
    taskId: '1.1',
    mandateTaskId: mandated ? 'mandate-one' : null,
    mandateBinding: mandated
      ? {
          schemaVersion: 1 as const,
          mandateTaskId: 'mandate-one',
          mandateId: '12345678-1234-4234-8234-123456789abc',
          mandateDigest: 'c'.repeat(64),
          changeId: 'demo-change',
          externalAuditRoot: '/audit',
        }
      : null,
    authorizationPolicyDigest: 'sha256:' + 'a'.repeat(64),
    repositoryRoot: '/repository',
    gitCommonDirectory: '/repository/.git',
    worktree: '/repository',
    branch: 'work/demo-change',
    parentCommit: '1'.repeat(40),
    parentTree: '2'.repeat(40),
    planningCommit: '3'.repeat(40),
    baselineTree: '4'.repeat(40),
    reportId: 'b'.repeat(64),
    changedPaths: ['openspec/changes/demo-change/tasks.md'],
    sessionId: 'session-one',
    createdAt: '2026-10-24T10:00:00.000Z',
  };
}

for (const [mandated, bytes] of [
  [false, ORDINARY_BYTES],
  [true, MANDATE_BYTES],
] as const) {
  test(`open-task ${mandated ? 'mandate' : 'ordinary'} journal matches fixed canonical bytes and identity`, () => {
    const created = createPreparedOpenTaskJournal(input(mandated));
    assert.equal(canonicalJson(created) + '\n', bytes);
    assert.deepEqual(parseOpenTaskJournal(bytes), created);
    assert.equal(
      exactOpenTaskRetryCommand(created),
      'pnpm workflow open-task demo-change --task 1.1' +
        (mandated ? ' --mandate mandate-one' : '') +
        ' --json',
    );
  });
}

test('open-task phase progression and completion preserve stable transaction identity', () => {
  for (const bytes of [ORDINARY_BYTES, MANDATE_BYTES]) {
    const prepared = parseOpenTaskJournal(bytes);
    const committed = advanceOpenTaskJournalPhase(prepared, 'plan-committed');
    const active = advanceOpenTaskJournalPhase(committed, 'session-active');
    assertOpenTaskCompletionPhase(active);
    const completed = parseOpenTaskJournal({
      ...active,
      phase: 'completed',
      completedAt: exactOpenTaskTimestamp(new Date('2026-10-24T10:01:00Z')),
    });
    for (const journal of [committed, active, completed]) {
      assert.equal(journal.transactionId, prepared.transactionId);
      assert.deepEqual(
        { ...journal, phase: 'prepared', completedAt: null },
        prepared,
      );
      assert.equal(Object.isFrozen(journal), true);
    }
    assert.equal(prepared.phase, 'prepared');
    assert.equal(committed.completedAt, null);
    assert.equal(completed.completedAt, '2026-10-24T10:01:00.000Z');
    assert.throws(
      () => advanceOpenTaskJournalPhase(prepared, 'session-active'),
      {
        code: 'OPEN_TASK_PHASE_DIVERGED',
        exitCode: ExitCode.staleState,
        message: 'Open-task cannot advance from prepared to session-active.',
      },
    );
    assert.throws(() => advanceOpenTaskJournalPhase(active, 'plan-committed'), {
      code: 'OPEN_TASK_PHASE_DIVERGED',
      exitCode: ExitCode.staleState,
      message:
        'Open-task cannot advance from session-active to plan-committed.',
    });
    for (const incomplete of [prepared, committed]) {
      assert.throws(() => assertOpenTaskCompletionPhase(incomplete), {
        code: 'OPEN_TASK_PHASE_DIVERGED',
        exitCode: ExitCode.staleState,
        message:
          'Open-task cannot complete before its exact session-active phase.',
      });
    }
  }
});

test('open-task creation clones caller data while freezing only the journal object', () => {
  const source = input(true);
  const journal = createPreparedOpenTaskJournal(source);
  assert.notEqual(journal.changedPaths, source.changedPaths);
  assert.notEqual(journal.mandateBinding, source.mandateBinding);
  assert.equal(Object.isFrozen(journal), true);
  assert.equal(Object.isFrozen(journal.changedPaths), false);
  assert.equal(Object.isFrozen(journal.mandateBinding), false);
  source.changedPaths.push('later.txt');
  source.mandateBinding!.externalAuditRoot = '/later';
  assert.equal(canonicalJson(journal) + '\n', MANDATE_BYTES);
});

test('open-task parser preserves schema, binding, path and timestamp error classification', () => {
  const ordinary = JSON.parse(ORDINARY_BYTES);
  const mandate = JSON.parse(MANDATE_BYTES);
  const corrupt = 'OPEN_TASK_JOURNAL_CORRUPT';
  const cases: [unknown, string, number, string][] = [
    ['{', corrupt, 14, 'Open-task journal is not JSON.'],
    [
      { ...ordinary, extra: true },
      corrupt,
      14,
      'Open-task journal is malformed.',
    ],
    [
      { ...ordinary, schemaVersion: 1 },
      corrupt,
      14,
      'Open-task journal is malformed.',
    ],
    [
      { ...ordinary, completedAt: ordinary.createdAt },
      corrupt,
      14,
      'Open-task journal is malformed.',
    ],
    [
      { ...ordinary, phase: 'completed' },
      corrupt,
      14,
      'Open-task journal is malformed.',
    ],
    [
      { ...mandate, mandateTaskId: null },
      corrupt,
      14,
      'Open-task journal bindings are not exact.',
    ],
    [
      {
        ...mandate,
        mandateBinding: { ...mandate.mandateBinding, changeId: 'other-change' },
      },
      corrupt,
      14,
      'Open-task journal bindings are not exact.',
    ],
    [
      {
        ...mandate,
        mandateBinding: { ...mandate.mandateBinding, mandateId: 'bad' },
      },
      corrupt,
      14,
      'Open-task mandate binding is malformed.',
    ],
    [
      { ...ordinary, changedPaths: ['b', 'a'] },
      corrupt,
      14,
      'Open-task journal identity is malformed.',
    ],
    [
      { ...ordinary, changedPaths: ['a', 'a'] },
      corrupt,
      14,
      'Open-task journal identity is malformed.',
    ],
    [
      { ...ordinary, worktree: 'relative' },
      corrupt,
      14,
      'Open-task journal identity is malformed.',
    ],
    [
      { ...ordinary, createdAt: 'invalid' },
      'OPEN_TASK_CLOCK_INVALID',
      14,
      'Open-task requires a valid wall-clock timestamp.',
    ],
    [
      { ...ordinary, createdAt: '2026-10-24T10:00:00Z' },
      corrupt,
      14,
      'Open-task journal bindings are not exact.',
    ],
    [
      { ...ordinary, changeId: 'INVALID' },
      'INVALID_CHANGE_ID',
      2,
      'Invalid change ID: INVALID',
    ],
    [
      { ...ordinary, taskId: 'invalid' },
      'INVALID_TASK_ID',
      2,
      'Invalid task ID: invalid',
    ],
    [
      { ...ordinary, changedPaths: ['../outside'] },
      'INVALID_REPOSITORY_PATH',
      10,
      'Invalid repository path reported by Git: ../outside',
    ],
    [
      { ...ordinary, transactionId: '0'.repeat(64) },
      corrupt,
      14,
      'Open-task transaction identity does not match.',
    ],
  ];
  for (const [value, code, exitCode, message] of cases) {
    assert.throws(
      () => parseOpenTaskJournal(value),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, code);
        assert.equal(error.exitCode, exitCode);
        assert.equal(error.message, message);
        return true;
      },
    );
  }
});

test('journal parsing retains the distinct ingress mandate length rule and exact timestamp conversion', () => {
  const source = input(true);
  const longId = 'a'.repeat(129);
  source.mandateTaskId = longId;
  source.mandateBinding!.mandateTaskId = longId;
  const journal = createPreparedOpenTaskJournal(source);
  assert.equal(
    parseOpenTaskJournal(canonicalJson(journal)).mandateTaskId,
    longId,
  );
  assert.equal(assertOpenTaskMandateTaskId('a'.repeat(128)), 'a'.repeat(128));
  for (const id of [longId, 'INVALID']) {
    assert.throws(() => assertOpenTaskMandateTaskId(id), {
      code: 'OPEN_TASK_MANDATE_TASK_ID_INVALID',
      exitCode: ExitCode.usage,
    });
  }
  assert.equal(
    exactOpenTaskTimestamp(new Date('2026-10-24T12:00:00+02:00')),
    '2026-10-24T10:00:00.000Z',
  );
  assert.throws(() => exactOpenTaskTimestamp(new Date(NaN)), {
    code: 'OPEN_TASK_CLOCK_INVALID',
    exitCode: ExitCode.staleState,
  });
});

test('open-task journal value and type dependencies stay in the permanent pure closure', () => {
  const entry = fileURLToPath(
    new URL('../src/modules/lifecycle/open-task-journal.ts', import.meta.url),
  );
  const closure = assertPureDependencyClosure(entry);
  for (const typeOwner of [
    'lifecycle/open-task-status.ts',
    'authority/task-mandate-contract.ts',
  ]) {
    assert.ok(
      [...closure].some((file) => file.endsWith('/modules/' + typeOwner)),
      typeOwner,
    );
  }
  for (const effect of [
    "import fs from 'node:fs';",
    "import type { Stats } from 'node:fs';",
  ]) {
    assert.throws(
      () => assertPureDependencyClosure(entry, effect),
      /Effect import/,
    );
  }
});
