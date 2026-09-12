import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { TaskSessionReference } from '@jigwright/core/workflow-identifiers';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type { TaskStrategyTransaction } from '../src/modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyGateIdentity } from '../src/modules/assurance/task-strategy-gate.ts';
import type { HarnessBootstrapParentObservation } from '../src/modules/lifecycle/harness-bootstrap-parent-session.ts';
import {
  dependencyOwner,
  readRepositoryDependencies,
} from './support/repository-dependency-graph.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];
type ReadonlyKeys<T> = {
  [K in keyof T]-?: Equal<Pick<T, K>, { -readonly [P in K]: T[P] }> extends true
    ? never
    : K;
}[keyof T];
type GateSession = TaskStrategyGateIdentity['session'];
type ReferenceContract = [
  Assert<
    Equal<
      keyof TaskSessionReference,
      'sessionId' | 'changeId' | 'taskId' | 'baseline'
    >
  >,
  Assert<Equal<OptionalKeys<TaskSessionReference>, never>>,
  Assert<Equal<ReadonlyKeys<TaskSessionReference>, never>>,
  Assert<Equal<ReadonlyKeys<WorkflowSession>, never>>,
  Assert<Equal<ReadonlyKeys<WorkflowSession['baseline']>, never>>,
  Assert<
    Equal<ReadonlyKeys<TaskStrategyTransaction>, keyof TaskStrategyTransaction>
  >,
  Assert<
    Equal<ReadonlyKeys<TaskStrategyTransaction['baseline']>, 'head' | 'tree'>
  >,
  Assert<Equal<OptionalKeys<TaskStrategyTransaction>, never>>,
  Assert<Equal<ReadonlyKeys<GateSession>, never>>,
  Assert<Equal<ReadonlyKeys<GateSession['baseline']>, 'head' | 'tree'>>,
  Assert<Equal<OptionalKeys<GateSession>, never>>,
  Assert<
    Equal<
      HarnessBootstrapParentObservation['candidates'][number]['session'],
      WorkflowSession
    >
  >,
];

// Compiled with the actual public declarations. Never execute these mutations.
function referenceContract(
  session: WorkflowSession,
  transaction: TaskStrategyTransaction,
  gate: GateSession,
  reference: TaskSessionReference,
): ReferenceContract | undefined {
  session.sessionId = reference.sessionId;
  session.changeId = reference.changeId;
  session.taskId = reference.taskId;
  session.baseline = reference.baseline;
  session.baseline.head = reference.baseline.head;
  session.baseline.tree = reference.baseline.tree;
  session.planningAssurance = null;
  session.mandateBinding = null;
  session.mandateBinding = undefined;
  session.revisionLeaseId = undefined;
  gate.sessionId = reference.sessionId;
  gate.changeId = reference.changeId;
  gate.taskId = reference.taskId;
  gate.baseline = reference.baseline;
  const references: TaskSessionReference[] = [session, transaction, gate];
  void references;
  // @ts-expect-error Transaction identity is immutable.
  transaction.sessionId = reference.sessionId;
  // @ts-expect-error Transaction identity is immutable.
  transaction.changeId = reference.changeId;
  // @ts-expect-error Transaction identity is immutable.
  transaction.taskId = reference.taskId;
  // @ts-expect-error Transaction baseline property is immutable.
  transaction.baseline = reference.baseline;
  // @ts-expect-error Transaction baseline members remain immutable.
  transaction.baseline.head = reference.baseline.head;
  // @ts-expect-error Transaction baseline members remain immutable.
  transaction.baseline.tree = reference.baseline.tree;
  // @ts-expect-error Gate baseline members remain immutable.
  gate.baseline.head = reference.baseline.head;
  // @ts-expect-error Gate baseline members remain immutable.
  gate.baseline.tree = reference.baseline.tree;
  // @ts-expect-error A narrow reference cannot replace a complete durable session.
  const complete: WorkflowSession = reference;
  // @ts-expect-error The task ID is required.
  const missingTask: TaskSessionReference = {
    sessionId: reference.sessionId,
    changeId: reference.changeId,
    baseline: reference.baseline,
  };
  const missingTree: TaskSessionReference = {
    ...reference,
    // @ts-expect-error The baseline tree is required.
    baseline: { head: reference.baseline.head },
  };
  void complete;
  void missingTask;
  void missingTree;
  return undefined;
}
void referenceContract;

test('assurance and engine-binding rules have no lifecycle imports and reject value or type back-edges', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const prefix = 'packages/workflow-engine/src/modules/';
  const resolver = readRepositoryDependencies(root);
  for (const relative of [
    'assurance/task-strategy-gate.ts',
    'assurance/task-strategy-evidence.ts',
    'authority/harness-bootstrap-parent-contract.ts',
  ]) {
    const check = (extra = '') => {
      const { edges } = resolver.read(path.join(root, prefix, relative), extra);
      assert.equal(
        edges.some((edge) => dependencyOwner(edge.to) === prefix + 'lifecycle'),
        false,
        relative,
      );
    };
    check();
    for (const declaration of [
      "import type { WorkflowSession } from '../lifecycle/workflow-session-contract.ts';",
      "import { admitHarnessBootstrapParent } from '../lifecycle/harness-bootstrap-parent-session.ts';",
    ])
      assert.throws(() => check('\n' + declaration), assert.AssertionError);
  }
});
