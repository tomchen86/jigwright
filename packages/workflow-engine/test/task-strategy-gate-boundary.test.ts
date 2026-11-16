import {
  assertTaskStrategyRedTransactionCurrent,
  assertCurrentTaskStrategyPatch,
  type TaskStrategyPatchEvidence,
} from '../src/modules/assurance/task-strategy-gate.ts';
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createTaskStrategyExecutionGate } from '../src/application/finalize/task-strategy-gate.ts';
import type {
  TaskStrategyGateInspection,
  TaskStrategyGateObservations,
  TaskStrategyGateCorrectionEvidence,
} from '../src/modules/assurance/task-strategy-gate.ts';
import type { TaskStrategyTransaction } from '../src/modules/assurance/task-strategy-evidence.ts';
import type { TddSingleAgentExecution } from '../src/modules/planning-provider/planning-artifact-types.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const digest = 'a'.repeat(64);
const objectId = 'b'.repeat(40);
const task: TddSingleAgentExecution = {
  strategy: 'tdd-single-agent',
  enforcement: 'planned',
  allowedPaths: ['test/**'],
  requiredChecks: ['unit'],
  diffReview: 'required',
  behaviorContractRefs: [],
  testPathScopes: ['test/**'],
  fixturePathScopes: [],
  implementationPathScopes: ['src/**'],
  redCheck: 'unit',
  greenChecks: ['unit'],
  requiredImplementerIndependence: 'none',
};
const inspection: TaskStrategyGateInspection = {
  session: {
    sessionId: 'session-gate',
    changeId: 'demo-change',
    taskId: '1.1',
    baseline: { head: objectId, tree: objectId },
  },
  contract: {
    execution: {
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId: 'demo-change',
      tasks: { '1.1': task },
    },
  },
  changedPaths: ['test/red.test.ts'],
};
const redEvidence = createEvidenceNode({
  type: 'gate-red',
  nodeSchema: 'v1',
  evaluator: 'gate-test',
  policyDigest: digest,
  exactInputDigests: {},
  semanticParentResultDigests: {},
  provenanceParentNodeIds: {},
  outputSchema: 'v1',
  output: {},
  runtimeMetadata: {},
});
const transaction: TaskStrategyTransaction = {
  schemaVersion: 1,
  kind: 'task-strategy-transaction.v1',
  recordDigest: digest,
  sessionId: 'session-gate',
  changeId: 'demo-change',
  taskId: '1.1',
  baseline: inspection.session.baseline,
  strategy: 'tdd-single-agent',
  phase: 'red-sealed',
  taskContractDigest: crypto
    .createHash('sha256')
    .update(canonicalJson(task))
    .digest('hex'),
  author: { providerId: 'codex', assurance: 'adapter-assigned' },
  red: {
    candidateTree: objectId,
    changedPaths: ['test/red.test.ts'],
    checkId: 'unit',
    runner: 'unit',
    runnerDigest: digest,
    exitCode: 1,
    failureCategory: 'assertion',
    selector: 'unit',
    testPaths: ['test/red.test.ts'],
    fixturePaths: [],
    files: [{ path: 'test/red.test.ts', mode: '100644', objectId }],
    stdoutDigest: digest,
    stderrDigest: digest,
    failureFingerprint: digest,
    evidenceNodeId: redEvidence.nodeId,
    evidenceResultDigest: redEvidence.resultDigest,
    evidenceNode: redEvidence,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
};

function fixture(
  overrides: Partial<TaskStrategyGateObservations> = {},
  correctionOverride?: TaskStrategyGateCorrectionEvidence,
) {
  const calls: string[] = [];
  const observations: TaskStrategyGateObservations = {
    readTransaction() {
      calls.push('transaction');
      return transaction;
    },
    previewTree() {
      calls.push('preview');
      return { tree: objectId };
    },
    readFrozenFiles() {
      calls.push('frozen');
      return [...transaction.red.files];
    },
    readPatchEvidence() {
      calls.push('patch');
      return { binding: null, record: null, receipt: null, reservation: null };
    },
    readCorrectionFailure() {
      calls.push('failure');
      return null;
    },
    readImplementationAuthority() {
      calls.push('authority');
      return { implementationResult: null, callerImplementationResult: null };
    },
    ...overrides,
  };
  const gate = createTaskStrategyExecutionGate<TaskStrategyGateInspection>({
    observeRepository() {
      calls.push('open');
      return observations;
    },
    resolveCorrection() {
      calls.push('correction');
      return (
        correctionOverride ?? {
          transaction,
          head: null,
          failure: null,
          completedCorrectionRounds: 0,
        }
      );
    },
    assertMechanicalEvidence() {
      calls.push('mechanical');
    },
    recordGreenFailure() {
      calls.push('record-green-failure');
      return null;
    },
  });
  return { calls, gate };
}

test('strategy rules and canonical failure parsers have a pure transitive value/type closure', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  for (const relative of [
    'modules/assurance/task-strategy-gate.ts',
    'modules/assurance/task-strategy-implementation-record.ts',
    'modules/assurance/task-strategy-implementation-values.ts',
    'modules/provider-orchestration/task-strategy-provider-contract.ts',
  ])
    assertPureDependencyClosure(path.join(src, relative));
});

test('missing and stale RED evidence reject before preview or correction observation', () => {
  for (const record of [null, { ...transaction, taskId: '2.1' }]) {
    const { calls, gate } = fixture({
      readTransaction() {
        return record;
      },
    });
    assert.throws(() => gate.assertExecutionAdmitted(inspection, {}), {
      code:
        record === null
          ? 'TASK_STRATEGY_RED_REQUIRED'
          : 'TASK_STRATEGY_RED_STALE',
    });
    assert.deepEqual(calls, ['open']);
  }
});

test('RED path mismatch prevents frozen Git reads and correction observation', () => {
  const { calls, gate } = fixture();
  assert.throws(
    () =>
      gate.assertExecutionAdmitted(
        { ...inspection, changedPaths: ['test/other.test.ts'] },
        {},
      ),
    { code: 'TASK_STRATEGY_RED_STALE' },
  );
  assert.deepEqual(calls, ['open', 'transaction', 'preview']);
});

test('missing imported head rejects after fresh frozen and correction observations', () => {
  const { calls, gate } = fixture();
  for (let i = 0; i < 2; i++)
    assert.throws(() => gate.assertExecutionAdmitted(inspection, {}), {
      code: 'TASK_STRATEGY_PATCH_REQUIRED',
    });
  assert.deepEqual(calls, [
    'open',
    'transaction',
    'preview',
    'frozen',
    'correction',
    'open',
    'transaction',
    'preview',
    'frozen',
    'correction',
  ]);
});

test('patch observation failure propagates exactly and cannot trigger authority reads', () => {
  const failure = new Error('injected patch read failure');
  const correction = {
    transaction,
    head: {
      binding: { bindingDigest: digest },
      record: { sourceTree: objectId, patchDigest: digest },
      receipt: { receiptDigest: digest },
    },
    failure: null,
    completedCorrectionRounds: 0,
  } as TaskStrategyGateCorrectionEvidence;
  const { calls, gate } = fixture(
    {
      readPatchEvidence() {
        throw failure;
      },
    },
    correction,
  );
  assert.throws(
    () => gate.assertExecutionAdmitted(inspection, {}),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    'open',
    'transaction',
    'preview',
    'frozen',
    'correction',
  ]);
});

test('missing patch records still observe authority before final patch validation', () => {
  const correction = {
    transaction,
    head: {
      binding: { bindingDigest: digest },
      record: { sourceTree: objectId, patchDigest: digest },
      receipt: { receiptDigest: digest },
    },
    failure: null,
    completedCorrectionRounds: 0,
  } as TaskStrategyGateCorrectionEvidence;
  const { calls, gate } = fixture({}, correction);
  assert.throws(() => gate.assertExecutionAdmitted(inspection, {}), {
    code: 'TASK_STRATEGY_PATCH_STALE',
  });
  assert.deepEqual(calls, [
    'open',
    'transaction',
    'preview',
    'frozen',
    'correction',
    'patch',
    'authority',
  ]);
});

test('RED identity mismatches reject before repository preview without adding a sessionId check', () => {
  const changes: Array<Partial<TaskStrategyTransaction>> = [
    { changeId: 'other' },
    { taskId: 'other' },
    { strategy: 'cross-agent-tdd' },
    { baseline: { ...transaction.baseline, head: 'other' } },
    { baseline: { ...transaction.baseline, tree: 'other' } },
    { taskContractDigest: 'other' },
  ];
  for (const change of changes) {
    const { calls, gate } = fixture({
      readTransaction: () => ({ ...transaction, ...change }),
    });
    assert.throws(() => gate.assertExecutionAdmitted(inspection, {}), {
      code: 'TASK_STRATEGY_RED_STALE',
    });
    assert.deepEqual(calls, ['open']);
  }
  assert.doesNotThrow(() =>
    assertTaskStrategyRedTransactionCurrent(inspection, task, {
      ...transaction,
      sessionId: 'different-session',
    }),
  );
});

test('RED reads only its original identity facts and serializes the full baseline', () => {
  const session = {
    ...inspection.session,
    baseline: { ...inspection.session.baseline, extra: 'original' },
  };
  const record = { ...transaction, baseline: { ...session.baseline } };
  const failRead = {
    get() {
      assert.fail('RED read a lifecycle field or sessionId');
    },
  };
  for (const name of [
    'sessionId',
    'state',
    'isolation',
    'planningAssurance',
    'latestCheckReportId',
  ])
    Object.defineProperty(session, name, failRead);
  Object.defineProperty(record, 'sessionId', failRead);
  assert.doesNotThrow(() =>
    assertTaskStrategyRedTransactionCurrent({ session }, task, record),
  );
  record.baseline.extra = 'changed';
  assert.throws(
    () => assertTaskStrategyRedTransactionCurrent({ session }, task, record),
    { code: 'TASK_STRATEGY_RED_STALE' },
  );
});

test('patch admission still rejects a sessionId-only mismatch after valid RED evidence', () => {
  const record: NonNullable<TaskStrategyPatchEvidence['record']> = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-record.v1',
    recordDigest: digest,
    sessionId: inspection.session.sessionId,
    changeId: inspection.session.changeId,
    taskId: inspection.session.taskId,
    strategy: task.strategy,
    sourceTree: objectId,
    candidateTree: objectId,
    taskContractDigest: transaction.taskContractDigest,
    patchDigest: digest,
    patchBase64: '',
    changedPaths: [],
    changes: [],
    implementer: transaction.author,
    createdAt: transaction.createdAt,
  };
  const receipt: NonNullable<TaskStrategyPatchEvidence['receipt']> = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-import-receipt.v1',
    receiptDigest: digest,
    recordDigest: digest,
    sessionId: inspection.session.sessionId,
    patchDigest: digest,
    candidateTree: objectId,
    importedAt: transaction.createdAt,
  };
  const binding: NonNullable<TaskStrategyPatchEvidence['binding']> = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-current.v1',
    bindingDigest: digest,
    sessionId: inspection.session.sessionId,
    patchDigest: digest,
    recordDigest: digest,
    receiptDigest: digest,
    candidateTree: objectId,
    createdAt: receipt.importedAt,
  };
  const reservation: NonNullable<TaskStrategyPatchEvidence['reservation']> = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-reservation.v1',
    reservationDigest: digest,
    sessionId: inspection.session.sessionId,
    patchDigest: digest,
    recordDigest: digest,
    sourceTree: objectId,
    candidateTree: objectId,
    createdAt: record.createdAt,
  };
  const assertPatch = (candidate: typeof record) =>
    assertCurrentTaskStrategyPatch(
      inspection,
      task,
      transaction,
      { tree: objectId },
      { binding, record, receipt },
      objectId,
      { binding, record: candidate, receipt, reservation },
      { implementationResult: null, callerImplementationResult: null },
    );
  assert.doesNotThrow(() => assertPatch(record));
  assert.doesNotThrow(() =>
    assertTaskStrategyRedTransactionCurrent(inspection, task, {
      ...transaction,
      sessionId: 'other',
    }),
  );
  assert.throws(() => assertPatch({ ...record, sessionId: 'other' }), {
    code: 'TASK_STRATEGY_PATCH_STALE',
  });
});
