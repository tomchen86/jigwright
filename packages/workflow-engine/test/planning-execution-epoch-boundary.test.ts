import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlanningExecutionEpochOperations } from '../src/application/propose/planning-execution-epoch.ts';
import {
  planningExecutionWorkflowId,
  planningManifest,
  taskEvidenceItems,
  type PlanningExecutionEpochTransition,
} from '../src/modules/lifecycle/planning-execution-epoch.ts';
import type { PlanningExecutionEpochObservations } from '../src/modules/lifecycle/planning-execution-epoch-observations.ts';
import type { ExecutionEpochStore } from '../src/modules/authority/execution-governance-epoch-port.ts';
import type {
  DurableEpochContextState,
  DurableRetentionCatalog,
} from '../src/modules/authority/execution-governance-store-contracts.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const input: PlanningExecutionEpochTransition = {
  changeId: 'demo-change',
  amendmentCommit: 'a'.repeat(40),
  parentCommit: 'b'.repeat(40),
  planningGeneration: 'c'.repeat(64),
  amendsPlanningGeneration: 'd'.repeat(64),
  decisionDigest: 'e'.repeat(64),
  reportId: 'f'.repeat(64),
  executionImpact: 'none',
  taskEvidence: [
    {
      taskId: '1.1',
      source: 'managed-task-commit',
      commitHash: '1'.repeat(40),
    },
  ],
  createdAt: '2026-08-12T09:00:00.000Z',
};
const workflowId = planningExecutionWorkflowId(input.changeId);
const manifest = planningManifest({
  workflowId,
  epoch: 2,
  contractVersion: 2,
  commit: input.amendmentCommit,
  intent: input.decisionDigest,
  planningGeneration: input.planningGeneration,
  items: taskEvidenceItems(input.taskEvidence),
});
const context: DurableEpochContextState = {
  schemaVersion: 1,
  kind: 'durable-epoch-context',
  generation: 2,
  workflow: {
    workflowId,
    currentEpoch: 2,
    contractVersion: 2,
    contextDigest: manifest.contextDigest,
    snapshotDigest: manifest.baselineDigest,
    status: 'active',
    checkpoint: 'execution-complete',
    blocker: null,
  },
  currentManifest: manifest,
  transitionReceipts: [],
  transitionStubs: [],
  updatedAt: input.createdAt,
};
const retention: DurableRetentionCatalog = {
  schemaVersion: 1,
  kind: 'durable-retention-catalog',
  workflowId,
  generation: 1,
  records: [],
  updatedAt: input.createdAt,
};
const missing = workflowError(
  'EXECUTION_CONTEXT_NOT_FOUND',
  'missing',
  ExitCode.staleState,
);
function setup(
  store: Partial<ExecutionEpochStore> = {},
  observation: Partial<PlanningExecutionEpochObservations> = {},
) {
  const calls: string[] = [];
  const executionEpochStore: ExecutionEpochStore = {
    inspectDurableEpochContextStore() {
      calls.push('inspect');
      return context;
    },
    inspectDurableRetentionCatalog() {
      calls.push('retention');
      return retention;
    },
    initializeDurableEpochContextStore() {
      calls.push('initialize');
      throw new Error('unexpected initialize');
    },
    rolloverDurableEpochContextStore() {
      calls.push('rollover');
      throw new Error('unexpected rollover');
    },
    ...store,
  };
  const observations: PlanningExecutionEpochObservations = {
    resolveEnvironment() {
      calls.push('environment');
      return {
        repositoryRoot: '/memory',
        changeRoot: 'changes',
        storeRoot: '/memory/runtime',
      };
    },
    readFirstParentCommits() {
      calls.push('commits');
      return [input.amendmentCommit];
    },
    readCommitFacts() {
      calls.push('facts');
      return {
        hash: input.amendmentCommit,
        parents: [input.parentCommit],
        tree: '2'.repeat(40),
        message: [
          'Amend plan',
          '',
          `Change: ${input.changeId}`,
          'Transition: amend-plan',
          `Planning-Generation: ${input.planningGeneration}`,
          `Amends-Planning-Generation: ${input.amendsPlanningGeneration}`,
          'Execution-Impact: none',
          `Plan-Review: ${'3'.repeat(64)}`,
        ].join('\n'),
      };
    },
    readReportEntries() {
      calls.push('entries');
      return [];
    },
    readPlanningTransitionReport() {
      calls.push('report');
      throw new Error('unexpected report');
    },
    taskExecutionGeneration() {
      calls.push('generation');
      throw new Error('unexpected generation');
    },
    ...observation,
  };
  return {
    calls,
    operations: createPlanningExecutionEpochOperations({
      executionEpochStore,
      observations,
    }),
  };
}
const archiveInput = {
  changeId: input.changeId,
  head: input.amendmentCommit,
  planningGeneration: input.planningGeneration,
  taskEvidence: input.taskEvidence,
  now: new Date(input.createdAt),
};

test('epoch and report rules have a complete pure type and value dependency closure', () => {
  for (const name of [
    'planning-execution-epoch.ts',
    'planning-execution-epoch-observations.ts',
    'planning-transition-report.ts',
  ])
    assertPureDependencyClosure(
      fileURLToPath(
        new URL(`../src/modules/lifecycle/${name}`, import.meta.url),
      ),
    );
});
test('construction is inert and repeated epoch inspection observes fresh environment and retention in order', () => {
  const { calls, operations } = setup();
  assert.deepEqual(calls, []);
  const result = operations.recordPlanningExecutionEpochTransition(
    '/memory',
    input,
  );
  assert.equal(result.context, context);
  assert.equal(result.retention, retention);
  assert.deepEqual(calls, [
    'environment',
    'inspect',
    'environment',
    'inspect',
    'retention',
  ]);
});
test('bad evidence rejects after environment observation and before durable inspection', () => {
  const { calls, operations } = setup();
  assert.throws(
    () =>
      operations.recordPlanningExecutionEpochTransition('/memory', {
        ...input,
        taskEvidence: [],
      }),
    { code: 'PLANNING_EXECUTION_EPOCH_INVALID' },
  );
  assert.deepEqual(calls, ['environment']);
});
test('non-missing store errors propagate unchanged without recovery or initialization', () => {
  const failure = new Error('store unavailable');
  const { calls, operations } = setup({
    inspectDurableEpochContextStore() {
      throw failure;
    },
  });
  assert.throws(
    () => operations.recordPlanningExecutionEpochTransition('/memory', input),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['environment']);
});
test('initialization timestamp validation remains after missing-state observation and before the write', () => {
  const { calls, operations } = setup({
    inspectDurableEpochContextStore() {
      throw missing;
    },
  });
  assert.throws(
    () =>
      operations.recordPlanningExecutionEpochTransition('/memory', {
        ...input,
        createdAt: 'bad',
      }),
    { code: 'PLANNING_EXECUTION_EPOCH_INVALID' },
  );
  assert.deepEqual(calls, ['environment']);
});
test('missing immutable amendment report refuses after ordered Git and directory observations without CI reads', () => {
  const { calls, operations } = setup({
    inspectDurableEpochContextStore() {
      throw missing;
    },
  });
  assert.throws(
    () =>
      operations.ensurePlanningExecutionEpochCompleteForArchive(
        '/memory',
        archiveInput,
      ),
    { code: 'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID' },
  );
  assert.deepEqual(calls, ['environment', 'commits', 'facts', 'entries']);
});
test('a report read fault propagates identically before any source generation or durable write', () => {
  const failure = new Error('report unavailable');
  const { calls, operations } = setup(
    {
      inspectDurableEpochContextStore() {
        throw missing;
      },
    },
    {
      readReportEntries() {
        return ['not-a-report', `${input.reportId}.json`];
      },
      readPlanningTransitionReport() {
        throw failure;
      },
    },
  );
  assert.throws(
    () =>
      operations.ensurePlanningExecutionEpochCompleteForArchive(
        '/memory',
        archiveInput,
      ),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['environment', 'commits', 'facts']);
});
