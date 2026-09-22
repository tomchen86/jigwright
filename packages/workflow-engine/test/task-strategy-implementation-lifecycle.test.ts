import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { LoadedDataAuthorizationPolicyV4 } from '@jigwright/core/data-authorization-policy-port';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import {
  createTaskStrategyImplementationLifecycle,
  type BeginTaskStrategyImplementationOptions,
} from '../src/application/execute-task/task-strategy-implementation-lifecycle.ts';
import type {
  TaskStrategyImplementationOperations,
  TaskStrategyImplementationJournal,
  TaskStrategyImplementationSession,
} from '../src/application/execute-task/task-strategy-implementation-operations.ts';
import type { SessionInspection } from '../src/modules/lifecycle/session-inspection.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../src/modules/planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
  TaskStrategyPatchRecord,
  TaskStrategyPatchCurrentBinding,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import {
  parseTaskStrategyImplementationReservation,
  type TaskStrategyImplementationReservation,
  type TaskStrategyImplementationProviderAttempt,
  type TaskStrategyCallerImplementationReservation,
} from '../src/modules/assurance/task-strategy-implementation-record.ts';
import type {
  TaskStrategyCorrectionProjection,
  TaskStrategyCorrectionRound,
} from '../src/modules/assurance/task-strategy-correction-round-record.ts';
import type {
  TaskStrategyPatchValidation,
  ImportedTaskStrategyPatch,
} from '../src/modules/assurance/task-strategy-patch-contract.ts';
import type { ProviderId } from '../src/modules/provider-orchestration/provider-registry.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationManifest } from '../src/modules/assurance/provider-invocation-manifest.ts';
import type { ProviderRetryReservationV3 } from '../src/modules/provider-orchestration/provider-invocation-reservations.ts';
import {
  providerRetryPolicyFromAccounting,
  type ProviderRetryAccountingReader,
} from '../src/modules/provider-orchestration/provider-retry-accounting.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import { prepareTaskStrategyGreenFailureRecord } from '../src/modules/provider-orchestration/task-strategy-correction-record.ts';
import type { RoleAdmissionServices } from '../src/modules/provider-orchestration/role-scheduler.ts';
import type {
  RoleParticipant,
  RecordedRoleParticipant,
  GrantedRoleAssignment,
} from '../src/modules/provider-orchestration/role-assignment.ts';
import type {
  CollaborationReservationRecord,
  CollaborationGrantInspection,
  CollaborationGrantUseProjection,
} from '../src/modules/authority/collaboration-grant-records.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import { sealAuthoritativeCollaborationGrantVerifier } from '../src/modules/authority/grant-verifier-port.ts';

const NOW = '2026-09-23T01:00:00.000Z';
const ROOT = '/memory/task-strategy';
const GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const digest = (value: string | Buffer) =>
  crypto.createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => digest(canonicalJson(value));
const unexpected = (): never => {
  throw new Error('unexpected capability');
};
const recordParticipant = (
  value: RoleParticipant | RecordedRoleParticipant,
): RecordedRoleParticipant => ({
  ...value,
  providerId: value.providerId ?? null,
  sessionId: value.sessionId ?? null,
  principalId: value.principalId ?? null,
});

type Event = { name: string; args: unknown[] };

// One synchronous memory implementation drives the complete factory. Observed
// facts have their canonical types; omitted capabilities throw instead of
// falling through to production. Grant envelopes below are inert fixture data.
function fixture(
  options: {
    single?: boolean;
    providers?: boolean;
    correction?: boolean;
    mandate?: boolean;
  } = {},
) {
  const events: Event[] = [];
  const emit = (name: string, ...args: unknown[]) => {
    events.push({ name, args });
  };
  const layout = {
    root: ROOT,
    locks: `${ROOT}/locks`,
    operations: `${ROOT}/operations`,
    sessions: `${ROOT}/sessions`,
    reports: `${ROOT}/reports`,
    taskRevisions: `${ROOT}/task-revisions`,
  };
  const session: WorkflowSession = {
    schemaVersion: 1,
    sessionId: 'session-memory',
    changeId: 'memory-change',
    taskId: '1.1',
    state: 'active',
    repositoryRoot: ROOT,
    gitCommonDirectory: `${ROOT}/.git`,
    branch: 'work/memory',
    baseline: { head: '1'.repeat(40), tree: '2'.repeat(40) },
    artifacts: {},
    allowedPaths: ['src/**', 'test/**'],
    requiredChecks: ['unit'],
    requiredCheckDigests: {},
    planningAssurance: null,
    createdAt: NOW,
    isolation: {
      schemaVersion: 1,
      routingRole: 'single',
      routingWorksetDigest: `sha256:${digest('workset')}`,
      concurrencyEnabled: false,
      worktreeDigest: `sha256:${digest('worktree')}`,
      resources: [],
    },
    ...(options.mandate
      ? {
          mandateBinding: {
            schemaVersion: 1,
            mandateTaskId: 'mandate-task',
            mandateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            mandateDigest: digest('mandate'),
            changeId: 'memory-change',
            externalAuditRoot: '/memory/audit',
          },
        }
      : {}),
  };
  const git = {
    repositoryRoot: ROOT,
    repositoryRealPath: ROOT,
    gitCommonDirectory: `${ROOT}/.git`,
    branch: session.branch,
    head: session.baseline.head,
    tree: session.baseline.tree,
    statusEntries: [],
  };
  const commonTask = {
    allowedPaths: session.allowedPaths,
    requiredChecks: ['unit'],
    diffReview: 'required' as const,
    enforcement: 'planned' as const,
    behaviorContractRefs: [
      {
        specPath: 'specs/feature/spec.md',
        requirement: 'Preserve implementation behavior',
        scenario: null,
      },
    ],
    testPathScopes: ['test/**'],
    fixturePathScopes: [],
    implementationPathScopes: ['src/**'],
    redCheck: 'unit',
    greenChecks: ['unit'],
  };
  const task: CrossAgentTddExecution | TddSingleAgentExecution = options.single
    ? {
        ...commonTask,
        strategy: 'tdd-single-agent',
        requiredImplementerIndependence: 'none',
      }
    : {
        ...commonTask,
        strategy: 'cross-agent-tdd',
        requiredImplementerIndependence: 'session-independent',
      };
  const redNode = createEvidenceNode({
    type: 'fixture-red',
    nodeSchema: 'fixture.red.v1',
    evaluator: 'fixture.v1',
    policyDigest: digest('red-policy'),
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.red-output.v1',
    output: { failed: true },
    runtimeMetadata: {},
  });
  const transaction: TaskStrategyTransaction = {
    schemaVersion: 1,
    kind: 'task-strategy-transaction.v1',
    recordDigest: digest('transaction'),
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    baseline: session.baseline,
    strategy: task.strategy,
    phase: 'red-sealed',
    taskContractDigest: hash(task),
    author: { providerId: 'codex', assurance: 'runtime-hint' },
    createdAt: NOW,
    red: {
      candidateTree: '3'.repeat(40),
      changedPaths: ['test/feature.test.ts'],
      checkId: 'unit',
      runner: 'node',
      runnerDigest: digest('runner'),
      exitCode: 1,
      failureCategory: 'assertion',
      selector: 'unit',
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [],
      files: [
        {
          path: 'test/feature.test.ts',
          mode: '100644',
          objectId: '4'.repeat(40),
        },
      ],
      stdoutDigest: digest('failed'),
      stderrDigest: digest(''),
      failureFingerprint: digest('red-failure'),
      evidenceNodeId: redNode.nodeId,
      evidenceResultDigest: redNode.resultDigest,
      evidenceNode: redNode,
    },
  };
  const config = {
    schemaVersion: 1 as const,
    repositoryName: 'memory',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main'],
    branchTemplate: 'work/{changeId}',
  };
  const context: TaskStrategyImplementationSession = {
    git,
    config,
    runtime: layout,
    session,
  };
  const inspection: SessionInspection = {
    git,
    session,
    policy: { allowedPaths: session.allowedPaths, requiredChecks: ['unit'] },
    artifactDigests: {},
    changedPaths: [...transaction.red.changedPaths],
    unexpectedPaths: [],
    fingerprint: digest('inspection'),
    tasksPath: 'tasks.md',
    baselineTasks: '',
    contract: {
      changeId: session.changeId,
      changeDirectory: 'openspec/changes/memory-change',
      schemaName: 'fixture',
      config,
      checks: { schemaVersion: 1, checks: {} },
      guard: {
        schemaVersion: 1,
        changeId: session.changeId,
        tasks: {
          '1.1': {
            allowedPaths: session.allowedPaths,
            requiredChecks: ['unit'],
          },
        },
      },
      tasks: [{ id: '1.1', completed: false, title: 'Memory implementation' }],
      behaviorContracts: commonTask.behaviorContractRefs,
      execution: {
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: session.changeId,
        tasks: { '1.1': task },
      },
      artifactPaths: [],
      artifactDigests: {},
      openspec: {
        version: '1.6.0',
        schemaName: 'fixture',
        statusComplete: true,
        validationValid: true,
      },
      diagnostics: [],
      artifactModes: {},
      contractDigest: digest('contract'),
      planningAssurance: null,
      planningProvider: {
        source: 'explicit',
        artifactPath: 'workflow/change-providers/memory-change.json',
        bindingDigest: digest('planning'),
        binding: {
          schemaVersion: 1,
          changeId: session.changeId,
          providerId: 'fixture',
          adapterContractVersion: 1,
          providerRequirement: { package: 'fixture', version: '1' },
          planningRoot: 'openspec',
        },
      },
    },
  };
  const failureBody = {
    checkId: 'unit',
    outcome: 'failed' as const,
    exitCode: 1,
    runner: 'node',
    runnerDigest: digest('runner'),
    stdoutDigest: digest('failed'),
    stderrDigest: digest(''),
    stdoutExcerpt: 'failed',
    stderrExcerpt: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const failure = prepareTaskStrategyGreenFailureRecord({
    sessionId: session.sessionId,
    currentRedTransactionDigest: transaction.recordDigest,
    currentPatchHead: {
      bindingDigest: digest('prior-binding'),
      recordDigest: digest('prior-record'),
      patchDigest: digest('prior-patch'),
      receiptDigest: digest('prior-receipt'),
    },
    candidateTree: '5'.repeat(40),
    checkDefinitions: [
      {
        checkId: 'unit',
        definition: {
          command: ['node', 'unit.mjs'],
          destructiveDatabase: false,
        },
        runner: 'node',
        runnerDigest: failureBody.runnerDigest,
      },
    ],
    passedChecks: [],
    failingCheck: { ...failureBody, failureFingerprint: hash(failureBody) },
    createdAt: NOW,
  });
  const policy: LoadedDataAuthorizationPolicyV4<ProviderId> = {
    policy: {
      schemaVersion: 4,
      mode: 'managed-read-only',
      launchPolicy: 'lifecycle-only',
      requiredControls: [],
      providers: {
        codex: { enabled: options.providers !== false },
        claude: { enabled: options.providers !== false },
      },
      limits: {
        timeoutMs: 1000,
        aggregateOutputBytes: 65536,
        maxConcurrent: 1,
      },
      retryAccounting: {
        maxAttempts: 4,
        maxCumulativeRuntimeMs: 10000,
        maxProviderCostMicros: 1000,
        maxProviderTokens: 1000,
        maxSameFailureFingerprint: 4,
        maxRepairAttempts: 2,
        deadlineMs: 600000,
        providerLimits: { codex: 4, claude: 4 },
        reservations: {
          codex: { providerCostMicros: 1, providerTokens: 1 },
          claude: { providerCostMicros: 1, providerTokens: 1 },
        },
      },
    },
    digest: digest('memory-policy'),
    document: 'exact memory policy bytes',
  };
  const state: {
    transaction: TaskStrategyTransaction | null;
    projection: TaskStrategyCorrectionProjection;
    root: TaskStrategyImplementationReservation | null;
    attempt: TaskStrategyImplementationProviderAttempt | null;
    invocation: ProviderInvocationRecord | null;
    request: ProviderInvocationRequest | null;
    manifest: ProviderInvocationManifest | null;
    result: TaskStrategyImplementationResultBinding | null;
    caller: TaskStrategyCallerImplementationReservation | null;
    callerResult: TaskStrategyCallerImplementationBinding | null;
    patch: TaskStrategyPatchRecord | null;
    binding: TaskStrategyPatchCurrentBinding | null;
    round: TaskStrategyCorrectionRound | null;
    rounds: TaskStrategyCorrectionRound[];
    grant: CollaborationReservationRecord | null;
    assignment: GrantedRoleAssignment | null;
    use: CollaborationGrantUseProjection | null;
    previewTree: string;
    failAt: string | null;
  } = {
    transaction,
    projection: {
      transaction,
      head: null,
      failure: options.correction ? failure : null,
      completedCorrectionRounds: 0,
      exhausted: false,
      correctionState: null,
    },
    root: null,
    attempt: null,
    invocation: null,
    request: null,
    manifest: null,
    result: null,
    caller: null,
    callerResult: null,
    patch: null,
    binding: null,
    round: null,
    rounds: [],
    grant: null,
    assignment: null,
    use: null,
    previewTree: transaction.red.candidateTree,
    failAt: null,
  };
  const nodes = new Map<string, EvidenceNode>();
  const sentinel = new Error('memory capability failure');
  const event = (name: string, ...args: unknown[]) => {
    emit(name, ...args);
    if (state.failAt === name) throw sentinel;
  };
  const assertOwned = () => event('owned');
  const paths = {
    base: ROOT,
    root: `${ROOT}/journal`,
    objects: `${ROOT}/objects`,
    refs: `${ROOT}/refs`,
    sessions: `${ROOT}/journal-sessions`,
    invocations: `${ROOT}/invocations`,
    locks: `${ROOT}/journal-locks`,
  };
  const requireValue = <T>(value: T | null): T => {
    assert.notEqual(value, null);
    return value!;
  };
  const journal: TaskStrategyImplementationJournal = {
    paths,
    evidence: {
      read(id) {
        event('evidence.read', id);
        const node = nodes.get(id);
        assert.ok(node);
        return node;
      },
      write(node) {
        event(`write.${node.type}`, node);
        nodes.set(node.nodeId, node);
      },
    },
    implementation: {
      readReservation(...args) {
        event('root.read', ...args);
        return state.root;
      },
      reserve(input) {
        event('root.publish', input);
        const body = {
          schemaVersion: 1 as const,
          kind: 'task-strategy-implementation-reservation.v1' as const,
          ...input,
        };
        state.root = parseTaskStrategyImplementationReservation({
          ...body,
          recordDigest: hash(body),
        });
        state.attempt = {
          root: state.root,
          attempt: 1,
          previousInvocationId: null,
          assignment: state.root.assignment,
          manifestDigest: state.root.request.inputManifestDigest,
          request: state.root.request,
          authorizationNodeId: state.root.authorizationNodeId,
          reservationNodeId: state.root.reservationNodeId,
          retryDecision: null,
          retryReservation: null,
          createdAt: state.root.createdAt,
        };
        return state.root;
      },
      readResult(...args) {
        event('result.read', ...args);
        return state.result;
      },
      publishResult(input) {
        event('result.publish', input);
        state.result = {
          schemaVersion: 1,
          kind: 'task-strategy-implementation-result-binding.v1',
          ...input,
          bindingDigest: hash(input),
        };
        return state.result;
      },
      readCallerReservation(...args) {
        event('caller.read', ...args);
        return state.caller;
      },
      reserveCaller(input) {
        event('caller.publish', input);
        state.caller = {
          schemaVersion: 1,
          kind: 'task-strategy-caller-implementation-reservation.v1',
          ...input,
          reservationDigest: hash(input),
        };
        return state.caller;
      },
      readCallerResult(...args) {
        event('caller-result.read', ...args);
        return state.callerResult;
      },
      publishCallerResult(input) {
        event('caller-result.publish', input);
        state.callerResult = {
          schemaVersion: 1,
          kind: 'task-strategy-caller-implementation-binding.v1',
          ...input,
          bindingDigest: hash(input),
        };
        return state.callerResult;
      },
      readAttempt(...args) {
        event('attempt.read', ...args);
        return requireValue(state.attempt);
      },
      readCurrentAttempt(...args) {
        event('attempt.current', ...args);
        return requireValue(state.attempt);
      },
      assertProviderCurrent(...args) {
        event('authority.provider', ...args);
      },
      assertCallerReservationCurrent(...args) {
        event('authority.caller-reservation', ...args);
      },
      assertCallerCurrent(...args) {
        event('authority.caller', ...args);
      },
    },
    provider: {
      exists(...args) {
        event('provider.exists', ...args);
        return state.invocation !== null;
      },
      read(...args) {
        event('provider.read', ...args);
        return requireValue(state.invocation);
      },
      readRequest(...args) {
        event('provider.request', ...args);
        return requireValue(state.request);
      },
      readManifest(...args) {
        event('provider.manifest', ...args);
        return requireValue(state.manifest);
      },
      storePolicy(...args) {
        event('policy.store', ...args);
      },
      create(input) {
        event('provider.create', input);
        state.request = input.request;
        state.manifest = input.manifest;
        state.invocation = {
          schemaVersion: 1,
          invocationId: input.request.invocationId,
          investigationId: input.investigationId,
          changeId: input.changeId,
          ...(input.mandateBinding
            ? { mandateBinding: input.mandateBinding }
            : {}),
          attempt: input.attempt,
          revision: 1,
          state: 'prepared',
          providerId: input.request.providerId,
          purpose: input.request.purpose,
          requestDigest: input.request.requestDigest,
          manifestDigest: input.request.inputManifestDigest,
          leaseGeneration: 0,
          lease: null,
          result: null,
          failure: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
        return state.invocation;
      },
      reserveRetry(input) {
        event('retry.publish', input);
        const retry: ProviderRetryReservationV3 = {
          schemaVersion: 3,
          kind: 'provider-retry-reservation',
          investigationId: input.investigationId,
          changeId: input.changeId,
          attempt: input.attempt,
          previousInvocationId: input.previousInvocationId,
          invocationId: input.request.invocationId,
          manifestDigest: hash(input.manifest),
          requestDigest: input.request.requestDigest,
          request: input.request,
          retryDecision: input.retryDecision,
          replacement: input.replacement,
          createdAt: input.createdAt,
          executionPolicySnapshot: {
            schemaVersion: 2,
            kind: 'provider-execution-policy-snapshot',
            invocationId: input.request.invocationId,
            requestDigest: input.request.requestDigest,
            policyDigest: policy.digest,
            policyDocument: policy.document,
            retryAccounting: policy.policy.retryAccounting,
            attemptReservation: {
              runtimeMs: 1000,
              providerCostMicros: 1,
              providerTokens: 1,
            },
            accountingDigest: digest('accounting'),
          },
        };
        const root = requireValue(state.root);
        state.attempt = {
          root,
          attempt: input.attempt,
          previousInvocationId: input.previousInvocationId,
          assignment: input.request.roleAssignment,
          manifestDigest: retry.manifestDigest,
          request: input.request,
          authorizationNodeId: input.replacement.authorizationNodeId,
          reservationNodeId: input.replacement.reservationNodeId,
          retryDecision: input.retryDecision,
          retryReservation: retry,
          createdAt: input.createdAt,
        };
        state.invocation = null;
        return retry;
      },
    },
    correction: {
      readTransaction(...args) {
        event('transaction.read', ...args);
        return state.transaction;
      },
      readFailure(...args) {
        event('failure.read', ...args);
        return failure;
      },
      readRound(...args) {
        event('round.read', ...args);
        return state.round;
      },
      listRounds(...args) {
        event('rounds.list', ...args);
        return state.rounds;
      },
      reserve(input) {
        event('round.reserve', input);
        state.round = {
          reservation: {
            schemaVersion: 1,
            kind: 'task-strategy-correction-round-reservation.v1',
            reservationDigest: hash(input),
            sessionId: input.sessionId,
            round: input.round,
            policy: input.policy,
            policyDigest: hash(input.policy),
            predecessorFailure: {
              recordDigest: failure.recordDigest,
              subjectDigest: failure.subjectDigest,
              candidateTree: failure.candidateTree,
              failureFingerprint: failure.failingCheck.failureFingerprint,
              currentRedTransactionDigest: transaction.recordDigest,
              currentPatchHead: failure.currentPatchHead,
            },
            correctionSubjectDigest: input.correctionSubjectDigest,
            redSourceTree: input.redSourceTree,
            authority: input.authority,
            createdAt: input.createdAt,
          },
          result: null,
          importRecord: null,
        };
      },
      publishResult(input) {
        event('round.result', input);
      },
      publishImport(input) {
        event('round.import', input);
      },
    },
    patch: {
      readRecord(...args) {
        event('patch.read', ...args);
        return state.patch;
      },
      readCurrentBinding(...args) {
        event('patch.binding', ...args);
        return state.binding;
      },
    },
  };
  const patchBytes = Buffer.from('memory patch bytes');
  const output = (sourceTree: string) => ({
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-output.v1' as const,
    sessionId: session.sessionId,
    sourceTree,
    patchBase64: patchBytes.toString('base64'),
    patchDigest: digest(patchBytes),
  });
  const validation = (
    bytes: string | Buffer,
    implementer: TaskStrategyPatchValidation['implementer'] = {
      providerId: 'codex',
      assurance: 'adapter-assigned',
    },
  ): TaskStrategyPatchValidation => ({
    schemaVersion: 1,
    kind: 'task-strategy-patch-validation.v1',
    sessionId: session.sessionId,
    strategy: transaction.strategy,
    sourceTree:
      state.root?.subject.sourceTree ??
      state.caller?.output.sourceTree ??
      (options.correction
        ? failure.candidateTree
        : transaction.red.candidateTree),
    candidateTree: '6'.repeat(40),
    patchDigest: digest(Buffer.from(bytes)),
    changedPaths: ['src/feature.ts'],
    changes: [],
    implementer,
  });
  const imported = (bytes: string | Buffer): ImportedTaskStrategyPatch => {
    const v = validation(bytes);
    const record: TaskStrategyPatchRecord = {
      schemaVersion: 1,
      kind: 'task-strategy-patch-record.v1',
      recordDigest: digest('patch-record'),
      sessionId: session.sessionId,
      changeId: session.changeId,
      taskId: session.taskId,
      strategy: v.strategy,
      sourceTree: v.sourceTree,
      candidateTree: v.candidateTree,
      taskContractDigest: transaction.taskContractDigest,
      patchDigest: v.patchDigest,
      patchBase64: Buffer.from(bytes).toString('base64'),
      changedPaths: v.changedPaths,
      changes: v.changes,
      implementer: v.implementer,
      createdAt: NOW,
    };
    const receipt = {
      schemaVersion: 1 as const,
      kind: 'task-strategy-patch-import-receipt.v1' as const,
      receiptDigest: digest('receipt'),
      recordDigest: record.recordDigest,
      sessionId: session.sessionId,
      patchDigest: record.patchDigest,
      candidateTree: record.candidateTree,
      importedAt: NOW,
    };
    const binding: TaskStrategyPatchCurrentBinding = {
      schemaVersion: 1,
      kind: 'task-strategy-patch-current.v1',
      bindingDigest: digest('binding'),
      sessionId: session.sessionId,
      patchDigest: record.patchDigest,
      recordDigest: record.recordDigest,
      receiptDigest: receipt.receiptDigest,
      candidateTree: record.candidateTree,
      createdAt: NOW,
    };
    state.patch = record;
    state.binding = binding;
    return {
      record,
      receipt,
      binding,
      reservation: {
        schemaVersion: 1,
        kind: 'task-strategy-patch-reservation.v1',
        reservationDigest: digest('patch-reservation'),
        sessionId: session.sessionId,
        patchDigest: record.patchDigest,
        recordDigest: record.recordDigest,
        sourceTree: record.sourceTree,
        candidateTree: record.candidateTree,
        createdAt: NOW,
      },
    };
  };
  const verifier = sealAuthoritativeCollaborationGrantVerifier(
    { verify: unexpected, assertCurrent: unexpected },
    `sha256:${digest('composition')}`,
  );
  const grantInspection = (): CollaborationGrantInspection => ({
    grantId: GRANT_ID,
    version: 2,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    state: state.grant ? 'reserved' : 'available',
    changeId: session.changeId,
    taskId: session.taskId,
    lifecyclePhase: 'task-implementation',
    targetDigest:
      state.grant?.envelope.payload.targetDigest ?? digest('pending'),
    degradedForm: 'caller-supplied',
    issuedAt: NOW,
    expiresAt: '2026-09-23T01:30:00.000Z',
    signer: 'fixture',
    signedEnvelopeDigest: digest('envelope'),
  });
  const operations: TaskStrategyImplementationOperations = {
    session: {
      loadActive(...args) {
        event('session.load', ...args);
        return context;
      },
      inspectExpected(...args) {
        event('session.inspect', ...args);
        assert.strictEqual(args[2], session);
        return inspection;
      },
      previewCandidate(...args) {
        event('preview', ...args);
        return { tree: state.previewTree };
      },
      resolveCorrection(value) {
        event('projection', value);
        assert.strictEqual(value, inspection);
        return state.projection;
      },
    },
    observeJournal(cwd) {
      event('journal.observe', cwd);
      return { ...journal };
    },
    locks: {
      repository(runtime, operation) {
        event('repository.enter', runtime);
        assert.strictEqual(runtime, layout);
        try {
          return operation(assertOwned);
        } finally {
          event('repository.release');
        }
      },
      session(runtime, id, operation) {
        event('session.enter', runtime, id);
        assert.strictEqual(runtime, layout);
        try {
          return operation();
        } finally {
          event('session.release');
        }
      },
    },
    baseline: {
      readDocument(...args) {
        event('baseline.document', ...args);
        if (args[2] === 'workflow/ai-adapter-policy.json')
          return policy.document;
        return JSON.stringify({
          schemaVersion: 1,
          repository: {
            id: 'github:fixture',
            origin: 'https://github.com/fixture/repo.git',
          },
          phase: 'bootstrap',
          auditTagPrefix: 'refs/tags/fixture/',
          signatureNamespace: 'workflow.maintainer-grant.v1',
          maxTtlMinutes: 30,
          maxUses: 1,
          bootstrapEligiblePaths: [],
          sealedImmutablePaths: [],
          requiredChecks: ['unit'],
          trustedSigners: [
            {
              identity: 'fixture',
              publicKey: 'ssh-ed25519 Zml4dHVyZQ==',
              fingerprint: `SHA256:${'A'.repeat(32)}`,
            },
          ],
        });
      },
      readMaintainerBlob(...args) {
        event('baseline.blob', ...args);
        return '7'.repeat(40);
      },
    },
    collaboration: {
      inspect(...args) {
        event('grant.inspect', ...args);
        assert.strictEqual(args[2], assertOwned);
        return [grantInspection()];
      },
      reserve(root, id, request, owned) {
        event('grant.reserve', root, id, request, owned);
        assert.strictEqual(owned, assertOwned);
        assert.strictEqual(request.verifier, verifier);
        state.grant = {
          schemaVersion: 1,
          state: 'reserved',
          grantId: id,
          transitionDigest: request.transitionDigest,
          repositoryRoot: root,
          reservedAt: NOW,
          envelope: {
            payload: {
              version: 2,
              signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
              grantId: id,
              ...request.expected,
              authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
              issuedAt: NOW,
              expiresAt: '2026-09-23T01:30:00.000Z',
              maxUses: 1,
              signer: 'fixture',
            },
            signature: 'inert-fixture-signature',
          },
        };
        return state.grant;
      },
      readReserved(...args) {
        event('grant.reserved', ...args);
        assert.strictEqual(args[2], assertOwned);
        return requireValue(state.grant);
      },
      consume(common, id, request, owned) {
        event('grant.consume', common, id, request, owned);
        assert.strictEqual(owned, assertOwned);
        assert.strictEqual(request.verifier, verifier);
        const reservation = requireValue(state.grant);
        const assignment = requireValue(state.assignment);
        assert.strictEqual(request.assignment, assignment);
        state.use = {
          schemaVersion: 1,
          grantId: id,
          signedEnvelopeDigest: hash(reservation.envelope),
          transitionDigest: request.transitionDigest,
          reservedAt: reservation.reservedAt,
          lifecyclePhase: 'task-implementation',
          targetDigest: assignment.targetDigest,
          degradedForm: assignment.degradedForm,
          authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
          assignment,
          structuredContent: {
            kind: request.contentAdmission.kind,
            nodeId: request.contentAdmission.nodeId,
            resultDigest: request.contentAdmission.resultDigest,
          },
          contentAuthority: 'reference-only-requires-governing-validator',
          directHumanReviewAttestation: null,
          retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
          replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
          residuals: COLLABORATION_GRANT_RESIDUALS,
          envelope: reservation.envelope,
        };
        return { ...grantInspection(), state: 'consumed', use: state.use };
      },
    },
    patches: {
      validateProvider(cwd, id, input) {
        event('patch.validate-provider', cwd, id, input);
        return validation(input.patch);
      },
      validateCaller(cwd, id, input) {
        event('patch.validate-caller', cwd, id, input);
        return validation(input.patch, input.callerImplementer);
      },
      importProvider(...args) {
        event('patch.import-provider', ...args);
        assert.strictEqual(args[3], assertOwned);
        return imported(args[2].patch);
      },
      importCaller(...args) {
        event('patch.import-caller', ...args);
        assert.strictEqual(args[3], assertOwned);
        return imported(args[2].patch);
      },
    },
    dataPolicy: {
      readCurrent: unexpected,
      parseCurrentDocument(document) {
        event('policy.parse', document);
        assert.equal(document, policy.document);
        return policy;
      },
    },
    correctionPolicy: Object.freeze({
      maxRepairAttempts: 2,
      maxSameFailureFingerprint: 2,
    }),
    clock: {
      now() {
        event('clock');
        return new Date(NOW);
      },
    },
  };
  const roleAdmission: Pick<
    RoleAdmissionServices,
    'admitRoleResult' | 'authorizeGrantedOrdinaryRole'
  > = {
    authorizeGrantedOrdinaryRole(input) {
      event('role.authorize', input);
      state.assignment = {
        role: 'task-implementer',
        providerId: null,
        sessionId: null,
        targetDigest: input.targetDigest,
        requiredIndependence: 'provider-independent',
        achievedIndependence: 'none',
        providerIndependent: false,
        sessionIndependent: false,
        engineSpawned: false,
        orchestration: 'caller-supplied',
        grantId: input.reservation.grantId,
        degradedForm: 'caller-supplied',
        authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
        author: recordParticipant(input.author),
        participant: recordParticipant(input.actualParticipant),
        callableProviderIds: [],
        directHumanReviewAttestationDigest: null,
      };
      return state.assignment;
    },
    admitRoleResult(input) {
      event('role.admit', input);
      assert.ok(
        input.assignment.requiredIndependence === 'session-independent' ||
          input.assignment.requiredIndependence === 'provider-independent',
      );
      const granted = 'grantId' in input.assignment;
      if (granted) {
        assert.strictEqual(input.grantUse, state.use);
        assert.strictEqual(input.grantValidation?.verifier, verifier);
      }
      return {
        schemaVersion: 1,
        form: granted ? 'granted-caller-supplied' : 'ordinary-provider',
        role: input.assignment.role,
        targetDigest: input.assignment.targetDigest,
        assignment: input.assignment,
        author: recordParticipant(input.author),
        participant: recordParticipant(input.participant),
        orchestration: granted ? 'caller-supplied' : 'engine-spawned-provider',
        requiredIndependence: input.assignment.requiredIndependence,
        achievedIndependence: input.assignment.achievedIndependence,
        content: input.content,
        providerInvocation: input.providerInvocation,
        grantUse: granted ? state.use : null,
        directHumanReviewAttestation: null,
        resultDigest: hash(input.content),
      };
    },
  };
  const lifecycle = createTaskStrategyImplementationLifecycle(
    operations,
    roleAdmission,
    {
      authorizeTaskMandateProviderReservationUnderLifecycleLock(...args) {
        event('mandate', ...args);
        assert.strictEqual(args[4], assertOwned);
        return {
          authorized: true,
          binding: args[1],
          reservationId: args[2],
          providerUsage: { invocations: 1, budget: 0 },
          replay: false,
          get audit() {
            return unexpected();
          },
        };
      },
    },
  );
  const accounting: ProviderRetryAccountingReader = (
    observed,
    failed,
    request,
  ) => {
    event('accounting', observed, failed, request);
    assert.strictEqual(observed, paths);
    const projected = projectProviderInvocationExecution({
      record: failed,
      request,
    });
    const reservation = {
      runtimeMs: 1000,
      providerCostMicros: 1,
      providerTokens: 1,
    };
    const attempt = { ...projected.attempt, ...reservation };
    const job = {
      ...projected.job,
      retryPolicy: providerRetryPolicyFromAccounting(
        policy.policy.retryAccounting,
        failed.createdAt,
      ),
      cumulativeRuntimeMs: 1000,
      providerCostMicros: 1,
      providerTokens: 1,
    };
    return {
      state: {
        revision: 1,
        workflow: projected.workflow,
        job,
        attempts: [attempt],
        invocationProjection: {
          kind: 'provider-invocation-projection.v1',
          completeHistory: true,
          invocations: [
            {
              invocationId: failed.invocationId,
              invocationRevision: failed.revision,
              attemptId: attempt.attemptId,
            },
          ],
        },
      },
      invocations: [
        {
          invocationId: failed.invocationId,
          request,
          accounting: {
            retryPolicy: policy.policy.retryAccounting,
            attemptReservation: reservation,
            accountingDigest: digest('accounting'),
          },
        },
      ],
    };
  };
  const begin = (
    input: BeginTaskStrategyImplementationOptions = {},
    reader = accounting,
  ) =>
    lifecycle.beginTaskStrategyImplementation(
      reader,
      ROOT,
      session.sessionId,
      input,
    );
  const inspect = () =>
    lifecycle.inspectTaskStrategyImplementation(ROOT, session.sessionId);
  const succeed = () => {
    const invocation = requireValue(state.invocation);
    const request = requireValue(state.request);
    const resultOutput = output(requireValue(state.root).subject.sourceTree);
    state.invocation = {
      ...invocation,
      state: 'succeeded',
      revision: 2,
      result: {
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        providerId: request.providerId,
        purpose: request.purpose,
        output: resultOutput,
        outputDigest: hash(resultOutput),
        runtimeObservation: {
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: digest('before'),
            afterDigest: digest('before'),
          },
          sameUserProcessConfined: false,
          residuals: [],
          executable: {
            candidatePath: '/memory/provider',
            realPath: '/memory/provider',
            device: '0',
            inode: '1',
            mode: 0o755,
            uid: 1,
            gid: 1,
            size: 0,
            mtimeNs: '0',
            sha256: digest('provider'),
          },
          elapsedMs: 1,
        },
      },
    };
  };
  const fail = (code = 'PROVIDER_TIMEOUT') => {
    state.invocation = {
      ...requireValue(state.invocation),
      state: 'failed',
      revision: 2,
      failure: { kind: 'retryable', code, message: 'fixture failure' },
    };
  };
  const callerOptions: BeginTaskStrategyImplementationOptions = {
    collaborationGrant: {
      grantId: GRANT_ID,
      verifier,
      callerSupplied: {
        callerId: 'caller-memory',
        assurance: 'runtime-hint',
        patch: patchBytes,
      },
    },
  };
  return {
    lifecycle,
    operations,
    journal,
    state,
    events,
    names: () => events.map(({ name }) => name),
    clear: () => {
      events.length = 0;
    },
    begin,
    inspect,
    succeed,
    fail,
    accounting,
    session,
    context,
    inspection,
    task,
    transaction,
    failure,
    policy,
    paths,
    assertOwned,
    sentinel,
    patchBytes,
    callerOptions,
  };
}

function ordered(names: string[], ...expected: string[]) {
  let cursor = -1;
  for (const name of expected) {
    const index = names.indexOf(name, cursor + 1);
    assert.ok(
      index > cursor,
      `missing ${name} after ${cursor}: ${names.join(', ')}`,
    );
    cursor = index;
  }
}
const inspectionMutationEvents = new Set([
  'root.publish',
  'result.publish',
  'caller.publish',
  'caller-result.publish',
  'provider.create',
  'policy.store',
  'retry.publish',
  'round.reserve',
  'round.result',
  'round.import',
  'grant.reserve',
  'grant.consume',
  'patch.import-provider',
  'patch.import-caller',
  'repository.enter',
  'repository.release',
  'session.enter',
  'session.release',
  'owned',
  'clock',
  'role.authorize',
  'role.admit',
  'mandate',
]);

function readOnly(f: ReturnType<typeof fixture>) {
  assert.equal(
    f
      .names()
      .some(
        (name) =>
          name.startsWith('write.') || inspectionMutationEvents.has(name),
      ),
    false,
    f.names().join(', '),
  );
}
function lastEvent(f: ReturnType<typeof fixture>, name: string) {
  const value = f.events.filter((entry) => entry.name === name).at(-1);
  assert.ok(value, `missing ${name}`);
  return value;
}

test('inspection mutation guard rejects provider creation, grant consumption and correction publication', () => {
  const f = fixture();
  f.inspect();
  readOnly(f);
  for (const name of ['provider.create', 'grant.consume', 'round.result']) {
    f.events.push({ name, args: [] });
    assert.throws(() => readOnly(f), { code: 'ERR_ASSERTION' });
    f.events.pop();
  }
  readOnly(f);
});

// D01–D04: no construction effects, independent instances, fresh observations,
// reference identity, refusal ordering, and all inspection status families.
test('factory construction is lazy and single-agent begin retains fresh RED, task and subject observations', () => {
  const first = fixture({ single: true });
  const second = fixture({ single: true });
  assert.deepEqual(first.events, []);
  assert.deepEqual(second.events, []);
  assert.equal(first.begin().state, 'provider-not-required');
  assert.deepEqual(first.names(), [
    'session.load',
    'repository.enter',
    'session.enter',
    'owned',
    'session.load',
    'journal.observe',
    'journal.observe',
    'transaction.read',
    'session.inspect',
    'preview',
    'projection',
    'rounds.list',
    'write.fixture-red',
    'session.inspect',
    'session.inspect',
    'projection',
    'session.release',
    'repository.release',
  ]);
  assert.strictEqual(
    lastEvent(first, 'write.fixture-red').args[0],
    first.transaction.red.evidenceNode,
  );
  const preview = lastEvent(first, 'preview');
  assert.deepEqual(preview.args, [
    ROOT,
    first.session.baseline.head,
    first.inspection.changedPaths,
  ]);
  assert.notStrictEqual(preview.args[2], first.inspection.changedPaths);
  assert.deepEqual(second.events, []);
  first.clear();
  assert.equal(first.inspect().state, 'provider-not-required');
  readOnly(first);
});

test('RED and subject refusals keep exact observation order and release both held locks', () => {
  for (const [phase, code] of [
    ['missing', 'TASK_STRATEGY_RED_REQUIRED'],
    ['stale', 'TASK_STRATEGY_RED_STALE'],
    ['contract', 'TASK_STRATEGY_CONTRACT_STALE'],
    ['projection', 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE'],
    ['exhausted', 'TASK_STRATEGY_CORRECTION_EXHAUSTED'],
  ] as const) {
    const f = fixture();
    if (phase === 'missing') f.state.transaction = null;
    if (phase === 'stale')
      f.state.transaction = { ...f.transaction, changeId: 'other-change' };
    if (phase === 'contract')
      f.inspection.contract.execution!.tasks['1.1'] = {
        ...f.task,
        implementationPathScopes: ['other/**'],
      };
    if (phase === 'projection')
      f.state.projection = {
        ...f.state.projection,
        transaction: { ...f.transaction, recordDigest: digest('other') },
      };
    if (phase === 'exhausted')
      f.state.projection = { ...f.state.projection, exhausted: true };
    assert.throws(() => f.begin(), { code });
    assert.deepEqual(f.names().slice(-2), [
      'session.release',
      'repository.release',
    ]);
    assert.equal(f.names().includes('root.read'), false);
    if (phase === 'missing')
      assert.equal(f.names().includes('session.inspect'), false);
    if (phase === 'stale') {
      ordered(f.names(), 'preview', 'projection', 'rounds.list');
      assert.equal(f.names().includes('write.fixture-red'), false);
    }
  }
});

test('inspection selects ready, reserved, waiting, failed, succeeded and imported without publications or locks', () => {
  const f = fixture();
  assert.equal(f.inspect().state, 'ready');
  ordered(f.names(), 'root.read', 'caller.read', 'caller-result.read');
  readOnly(f);
  f.begin();
  const invocation = f.state.invocation;
  assert.ok(invocation);
  f.state.invocation = null;
  f.clear();
  assert.equal(f.inspect().state, 'reservation-persisted');
  assert.equal(f.names().includes('provider.read'), false);
  readOnly(f);
  f.state.invocation = invocation;
  for (const state of ['prepared', 'leased', 'failed'] as const) {
    f.state.invocation = { ...invocation, state };
    f.clear();
    assert.equal(
      f.inspect().state,
      state === 'failed' ? 'provider-failed' : 'waiting-for-provider',
    );
    assert.equal(f.names().includes('result.read'), false);
    assert.equal(f.names().includes('patch.binding'), false);
    readOnly(f);
  }
  f.succeed();
  f.clear();
  assert.equal(f.inspect().state, 'provider-succeeded-awaiting-import');
  ordered(f.names(), 'provider.read', 'result.read', 'patch.binding');
  readOnly(f);
  assert.equal(f.begin().state, 'patch-imported');
  f.clear();
  assert.equal(f.inspect().state, 'patch-imported');
  ordered(f.names(), 'result.read', 'patch.binding', 'authority.provider');
  readOnly(f);
  f.state.failAt = 'authority.provider';
  assert.throws(
    () => f.inspect(),
    (error) => error === f.sentinel,
  );
});

test('reservation/root mismatch fails before reading invocation and owner checks compare exact effective attempt', () => {
  const f = fixture();
  f.begin();
  const root = f.state.root!;
  const attempt = f.state.attempt!;
  const id = root.request.invocationId;
  f.clear();
  assert.deepEqual(
    f.lifecycle.assertTaskStrategyImplementationProviderOwnerCurrent(ROOT, id),
    root,
  );
  ordered(
    f.names(),
    'journal.observe',
    'provider.read',
    'provider.manifest',
    'provider.request',
    'session.load',
    'transaction.read',
    'root.read',
    'attempt.read',
    'attempt.current',
  );
  readOnly(f);
  f.state.attempt = {
    ...attempt,
    root: { ...root, recordDigest: digest('different-root') },
  };
  f.clear();
  assert.throws(() => f.inspect(), {
    code: 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
  });
  assert.equal(f.names().includes('provider.read'), false);
  f.state.attempt = attempt;
  f.state.root = { ...root, repositoryRoot: '/other' };
  f.clear();
  assert.throws(() => f.inspect(), {
    code: 'TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT',
  });
  assert.equal(f.names().includes('attempt.current'), false);
  f.state.root = root;
  f.state.request = { ...root.request, nonce: 'different-current-request' };
  assert.throws(
    () =>
      f.lifecycle.assertTaskStrategyImplementationProviderOwnerCurrent(
        ROOT,
        id,
      ),
    { code: 'TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT' },
  );
  f.state.manifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: root.changeId,
    repositoryId: 'memory',
    baseCommit: root.baseline.head,
    baseTree: root.baseline.tree,
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Fixture',
      sourceRefs: [],
      explicitPaths: [],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'Fixture?',
    capabilityProfile: 'repository-read-only',
  };
  f.clear();
  assert.throws(
    () =>
      f.lifecycle.assertTaskStrategyImplementationProviderOwnerCurrent(
        ROOT,
        id,
      ),
    { code: 'TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT' },
  );
  assert.deepEqual(f.names(), [
    'journal.observe',
    'provider.read',
    'provider.manifest',
    'provider.request',
  ]);
});

// D05–D07: policy parse/catch boundaries, evidence order, mandate admission,
// durable retry lineage, and the real (non-automatic) strategy-change decision.
test('provider reservation snapshots policy at each original point and admits mandate before existing invocation reads', () => {
  const f = fixture({ mandate: true });
  assert.equal(f.begin().state, 'waiting-for-provider');
  ordered(
    f.names(),
    'baseline.document',
    'policy.parse',
    'write.task-strategy-implementation-authorization',
    'policy.store',
    'write.task-strategy-implementation-request-reservation',
    'root.publish',
    'attempt.current',
    'baseline.document',
    'policy.parse',
    'policy.store',
    'mandate',
    'provider.exists',
    'provider.create',
  );
  assert.strictEqual(lastEvent(f, 'policy.store').args[1], f.policy);
  assert.deepEqual(lastEvent(f, 'mandate').args.slice(0, 3), [
    ROOT,
    f.session.mandateBinding,
    f.state.root!.request.invocationId,
  ]);
  f.clear();
  f.begin();
  ordered(
    f.names(),
    'policy.store',
    'mandate',
    'provider.exists',
    'provider.read',
    'provider.request',
    'provider.manifest',
  );
  assert.equal(f.names().includes('provider.create'), false);
  for (const failureAt of ['baseline.document', 'policy.parse']) {
    f.clear();
    f.state.failAt = failureAt;
    assert.throws(() => f.begin(), {
      code: 'TASK_STRATEGY_IMPLEMENTATION_BASELINE_POLICY_INVALID',
      details: { cause: f.sentinel.message },
    });
    assert.equal(f.names().includes('mandate'), false);
  }
});

test('same-input retry consumes actual accounting, publishes V3 before crash, and resumes with the current attempt', () => {
  const f = fixture({ mandate: true });
  f.begin();
  f.fail();
  f.clear();
  const root = f.state.root!;
  const failed = f.state.invocation!;
  assert.throws(
    () =>
      f.begin({
        retryProviderFailure: true,
        testCrashAfter: 'provider-retry-reservation-persisted',
      }),
    /retry reservation persistence/,
  );
  ordered(
    f.names(),
    'accounting',
    'clock',
    'policy.parse',
    'provider.read',
    'write.task-strategy-implementation-request-reservation',
    'retry.publish',
    'session.release',
    'repository.release',
  );
  assert.equal(f.names().filter((name) => name === 'clock').length, 1);
  assert.strictEqual(lastEvent(f, 'accounting').args[1], failed);
  assert.strictEqual(lastEvent(f, 'accounting').args[2], root.request);
  const attempt = f.state.attempt!;
  assert.equal(attempt.attempt, 2);
  assert.equal(attempt.retryReservation?.schemaVersion, 3);
  assert.equal(attempt.previousInvocationId, failed.invocationId);
  assert.notEqual(attempt.request.invocationId, failed.invocationId);
  assert.equal(f.names().includes('provider.create'), false);
  f.clear();
  assert.equal(f.begin().state, 'waiting-for-provider');
  assert.strictEqual(f.state.root, root);
  assert.equal(f.state.invocation!.attempt, 2);
  const admission = lastEvent(f, 'mandate').args[3];
  assert.ok(
    typeof admission === 'object' && admission !== null && 'retry' in admission,
  );
  assert.equal(admission.retry, true);
  assert.equal(f.names().includes('retry.publish'), false);
  f.clear();
  const effective =
    f.lifecycle.assertTaskStrategyImplementationProviderOwnerCurrent(
      ROOT,
      attempt.request.invocationId,
    );
  assert.strictEqual(effective.request, attempt.request);
  assert.equal(effective.recordDigest, root.recordDigest);
  readOnly(f);
});

test('retry refusal preserves real accounting failures and strategy-change reads accounting and clock twice before denial', () => {
  const f = fixture();
  f.begin();
  f.fail();
  f.clear();
  assert.throws(
    () =>
      f.begin({ retryProviderFailure: true }, () => {
        throw f.sentinel;
      }),
    (error) => error === f.sentinel,
  );
  assert.equal(f.names().includes('clock'), false);
  assert.equal(f.names().includes('retry.publish'), false);
  f.clear();
  assert.throws(
    () =>
      f.begin({ retryProviderFailure: true }, () => ({
        state: null,
        invocations: [],
      })),
    { code: 'PROVIDER_RETRY_ACCOUNTING_REQUIRED' },
  );
  assert.equal(f.names().includes('retry.publish'), false);
  f.fail('PROVIDER_TOOL_UNAVAILABLE');
  f.clear();
  assert.throws(() => f.begin({ retryProviderFailure: true }), {
    code: 'TASK_STRATEGY_IMPLEMENTATION_RETRY_DENIED',
  });
  assert.equal(f.names().filter((name) => name === 'accounting').length, 2);
  assert.equal(f.names().filter((name) => name === 'clock').length, 2);
  ordered(
    f.names(),
    'accounting',
    'clock',
    'write.task-strategy-implementation-authorization',
    'accounting',
    'clock',
  );
  assert.equal(f.names().includes('retry.publish'), false);
});

// D08–D13: distinct caller/provider crash cuts, exact held-lock arguments,
// patch preflight gates and correction reservation/result/import ordering.
test('provider result crash is only on first publication; replay imports with authority and forwards patch crash phases', () => {
  const f = fixture();
  f.begin();
  f.succeed();
  f.clear();
  assert.throws(
    () => f.begin({ testCrashAfter: 'provider-result-persisted' }),
    /provider result persistence/,
  );
  ordered(
    f.names(),
    'patch.read',
    'patch.validate-provider',
    'result.read',
    'evidence.read',
    'evidence.read',
    'write.task-strategy-implementation-provider-observation',
    'role.admit',
    'write.task-strategy-implementation-provider-result',
    'result.publish',
  );
  assert.equal(f.names().includes('patch.import-provider'), false);
  const binding = f.state.result!;
  f.clear();
  assert.equal(
    f.begin({ testCrashAfter: 'provider-result-persisted' }).state,
    'patch-imported',
  );
  assert.strictEqual(f.state.result, binding);
  assert.equal(f.names().includes('result.publish'), false);
  ordered(
    f.names(),
    'authority.provider',
    'patch.import-provider',
    'owned',
    'provider.read',
  );
  const imported = lastEvent(f, 'patch.import-provider').args[2];
  assert.ok(
    typeof imported === 'object' && imported !== null && 'patch' in imported,
  );
  assert.deepEqual(imported.patch, f.patchBytes);
  for (const phase of ['patch-applied', 'receipt-persisted'] as const) {
    const current = fixture();
    current.begin();
    current.succeed();
    current.begin({ testCrashAfter: phase });
    const input = lastEvent(current, 'patch.import-provider').args[2];
    assert.ok(
      typeof input === 'object' && input !== null && 'testCrashAfter' in input,
    );
    assert.equal(input.testCrashAfter, phase);
  }
});

test('provider validation refuses unobserved/stale outputs before patches and imported patches skip preflight', () => {
  for (const invalid of ['observation', 'session', 'source'] as const) {
    const f = fixture();
    f.begin();
    f.succeed();
    const result = f.state.invocation!.result!;
    if (invalid === 'observation') result.runtimeObservation = null;
    else
      result.output = {
        ...(result.output as Record<string, unknown>),
        [invalid === 'session' ? 'sessionId' : 'sourceTree']:
          invalid === 'session' ? 'session-other' : '9'.repeat(40),
      };
    f.clear();
    assert.throws(() => f.begin(), {
      code:
        invalid === 'observation'
          ? 'TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OBSERVATION_REQUIRED'
          : 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
    });
    assert.equal(f.names().includes('patch.read'), false);
    assert.equal(f.names().includes('result.publish'), false);
  }
  const f = fixture();
  f.begin();
  f.succeed();
  f.begin();
  f.state.binding = null;
  f.clear();
  assert.equal(f.begin().state, 'patch-imported');
  assert.equal(f.names().includes('patch.validate-provider'), false);
  f.state.binding = null;
  f.state.failAt = 'authority.provider';
  f.clear();
  assert.throws(
    () => f.begin(),
    (error) => error === f.sentinel,
  );
  assert.equal(f.names().includes('patch.import-provider'), false);
});

test('caller publications preserve preflight, exact grant/verifier ownership, clock override and repeated crash semantics', () => {
  const f = fixture({ providers: false });
  assert.equal(f.begin().state, 'collaboration-grant-required');
  f.clear();
  const suppliedNow = new Date('2026-09-23T01:02:00.000Z');
  const options = {
    ...f.callerOptions,
    collaborationGrant: {
      ...f.callerOptions.collaborationGrant!,
      now: suppliedNow,
    },
    testCrashAfter: 'provider-result-persisted' as const,
  };
  assert.throws(() => f.begin(options), /caller result persistence/);
  ordered(
    f.names(),
    'patch.validate-caller',
    'baseline.document',
    'baseline.blob',
    'grant.inspect',
    'grant.reserve',
    'role.authorize',
    'write.task-strategy-implementation-caller-submission',
    'caller.publish',
    'authority.caller-reservation',
    'caller-result.read',
    'baseline.document',
    'grant.consume',
    'role.admit',
    'write.task-strategy-implementation-caller-result',
    'caller-result.publish',
    'authority.caller',
  );
  assert.equal(f.names().includes('clock'), false);
  const consume = lastEvent(f, 'grant.consume').args[2];
  assert.ok(
    typeof consume === 'object' && consume !== null && 'now' in consume,
  );
  assert.strictEqual(consume.now, suppliedNow);
  const preflight = lastEvent(f, 'patch.validate-caller').args[2];
  assert.ok(
    typeof preflight === 'object' && preflight !== null && 'patch' in preflight,
  );
  assert.notStrictEqual(preflight.patch, f.patchBytes);
  assert.deepEqual(preflight.patch, f.patchBytes);
  f.clear();
  assert.throws(() => f.begin(options), /caller result persistence/);
  for (const absent of [
    'patch.validate-caller',
    'grant.inspect',
    'grant.reserve',
    'grant.consume',
    'caller-result.publish',
    'patch.import-caller',
  ])
    assert.equal(f.names().includes(absent), false, absent);
  ordered(
    f.names(),
    'baseline.document',
    'baseline.blob',
    'authority.caller-reservation',
    'caller-result.read',
    'authority.caller',
  );
  f.clear();
  assert.equal(f.begin(f.callerOptions).state, 'patch-imported');
  assert.equal(f.names().includes('clock'), false);
  f.clear();
  assert.equal(f.inspect().state, 'patch-imported');
  readOnly(f);
});

test('caller inspection requires the reservation, and fresh caller preflight/refusals precede grant effects', () => {
  const f = fixture({ providers: false });
  assert.throws(() => f.begin({ collaborationGrant: { grantId: GRANT_ID } }), {
    code: 'COLLABORATION_GRANT_FORM_REQUIRED',
  });
  f.state.failAt = 'patch.validate-caller';
  f.clear();
  assert.throws(
    () => f.begin(f.callerOptions),
    (error) => error === f.sentinel,
  );
  assert.equal(f.names().includes('grant.inspect'), false);
  f.state.failAt = null;
  f.clear();
  assert.throws(
    () =>
      f.begin({
        ...f.callerOptions,
        testCrashAfter: 'provider-result-persisted',
      }),
    /caller result persistence/,
  );
  assert.equal(f.names().filter((name) => name === 'clock').length, 1);
  f.clear();
  assert.equal(f.inspect().state, 'caller-supplied-awaiting-import');
  readOnly(f);
  const reservation = f.state.caller!;
  f.state.caller = null;
  f.clear();
  assert.throws(() => f.inspect(), {
    code: 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
  });
  assert.equal(f.names().includes('authority.caller'), false);
  f.state.caller = reservation;
  f.clear();
  assert.throws(
    () =>
      f.begin({
        ...f.callerOptions,
        collaborationGrant: {
          ...f.callerOptions.collaborationGrant!,
          callerSupplied: {
            ...f.callerOptions.collaborationGrant!.callerSupplied!,
            callerId: 'different-caller',
          },
        },
      }),
    { code: 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE' },
  );
  assert.equal(f.names().includes('patch.import-caller'), false);
});

test('provider correction crash precedes correction artifacts; undefined round differs from null import receipt', () => {
  const f = fixture({ correction: true });
  f.begin();
  assert.strictEqual(
    (lastEvent(f, 'round.reserve').args[0] as { policy: unknown }).policy,
    f.operations.correctionPolicy,
  );
  f.succeed();
  f.clear();
  assert.throws(
    () => f.begin({ testCrashAfter: 'provider-patch-imported' }),
    /provider patch import/,
  );
  assert.equal(f.names().includes('round.result'), false);
  assert.equal(f.names().includes('round.import'), false);
  f.clear();
  assert.equal(f.begin().state, 'patch-imported');
  ordered(
    f.names(),
    'round.read',
    'patch.import-provider',
    'round.result',
    'round.import',
    'owned',
    'provider.read',
  );
  f.journal.correction.readRound = (...args) => {
    f.events.push({ name: 'round.read', args });
    return null;
  };
  f.clear();
  assert.equal(f.begin().state, 'patch-imported');
  assert.equal(f.names().includes('round.read'), true);
  assert.equal(f.names().includes('patch.import-provider'), false);
});

test('caller correction publishes result then receipt under original lock and forwards patch phase', () => {
  const f = fixture({ providers: false, correction: true });
  assert.equal(
    f.begin({ ...f.callerOptions, testCrashAfter: 'receipt-persisted' }).state,
    'patch-imported',
  );
  ordered(
    f.names(),
    'round.reserve',
    'caller-result.publish',
    'authority.caller',
    'patch.import-caller',
    'round.result',
    'round.import',
    'owned',
    'patch.binding',
  );
  assert.strictEqual(
    (lastEvent(f, 'round.reserve').args[0] as { policy: unknown }).policy,
    f.operations.correctionPolicy,
  );
  assert.equal(
    (lastEvent(f, 'patch.import-caller').args[2] as { testCrashAfter: string })
      .testCrashAfter,
    'receipt-persisted',
  );
});

test('recoverable correction reads the source-scoped patch and completed rounds observe a fresh journal', () => {
  const f = fixture({ correction: true });
  f.begin();
  f.succeed();
  f.begin();
  const round = f.state.round!;
  f.state.rounds = [round];
  f.state.previewTree = f.state.patch!.candidateTree;
  f.clear();
  assert.equal(f.inspect().state, 'patch-imported');
  ordered(f.names(), 'rounds.list', 'result.read', 'patch.read');
  readOnly(f);
  const patch = f.state.patch!;
  f.state.projection = {
    ...f.state.projection,
    failure: null,
    completedCorrectionRounds: 1,
    head: {
      record: patch,
      binding: f.state.binding!,
      receipt: {
        schemaVersion: 1,
        kind: 'task-strategy-patch-import-receipt.v1',
        receiptDigest: f.state.binding!.receiptDigest,
        recordDigest: patch.recordDigest,
        sessionId: f.session.sessionId,
        patchDigest: patch.patchDigest,
        candidateTree: patch.candidateTree,
        importedAt: NOW,
      },
    },
  };
  f.clear();
  f.inspect();
  ordered(f.names(), 'projection', 'journal.observe', 'failure.read');
  assert.deepEqual(lastEvent(f, 'failure.read').args, [
    f.session.sessionId,
    patch.sourceTree,
  ]);
  assert.equal(
    f.names().filter((name) => name === 'journal.observe').length,
    3,
  );
  readOnly(f);
});

test('begin uses the initial lock layout but reloads the replacement session observation only inside both callbacks', () => {
  const f = fixture({ single: true });
  const initialLayout = { ...f.context.runtime, root: '/memory/initial' };
  const initial = {
    ...f.context,
    runtime: initialLayout,
    session: { ...f.session, changeId: 'stale-before-lock' },
  };
  const originalLoad = f.operations.session.loadActive;
  let held = 0;
  let loads = 0;
  f.operations.session.loadActive = () => {
    loads += 1;
    if (loads === 1) {
      assert.equal(held, 0);
      return initial;
    }
    assert.equal(held, 2);
    return f.context;
  };
  f.operations.locks.repository = (layout, operation) => {
    assert.strictEqual(layout, initialLayout);
    held++;
    try {
      return operation(f.assertOwned);
    } finally {
      held--;
    }
  };
  f.operations.locks.session = (layout, id, operation) => {
    assert.strictEqual(layout, initialLayout);
    assert.equal(held, 1);
    assert.equal(id, f.session.sessionId);
    held++;
    try {
      return operation();
    } finally {
      held--;
    }
  };
  assert.equal(f.begin().state, 'provider-not-required');
  assert.equal(loads, 2);
  assert.equal(held, 0);
  f.operations.session.loadActive = originalLoad;
  const other = fixture();
  f.state.failAt = 'session.inspect';
  assert.throws(
    () => f.inspect(),
    (error) => error === f.sentinel,
  );
  other.state.failAt = 'session.inspect';
  assert.throws(
    () => other.inspect(),
    (error) => error === other.sentinel && error !== f.sentinel,
  );
});

test('third inspection is fresh and inspection cannot call any mutation capability', () => {
  const f = fixture({ single: true });
  let inspections = 0;
  const inspect = f.operations.session.inspectExpected;
  f.operations.session.inspectExpected = (...args) => {
    inspections++;
    if (inspections === 3)
      f.state.projection = {
        ...f.state.projection,
        transaction: {
          ...f.transaction,
          recordDigest: digest('changed-during-begin'),
        },
      };
    return inspect(...args);
  };
  assert.throws(() => f.begin(), {
    code: 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
  });
  assert.equal(inspections, 3);
  assert.equal(f.names().includes('write.fixture-red'), true);
  const read = fixture();
  read.operations.locks = { repository: unexpected, session: unexpected };
  read.journal.evidence.write = unexpected;
  Object.assign(read.journal.implementation, {
    reserve: unexpected,
    publishResult: unexpected,
    reserveCaller: unexpected,
    publishCallerResult: unexpected,
  });
  Object.assign(read.journal.provider, {
    create: unexpected,
    storePolicy: unexpected,
    reserveRetry: unexpected,
  });
  Object.assign(read.journal.correction, {
    reserve: unexpected,
    publishResult: unexpected,
    publishImport: unexpected,
  });
  read.operations.collaboration = {
    inspect: unexpected,
    reserve: unexpected,
    readReserved: unexpected,
    consume: unexpected,
  };
  read.operations.patches = {
    validateCaller: unexpected,
    validateProvider: unexpected,
    importCaller: unexpected,
    importProvider: unexpected,
  };
  assert.equal(read.inspect().state, 'ready');
  readOnly(read);
});

test('owner checks reject changed mandate, manifest, RED and superseded attempt while observing the manifest session', () => {
  for (const changed of ['mandate', 'manifest', 'red', 'successor'] as const) {
    const f = fixture();
    f.begin();
    const root = f.state.root!;
    const attempt = f.state.attempt!;
    if (changed === 'mandate')
      f.state.invocation = {
        ...f.state.invocation!,
        mandateBinding: {
          schemaVersion: 1,
          mandateTaskId: 'task-other',
          mandateId: GRANT_ID,
          mandateDigest: digest('different'),
          changeId: f.session.changeId,
          externalAuditRoot: '/memory/audit',
        },
      };
    if (changed === 'manifest')
      f.state.manifest = { ...root.manifest, repositoryId: 'different' };
    if (changed === 'red')
      f.state.transaction = { ...f.transaction, taskId: '2.1' };
    if (changed === 'successor')
      f.journal.implementation.readCurrentAttempt = () => ({
        ...attempt,
        request: { ...attempt.request, invocationId: 'invocation-successor' },
      });
    f.clear();
    assert.throws(
      () =>
        f.lifecycle.assertTaskStrategyImplementationProviderOwnerCurrent(
          ROOT,
          root.request.invocationId,
        ),
      {
        code:
          changed === 'red'
            ? 'TASK_STRATEGY_RED_STALE'
            : 'TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT',
      },
    );
    assert.deepEqual(lastEvent(f, 'session.load').args, [
      ROOT,
      root.manifest.subject.sessionId,
    ]);
    readOnly(f);
  }
});

test('second strategy-change accounting observation decides the outcome and V2 retry reservation is refused', () => {
  const f = fixture();
  f.begin();
  f.fail('PROVIDER_TOOL_UNAVAILABLE');
  f.clear();
  let reads = 0;
  assert.throws(
    () =>
      f.begin({ retryProviderFailure: true }, (...args) => {
        reads++;
        const evidence = f.accounting(...args);
        return reads === 1 ? evidence : { state: null, invocations: [] };
      }),
    { code: 'PROVIDER_RETRY_ACCOUNTING_REQUIRED' },
  );
  assert.equal(reads, 2);
  assert.equal(f.names().filter((name) => name === 'clock').length, 2);
  assert.equal(
    f.names().includes('write.task-strategy-implementation-authorization'),
    true,
  );
  assert.equal(f.names().includes('retry.publish'), false);
  const v2 = fixture();
  v2.begin();
  v2.fail();
  const reserve = v2.journal.provider.reserveRetry;
  v2.journal.provider.reserveRetry = (input) => {
    const persisted = reserve(input);
    assert.equal(persisted.schemaVersion, 3);
    if (persisted.schemaVersion !== 3) return unexpected();
    const {
      schemaVersion: ignored,
      replacement: ignoredReplacement,
      ...body
    } = persisted;
    return { ...body, schemaVersion: 2 };
  };
  v2.clear();
  assert.throws(() => v2.begin({ retryProviderFailure: true }), {
    code: 'TASK_STRATEGY_IMPLEMENTATION_RETRY_DENIED',
    details: {
      reasonCode: 'TASK_STRATEGY_IMPLEMENTATION_RETRY_RESERVATION_INVALID',
    },
  });
  assert.equal(v2.names().includes('provider.create'), false);
});

test('capability failures propagate the same error and stop subsequent publications, including lost ownership', () => {
  for (const phase of [
    'transaction.read',
    'mandate',
    'policy.store',
    'patch.import-provider',
    'round.result',
    'round.import',
  ] as const) {
    const f = fixture({ mandate: true, correction: true });
    if (phase.startsWith('patch.') || phase.startsWith('round.')) {
      f.begin();
      f.succeed();
    }
    f.clear();
    f.state.failAt = phase;
    assert.throws(
      () => f.begin(),
      (error) => error === f.sentinel,
    );
    assert.deepEqual(f.names().slice(-3), [
      phase,
      'session.release',
      'repository.release',
    ]);
  }
  for (const phase of [
    'grant.inspect',
    'grant.reserve',
    'grant.consume',
    'authority.caller',
    'patch.import-caller',
  ] as const) {
    const f = fixture({ providers: false });
    f.state.failAt = phase;
    assert.throws(
      () => f.begin(f.callerOptions),
      (error) => error === f.sentinel,
    );
    assert.deepEqual(f.names().slice(-3), [
      phase,
      'session.release',
      'repository.release',
    ]);
  }
  const f = fixture();
  f.state.failAt = 'owned';
  assert.throws(
    () => f.begin(),
    (error) => error === f.sentinel,
  );
  assert.deepEqual(f.names(), [
    'session.load',
    'repository.enter',
    'session.enter',
    'owned',
    'session.release',
    'repository.release',
  ]);
});

test('lifecycle preserves exact nested wrapper failure and cleanup error identities', () => {
  const f = fixture();
  const sessionRelease = new Error('session release');
  const repositoryRelease = new Error('repository release');
  let caught: unknown;
  f.operations.locks.session = (_layout, _id, operation) => {
    try {
      return operation();
    } finally {
      throw sessionRelease;
    }
  };
  f.operations.locks.repository = (_layout, operation) => {
    try {
      return operation(f.assertOwned);
    } catch (error) {
      caught = error;
      throw new AggregateError([error, repositoryRelease], 'both', {
        cause: repositoryRelease,
      });
    }
  };
  f.state.failAt = 'transaction.read';
  assert.throws(
    () => f.begin(),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [sessionRelease, repositoryRelease]);
      assert.strictEqual(error.cause, repositoryRelease);
      return true;
    },
  );
  assert.strictEqual(caught, sessionRelease);
});

test('caller resumes an exact reserved grant and refuses a different transition before admitting a role', () => {
  for (const mismatch of [false, true]) {
    const f = fixture({ providers: false });
    f.state.failAt = 'role.authorize';
    assert.throws(
      () => f.begin(f.callerOptions),
      (error) => error === f.sentinel,
    );
    assert.ok(f.state.grant);
    assert.equal(f.state.caller, null);
    if (mismatch)
      f.state.grant = {
        ...f.state.grant,
        transitionDigest: digest('different-transition'),
      };
    f.state.failAt = null;
    f.clear();
    if (mismatch) {
      assert.throws(() => f.begin(f.callerOptions), {
        code: 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
      });
      assert.equal(f.names().includes('role.authorize'), false);
    } else {
      assert.equal(f.begin(f.callerOptions).state, 'patch-imported');
    }
    ordered(f.names(), 'grant.inspect', 'grant.reserved');
    assert.equal(f.names().includes('grant.reserve'), false);
  }
});
