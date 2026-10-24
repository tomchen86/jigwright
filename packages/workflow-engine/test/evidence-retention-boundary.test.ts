/** Exercise retention use cases with memory capabilities, independently of production composition. */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import {
  inspectEvidenceRetention,
  pinWorkflowEvidence,
  runEvidenceRetentionMaintenance,
  type EvidencePinDependencies,
  type RetentionInspectionDependencies,
  type RetentionMaintenanceDependencies,
} from '../src/application/control-plane/evidence-retention.ts';
import {
  collectRetentionWorkflowBindings,
  pinEvidence,
  type EvidenceRetentionRecord,
  type WorkflowRetentionBinding,
} from '../src/modules/authority/execution-governance-retention.ts';
import type { TaskMandateBinding } from '../src/modules/authority/task-mandate-contract.ts';
import type { TaskMandateOptions } from '../src/modules/authority/task-mandate-access-contract.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type {
  DurableEpochContextState,
  DurableEvidencePinInput,
  DurableRetentionCatalog,
} from '../src/modules/authority/execution-governance-store-contracts.ts';
import { buildContextManifest } from '../src/modules/authority/execution-governance-context.ts';
import type {
  ProviderRetentionMetrics,
  ProviderRetentionPassResult,
} from '../src/modules/provider-orchestration/provider-retention.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const digest = `sha256:${'a'.repeat(64)}`;
const binding: TaskMandateBinding = {
  schemaVersion: 1,
  mandateTaskId: 'task-1',
  mandateId: 'mandate-1',
  mandateDigest: digest,
  changeId: 'change-1',
  externalAuditRoot: '/audit',
};
const paths: InvestigationRuntimePaths = {
  base: '/runtime',
  root: '/runtime/store',
  objects: '/runtime/objects',
  refs: '/runtime/refs',
  sessions: '/runtime/sessions',
  invocations: '/runtime/invocations',
  locks: '/runtime/locks',
};
const record: EvidenceRetentionRecord = {
  schemaVersion: 1,
  kind: 'evidence-retention',
  evidenceId: 'evidence-1',
  itemIdentity: null,
  workflowId: 'workflow-1',
  epoch: 1,
  evidenceClass: 'raw',
  digest,
  retention: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: null,
  pin: null,
};
const request = {
  workflowId: record.workflowId,
  evidenceId: record.evidenceId,
  reason: 'Keep incident evidence.',
};
const metrics: ProviderRetentionMetrics = {
  schemaVersion: 1,
  kind: 'provider-retention-metrics',
  measuredAt: NOW.toISOString(),
  ttlDays: 7,
  rawEvidenceBytesByRetentionClass: { active: 3, debug: 2, pinned: 1 },
  expiredPendingDeletion: { count: 1, bytes: 2 },
  pinnedCount: 1,
  receiptCount: 0,
};
const pass: ProviderRetentionPassResult = {
  schemaVersion: 1,
  kind: 'provider-runtime-prune-pass',
  policy: {
    schemaVersion: 1,
    ttlDays: 7,
    maxTtlDays: 90,
    cutoffAt: NOW.toISOString(),
    limit: 2,
  },
  examined: 1,
  recovered: [],
  pruned: [],
  deniedCount: 0,
  denied: [],
  deniedTruncated: false,
};
const policy: MaintainerPolicy = {
  schemaVersion: 1,
  repository: { id: 'repo', origin: 'memory' },
  phase: 'sealed',
  auditTagPrefix: 'audit',
  signatureNamespace: 'test',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [],
  sealedImmutablePaths: [],
  requiredChecks: [],
  trustedSigners: [
    { identity: 'human', publicKey: 'fixture', fingerprint: 'fixture' },
  ],
};
const failCode = (code: string) => (error: unknown) =>
  error instanceof WorkflowError && error.code === code;
function context(workflowId: string): DurableEpochContextState {
  const manifest = buildContextManifest({
    workflowId,
    epoch: 1,
    contractVersion: 1,
    baselineDigest: digest,
    intentDigest: digest,
    termSetDigest: digest,
    planningSnapshotDigest: digest,
    items: [{ identity: 'intent:current', content: 'intent' }],
  });
  return {
    schemaVersion: 1,
    kind: 'durable-epoch-context',
    generation: 4,
    workflow: {
      workflowId,
      currentEpoch: 1,
      contractVersion: 1,
      contextDigest: manifest.contextDigest,
      snapshotDigest: digest,
      status: 'active',
      checkpoint: 'main-terms',
      blocker: null,
    },
    currentManifest: manifest,
    transitionReceipts: [],
    transitionStubs: [],
    updatedAt: NOW.toISOString(),
  };
}
function harness() {
  const trace: string[] = [];
  let reads = 0;
  const state = {
    initialRecords: [structuredClone(record)],
    currentRecords: [structuredClone(record)],
    activeBinding: structuredClone(binding),
    actor: 'human',
    mandateOptions: undefined as TaskMandateOptions | undefined,
    pinInput: undefined as DurableEvidencePinInput | undefined,
  };
  const signer = {
    assertHumanPresent() {
      trace.push('human');
    },
    identity() {
      trace.push('identity');
      return state.actor;
    },
    sign(): string {
      assert.fail('Retention must not sign an envelope');
    },
    verify() {
      assert.fail('Memory authority owns verification');
    },
  };
  const dependencies: EvidencePinDependencies &
    RetentionInspectionDependencies &
    RetentionMaintenanceDependencies = {
    runtime(cwd) {
      assert.equal(cwd, '/repo');
      trace.push('runtime');
      return paths;
    },
    *workflowBindings(cwd) {
      assert.equal(cwd, '/repo');
      trace.push('observe');
      yield { workflowId: record.workflowId, mandateBinding: binding };
    },
    now() {
      trace.push('clock');
      return NOW;
    },
    catalog(root, workflowId) {
      assert.equal(root, paths.root);
      reads++;
      trace.push(`catalog:${reads}`);
      return {
        schemaVersion: 1,
        kind: 'durable-retention-catalog',
        workflowId,
        generation: reads === 1 ? 3 : 9,
        records: reads === 1 ? state.initialRecords : state.currentRecords,
        updatedAt: NOW.toISOString(),
      };
    },
    context(root, workflowId) {
      assert.equal(root, paths.root);
      trace.push(`context:${workflowId}`);
      return context(workflowId);
    },
    policy(cwd) {
      assert.equal(cwd, '/repo');
      trace.push('policy');
      return { repositoryRoot: '/repo', policy };
    },
    createSigner(root, actualPolicy) {
      assert.equal(root, '/repo');
      assert.equal(actualPolicy, policy);
      trace.push('signer');
      return signer;
    },
    withActiveTaskMandateBinding(cwd, taskId, options, operation) {
      assert.equal(cwd, '/repo');
      assert.equal(taskId, binding.mandateTaskId);
      state.mandateOptions = options;
      trace.push('lock');
      return operation(state.activeBinding, () => {
        trace.push('owned');
      });
    },
    assertPinnable(runtime, current) {
      assert.equal(runtime, paths);
      assert.equal(current, state.currentRecords[0]);
      trace.push('pinnable');
    },
    pinEvidence(root, input) {
      assert.equal(root, paths.root);
      trace.push('pin');
      state.pinInput = input;
      return {
        schemaVersion: 1,
        kind: 'durable-retention-catalog',
        workflowId: input.workflowId,
        generation: 10,
        records: [pinEvidence(state.currentRecords[0]!, input.decision)],
        updatedAt: NOW.toISOString(),
      };
    },
    pruneProviderRuntime(cwd, input) {
      assert.equal(cwd, '/repo');
      assert.deepEqual(input, { limit: 2, now: NOW.toISOString() });
      trace.push('provider-prune');
      return structuredClone(pass);
    },
    maintainDurableContexts(root, workflows, input) {
      assert.equal(root, paths.root);
      assert.deepEqual(workflows, [record.workflowId]);
      assert.equal(input.limit, 2);
      assert.equal(input.now.toISOString(), NOW.toISOString());
      assert.notEqual(input.now, NOW);
      trace.push('durable');
      return {
        examined: 1,
        compacted: [],
        pruned: [],
        skipped: [{ workflowId: record.workflowId, reason: 'nothing-expired' }],
      };
    },
    inspectProviderRetentionMetrics(cwd, input) {
      assert.equal(cwd, '/repo');
      assert.deepEqual(input, { now: NOW.toISOString() });
      trace.push('metrics');
      return structuredClone(metrics);
    },
  };
  return { trace, state, signer, dependencies };
}

test('retention application imports only pure dependency closures including canonical types', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const entry = path.join(
    root,
    'packages/workflow-engine/src/application/control-plane/evidence-retention.ts',
  );
  const { edges, problems } = readRepositoryDependencies(root).read(entry);
  assert.deepEqual(problems, []);
  for (const edge of edges)
    assertPureDependencyClosure(path.join(root, edge.to));
  assertPureDependencyClosure(
    path.join(
      root,
      'packages/workflow-engine/src/modules/provider-orchestration/provider-retention.ts',
    ),
  );
});

test('workflow conflict stops observation immediately and bindings are cloned and sorted', () => {
  const trace: number[] = [];
  function* observations(): Iterable<WorkflowRetentionBinding> {
    trace.push(1);
    yield { workflowId: 'workflow-1', mandateBinding: binding };
    trace.push(2);
    yield {
      workflowId: 'workflow-1',
      mandateBinding: { ...binding, mandateId: 'other' },
    };
    trace.push(3);
    throw new Error('Must not read later provider state');
  }
  assert.throws(
    () => collectRetentionWorkflowBindings(observations()),
    failCode('RETENTION_WORKFLOW_STATE_AMBIGUOUS'),
  );
  assert.deepEqual(trace, [1, 2]);
  const source = structuredClone(binding);
  const result = collectRetentionWorkflowBindings([
    { workflowId: 'b', mandateBinding: source },
    { workflowId: 'a', mandateBinding: source },
    { workflowId: 'b', mandateBinding: source },
  ]);
  source.mandateId = 'mutated';
  assert.deepEqual(
    result.map((item) => item.workflowId),
    ['a', 'b'],
  );
  assert.equal(result[0]!.mandateBinding.mandateId, binding.mandateId);
});

test('maintenance validates before effects and shares one exact time after provider pruning', () => {
  for (const input of [{ limit: 0 }, { limit: 2, now: 'invalid' }]) {
    const h = harness();
    assert.throws(
      () => runEvidenceRetentionMaintenance(h.dependencies, '/repo', input),
      failCode('RETENTION_MAINTENANCE_INVALID'),
    );
    assert.deepEqual(h.trace, []);
  }
  const h = harness();
  const result = runEvidenceRetentionMaintenance(h.dependencies, '/repo', {
    limit: 2,
  });
  assert.deepEqual(h.trace, [
    'clock',
    'provider-prune',
    'runtime',
    'observe',
    'durable',
  ]);
  assert.equal(result.durableContexts.examined, 1);
  assert.ok(Object.isFrozen(result.provider.policy));
  const error = new Error('physical failure');
  h.trace.length = 0;
  h.dependencies.pruneProviderRuntime = () => {
    h.trace.push('provider-prune');
    throw error;
  };
  assert.throws(
    () =>
      runEvidenceRetentionMaintenance(h.dependencies, '/repo', {
        limit: 2,
        now: NOW.toISOString(),
      }),
    (actual) => actual === error,
  );
  assert.deepEqual(h.trace, ['provider-prune']);
});

test('inspection skips only absent contexts and samples provider metrics after durable observations', () => {
  const h = harness();
  h.dependencies.workflowBindings = function* () {
    h.trace.push('observe');
    yield { workflowId: 'absent', mandateBinding: binding };
    yield { workflowId: record.workflowId, mandateBinding: binding };
  };
  h.dependencies.context = (_root, workflowId) => {
    h.trace.push(`context:${workflowId}`);
    if (workflowId === 'absent')
      throw workflowError(
        'EXECUTION_CONTEXT_NOT_FOUND',
        'absent',
        ExitCode.guard,
      );
    return context(workflowId);
  };
  const result = inspectEvidenceRetention(h.dependencies, '/repo', {
    now: NOW.toISOString(),
  });
  assert.deepEqual(h.trace, [
    'runtime',
    'observe',
    'context:absent',
    'context:workflow-1',
    'catalog:1',
    'metrics',
  ]);
  assert.deepEqual(result.durableContexts, [
    {
      workflowId: record.workflowId,
      currentEpoch: 1,
      contextGeneration: 4,
      catalogGeneration: 3,
      records: 1,
      active: 1,
      expiring: 0,
      pinned: 0,
    },
  ]);
  assert.ok(Object.isFrozen(result.durableContexts[0]));
  const other = new Error('corrupt context');
  h.dependencies.context = () => {
    throw other;
  };
  h.trace.length = 0;
  assert.throws(
    () =>
      inspectEvidenceRetention(h.dependencies, '/repo', {
        now: NOW.toISOString(),
      }),
    (actual) => actual === other,
  );
  assert.ok(!h.trace.includes('metrics'));
});

const pinStart = [
  'observe',
  'runtime',
  'catalog:1',
  'policy',
  'signer',
  'human',
  'identity',
  'lock',
];
test('pin preserves human authority, locked rereads, fresh CAS and provided Date identity', () => {
  const h = harness();
  const supplied = new Date(NOW);
  const result = pinWorkflowEvidence(h.dependencies, '/repo', request, {
    now: supplied,
  });
  assert.deepEqual(h.trace, [
    ...pinStart,
    'runtime',
    'catalog:2',
    'pinnable',
    'owned',
    'pin',
    'owned',
  ]);
  assert.equal(h.state.mandateOptions?.now, supplied);
  assert.equal(h.state.mandateOptions?.signer, h.signer);
  assert.equal(h.state.pinInput?.decision.pinnedAt, supplied);
  assert.equal(h.state.pinInput?.expectedCatalogGeneration, 9);
  assert.equal(result.catalogGeneration, 10);
  assert.equal(result.replayed, false);
  assert.ok(Object.isFrozen(result.record.pin));
});

test('pin replay and conflict use locked current evidence without a write or pin clock', () => {
  for (const conflict of [false, true]) {
    const h = harness();
    h.state.currentRecords = [
      pinEvidence(record, {
        actor: 'human',
        reason: conflict ? 'Different decision.' : request.reason,
        pinnedAt: NOW,
        humanConfirmed: true,
      }),
    ];
    if (conflict)
      assert.throws(
        () => pinWorkflowEvidence(h.dependencies, '/repo', request),
        failCode('RETENTION_PIN_CONFLICT'),
      );
    else {
      const result = pinWorkflowEvidence(h.dependencies, '/repo', request);
      assert.equal(result.replayed, true);
      assert.equal(result.record, h.state.currentRecords[0]);
      assert.equal(result.catalogGeneration, 9);
    }
    assert.deepEqual(h.trace, [
      ...pinStart,
      'runtime',
      'catalog:2',
      'pinnable',
      'owned',
    ]);
    assert.equal(h.state.pinInput, undefined);
  }
});

test('a new pin reads its clock only after the physical and ownership guards', () => {
  const h = harness();
  pinWorkflowEvidence(h.dependencies, '/repo', request);
  assert.deepEqual(h.trace, [
    ...pinStart,
    'runtime',
    'catalog:2',
    'pinnable',
    'owned',
    'clock',
    'pin',
    'owned',
  ]);
  assert.equal(h.state.mandateOptions?.now, undefined);
  assert.equal(h.state.pinInput?.decision.pinnedAt, NOW);
});

test('pin failures stop before later observations and mutations with exact error identity', () => {
  const invalid = harness();
  assert.throws(
    () =>
      pinWorkflowEvidence(invalid.dependencies, '/repo', {
        ...request,
        reason: ' untrimmed',
      }),
    failCode('RETENTION_PIN_INVALID'),
  );
  assert.deepEqual(invalid.trace, []);
  const absent = harness();
  absent.dependencies.workflowBindings = function* () {};
  assert.throws(
    () => pinWorkflowEvidence(absent.dependencies, '/repo', request),
    failCode('RETENTION_WORKFLOW_NOT_FOUND'),
  );
  assert.deepEqual(absent.trace, []);
  const missing = harness();
  missing.state.initialRecords = [];
  assert.throws(
    () => pinWorkflowEvidence(missing.dependencies, '/repo', request),
    failCode('RETENTION_EVIDENCE_NOT_FOUND'),
  );
  assert.deepEqual(missing.trace, ['observe', 'runtime', 'catalog:1']);
  const human = harness();
  const refusal = new Error('human declined');
  human.signer.assertHumanPresent = () => {
    human.trace.push('human');
    throw refusal;
  };
  assert.throws(
    () => pinWorkflowEvidence(human.dependencies, '/repo', request),
    (actual) => actual === refusal,
  );
  assert.deepEqual(human.trace, pinStart.slice(0, 6));
  const trust = harness();
  trust.state.actor = 'untrusted';
  assert.throws(
    () => pinWorkflowEvidence(trust.dependencies, '/repo', request),
    failCode('RETENTION_PIN_SIGNER_UNTRUSTED'),
  );
  assert.deepEqual(trust.trace, pinStart.slice(0, 7));
  const authority = harness();
  authority.state.activeBinding.mandateId = 'different';
  assert.throws(
    () => pinWorkflowEvidence(authority.dependencies, '/repo', request),
    failCode('RETENTION_TASK_MANDATE_MISMATCH'),
  );
  assert.deepEqual(authority.trace, pinStart);
  const removed = harness();
  removed.state.currentRecords = [];
  assert.throws(
    () => pinWorkflowEvidence(removed.dependencies, '/repo', request),
    failCode('RETENTION_EVIDENCE_NOT_FOUND'),
  );
  assert.deepEqual(removed.trace, [...pinStart, 'runtime', 'catalog:2']);
  const physical = harness();
  const pruned = new Error('physical evidence missing');
  physical.dependencies.assertPinnable = () => {
    physical.trace.push('pinnable');
    throw pruned;
  };
  assert.throws(
    () => pinWorkflowEvidence(physical.dependencies, '/repo', request),
    (actual) => actual === pruned,
  );
  assert.deepEqual(physical.trace, [
    ...pinStart,
    'runtime',
    'catalog:2',
    'pinnable',
  ]);
});

import type { runDurableContextRetentionMaintenance } from '../src/runtime/provider-execution/retention-control.ts';

/** Compile-only assertions: the durable runtime result retains the original readonly contract. */
function checkReadonlyMaintenanceContract(
  result: ReturnType<typeof runDurableContextRetentionMaintenance>,
): void {
  // @ts-expect-error The original result forbids assigning its examined count.
  result.examined = 0;
  // @ts-expect-error The original result forbids replacing the compaction list.
  result.compacted = [];
  // @ts-expect-error The original result forbids replacing the pruning list.
  result.pruned = [];
  // @ts-expect-error The original result forbids replacing the skipped list.
  result.skipped = [];
  // @ts-expect-error The original result exposes readonly compaction entries.
  result.compacted.push();
  // @ts-expect-error The original result exposes readonly pruning entries.
  result.pruned.push();
  // @ts-expect-error The original result exposes readonly skipped entries.
  result.skipped.push();
}
