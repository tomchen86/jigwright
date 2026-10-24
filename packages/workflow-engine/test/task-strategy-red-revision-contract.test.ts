import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import type { TaskStrategyTransaction } from '../src/modules/assurance/task-strategy-evidence.ts';
import {
  prepareTaskStrategyTransaction,
  parseTaskStrategyTransaction,
  isSameReviewedTaskStrategyLineage,
} from '../src/modules/assurance/task-strategy-transaction.ts';
import {
  createTaskStrategyCurrentRef,
  parseTaskStrategyCurrentRef,
} from '../src/modules/assurance/task-strategy-current-ref.ts';
import {
  parseTaskStrategyRedRevisionRequest,
  taskStrategyRedRevisionId,
  taskStrategyRedRevisionRequestDigest,
  taskStrategyRedRevisionSnapshotDigest,
  buildRevisionJournal,
  parseTaskStrategyRedRevisionJournal,
  assertNextJournalState,
  sameJournalState,
  type TaskStrategyRedRevisionJournalState,
} from '../src/modules/assurance/task-strategy-red-revision-contract.ts';
import {
  TASK_STRATEGY_RED_REVISION_PHASES,
  revisionRequestInvalid,
  revisionPhaseInvalid,
  revisionStateCorrupt,
} from '../src/modules/assurance/task-strategy-red-revision-values.ts';
const digest = (v: unknown) =>
  crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
function redigest<T extends object>(value: T, key: string): T {
  const obj = { ...value } as Record<string, unknown>;
  delete obj[key];
  return { ...obj, [key]: digest(obj) } as T;
}
function set(value: object, field: string, replacement: unknown) {
  const keys = field.split('.');
  let cursor = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    cursor = cursor[key] as Record<string, unknown>;
  cursor[keys.at(-1)!] = replacement;
}
function transactionInput(
  marker: string,
): Omit<TaskStrategyTransaction, 'schemaVersion' | 'kind' | 'recordDigest'> {
  const candidateTree = marker.repeat(40);
  const evidenceNode = createEvidenceNode({
    type: 'task-strategy-red-evidence',
    nodeSchema: 'task-strategy-red-evidence.v1',
    evaluator: 'workflow-engine',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { candidateTree: 'b'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'task-strategy-red-result.v1',
    output: { marker },
    runtimeMetadata: { createdAt: '2026-08-13T00:00:00.000Z' },
  });
  return {
    sessionId: 'session-store-contract',
    changeId: 'demo-change',
    taskId: '1.1',
    baseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
    strategy: 'tdd-single-agent',
    phase: 'red-sealed',
    taskContractDigest: 'c'.repeat(64),
    author: { providerId: 'codex', assurance: 'self-declared' },
    red: {
      candidateTree,
      changedPaths: ['test/feature.test.mjs'],
      checkId: 'red',
      runner: 'node --test test/feature.test.mjs',
      runnerDigest: 'd'.repeat(64),
      exitCode: 1,
      failureCategory: 'assertion',
      selector: 'test/feature.test.mjs',
      testPaths: ['test/feature.test.mjs'],
      fixturePaths: [],
      files: [
        {
          path: 'test/feature.test.mjs',
          mode: '100644',
          objectId: marker.repeat(40),
        },
      ],
      stdoutDigest: 'e'.repeat(64),
      stderrDigest: 'f'.repeat(64),
      failureFingerprint: '1'.repeat(64),
      evidenceNodeId: evidenceNode.nodeId,
      evidenceResultDigest: evidenceNode.resultDigest,
      evidenceNode,
    },
    createdAt: `2026-08-13T00:00:0${marker}.000Z`,
  };
}

function fixture() {
  const predecessor = prepareTaskStrategyTransaction(transactionInput('1'));
  const successor = prepareTaskStrategyTransaction(transactionInput('2'));
  const request = parseTaskStrategyRedRevisionRequest({
    schemaVersion: 1,
    kind: 'task-strategy-red-revision-request',
    sessionId: predecessor.sessionId,
    expectedTransactionDigest: predecessor.recordDigest,
    reason: 'Correct assertion',
  });
  const revisionId = taskStrategyRedRevisionId(request);
  const current = createTaskStrategyCurrentRef({
    sessionId: predecessor.sessionId,
    state: 'red-sealed',
    transactionDigest: predecessor.recordDigest,
    predecessorTransactionDigest: null,
    revisionId: null,
    taskContractDigest: predecessor.taskContractDigest,
    updatedAt: predecessor.createdAt,
  });
  const authoring = createTaskStrategyCurrentRef({
    ...current,
    state: 'red-authoring',
    transactionDigest: null,
    predecessorTransactionDigest: predecessor.recordDigest,
    revisionId,
    updatedAt: successor.createdAt,
  });
  const successorRef = createTaskStrategyCurrentRef({
    ...authoring,
    state: 'red-sealed',
    transactionDigest: successor.recordDigest,
  });
  const before = {
    sessionId: predecessor.sessionId,
    unrelated: { keep: true },
    latestCheckReportId: 'check',
    implementationReconciliationReportId: 'reconcile',
    implementationReconciliationPaths: ['src/semantic.ts'],
  };
  const after = { sessionId: predecessor.sessionId, unrelated: { keep: true } };
  const state: TaskStrategyRedRevisionJournalState = {
    revisionId,
    sessionId: predecessor.sessionId,
    phase: 'prepared',
    request,
    requestDigest: taskStrategyRedRevisionRequestDigest(request),
    predecessor: {
      transactionDigest: predecessor.recordDigest,
      candidateTree: predecessor.red.candidateTree,
      currentRefDigest: current.refDigest,
    },
    binding: {
      changeId: predecessor.changeId,
      taskId: predecessor.taskId,
      baseline: predecessor.baseline,
      strategy: predecessor.strategy,
      taskContractDigest: predecessor.taskContractDigest,
      checkId: predecessor.red.checkId,
      runner: predecessor.red.runner,
      runnerDigest: predecessor.red.runnerDigest,
      author: predecessor.author,
    },
    restoration: {
      sourceTree: predecessor.red.candidateTree,
      implementationCandidateTree: null,
      patchRecordDigest: null,
      patchDigest: null,
    },
    sessionTransition: {
      before,
      beforeDigest: digest(before),
      after,
      afterDigest: digest(after),
    },
    authoringRef: authoring,
    successorTransaction: null,
    successorRef: null,
    createdAt: successor.createdAt,
    updatedAt: successor.createdAt,
  };
  return {
    predecessor,
    successor,
    request,
    current,
    authoring,
    successorRef,
    state,
  };
}
test('pure RED request exact keys UTF-8 limits control characters identity and shallow freeze', () => {
  const f = fixture();
  const valid = { ...f.request, reason: '界'.repeat(1365) + 'a' };
  const parsed = parseTaskStrategyRedRevisionRequest(valid);
  assert.equal(parsed, valid);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(taskStrategyRedRevisionRequestDigest(parsed), digest(parsed));
  assert.equal(
    taskStrategyRedRevisionId(parsed),
    'red-revision-' + digest(parsed),
  );
  const invalid = [
    ...[
      '',
      ' leading',
      'trailing ',
      'a\nb',
      'a\u007fb',
      'a\u0080b',
      '界'.repeat(1366),
    ].map((reason) => ({ ...f.request, reason })),
    { ...f.request, extra: true },
    { ...f.request, schemaVersion: 2 },
    { ...f.request, kind: 'wrong' },
    { ...f.request, sessionId: '../outside' },
    { ...f.request, expectedTransactionDigest: 'f'.repeat(63) },
  ];
  for (const input of invalid)
    assert.throws(() => parseTaskStrategyRedRevisionRequest(input), {
      code: 'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
    });
  assert.equal(
    taskStrategyRedRevisionSnapshotDigest({ b: 1, a: 2 }),
    taskStrategyRedRevisionSnapshotDigest({ a: 2, b: 1 }),
  );
});

test('pure RED current-ref variants enforce exact schema null pairing and redigested identity', () => {
  const f = fixture();
  for (const value of [f.current, f.authoring, f.successorRef]) {
    assert.equal(parseTaskStrategyCurrentRef(value), value);
    assert.ok(Object.isFrozen(value));
    assert.equal(redigest(value, 'refDigest').refDigest, value.refDigest);
  }
  const faults: Array<[string, unknown]> = [
    ['schemaVersion', 2],
    ['kind', 'wrong'],
    ['sessionId', '../escape'],
    ['state', 'other'],
    ['taskContractDigest', 'short'],
    ['updatedAt', 'invalid'],
    ['extra', true],
    ['predecessorTransactionDigest', null],
    ['revisionId', null],
    ['transactionDigest', f.predecessor.recordDigest],
  ];
  for (const [field, value] of faults) {
    const v = structuredClone(f.authoring);
    set(v, field, value);
    assert.throws(
      () => parseTaskStrategyCurrentRef(redigest(v, 'refDigest')),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
      field,
    );
  }
  for (const value of [
    { ...f.successorRef, transactionDigest: f.predecessor.recordDigest },
    { ...f.current, revisionId: f.authoring.revisionId },
    { ...f.current, predecessorTransactionDigest: f.predecessor.recordDigest },
  ])
    assert.throws(
      () => parseTaskStrategyCurrentRef(redigest(value, 'refDigest')),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
    );
  assert.throws(
    () =>
      parseTaskStrategyCurrentRef({ ...f.current, refDigest: '0'.repeat(64) }),
    { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
  );
});

test('pure RED transaction parser rejects redigested malformed metadata RED paths files and evidence', () => {
  const f = fixture();
  assert.equal(parseTaskStrategyTransaction(f.predecessor), f.predecessor);
  assert.ok(Object.isFrozen(f.predecessor));
  assert.equal(
    f.predecessor.recordDigest,
    digest((({ recordDigest, ...body }) => body)(f.predecessor)),
  );
  const faults: Array<[string, unknown]> = [
    ['schemaVersion', 2],
    ['kind', 'wrong'],
    ['phase', 'authoring'],
    ['sessionId', '../x'],
    ['changeId', 'Invalid'],
    ['taskId', 'one'],
    ['baseline.head', 'short'],
    ['baseline.tree', 'short'],
    ['baseline.extra', true],
    ['strategy', 'other'],
    ['taskContractDigest', 'short'],
    ['author.providerId', 'unknown-provider'],
    ['author.assurance', 'other'],
    ['author.extra', true],
    ['createdAt', 'not-time'],
    ['extra', true],
    ['red.candidateTree', 'short'],
    ['red.changedPaths', ['z.ts', 'a.ts']],
    ['red.changedPaths', ['a.ts', 'a.ts']],
    ['red.changedPaths', ['../x']],
    ['red.testPaths', []],
    ['red.fixturePaths', ['/escape']],
    ['red.checkId', ''],
    ['red.runner', ''],
    ['red.runnerDigest', 'short'],
    ['red.exitCode', 0],
    ['red.exitCode', 1.5],
    ['red.failureCategory', 'timeout'],
    ['red.selector', ''],
    ['red.files', []],
    ['red.files', [{ path: '../x', mode: '100644', objectId: '1'.repeat(40) }]],
    [
      'red.files',
      [{ path: 'test/a.ts', mode: '120000', objectId: '1'.repeat(40) }],
    ],
    ['red.files', [{ path: 'test/a.ts', mode: '100644', objectId: 'short' }]],
    ['red.stdoutDigest', 'short'],
    ['red.stderrDigest', 'short'],
    ['red.failureFingerprint', 'short'],
    ['red.evidenceNodeId', 'e'.repeat(64)],
    ['red.evidenceResultDigest', 'e'.repeat(64)],
    ['red.evidenceNode.type', 'other'],
    ['red.extra', true],
  ];
  for (const [field, value] of faults) {
    const v = structuredClone(f.predecessor);
    set(v, field, value);
    assert.throws(
      () => parseTaskStrategyTransaction(redigest(v, 'recordDigest')),
      { code: 'TASK_STRATEGY_STATE_CORRUPT' },
      field,
    );
  }
  assert.throws(
    () =>
      parseTaskStrategyTransaction({
        ...f.predecessor,
        recordDigest: '0'.repeat(64),
      }),
    { code: 'TASK_STRATEGY_STATE_CORRUPT' },
  );
  for (const field of ['changedPaths', 'testPaths', 'fixturePaths', 'files']) {
    const v = structuredClone(f.predecessor);
    set(
      v,
      'red.' + field,
      Array.from({ length: 1025 }, (_, i) =>
        field === 'files'
          ? { path: `test/${i}.ts`, mode: '100644', objectId: '1'.repeat(40) }
          : `test/${i}.ts`,
      ),
    );
    assert.throws(
      () => parseTaskStrategyTransaction(redigest(v, 'recordDigest')),
      { code: 'TASK_STRATEGY_STATE_CORRUPT' },
    );
  }
});

test('pure RED reviewed lineage compares every bound field without conflating candidate bytes', () => {
  const f = fixture();
  assert.ok(isSameReviewedTaskStrategyLineage(f.successor, f.predecessor));
  assert.equal(isSameReviewedTaskStrategyLineage(f.successor, null), false);
  assert.equal(
    isSameReviewedTaskStrategyLineage(f.predecessor, f.predecessor),
    false,
  );
  for (const field of [
    'sessionId',
    'changeId',
    'taskId',
    'baseline.head',
    'baseline.tree',
    'strategy',
    'taskContractDigest',
    'author.providerId',
    'author.assurance',
    'red.checkId',
    'red.runner',
    'red.runnerDigest',
  ]) {
    const v = structuredClone(f.successor);
    set(v, field, 'different');
    assert.equal(
      isSameReviewedTaskStrategyLineage(v, f.predecessor),
      false,
      field,
    );
  }
});

function journalFor(index: number) {
  const f = fixture();
  const state = {
    ...f.state,
    phase: TASK_STRATEGY_RED_REVISION_PHASES[index]!,
    ...(index >= 4
      ? { successorTransaction: f.successor, successorRef: f.successorRef }
      : {}),
  };
  return buildRevisionJournal(state, index === 0 ? null : 'a'.repeat(64));
}
function redigestJournal(v: ReturnType<typeof journalFor>) {
  if (v.authoringRef)
    v = { ...v, authoringRef: redigest(v.authoringRef, 'refDigest') };
  if (v.successorRef)
    v = { ...v, successorRef: redigest(v.successorRef, 'refDigest') };
  if (v.successorTransaction)
    v = {
      ...v,
      successorTransaction: redigest(v.successorTransaction, 'recordDigest'),
    };
  return redigest(v, 'journalDigest');
}
test('pure RED all eight journal phases validate exact canonical bytes and payload nullability', () => {
  for (let i = 0; i < 8; i++) {
    const j = journalFor(i);
    assert.deepEqual(parseTaskStrategyRedRevisionJournal(j), j);
    assert.ok(Object.isFrozen(j));
    assert.ok(Object.isFrozen(j.binding));
    assert.equal(j.journalDigest, redigest(j, 'journalDigest').journalDigest);
    const wrong = {
      ...j,
      successorTransaction: i < 4 ? fixture().successor : null,
      successorRef: i < 4 ? fixture().successorRef : null,
    };
    assert.throws(
      () => parseTaskStrategyRedRevisionJournal(redigestJournal(wrong)),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
    );
    assert.throws(
      () =>
        parseTaskStrategyRedRevisionJournal(
          redigestJournal({
            ...j,
            previousJournalDigest: i === 0 ? 'a'.repeat(64) : null,
          }),
        ),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
    );
  }
});

test('pure RED journal rejects redigested schema request predecessor restoration and session bindings', () => {
  const faults: Array<[string, unknown]> = [
    ['schemaVersion', 2],
    ['kind', 'wrong'],
    ['revisionId', 'red-revision-' + '1'.repeat(64)],
    ['sessionId', 'another-session'],
    ['phase', 'unknown'],
    ['requestDigest', '1'.repeat(64)],
    ['request.reason', 'different'],
    ['predecessor.transactionDigest', '1'.repeat(64)],
    ['predecessor.candidateTree', '9'.repeat(40)],
    ['predecessor.currentRefDigest', 'short'],
    ['binding.changeId', 'BAD'],
    ['binding.taskId', 'bad'],
    ['binding.baseline.head', 'short'],
    ['binding.strategy', 'other'],
    ['binding.checkId', ''],
    ['binding.runner', ''],
    ['binding.runnerDigest', 'short'],
    ['binding.author.providerId', 'bad'],
    ['restoration.sourceTree', '7'.repeat(40)],
    ['restoration.patchDigest', 'f'.repeat(64)],
    ['restoration.patchRecordDigest', 'f'.repeat(64)],
    ['restoration.implementationCandidateTree', 'f'.repeat(40)],
    ['sessionTransition.before.sessionId', 'other'],
    ['sessionTransition.beforeDigest', '1'.repeat(64)],
    ['sessionTransition.after.sessionId', 'other'],
    ['sessionTransition.afterDigest', '1'.repeat(64)],
    ['authoringRef.sessionId', 'other'],
    ['authoringRef.predecessorTransactionDigest', '1'.repeat(64)],
    ['authoringRef.revisionId', 'red-revision-' + '1'.repeat(64)],
    ['authoringRef.taskContractDigest', '1'.repeat(64)],
    ['createdAt', 'bad'],
    ['updatedAt', '2020-01-01T00:00:00Z'],
    ['extra', true],
  ];
  for (const [field, value] of faults) {
    const v = structuredClone(journalFor(0));
    set(v, field, value);
    assert.throws(
      () => parseTaskStrategyRedRevisionJournal(redigestJournal(v)),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
      field,
    );
  }
  for (const field of [
    'unrelated',
    'latestCheckReportId',
    'checkEvidenceEngineDigest',
    'implementationReconciliationReportId',
    'implementationReconciliationPaths',
  ]) {
    const v = structuredClone(journalFor(0));
    const after = { ...v.sessionTransition.after, [field]: 'illicit' };
    const changed = {
      ...v,
      sessionTransition: {
        ...v.sessionTransition,
        after,
        afterDigest: digest(after),
      },
    };
    assert.throws(
      () => parseTaskStrategyRedRevisionJournal(redigestJournal(changed)),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
      field,
    );
  }
});

test('pure RED journal rejects each redigested successor and ref binding and translates invalid transaction', () => {
  for (const field of [
    'sessionId',
    'changeId',
    'taskId',
    'baseline.head',
    'baseline.tree',
    'strategy',
    'taskContractDigest',
    'author.providerId',
    'author.assurance',
    'red.checkId',
    'red.runner',
    'red.runnerDigest',
  ]) {
    const v = structuredClone(journalFor(4));
    const values: Record<string, unknown> = {
      sessionId: 'other-session',
      changeId: 'other-change',
      taskId: '2.1',
      'baseline.head': '9'.repeat(40),
      'baseline.tree': '9'.repeat(40),
      strategy: 'cross-agent-tdd',
      taskContractDigest: '9'.repeat(64),
      'author.providerId': 'claude',
      'author.assurance': 'runtime-hint',
      'red.checkId': 'other',
      'red.runner': 'other',
      'red.runnerDigest': '9'.repeat(64),
    };
    set(v.successorTransaction!, field, values[field]);
    const tx = redigest(v.successorTransaction!, 'recordDigest');
    const changed = {
      ...v,
      successorTransaction: tx,
      successorRef: {
        ...v.successorRef!,
        state: 'red-sealed' as const,
        transactionDigest: tx.recordDigest,
      },
    };
    assert.throws(
      () => parseTaskStrategyRedRevisionJournal(redigestJournal(changed)),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
      field,
    );
  }
  for (const [field, value] of [
    ['sessionId', 'other-session'],
    ['transactionDigest', '9'.repeat(64)],
    ['predecessorTransactionDigest', '9'.repeat(64)],
    ['revisionId', 'red-revision-' + '9'.repeat(64)],
    ['taskContractDigest', '9'.repeat(64)],
  ]) {
    const v = structuredClone(journalFor(4));
    set(v.successorRef!, field!, value);
    assert.throws(
      () => parseTaskStrategyRedRevisionJournal(redigestJournal(v)),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
      field,
    );
  }
  const v = structuredClone(journalFor(4));
  set(v.successorTransaction!, 'red.exitCode', 0);
  assert.throws(() => parseTaskStrategyRedRevisionJournal(redigestJournal(v)), {
    code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT',
  });
});

test('pure RED journal advancement preserves immutable state and only admits the immediate next phase', () => {
  for (let i = 0; i < 7; i++) {
    const current = journalFor(i);
    const next = {
      ...fixture().state,
      ...current,
      phase: TASK_STRATEGY_RED_REVISION_PHASES[i + 1]!,
      updatedAt: '2026-08-13T00:00:05.000Z',
      ...(i + 1 >= 4
        ? {
            successorTransaction: fixture().successor,
            successorRef: fixture().successorRef,
          }
        : {}),
    };
    assert.doesNotThrow(() => assertNextJournalState(current, next));
  }
  const current = journalFor(0);
  const next = {
    ...fixture().state,
    phase: 'implementation-restored' as const,
  };
  for (const phase of ['prepared', 'current-authoring', 'completed'] as const)
    assert.throws(() => assertNextJournalState(current, { ...next, phase }), {
      code: 'TASK_STRATEGY_RED_REVISION_PHASE_INVALID',
    });
  for (const field of [
    'revisionId',
    'sessionId',
    'request.reason',
    'requestDigest',
    'predecessor.currentRefDigest',
    'binding.runner',
    'restoration.sourceTree',
    'sessionTransition.beforeDigest',
    'sessionTransition.afterDigest',
    'authoringRef.refDigest',
    'createdAt',
  ]) {
    const v = structuredClone(next);
    set(v, field, 'changed');
    assert.throws(
      () => assertNextJournalState(current, v),
      { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
      field,
    );
  }
  assert.throws(
    () =>
      assertNextJournalState(current, {
        ...next,
        updatedAt: '2020-01-01T00:00:00Z',
      }),
    { code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT' },
  );
  const late = journalFor(4);
  for (const field of ['successorTransaction', 'successorRef']) {
    const v = {
      ...fixture().state,
      ...late,
      phase: 'successor-persisted' as const,
      [field]: null,
    };
    assert.throws(() => assertNextJournalState(late, v), {
      code: 'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT',
    });
  }
  const { schemaVersion, kind, journalDigest, previousJournalDigest, ...body } =
    current;
  assert.ok(sameJournalState(current, body));
  assert.equal(
    sameJournalState(current, { ...body, updatedAt: '2026-08-13T00:00:09Z' }),
    false,
  );
});

test('pure RED error owners preserve exact codes messages and exit status', () => {
  for (const [make, code, message, exit] of [
    [
      revisionRequestInvalid,
      'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
      'Task strategy RED revision input is malformed or unsafe.',
      2,
    ],
    [
      revisionPhaseInvalid,
      'TASK_STRATEGY_RED_REVISION_PHASE_INVALID',
      'Task strategy RED revision journal cannot skip, repeat with changed data, or move backwards.',
      11,
    ],
    [
      revisionStateCorrupt,
      'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT',
      'Task strategy RED revision state is malformed or unsafe.',
      14,
    ],
  ] as const) {
    const error = make();
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.exitCode, exit);
  }
});
