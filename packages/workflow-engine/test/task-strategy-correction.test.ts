import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  parseTaskStrategyImplementationReservation,
  parseTaskStrategyImplementationResultBinding,
  parseTaskStrategyCallerImplementationReservation,
  parseTaskStrategyCallerImplementationBinding,
  type TaskStrategyImplementationReservation,
  type TaskStrategyCallerImplementationReservation,
} from '../src/modules/assurance/task-strategy-implementation-record.ts';
import type {
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import type { CollaborationGrantUseProjection } from '../src/modules/authority/collaboration-grant-records.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  scheduleOrdinaryRole,
  type GrantedRoleAssignment,
  type RecordedRoleParticipant,
} from '../src/modules/provider-orchestration/role-assignment.ts';
import type { RoleContentAdmission } from '../src/modules/provider-orchestration/role-admission-contracts.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
  createTaskStrategyCorrectionSubject,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';

import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type { SessionInspection } from '../src/modules/lifecycle/session-inspection.ts';
import type { TaskMechanicalTransformLifecycleStatus } from '../src/modules/lifecycle/managed-workflow-state-contract.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
  ExecutionTask,
} from '../src/modules/planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyPatchRecord,
  TaskStrategyPatchCurrentBinding,
  TaskStrategyRedRevisionRequest,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionProjection } from '../src/modules/assurance/task-strategy-correction-round-record.ts';
import type { TaskStrategyImplementationProviderAttempt } from '../src/modules/assurance/task-strategy-implementation-record.ts';
import type { ImportedTaskStrategyPatch } from '../src/modules/assurance/task-strategy-patch-contract.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type { TaskStrategyImplementationSubject } from '../src/modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import {
  prepareTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
} from '../src/modules/provider-orchestration/task-strategy-correction-record.ts';

import {
  createTaskStrategyCorrection,
  createCurrentTaskStrategyCorrectionSubject,
} from '../src/application/execute-task/task-strategy-correction.ts';
import type {
  TaskStrategyCorrectionOperations,
  TaskStrategyCorrectionJournal,
} from '../src/application/execute-task/task-strategy-correction-operations.ts';
import type {
  TaskStrategyCorrectionRound,
  TaskStrategyCorrectionReservationAuthority,
  TaskStrategyCorrectionResultAuthority,
  TaskStrategyCorrectionState,
  CurrentTaskStrategyPatchHead,
} from '../src/modules/assurance/task-strategy-correction-round-record.ts';
import type {
  TaskStrategyGreenFailureInput,
  TaskStrategyCorrectionPolicy,
} from '../src/modules/provider-orchestration/task-strategy-correction-record.ts';
import type {
  CheckEvidence,
  ObservedCheckFailure,
} from '../src/foundation/check-evidence/check-evidence.ts';
import type { CheckRunnerPin } from '../src/modules/source/check-command.ts';
import { ExitCode } from '../src/foundation/errors/errors.ts';
import {
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
} from '../src/modules/assurance/task-strategy-implementation-attempt.ts';

const NOW = '2026-09-23T01:00:00.000Z';
const CREATED_AT = NOW;
const ROOT = '/memory/task-strategy';
const GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROLE_RESULT_SCHEMA = 'admitted-role-result.v1';
const hash = (value: unknown) => digest(canonicalJson(value));
const unexpected = (): never => {
  throw new Error('unexpected capability');
};
const STALE = { code: 'TASK_STRATEGY_CORRECTION_STATE_STALE' };

// Complete typed wire fixtures use pure canonical builders. No store, Git,
// production binding or whole-use-case substitute participates in these tests.
function baseFacts(options: { single?: boolean; correction?: boolean } = {}) {
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

  const initialSubject = createTaskStrategyImplementationSubject({
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    taskContractDigest: transaction.taskContractDigest,
    sourceTree: transaction.red.candidateTree,
    failureFingerprint: transaction.red.failureFingerprint,
    redEvidenceNodeId: transaction.red.evidenceNodeId,
    redEvidenceResultDigest: transaction.red.evidenceResultDigest,
    testPaths: transaction.red.testPaths,
    fixturePaths: transaction.red.fixturePaths,
    frozenFiles: transaction.red.files,
  });
  const subject = options.correction
    ? createTaskStrategyCorrectionSubject({
        subject: initialSubject,
        round: 1,
        greenFailureRecord: failure,
      })
    : initialSubject;
  const records = implementationRecords(
    subject,
    transaction,
    options.correction ? failure : undefined,
  );
  const patchBytes = Buffer.from('fixed implementation patch bytes');
  const record: TaskStrategyPatchRecord = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-record.v1',
    recordDigest: digest('patch-record'),
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    strategy: transaction.strategy,
    sourceTree: subject.sourceTree,
    candidateTree: '6'.repeat(40),
    taskContractDigest: transaction.taskContractDigest,
    patchDigest: digest(patchBytes),
    patchBase64: patchBytes.toString('base64'),
    changedPaths: ['src/feature.ts'],
    changes: [],
    implementer: { providerId: 'codex', assurance: 'adapter-assigned' },
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
  const imported: ImportedTaskStrategyPatch = {
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
  const projection: TaskStrategyCorrectionProjection = {
    transaction,
    head: null,
    failure: null,
    completedCorrectionRounds: 0,
    exhausted: false,
    correctionState: null,
  };
  const root = records.reservation;
  const attempt: TaskStrategyImplementationProviderAttempt = {
    root,
    attempt: 1,
    previousInvocationId: null,
    assignment: root.assignment,
    manifestDigest: hash(root.manifest),
    request: root.request,
    authorizationNodeId: root.authorizationNodeId,
    reservationNodeId: root.reservationNodeId,
    retryDecision: null,
    retryReservation: null,
    createdAt: NOW,
  };
  const invocation: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: attempt.request.invocationId,
    investigationId: root.ownerInvestigationId,
    changeId: session.changeId,
    attempt: 1,
    revision: 0,
    state: 'prepared',
    providerId: root.assignment.providerId,
    purpose: 'task-implementation',
    requestDigest: attempt.request.requestDigest,
    manifestDigest: attempt.manifestDigest,
    leaseGeneration: 0,
    lease: null,
    result: null,
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    session,
    git,
    task,
    inspection,
    transaction: transaction as TaskStrategyTransaction | null,
    projection,
    authority: {
      subject,
      greenFailureRecord: options.correction ? failure : null,
    },
    initialSubject,
    failure,
    imported,
    records,
    mechanical: {
      state: 'transformation-required',
      projectionDigest: digest('mechanical'),
    } as TaskMechanicalTransformLifecycleStatus | null,
    reservation: null as TaskStrategyImplementationReservation | null,
    callerReservation:
      null as TaskStrategyCallerImplementationReservation | null,
    callerResult: null as TaskStrategyCallerImplementationBinding | null,
    result: null as TaskStrategyImplementationResultBinding | null,
    attempt,
    invocation,
    invocationExists: false,
  };
}

function implementationRecords(
  subject: TaskStrategyImplementationSubject,
  transaction: TaskStrategyTransaction,
  greenFailureRecord?: TaskStrategyGreenFailureRecord,
) {
  const author = {
    providerId: 'codex' as const,
    sessionId: 'red-author-session',
    principalId: 'provider:codex',
    identityAssurance: 'self-declared' as const,
    engineSpawned: false,
  };
  const providerId = 'claude';
  const participant = {
    providerId,
    sessionId: 'implementation-provider-session',
    principalId: `provider:${providerId}`,
    identityAssurance: 'adapter-assigned' as const,
    engineSpawned: true,
  } satisfies RecordedRoleParticipant;
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author,
    targetDigest: subject.subjectDigest,
    candidates: [
      {
        providerId,
        sessionId: participant.sessionId,
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') throw new Error('invalid fixture');
  const assignment = scheduled.assignment;
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'record-contract',
    baseCommit: transaction.baseline.head,
    baseTree: transaction.baseline.tree,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/feature/spec.md',
        requirement: 'Implementation records retain their exact subject',
        scenario: null,
      },
    ],
    implementationPathScopes: ['src/**'],
    ...(greenFailureRecord === undefined ? {} : { greenFailureRecord }),
  });
  const authorizationNodeId = digest('authorization-node');
  const request = createProviderInvocationRequest({
    invocationId: 'invocation-record-contract',
    nonce: 'record-contract-nonce',
    purpose: 'task-implementation',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: 'record-contract',
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: digest(canonicalJson(manifest)),
    authorizationNodeId,
    writeAllowedPaths: [],
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-strategy-implementation.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    limits: { timeoutMs: 10_000, aggregateOutputBytes: 100_000 },
  });
  const patch = Buffer.from('fixed implementation patch bytes');
  const output = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-output.v1' as const,
    sessionId: subject.sessionId,
    sourceTree: subject.sourceTree,
    patchBase64: patch.toString('base64'),
    patchDigest: digest(patch),
  };
  const content = {
    kind: 'task-implementation' as const,
    nodeId: digest('observation-node'),
    resultDigest: digest('observation-result'),
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluator: 'task-strategy-implementation.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    contentDigest: digest('observation-result'),
    current: true as const,
  };
  const providerRoleResult = seal(
    {
      schemaVersion: 1 as const,
      form: 'ordinary-provider' as const,
      role: 'task-implementer' as const,
      targetDigest: subject.subjectDigest,
      assignment,
      author,
      participant,
      orchestration: 'engine-spawned-provider' as const,
      requiredIndependence: 'session-independent' as const,
      achievedIndependence: assignment.achievedIndependence,
      content,
      providerInvocation: {
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        outputDigest: digest(canonicalJson(output)),
        providerId: assignment.providerId,
        sessionId: assignment.sessionId,
        targetDigest: subject.subjectDigest,
        engineSpawned: true as const,
      },
      grantUse: null,
      directHumanReviewAttestation: null,
    },
    'resultDigest',
    ROLE_RESULT_SCHEMA,
  );
  const reservation = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-implementation-reservation.v1' as const,
      ownerInvestigationId: 'investigation-record-contract',
      sessionId: subject.sessionId,
      changeId: subject.changeId,
      taskId: subject.taskId,
      repositoryRoot: '/fixture/repository',
      gitCommonDirectory: '/fixture/repository/.git',
      branch: 'work/record-contract',
      baseline: { head: manifest.baseCommit, tree: manifest.baseTree },
      mandateBinding: null,
      subject,
      redAuthor: author,
      assignment,
      manifest,
      request,
      authorizationNodeId,
      reservationNodeId: digest('reservation-node'),
      createdAt: NOW,
    },
    'recordDigest',
  ) satisfies TaskStrategyImplementationReservation;
  const result = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-implementation-result-binding.v1' as const,
      ownerInvestigationId: reservation.ownerInvestigationId,
      sessionId: subject.sessionId,
      subjectDigest: subject.subjectDigest,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest: digest(canonicalJson(output)),
      runtimeObservationDigest: digest('runtime-observation'),
      providerObservationNodeId: content.nodeId,
      providerObservationDigest: content.resultDigest,
      providerResultNodeId: digest('provider-result-node'),
      providerResultDigest: digest('provider-result'),
      roleResult: providerRoleResult,
      output,
      createdAt: NOW,
    },
    'bindingDigest',
  ) satisfies TaskStrategyImplementationResultBinding;

  const callerAssignment = {
    role: 'task-implementer',
    providerId: null,
    sessionId: null,
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'none',
    providerIndependent: false,
    sessionIndependent: false,
    engineSpawned: false,
    orchestration: 'caller-supplied',
    grantId: GRANT_ID,
    degradedForm: 'caller-supplied',
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    author,
    participant: {
      providerId: null,
      sessionId: null,
      principalId: 'caller-record-contract',
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    callableProviderIds: [],
    directHumanReviewAttestationDigest: null,
  } satisfies GrantedRoleAssignment;
  const callerContent = {
    ...content,
    nodeId: digest('submission-node'),
    resultDigest: digest('submission-result'),
    contentDigest: digest('submission-result'),
  };
  const callerReservation = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-caller-implementation-reservation.v1' as const,
      sessionId: subject.sessionId,
      subjectDigest: subject.subjectDigest,
      grantId: GRANT_ID,
      transitionDigest: digest('transition'),
      assignment: callerAssignment,
      submissionNodeId: callerContent.nodeId,
      submissionResultDigest: callerContent.resultDigest,
      output,
      createdAt: NOW,
    },
    'reservationDigest',
  ) satisfies TaskStrategyCallerImplementationReservation;
  const callerRoleResult = seal(
    {
      schemaVersion: 1 as const,
      form: 'granted-caller-supplied' as const,
      role: 'task-implementer' as const,
      targetDigest: subject.subjectDigest,
      assignment: callerAssignment,
      author,
      participant: callerAssignment.participant,
      orchestration: 'caller-supplied' as const,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'none' as const,
      content: callerContent,
      providerInvocation: null,
      grantUse: grantUse(callerAssignment, callerContent),
      directHumanReviewAttestation: null,
    },
    'resultDigest',
    ROLE_RESULT_SCHEMA,
  );
  const callerResult = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-caller-implementation-binding.v1' as const,
      sessionId: subject.sessionId,
      subjectDigest: subject.subjectDigest,
      transitionDigest: callerReservation.transitionDigest,
      submissionNodeId: callerContent.nodeId,
      submissionResultDigest: callerContent.resultDigest,
      resultNodeId: digest('caller-result-node'),
      resultDigest: digest('caller-result'),
      roleResult: callerRoleResult,
      output,
      createdAt: NOW,
    },
    'bindingDigest',
  ) satisfies TaskStrategyCallerImplementationBinding;
  // These four inputs also pass their canonical record parsers. Later tests
  // explicitly label altered mismatches as consumer-boundary fault injection.
  parseTaskStrategyImplementationReservation(reservation);
  parseTaskStrategyImplementationResultBinding(result);
  parseTaskStrategyCallerImplementationReservation(callerReservation);
  parseTaskStrategyCallerImplementationBinding(callerResult);
  return { reservation, result, callerReservation, callerResult };
}

function grantUse(
  assignment: GrantedRoleAssignment,
  content: RoleContentAdmission,
): CollaborationGrantUseProjection {
  const payload = {
    version: 2 as const,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    grantId: assignment.grantId,
    repositoryId: 'record-contract',
    repositoryOrigin: 'git@example.invalid:record-contract.git',
    policyBlob: '5'.repeat(40),
    collaborationPolicyDigest: digest('collaboration-policy'),
    changeId: 'record-contract',
    taskId: '1.1',
    baselineCommit: '3'.repeat(40),
    baselineTree: '4'.repeat(40),
    targetDigest: assignment.targetDigest,
    lifecyclePhase: 'task-implementation' as const,
    rolePair: {
      authorRole: 'red-author' as const,
      conflictingRole: 'task-implementer' as const,
    },
    availableActor:
      assignment.providerId === null
        ? {
            kind: 'caller' as const,
            callerId: 'caller-record-contract',
            assurance: 'runtime-hint' as const,
          }
        : {
            kind: 'provider' as const,
            providerId: assignment.providerId,
            assurance: 'self-declared' as const,
          },
    degradedForm: assignment.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: 'No provider-independent implementation candidate is callable.',
    issuedAt: CREATED_AT,
    expiresAt: '2026-09-23T01:30:00.000Z',
    maxUses: 1 as const,
    signer: 'fixture-maintainer',
  };
  const envelope = { payload, signature: 'fixture-signature' };
  return {
    schemaVersion: 1,
    grantId: assignment.grantId,
    signedEnvelopeDigest: digest(canonicalJson(envelope)),
    transitionDigest: digest('transition'),
    reservedAt: CREATED_AT,
    lifecyclePhase: 'task-implementation',
    targetDigest: assignment.targetDigest,
    degradedForm: assignment.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    assignment,
    structuredContent: {
      kind: content.kind,
      nodeId: content.nodeId,
      resultDigest: content.resultDigest,
    },
    contentAuthority: 'reference-only-requires-governing-validator',
    directHumanReviewAttestation: null,
    retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
    residuals: COLLABORATION_GRANT_RESIDUALS,
    envelope,
  };
}

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function seal<T extends object, K extends string>(
  value: T,
  key: K,
  schema?: string,
): T & Record<K, string> {
  const body = { ...value } as Record<string, unknown>;
  delete body[key];
  return {
    ...value,
    [key]: digest(
      canonicalJson(schema === undefined ? body : { schema, ...body }),
    ),
  } as T & Record<K, string>;
}

type AuthorityKind = 'sealed-local' | 'provider' | 'caller-supplied';
type BaseFacts = ReturnType<typeof baseFacts>;
const POLICY: TaskStrategyCorrectionPolicy = Object.freeze({
  maxRepairAttempts: 3,
  maxSameFailureFingerprint: 2,
});
const STALE_MESSAGE =
  'GREEN failure evidence does not match the exact current RED transaction, patch head, check set, or runner identity.';
function patchIdentity(head: CurrentTaskStrategyPatchHead) {
  return {
    bindingDigest: head.binding.bindingDigest,
    recordDigest: head.record.recordDigest,
    patchDigest: head.record.patchDigest,
    receiptDigest: head.receipt.receiptDigest,
  };
}
function failureFor(
  f: BaseFacts,
  head: CurrentTaskStrategyPatchHead,
  name = 'failed',
) {
  const body = {
    ...f.failure.failingCheck,
    stdoutDigest: digest(name),
    stdoutExcerpt: name,
  };
  const { failureFingerprint: _old, ...fingerprintBody } = body;
  return prepareTaskStrategyGreenFailureRecord({
    sessionId: f.session.sessionId,
    currentRedTransactionDigest: f.projection.transaction.recordDigest,
    currentPatchHead: patchIdentity(head),
    candidateTree: head.record.candidateTree,
    checkDefinitions: f.failure.checkDefinitions,
    passedChecks: [],
    failingCheck: {
      ...fingerprintBody,
      failureFingerprint: hash(fingerprintBody),
    },
    createdAt: NOW,
  });
}
function authorityFacts(
  f: BaseFacts,
  subject: TaskStrategyImplementationSubject,
  kind: AuthorityKind,
  failure?: TaskStrategyGreenFailureRecord,
) {
  const records = implementationRecords(
    subject,
    f.projection.transaction,
    failure,
  );
  const root = records.reservation;
  const attempt: TaskStrategyImplementationProviderAttempt = {
    root,
    attempt: 1,
    previousInvocationId: null,
    assignment: root.assignment,
    manifestDigest: hash(root.manifest),
    request: root.request,
    authorizationNodeId: root.authorizationNodeId,
    reservationNodeId: root.reservationNodeId,
    retryDecision: null,
    retryReservation: null,
    createdAt: NOW,
  };
  return {
    subject,
    records,
    providerReservation:
      kind === 'provider'
        ? root
        : (null as TaskStrategyImplementationReservation | null),
    providerResult:
      kind === 'provider'
        ? records.result
        : (null as TaskStrategyImplementationResultBinding | null),
    callerReservation:
      kind === 'caller-supplied'
        ? records.callerReservation
        : (null as TaskStrategyCallerImplementationReservation | null),
    callerResult:
      kind === 'caller-supplied'
        ? records.callerResult
        : (null as TaskStrategyCallerImplementationBinding | null),
    attempt,
    invocation: {
      ...f.invocation,
      invocationId: attempt.request.invocationId,
      requestDigest: attempt.request.requestDigest,
    },
  };
}
type AuthorityFacts = ReturnType<typeof authorityFacts>;
function headFor(
  f: BaseFacts,
  sourceTree: string,
  index: number,
  kind: AuthorityKind,
  facts: AuthorityFacts,
): CurrentTaskStrategyPatchHead {
  const caller = facts.records.callerReservation.assignment.participant;
  assert.ok(caller.principalId);
  assert.notEqual(caller.identityAssurance, 'maintainer-signed');
  const implementer =
    kind === 'sealed-local'
      ? f.projection.transaction.author
      : kind === 'provider'
        ? {
            providerId: facts.records.result.roleResult.participant.providerId!,
            assurance: 'adapter-assigned' as const,
          }
        : {
            providerId: null,
            principalId: caller.principalId,
            assurance: 'runtime-hint' as const,
            degradedForm: 'caller-supplied' as const,
            grantId: GRANT_ID,
          };
  const record: TaskStrategyPatchRecord = {
    ...f.imported.record,
    sourceTree,
    candidateTree: (6 + index).toString(16).repeat(40),
    recordDigest: digest(`record-${index}`),
    implementer,
  };
  const receipt = {
    ...f.imported.receipt,
    receiptDigest: digest(`receipt-${index}`),
    recordDigest: record.recordDigest,
    candidateTree: record.candidateTree,
  };
  const binding = {
    ...f.imported.binding,
    bindingDigest: digest(`binding-${index}`),
    recordDigest: record.recordDigest,
    receiptDigest: receipt.receiptDigest,
    candidateTree: record.candidateTree,
  };
  return { record, receipt, binding };
}
function roundFor(
  f: BaseFacts,
  failure: TaskStrategyGreenFailureRecord,
  head: CurrentTaskStrategyPatchHead,
  facts: AuthorityFacts,
  index: number,
  kind: AuthorityKind,
): TaskStrategyCorrectionRound {
  const provider = facts.providerReservation ?? facts.records.reservation;
  const result = facts.providerResult ?? facts.records.result;
  const caller = facts.callerReservation ?? facts.records.callerReservation;
  const callerResult = facts.callerResult ?? facts.records.callerResult;
  let reservationAuthority: TaskStrategyCorrectionReservationAuthority;
  let resultAuthority: TaskStrategyCorrectionResultAuthority;
  if (kind === 'sealed-local') {
    reservationAuthority = resultAuthority = {
      kind,
      author: f.projection.transaction.author,
    };
  } else if (kind === 'provider') {
    reservationAuthority = {
      kind,
      providerRequest: {
        ownerInvestigationId: provider.ownerInvestigationId,
        invocationId: provider.request.invocationId,
        requestDigest: provider.request.requestDigest,
      },
      providerReservation: {
        reservationDigest: provider.recordDigest,
        authorizationNodeId: provider.authorizationNodeId,
        reservationNodeId: provider.reservationNodeId,
      },
    };
    resultAuthority = {
      ...reservationAuthority,
      providerAttempt: {
        attempt: facts.attempt.attempt,
        attemptReservationDigest:
          taskStrategyImplementationProviderAttemptReservationDigest(
            facts.attempt,
          ),
        invocationId: facts.attempt.request.invocationId,
        requestDigest: facts.attempt.request.requestDigest,
      },
      providerResult: {
        bindingDigest: result.bindingDigest,
        invocationId: result.invocationId,
        requestDigest: result.requestDigest,
        outputDigest: result.outputDigest,
        providerResultNodeId: result.providerResultNodeId,
        providerResultDigest: result.providerResultDigest,
      },
    };
  } else {
    reservationAuthority = {
      kind,
      callerReservation: {
        reservationDigest: caller.reservationDigest,
        grantId: caller.grantId,
        transitionDigest: caller.transitionDigest,
        submissionNodeId: caller.submissionNodeId,
        submissionResultDigest: caller.submissionResultDigest,
      },
    };
    resultAuthority = {
      ...reservationAuthority,
      callerResult: {
        bindingDigest: callerResult.bindingDigest,
        resultNodeId: callerResult.resultNodeId,
        resultDigest: callerResult.resultDigest,
        roleResultDigest: callerResult.roleResult.resultDigest,
        grantUseDigest: hash(callerResult.roleResult.grantUse),
      },
    };
  }
  const patchResult = {
    sourceTree: failure.candidateTree,
    targetCandidateTree: head.record.candidateTree,
    patchRecordDigest: head.record.recordDigest,
    patchDigest: head.record.patchDigest,
  };
  const identity = {
    sessionId: f.session.sessionId,
    currentRedTransactionDigest: f.projection.transaction.recordDigest,
    round: index,
    correctionSubjectDigest: facts.subject.subjectDigest,
  };
  return {
    reservation: seal(
      {
        schemaVersion: 1,
        kind: 'task-strategy-correction-round-reservation.v1',
        sessionId: f.session.sessionId,
        round: index,
        policy: POLICY,
        policyDigest: hash(POLICY),
        predecessorFailure: {
          recordDigest: failure.recordDigest,
          subjectDigest: failure.subjectDigest,
          candidateTree: failure.candidateTree,
          failureFingerprint: failure.failingCheck.failureFingerprint,
          currentRedTransactionDigest: failure.currentRedTransactionDigest,
          currentPatchHead: failure.currentPatchHead,
        },
        correctionSubjectDigest: facts.subject.subjectDigest,
        redSourceTree: f.projection.transaction.red.candidateTree,
        authority: reservationAuthority,
        createdAt: NOW,
      } as const,
      'reservationDigest',
    ),
    result: seal(
      {
        schemaVersion: 1,
        kind: 'task-strategy-correction-round-result.v1',
        ...identity,
        authority: resultAuthority,
        patchResult,
        createdAt: NOW,
      } as const,
      'resultDigest',
    ),
    importRecord: seal(
      {
        schemaVersion: 1,
        kind: 'task-strategy-correction-round-import.v1',
        ...identity,
        authority: resultAuthority,
        patchResult,
        importReceipt: {
          patchRecordDigest: head.record.recordDigest,
          patchDigest: head.record.patchDigest,
          receiptDigest: head.receipt.receiptDigest,
          candidateTree: head.record.candidateTree,
        },
        currentPatchHead: patchIdentity(head),
        importedAt: NOW,
      } as const,
      'importDigest',
    ),
  };
}

// Each journal frame represents separately observed canonical records, not a
// precomputed projection. The real factory performs every lineage comparison.
function frame(
  kind: AuthorityKind = 'sealed-local',
  count = 0,
  finalFailure = false,
) {
  const base = baseFacts({ single: kind === 'sealed-local' });
  base.inspection.contract.checks.checks.unit = {
    command: ['node', 'unit.mjs'],
    destructiveDatabase: false,
  };
  const heads: CurrentTaskStrategyPatchHead[] = [];
  const authorities: AuthorityFacts[] = [];
  const failures = new Map<string, TaskStrategyGreenFailureRecord | null>();
  const rounds: TaskStrategyCorrectionRound[] = [];
  const initial = authorityFacts(base, base.initialSubject, kind);
  authorities.push(initial);
  heads.push(
    headFor(
      base,
      base.projection.transaction.red.candidateTree,
      0,
      kind,
      initial,
    ),
  );
  for (let i = 1; i <= count; i++) {
    const previous = heads[i - 1]!;
    const failure = failureFor(base, previous, `failure-${i}`);
    failures.set(previous.record.candidateTree, failure);
    const subject = createCurrentTaskStrategyCorrectionSubject(
      base.projection.transaction,
      failure,
      i,
    );
    const authority = authorityFacts(base, subject, kind, failure);
    authorities.push(authority);
    const head = headFor(base, failure.candidateTree, i, kind, authority);
    heads.push(head);
    rounds.push(roundFor(base, failure, head, authority, i, kind));
  }
  const last = heads.at(-1)!;
  failures.set(
    last.record.candidateTree,
    finalFailure ? failureFor(base, last, 'last-failure') : null,
  );
  return {
    base,
    transaction: base.projection.transaction as TaskStrategyTransaction | null,
    heads,
    sources: heads.map((h) => h.record.sourceTree),
    authorities,
    failures,
    rounds,
    missingBindings: new Set<string>(),
    missingRecords: new Set<string>(),
    missingReceipts: new Set<string>(),
    derived: {
      state: 'correction-required',
      round: count + 1,
      nextAction: 'reserve',
    } as TaskStrategyCorrectionState,
  };
}
type Frame = ReturnType<typeof frame>;
type Event = { name: string; args: unknown[]; frame: number };
function fixture(frames: Frame[] = [frame()], record = false) {
  const events: Event[] = [];
  let index = -1;
  const state: {
    failAt?: string;
    failOccurrence: number;
    sentinel: Error;
    forbidden: Set<string>;
    onEvent?: (event: Event) => void;
    returned?: TaskStrategyGreenFailureRecord;
  } = {
    failOccurrence: 1,
    sentinel: new Error('injected port failure'),
    forbidden: new Set(),
  };
  const emit = (name: string, args: unknown[], at = index) => {
    const event = { name, args, frame: at };
    events.push(event);
    state.onEvent?.(event);
    if (state.forbidden.has(name))
      throw new Error(`unexpected capability: ${name}`);
    if (
      state.failAt === name &&
      events.filter((e) => e.name === name).length === state.failOccurrence
    )
      throw state.sentinel;
  };
  const operations: TaskStrategyCorrectionOperations = {
    correctionPolicy: POLICY,
    clock: {
      now() {
        emit('clock', []);
        if (!record) return unexpected();
        return new Date(NOW);
      },
    },
    observeJournal(...args) {
      const at = ++index;
      const current = frames[Math.min(index, frames.length - 1)]!;
      emit('observe', args, at);
      let activeAuthority = current.authorities[0]!;
      const bySubject = (subject: string) => {
        const found = current.authorities.find(
          (a) => a.subject.subjectDigest === subject,
        );
        assert.ok(found, 'unplanned subject read');
        activeAuthority = found;
        return found;
      };
      const byTree = (source: string) =>
        current.heads[current.sources.indexOf(source)];
      return {
        correction: {
          readTransaction(...args) {
            emit('transaction', args, at);
            return current.transaction;
          },
          readFailure(...args) {
            emit('failure', args, at);
            return current.failures.get(args[1]) ?? null;
          },
          listRounds(...args) {
            emit('rounds', args, at);
            return current.rounds;
          },
          deriveState(...args) {
            emit('derive', args, at);
            return current.derived;
          },
          createFailure(...args) {
            emit('write', args, at);
            if (!record) return unexpected();
            state.returned = prepareTaskStrategyGreenFailureRecord(args[0]);
            return state.returned;
          },
        },
        patch: {
          readCurrentBinding(...args) {
            emit('binding', args, at);
            return current.missingBindings.has(args[1])
              ? null
              : (byTree(args[1])?.binding ?? null);
          },
          readRecord(...args) {
            emit('record', args, at);
            return current.missingRecords.has(args[2])
              ? null
              : (byTree(args[2])?.record ?? null);
          },
          readImportReceipt(...args) {
            emit('receipt', args, at);
            return current.missingReceipts.has(args[2])
              ? null
              : (byTree(args[2])?.receipt ?? null);
          },
        },
        implementation: {
          readReservation(...args) {
            emit('provider.reservation', args, at);
            return bySubject(args[1]).providerReservation;
          },
          readResult(...args) {
            emit('provider.result', args, at);
            return bySubject(args[1]).providerResult;
          },
          readCallerReservation(...args) {
            emit('caller.reservation', args, at);
            return bySubject(args[1]).callerReservation;
          },
          readCallerResult(...args) {
            emit('caller.result', args, at);
            return bySubject(args[1]).callerResult;
          },
          readAttempt(...args) {
            emit('attempt', args, at);
            return activeAuthority.attempt;
          },
          assertProviderCurrent(...args) {
            emit('provider.verify', args, at);
          },
          assertCallerCurrent(...args) {
            emit('caller.verify', args, at);
          },
        },
        provider: {
          read(...args) {
            emit('invocation', args, at);
            return activeAuthority.invocation;
          },
        },
      } satisfies TaskStrategyCorrectionJournal;
    },
  };
  const pin: CheckRunnerPin = (...args) => {
    emit('pin', args);
    if (!record) return unexpected();
    return {
      runner: 'node',
      executable: '/memory/node',
      args: ['unit.mjs'],
      digest: digest('runner'),
    };
  };
  const service = createTaskStrategyCorrection(operations);
  const inspection = frames[0]!.base.inspection;
  return {
    service,
    operations,
    pin,
    events,
    frames,
    inspection,
    state,
    resolve: () => service.resolveCurrentTaskStrategyCorrection(inspection),
    read: () => service.readCurrentTaskStrategyGreenFailure(inspection),
    authority: (projection?: TaskStrategyCorrectionProjection) =>
      service.resolveCurrentTaskStrategyImplementationAuthority(
        inspection,
        projection,
      ),
    record: (
      passed: readonly CheckEvidence[] = [],
      failing: ObservedCheckFailure = frames[0]!.base.failure.failingCheck,
    ) =>
      service.recordTaskStrategyGreenFailure(pin, inspection, passed, failing),
    names: () => events.map((e) => e.name),
    calls: (name: string) => events.filter((e) => e.name === name),
  };
}
function last(f: ReturnType<typeof fixture>, name: string) {
  const found = f.calls(name).at(-1);
  assert.ok(found, `missing ${name}`);
  return found;
}
const headReads = [
  'observe',
  'transaction',
  'binding',
  'record',
  'receipt',
  'rounds',
];
const initialAuthorityReads = [
  'provider.reservation',
  'provider.result',
  'caller.reservation',
  'caller.result',
];
const localReads = [...headReads, ...initialAuthorityReads, 'failure'];
function assertStale(run: () => unknown, original?: Error) {
  assert.throws(run, (e) => {
    assert.ok(e instanceof Error);
    assert.notStrictEqual(e, original);
    assert.equal(Reflect.get(e, 'code'), STALE.code);
    assert.equal(e.message, STALE_MESSAGE);
    assert.equal(Reflect.get(e, 'exitCode'), ExitCode.staleState);
    return true;
  });
}
// Deliberate consumer-boundary fault injection. Mutated records are never
// asserted to be accepted by a durable canonical producer.
function fault<T>(value: T, path: string, replacement: unknown): T {
  const result = structuredClone(value);
  const keys = path.split('.');
  let cursor = result as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    cursor = cursor[key] as Record<string, unknown>;
  cursor[keys.at(-1)!] = replacement;
  return result;
}

test('factory is lazy and isolated; writer, clock and pin guards reject explicit negative probes', () => {
  const a = fixture();
  const b = fixture();
  assert.deepEqual(a.events, []);
  assert.deepEqual(b.events, []);
  assert.throws(() => a.operations.clock.now(), /unexpected capability/);
  assert.throws(
    () => a.pin(ROOT, 'unit', a.inspection.contract.checks.checks.unit!),
    /unexpected capability/,
  );
  const journal = a.operations.observeJournal(
    a.inspection.git.gitCommonDirectory,
    a.inspection.contract.config.runtimeDirectory,
  );
  const input: TaskStrategyGreenFailureInput = a.frames[0]!.base.failure;
  assert.throws(
    () => journal.correction.createFailure(input),
    /unexpected capability/,
  );
  a.events.length = 0;
  assert.equal(a.resolve().completedCorrectionRounds, 0);
  assert.deepEqual(b.events, []);
  assert.equal(b.resolve().completedCorrectionRounds, 0);
  assert.deepEqual(a.names(), localReads);
});

test('local, provider and caller lineages expose the exact head across zero, one and two completed rounds', () => {
  for (const kind of ['sealed-local', 'provider', 'caller-supplied'] as const)
    for (const count of [0, 1, 2]) {
      const item = frame(kind, count);
      const f = fixture([item]);
      const result = f.resolve();
      assert.equal(result.completedCorrectionRounds, count);
      assert.equal(result.failure, null);
      assert.equal(result.exhausted, false);
      assert.equal(result.correctionState, null);
      assert.strictEqual(result.transaction, item.transaction);
      assert.strictEqual(result.head?.record, item.heads.at(-1)!.record);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.head), true);
      assert.deepEqual(
        f.calls('failure').map((e) => e.args[1]),
        item.heads.map((h) => h.record.candidateTree),
      );
      assert.equal(f.calls('derive').length, 0);
      assert.deepEqual(
        f.calls('binding').map((e) => e.args[1]),
        item.sources,
      );
      assert.equal(
        f.calls('provider.verify').length,
        kind === 'provider' ? count + 1 : 0,
      );
      assert.equal(
        f.calls('caller.verify').length,
        kind === 'caller-supplied' ? count + 1 : 0,
      );
    }
});

test('non-TDD and missing transaction paths stop before journal work and patch observations', () => {
  const item = frame();
  item.base.inspection.contract.execution = undefined;
  const f = fixture([item]);
  assert.equal(f.record(), null);
  assert.deepEqual(f.events, []);
  assertStale(f.resolve);
  assertStale(f.read);
  assertStale(() => f.authority());
  assert.deepEqual(f.events, []);
  const missing = frame();
  missing.transaction = null;
  for (const run of ['resolve', 'record'] as const) {
    const f = fixture([missing]);
    assertStale(f[run]);
    assert.deepEqual(f.names(), ['observe', 'transaction']);
  }
});

test('missing initial binding still lists rounds and rejects a lineage without its initial head', () => {
  for (const count of [0, 1]) {
    const item = frame('sealed-local', count);
    item.missingBindings.add(item.sources[0]!);
    const f = fixture([item]);
    if (count === 1) assertStale(f.resolve);
    else
      assert.deepEqual(f.resolve(), {
        transaction: item.transaction,
        head: null,
        failure: null,
        completedCorrectionRounds: 0,
        exhausted: false,
        correctionState: null,
      });
    assert.deepEqual(f.names(), [
      'observe',
      'transaction',
      'binding',
      'rounds',
    ]);
  }
});

test('authenticated head always reads record then receipt and checks every original relationship', () => {
  for (const path of [
    'record.sourceTree',
    'binding.recordDigest',
    'binding.receiptDigest',
    'binding.candidateTree',
    'receipt.recordDigest',
    'receipt.candidateTree',
  ]) {
    const item = frame();
    item.heads[0] = fault(item.heads[0]!, path, 'a'.repeat(40));
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names(), headReads.slice(0, -1), path);
  }
  for (const missing of ['missingRecords', 'missingReceipts'] as const) {
    const item = frame();
    item[missing].add(item.sources[0]!);
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names(), headReads.slice(0, -1));
  }
  const item = frame();
  item.missingRecords.add(item.sources[0]!);
  const f = fixture([item]);
  f.state.failAt = 'receipt';
  assert.throws(f.resolve, (e) => e === f.state.sentinel);
  assert.deepEqual(f.names(), headReads.slice(0, -1));
});

test('initial authority always reads four records, including local and partial-pair port controls', () => {
  for (const kind of ['sealed-local', 'provider', 'caller-supplied'] as const) {
    const item = frame(kind);
    const f = fixture([item]);
    f.resolve();
    assert.deepEqual(f.names().slice(6, 10), initialAuthorityReads);
    for (const name of initialAuthorityReads) {
      const bad = fixture([item]);
      bad.state.failAt = name;
      assertStale(bad.resolve, bad.state.sentinel);
      assert.deepEqual(bad.names(), [
        ...headReads,
        ...initialAuthorityReads.slice(
          0,
          initialAuthorityReads.indexOf(name) + 1,
        ),
      ]);
    }
  }
  const none = frame('provider');
  none.authorities[0]!.providerResult = null;
  assertStale(fixture([none]).resolve);
  for (const kind of ['sealed-local', 'provider'] as const) {
    const item = frame(kind);
    const a = item.authorities[0]!;
    a.callerReservation = a.records.callerReservation;
    a.callerResult = a.records.callerResult;
    assertStale(fixture([item]).resolve);
  }
  // Incomplete pairs do not themselves count as a second complete authority.
  const partial = frame();
  partial.authorities[0]!.providerReservation =
    partial.authorities[0]!.records.reservation;
  const wrongLocal = frame();
  wrongLocal.heads[0] = fault(
    wrongLocal.heads[0]!,
    'record.implementer.assurance',
    'self-declared',
  );
  assertStale(fixture([wrongLocal]).resolve);
  const f = fixture([partial]);
  assert.equal(f.resolve().head?.record, partial.heads[0]!.record);
  assert.deepEqual(f.names(), localReads);
});

test('initial subject construction remains outside the authority catch', () => {
  const item = frame();
  item.transaction = {
    ...item.transaction!,
    red: { ...item.transaction!.red, evidenceNodeId: 'invalid' },
  };
  const f = fixture([item]);
  assert.throws(f.resolve, {
    code: 'TASK_STRATEGY_IMPLEMENTATION_MANIFEST_INVALID',
  });
  assert.deepEqual(f.names(), headReads);
});

test('initial provider predicate rejects each mismatch before durable verifier and preserves exact attempt arguments', () => {
  for (const path of [
    'providerReservation.subject.failureFingerprint',
    'providerResult.output.sourceTree',
    'providerResult.output.patchDigest',
    'providerResult.roleResult.participant.providerId',
  ]) {
    const item = frame('provider');
    item.authorities[0] = fault(
      item.authorities[0]!,
      path,
      path.endsWith('providerId') ? 'codex' : digest('other'),
    );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.equal(f.calls('provider.verify').length, 0);
    assert.deepEqual(f.names(), [
      ...headReads,
      ...initialAuthorityReads,
      'attempt',
      'invocation',
    ]);
  }
  const item = frame('provider');
  const a = item.authorities[0]!;
  const {
    requestDigest: _d,
    schemaVersion: _s,
    roleAssignmentDigest: _r,
    ...input
  } = a.attempt.request;
  const request = createProviderInvocationRequest({
    ...input,
    invocationId: 'invocation-winning-attempt',
    nonce: 'winning-attempt-nonce',
  });
  a.attempt = { ...a.attempt, attempt: 2, request };
  a.providerResult = {
    ...a.providerResult!,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
  };
  a.invocation = {
    ...a.invocation,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
  };
  const f = fixture([item]);
  f.resolve();
  assert.deepEqual(last(f, 'attempt').args, [
    a.providerReservation,
    request.invocationId,
  ]);
  assert.strictEqual(last(f, 'attempt').args[0], a.providerReservation);
  assert.deepEqual(last(f, 'invocation').args, [request.invocationId]);
  const verify = last(f, 'provider.verify').args;
  assert.deepEqual(
    verify[0],
    taskStrategyImplementationReservationForAttempt(a.attempt),
  );
  assert.strictEqual(verify[1], a.invocation);
  assert.strictEqual(verify[2], a.providerResult);
});

test('initial caller enforces output and participant identity and passes canonical verifier objects unchanged', () => {
  for (const [path, value] of [
    ['callerResult.output.sourceTree', 'a'.repeat(40)],
    ['callerResult.output.patchDigest', digest('other')],
    ['callerReservation.assignment.participant.principalId', null],
    [
      'callerReservation.assignment.participant.identityAssurance',
      'maintainer-signed',
    ],
  ] as const) {
    const item = frame('caller-supplied');
    item.authorities[0] = fault(item.authorities[0]!, path, value);
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.equal(f.calls('caller.verify').length, 0);
  }
  for (const field of [
    'providerId',
    'principalId',
    'assurance',
    'degradedForm',
    'grantId',
  ]) {
    const item = frame('caller-supplied');
    item.heads[0] = fault(
      item.heads[0]!,
      `record.implementer.${field}`,
      'other',
    );
    assertStale(fixture([item]).resolve);
  }
  const item = frame('caller-supplied');
  const f = fixture([item]);
  f.resolve();
  const a = item.authorities[0]!;
  const args = last(f, 'caller.verify').args;
  assert.strictEqual(args[0], item.transaction);
  assert.deepEqual(args[1], a.subject);
  assert.strictEqual(args[2], a.callerReservation);
  assert.strictEqual(args[3], a.callerResult);
});

test('failure authentication checks RED and every head digest after candidate lookup', () => {
  for (const path of [
    'currentRedTransactionDigest',
    'currentPatchHead.bindingDigest',
    'currentPatchHead.recordDigest',
    'currentPatchHead.patchDigest',
    'currentPatchHead.receiptDigest',
  ]) {
    const item = frame('sealed-local', 0, true);
    const tree = item.heads[0]!.record.candidateTree;
    item.failures.set(
      tree,
      fault(item.failures.get(tree)!, path, digest('other')),
    );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names(), localReads);
    assert.deepEqual(last(f, 'failure').args, [
      item.base.session.sessionId,
      tree,
    ]);
  }
  const item = frame('sealed-local', 1);
  item.failures.set(item.heads[0]!.record.candidateTree, null);
  assertStale(fixture([item]).resolve);
});

test('round reservation rejects each continuity mismatch with no successor-head observation', () => {
  const fields = [
    'round',
    'redSourceTree',
    'correctionSubjectDigest',
    'predecessorFailure.recordDigest',
    'predecessorFailure.subjectDigest',
    'predecessorFailure.candidateTree',
    'predecessorFailure.currentPatchHead.bindingDigest',
    'predecessorFailure.currentPatchHead.recordDigest',
    'predecessorFailure.currentPatchHead.patchDigest',
    'predecessorFailure.currentPatchHead.receiptDigest',
  ];
  for (const field of fields) {
    const item = frame('sealed-local', 1);
    item.rounds[0] = fault(
      item.rounds[0]!,
      `reservation.${field}`,
      field === 'round' ? 2 : digest('other'),
    );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names(), localReads, field);
  }
});

test('pending round only at tail derives exact failure/policy and skips the unreserved-patch probe', () => {
  for (const nextAction of [
    'publish-result',
    'publish-import-receipt',
  ] as const) {
    const item = frame('sealed-local', 1);
    const original = item.rounds[0]!;
    item.rounds[0] = {
      ...original,
      importRecord: null,
      result: nextAction === 'publish-result' ? null : original.result,
    };
    item.derived = {
      state: 'correction-required',
      round: 1,
      nextAction,
      correctionSubjectDigest: original.reservation.correctionSubjectDigest,
    };
    const f = fixture([item]);
    const result = f.resolve();
    assert.strictEqual(result.correctionState, item.derived);
    assert.equal(result.completedCorrectionRounds, 0);
    assert.equal(result.exhausted, false);
    assert.deepEqual(f.names(), [...localReads, 'derive']);
    assert.strictEqual(
      last(f, 'derive').args[0],
      item.failures.get(item.heads[0]!.record.candidateTree),
    );
    assert.strictEqual(last(f, 'derive').args[1], POLICY);
  }
  const bad = frame('sealed-local', 2);
  bad.rounds[0] = { ...bad.rounds[0]!, importRecord: null };
  assertStale(fixture([bad]).resolve);
  const exhausted = frame('sealed-local', 1);
  exhausted.rounds[0] = { ...exhausted.rounds[0]!, importRecord: null };
  exhausted.derived = {
    state: 'correction-exhausted',
    completedRounds: 1,
    reason: 'max-repair-attempts',
    failureRecordDigest: digest('failure'),
  };
  const f = fixture([exhausted]);
  assert.equal(f.resolve().exhausted, true);
  assert.deepEqual(f.names(), [...localReads, 'derive']);
});

test('imported round reads successor head before rejecting null result or each patch relationship', () => {
  const paths = [
    'result.patchResult.sourceTree',
    'result.patchResult.targetCandidateTree',
    'result.patchResult.patchRecordDigest',
    'result.patchResult.patchDigest',
    'importRecord.currentPatchHead.bindingDigest',
    'importRecord.currentPatchHead.recordDigest',
    'importRecord.currentPatchHead.patchDigest',
    'importRecord.currentPatchHead.receiptDigest',
  ];
  for (const path of ['result', ...paths]) {
    const item = frame('sealed-local', 1);
    item.rounds[0] = fault(
      item.rounds[0]!,
      path,
      path === 'result' ? null : digest('other'),
    );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(
      f.names(),
      [...localReads, 'binding', 'record', 'receipt'],
      path,
    );
  }
  const item = frame('sealed-local', 1);
  item.missingBindings.add(item.sources[1]!);
  const f = fixture([item]);
  assertStale(f.resolve);
  assert.deepEqual(f.names(), [...localReads, 'binding']);
});

test('local imported correction requires single-agent strategy and exact RED author/implementer', () => {
  for (const which of ['author', 'implementer', 'strategy']) {
    const item = frame('sealed-local', 1);
    if (which === 'author')
      item.rounds[0] = fault(
        item.rounds[0]!,
        'result.authority.author.providerId',
        'claude',
      );
    if (which === 'implementer')
      item.heads[1] = fault(
        item.heads[1]!,
        'record.implementer.assurance',
        'self-declared',
      );
    if (which === 'strategy') {
      // Keep a valid initial cross-agent head but return a sealed-local round.
      const other = frame('provider', 1);
      other.rounds[0] = {
        ...other.rounds[0]!,
        result: {
          ...other.rounds[0]!.result!,
          authority: {
            kind: 'sealed-local',
            author: other.transaction!.author,
          },
        },
      };
      assertStale(fixture([other]).resolve);
      continue;
    }
    assertStale(fixture([item]).resolve);
  }
});

test('provider correction checks every root, winning-attempt and result authority field', () => {
  const fields = [
    'providerReservation.reservationDigest',
    'providerRequest.ownerInvestigationId',
    'providerReservation.authorizationNodeId',
    'providerReservation.reservationNodeId',
    'providerRequest.invocationId',
    'providerRequest.requestDigest',
    'providerAttempt.attempt',
    'providerAttempt.attemptReservationDigest',
    'providerAttempt.invocationId',
    'providerAttempt.requestDigest',
    'providerResult.bindingDigest',
    'providerResult.invocationId',
    'providerResult.requestDigest',
    'providerResult.outputDigest',
    'providerResult.providerResultNodeId',
    'providerResult.providerResultDigest',
  ];
  for (const field of fields) {
    const item = frame('provider', 1);
    const value = field === 'providerAttempt.attempt' ? 2 : digest('other');
    item.rounds[0] = fault(item.rounds[0]!, `result.authority.${field}`, value);
    // Keep the reservation/result projection equal so each later field check
    // is exercised, rather than failing the first canonical comparison.
    if (
      field.startsWith('providerReservation.') ||
      field.startsWith('providerRequest.')
    )
      item.rounds[0] = fault(
        item.rounds[0]!,
        `reservation.authority.${field}`,
        value,
      );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.equal(f.calls('provider.verify').length, 1, field);
    assert.equal(f.events.at(-1)!.name, 'invocation', field);
  }
  for (const path of [
    'providerReservation.subject.failureFingerprint',
    'providerResult.output.sourceTree',
    'providerResult.output.patchDigest',
    'providerResult.roleResult.participant.providerId',
  ]) {
    const item = frame('provider', 1);
    item.authorities[1] = fault(
      item.authorities[1]!,
      path,
      path.endsWith('providerId') ? 'codex' : digest('other'),
    );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.equal(f.calls('provider.verify').length, 1, path);
  }
  const unequal = frame('provider', 1);
  unequal.rounds[0] = fault(
    unequal.rounds[0]!,
    'reservation.authority.providerRequest.requestDigest',
    digest('other'),
  );
  assertStale(fixture([unequal]).resolve);
  for (const path of ['providerReservation', 'providerResult'] as const) {
    const item = frame('provider', 1);
    item.authorities[1]![path] = null;
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names().slice(-2), [
      'provider.reservation',
      'provider.result',
    ]);
    assert.equal(f.calls('attempt').length, 1);
  }
  const kind = frame('provider', 1);
  kind.rounds[0] = fault(
    kind.rounds[0]!,
    'reservation.authority.kind',
    'caller-supplied',
  );
  const f = fixture([kind]);
  assertStale(f.resolve);
  assert.equal(f.events.at(-1)!.name, 'receipt');
});

test('provider correction verifies the winning binding attempt rather than root request', () => {
  const item = frame('provider', 1);
  const a = item.authorities[1]!;
  const {
    requestDigest: _d,
    schemaVersion: _s,
    roleAssignmentDigest: _r,
    ...input
  } = a.attempt.request;
  const request = createProviderInvocationRequest({
    ...input,
    invocationId: 'invocation-correction-winning',
    nonce: 'correction-winning-nonce',
  });
  // Exact-attempt selection is an injected producer responsibility. This
  // control uses its returned attempt plus a canonical changed request; real
  // retry reservation legality is covered by provider retry integration.
  a.attempt = {
    ...a.attempt,
    attempt: 2,
    previousInvocationId: a.attempt.request.invocationId,
    request,
  };
  a.providerResult = {
    ...a.providerResult!,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
  };
  a.invocation = {
    ...a.invocation,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
  };
  item.rounds[0] = roundFor(
    item.base,
    item.failures.get(item.heads[0]!.record.candidateTree)!,
    item.heads[1]!,
    a,
    1,
    'provider',
  );
  const f = fixture([item]);
  assert.equal(f.resolve().completedCorrectionRounds, 1);
  assert.deepEqual(last(f, 'attempt').args, [
    a.providerReservation,
    request.invocationId,
  ]);
  assert.deepEqual(last(f, 'invocation').args, [request.invocationId]);
  assert.deepEqual(
    last(f, 'provider.verify').args[0],
    taskStrategyImplementationReservationForAttempt(a.attempt),
  );
  assert.strictEqual(last(f, 'provider.verify').args[1], a.invocation);
  assert.strictEqual(last(f, 'provider.verify').args[2], a.providerResult);
});

test('caller correction checks every reservation, result and grant-use authority field', () => {
  const fields = [
    'callerReservation.reservationDigest',
    'callerReservation.grantId',
    'callerReservation.transitionDigest',
    'callerReservation.submissionNodeId',
    'callerReservation.submissionResultDigest',
    'callerResult.bindingDigest',
    'callerResult.resultNodeId',
    'callerResult.resultDigest',
    'callerResult.roleResultDigest',
    'callerResult.grantUseDigest',
  ];
  for (const field of fields) {
    const item = frame('caller-supplied', 1);
    item.rounds[0] = fault(
      item.rounds[0]!,
      `result.authority.${field}`,
      digest('other'),
    );
    if (field.startsWith('callerReservation.'))
      item.rounds[0] = fault(
        item.rounds[0]!,
        `reservation.authority.${field}`,
        digest('other'),
      );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.equal(f.calls('caller.verify').length, 1, field);
    assert.equal(f.events.at(-1)!.name, 'caller.result', field);
  }
  const fieldsAndValues: [string, unknown][] = [
    ['callerReservation.subjectDigest', digest('other')],
    ['callerResult.roleResult.grantUse', null],
    ['callerResult.output.sourceTree', 'a'.repeat(40)],
    ['callerResult.output.patchDigest', digest('other')],
    ['callerReservation.assignment.participant.principalId', null],
    [
      'callerReservation.assignment.participant.identityAssurance',
      'maintainer-signed',
    ],
  ];
  for (const [path, value] of fieldsAndValues) {
    const item = frame('caller-supplied', 1);
    item.authorities[1] = fault(item.authorities[1]!, path, value);
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.equal(f.calls('caller.verify').length, 1, path);
  }
  for (const field of [
    'providerId',
    'principalId',
    'assurance',
    'degradedForm',
    'grantId',
  ]) {
    const item = frame('caller-supplied', 1);
    item.heads[1] = fault(
      item.heads[1]!,
      `record.implementer.${field}`,
      'other',
    );
    assertStale(fixture([item]).resolve);
  }
  const unequal = frame('caller-supplied', 1);
  unequal.rounds[0] = fault(
    unequal.rounds[0]!,
    'reservation.authority.callerReservation.transitionDigest',
    digest('other'),
  );
  assertStale(fixture([unequal]).resolve);
  for (const path of ['callerReservation', 'callerResult'] as const) {
    const item = frame('caller-supplied', 1);
    item.authorities[1]![path] = null;
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names().slice(-2), [
      'caller.reservation',
      'caller.result',
    ]);
  }
  const kind = frame('caller-supplied', 1);
  kind.rounds[0] = fault(
    kind.rounds[0]!,
    'reservation.authority.kind',
    'provider',
  );
  const bad = fixture([kind]);
  assertStale(bad.resolve);
  assert.equal(bad.events.at(-1)!.name, 'receipt');
  const item = frame('caller-supplied', 1);
  const f = fixture([item]);
  f.resolve();
  const a = item.authorities[1]!;
  assert.strictEqual(last(f, 'caller.verify').args[0], item.transaction);
  assert.deepEqual(last(f, 'caller.verify').args[1], a.subject);
  assert.strictEqual(last(f, 'caller.verify').args[2], a.callerReservation);
  assert.strictEqual(last(f, 'caller.verify').args[3], a.callerResult);
});

test('failure-null only terminates the last round; continuation derives from the latest failure', () => {
  const early = frame('sealed-local', 2);
  early.failures.set(early.heads[1]!.record.candidateTree, null);
  const bad = fixture([early]);
  assertStale(bad.resolve);
  assert.equal(bad.calls('derive').length, 0);
  assert.deepEqual(
    bad.calls('binding').map((e) => e.args[1]),
    early.sources.slice(0, 2),
  );
  const item = frame('sealed-local', 2, true);
  const f = fixture([item]);
  const result = f.resolve();
  assert.equal(result.completedCorrectionRounds, 2);
  assert.strictEqual(
    result.failure,
    item.failures.get(item.heads[2]!.record.candidateTree),
  );
  assert.strictEqual(last(f, 'derive').args[0], result.failure);
  assert.strictEqual(last(f, 'derive').args[1], POLICY);
  assert.deepEqual(
    f.calls('failure').map((e) => e.args[1]),
    item.heads.map((h) => h.record.candidateTree),
  );
  assert.equal(f.calls('derive').length, 1);
  assert.equal(
    f.calls('binding').at(-1)!.args[1],
    item.heads[2]!.record.candidateTree,
  );
});

test('final derive keeps its fresh result and probes unreserved bindings only for reserve or exhausted', () => {
  for (const action of [
    'reserve',
    'publish-result',
    'publish-import-receipt',
    'exhausted',
  ] as const) {
    for (const unreserved of [false, true]) {
      const item = frame('sealed-local', 0, true);
      const failure = item.failures.get(item.heads[0]!.record.candidateTree)!;
      const updated: TaskStrategyCorrectionState =
        action === 'exhausted'
          ? {
              state: 'correction-exhausted',
              completedRounds: 2,
              reason: 'same-failure-fingerprint',
              failureRecordDigest: failure.recordDigest,
            }
          : action === 'reserve'
            ? { state: 'correction-required', round: 1, nextAction: action }
            : {
                state: 'correction-required',
                round: 1,
                nextAction: action,
                correctionSubjectDigest: digest('subject'),
              };
      if (unreserved) {
        item.heads.push(
          headFor(
            item.base,
            failure.candidateTree,
            1,
            'sealed-local',
            item.authorities[0]!,
          ),
        );
        item.sources.push(failure.candidateTree);
      }
      const f = fixture([item]);
      // The durable derive producer is a distinct later observation. Its state
      // must be used even when it differs from the earlier listed-round view.
      f.state.onEvent = (e) => {
        if (e.name === 'derive') item.derived = updated;
      };
      if (unreserved && (action === 'reserve' || action === 'exhausted'))
        assertStale(f.resolve);
      else {
        const result = f.resolve();
        assert.strictEqual(result.correctionState, updated);
        assert.equal(result.exhausted, action === 'exhausted');
      }
      assert.equal(
        f.calls('binding').length,
        action === 'reserve' || action === 'exhausted' ? 2 : 1,
      );
      assert.strictEqual(last(f, 'derive').args[0], failure);
    }
  }
});

test('authority omission and explicit undefined run the real resolver; explicit projection avoids it', () => {
  for (const supplied of [false, true]) {
    const f = fixture();
    const result = supplied
      ? f.service.resolveCurrentTaskStrategyImplementationAuthority(
          f.inspection,
          undefined,
        )
      : f.service.resolveCurrentTaskStrategyImplementationAuthority(
          f.inspection,
        );
    assert.deepEqual(f.names(), localReads);
    assert.deepEqual(result.subject, f.frames[0]!.base.initialSubject);
    assert.equal(result.greenFailureRecord, null);
    assert.equal(Object.isFrozen(result), true);
  }
  const item = frame();
  const projection: TaskStrategyCorrectionProjection = {
    transaction: item.transaction!,
    head: null,
    failure: null,
    completedCorrectionRounds: 0,
    exhausted: false,
    correctionState: null,
  };
  const f = fixture([item]);
  // Explicit projections do not add a new applicability gate against inspection.
  f.inspection.contract.execution = undefined;
  f.authority(projection);
  assert.deepEqual(f.events, []);
  const failure = failureFor(item.base, item.heads[0]!);
  const pending = { ...projection, failure, completedCorrectionRounds: 2 };
  const result = f.authority(pending);
  assert.deepEqual(f.events, []);
  assert.equal(result.subject.correction?.round, 3);
  assert.strictEqual(result.greenFailureRecord, failure);
});

test('completed authority freshly reads originating source-tree failure and retains completed round number', () => {
  const item = frame('provider', 1);
  const resolver = fixture([item]);
  const projection = resolver.resolve();
  const fresh = frame('provider', 1);
  const f = fixture([fresh]);
  const result = f.authority(projection);
  const source = projection.head!.record.sourceTree;
  assert.notEqual(source, projection.head!.record.candidateTree);
  assert.deepEqual(f.names(), ['observe', 'failure']);
  assert.deepEqual(last(f, 'failure').args, [
    f.inspection.session.sessionId,
    source,
  ]);
  assert.strictEqual(result.greenFailureRecord, fresh.failures.get(source));
  assert.equal(result.subject.correction?.round, 1);
  assertStale(() => fixture([fresh]).authority({ ...projection, head: null }));
  fresh.failures.set(source, null);
  assertStale(() => fixture([fresh]).authority(projection));
  const bad = fixture([item]);
  bad.state.failAt = 'failure';
  assert.throws(
    () => bad.authority(projection),
    (e) => e === bad.state.sentinel,
  );
});

test('read-current failure executes actual projection and returns the original failure reference', () => {
  const item = frame('sealed-local', 1, true);
  const f = fixture([item]);
  assert.strictEqual(
    f.read(),
    item.failures.get(item.heads[1]!.record.candidateTree),
  );
  assert.equal(f.calls('transaction').length, 1);
  assert.equal(f.calls('rounds').length, 1);
});

test('recording reobserves a different journal but writes the first transaction digest through its first journal', () => {
  const first = frame();
  const next = frame();
  first.transaction = {
    ...first.transaction!,
    recordDigest: digest('first-observation'),
  };
  next.heads[0] = fault(next.heads[0]!, 'record.candidateTree', 'b'.repeat(40));
  next.heads[0] = fault(
    next.heads[0]!,
    'binding.candidateTree',
    'b'.repeat(40),
  );
  next.heads[0] = fault(
    next.heads[0]!,
    'receipt.candidateTree',
    'b'.repeat(40),
  );
  const f = fixture([first, next], true);
  const result = f.record();
  assert.ok(result);
  assert.strictEqual(result, f.state.returned);
  assert.equal(
    result.currentRedTransactionDigest,
    first.transaction.recordDigest,
  );
  assert.equal(result.candidateTree, next.heads[0]!.record.candidateTree);
  assert.deepEqual(result.currentPatchHead, patchIdentity(next.heads[0]!));
  assert.deepEqual(f.names(), [
    'observe',
    'transaction',
    ...localReads,
    'pin',
    'clock',
    'write',
  ]);
  assert.equal(last(f, 'write').frame, 0);
  assert.deepEqual(
    f.calls('transaction').map((e) => e.frame),
    [0, 1],
  );
  for (const e of f.calls('observe'))
    assert.deepEqual(e.args, [
      f.inspection.git.gitCommonDirectory,
      f.inspection.contract.config.runtimeDirectory,
    ]);
});

test('provider and caller round helpers reject a single-agent transaction before external authority reads', () => {
  for (const kind of ['provider', 'caller-supplied'] as const) {
    const item = frame('sealed-local', 1);
    const failure = item.failures.get(item.heads[0]!.record.candidateTree)!;
    const authority = authorityFacts(
      item.base,
      item.authorities[1]!.subject,
      kind,
      failure,
    );
    item.authorities[1] = authority;
    item.heads[1] = headFor(
      item.base,
      failure.candidateTree,
      1,
      kind,
      authority,
    );
    item.rounds[0] = roundFor(
      item.base,
      failure,
      item.heads[1]!,
      authority,
      1,
      kind,
    );
    const f = fixture([item]);
    assertStale(f.resolve);
    assert.deepEqual(f.names(), [
      ...localReads,
      'binding',
      'record',
      'receipt',
    ]);
  }
});

test('recording applicability, exact GREEN membership and current-head guards precede pins, clock and writes', () => {
  for (const faultName of ['strategy', 'check', 'head', 'failure'] as const) {
    const first = frame();
    const next = frame('sealed-local', 0, faultName === 'failure');
    if (faultName === 'strategy')
      first.transaction = {
        ...first.transaction!,
        strategy: 'cross-agent-tdd',
      };
    if (faultName === 'head') next.missingBindings.add(next.sources[0]!);
    const f = fixture([first, next], true);
    const failing =
      faultName === 'check'
        ? { ...first.base.failure.failingCheck, checkId: 'undeclared' }
        : first.base.failure.failingCheck;
    assertStale(() => f.record([], failing));
    assert.equal(f.calls('pin').length, 0);
    assert.equal(f.calls('clock').length, 0);
    assert.equal(f.calls('write').length, 0);
    if (faultName === 'strategy' || faultName === 'check')
      assert.deepEqual(f.names(), ['observe', 'transaction']);
    else assert.equal(f.calls('observe').length, 2);
  }
});

function twoChecks(item: Frame, first = 'first') {
  item.base.inspection.contract.execution!.tasks[item.base.session.taskId] = {
    ...item.base.task,
    greenChecks: [first, 'unit'],
  };
  item.base.inspection.contract.checks.checks[first] = {
    command: ['node', `${first}.mjs`],
    destructiveDatabase: false,
  };
  const passed: CheckEvidence = {
    checkId: first,
    outcome: 'passed',
    exitCode: 0,
    runner: 'node',
    runnerDigest: digest('runner'),
    destructiveDatabase: false,
    completedAt: NOW,
  };
  return passed;
}

test('recorder pins every GREEN definition in declaration order before comparing failing or passed runner identities', () => {
  for (const mismatch of ['failing', 'passed', 'membership'] as const) {
    const item = frame();
    const passed = twoChecks(item);
    const f = fixture([item], true);
    const failing =
      mismatch === 'failing'
        ? { ...item.base.failure.failingCheck, runnerDigest: digest('other') }
        : item.base.failure.failingCheck;
    const evidence =
      mismatch === 'passed'
        ? { ...passed, runnerDigest: digest('other') }
        : mismatch === 'membership'
          ? { ...passed, checkId: 'undeclared' }
          : passed;
    assertStale(() => f.record([evidence], failing));
    assert.deepEqual(
      f.calls('pin').map((e) => e.args[1]),
      ['first', 'unit'],
    );
    assert.equal(f.calls('clock').length, 0);
    assert.equal(f.calls('write').length, 0);
    for (const e of f.calls('pin')) {
      assert.equal(e.args[0], item.base.inspection.git.repositoryRoot);
      assert.strictEqual(
        e.args[2],
        item.base.inspection.contract.checks.checks[e.args[1] as string],
      );
    }
  }
  const item = frame();
  twoChecks(item);
  delete item.base.inspection.contract.checks.checks.unit;
  const f = fixture([item], true);
  assertStale(f.record);
  assert.deepEqual(
    f.calls('pin').map((e) => e.args[1]),
    ['first'],
  );
  assert.equal(f.calls('clock').length, 0);
});

test('a later pin exception wins over an earlier mismatched digest', () => {
  const item = frame();
  const passed = twoChecks(item);
  const f = fixture([item], true);
  const pin: CheckRunnerPin = (...args) => {
    const result = f.pin(...args);
    if (args[1] === 'unit') throw f.state.sentinel;
    return { ...result, digest: digest('earlier-wrong-runner') };
  };
  assert.throws(
    () =>
      f.service.recordTaskStrategyGreenFailure(
        pin,
        f.inspection,
        [passed],
        item.base.failure.failingCheck,
      ),
    (e) => e === f.state.sentinel,
  );
  assert.deepEqual(
    f.calls('pin').map((e) => e.args[1]),
    ['first', 'unit'],
  );
  assert.equal(f.calls('clock').length, 0);
  assert.equal(f.calls('write').length, 0);
});

test('record write keeps exact canonical input, original evidence references and deliberate shallow freezes', () => {
  const item = frame();
  const passed = twoChecks(item);
  const passedChecks = [passed];
  const failing = item.base.failure.failingCheck;
  const f = fixture([item], true);
  const result = f.record(passedChecks, failing);
  assert.ok(result);
  const input = last(f, 'write').args[0] as TaskStrategyGreenFailureInput;
  assert.strictEqual(result, f.state.returned);
  assert.strictEqual(input.failingCheck, failing);
  assert.notStrictEqual(input.passedChecks, passedChecks);
  assert.equal(Object.isFrozen(input.passedChecks), true);
  assert.strictEqual(input.passedChecks[0], passed);
  assert.equal(Object.isFrozen(passed), false);
  assert.deepEqual(
    input.checkDefinitions.map((d) => d.checkId),
    ['first', 'unit'],
  );
  for (const definition of input.checkDefinitions) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.definition), true);
    assert.equal(Object.isFrozen(definition.definition.command), true);
    assert.notStrictEqual(
      definition.definition.command,
      item.base.inspection.contract.checks.checks[definition.checkId]!.command,
    );
    assert.deepEqual(
      definition.definition,
      item.base.inspection.contract.checks.checks[definition.checkId],
    );
    assert.equal(definition.runner, 'node');
    assert.equal(definition.runnerDigest, digest('runner'));
  }
  assert.deepEqual(input.currentPatchHead, patchIdentity(item.heads[0]!));
  assert.equal(input.candidateTree, item.heads[0]!.record.candidateTree);
  assert.equal(
    input.currentRedTransactionDigest,
    item.transaction!.recordDigest,
  );
  assert.equal(input.sessionId, item.base.session.sessionId);
  assert.equal(input.createdAt, NOW);
  assert.deepEqual(f.names().slice(-3), ['pin', 'clock', 'write']);
  assert.equal(f.calls('clock').length, 1);
  assert.equal(f.calls('write').length, 1);
});

test('canonical writer rejects invalid ordered evidence without inventing admission in the memory port', () => {
  const item = frame();
  const passed = twoChecks(item);
  const f = fixture([item], true);
  // Duplicate passed records have valid runner identity but are not an admitted
  // ordered prefix. Use the real pure preparation/parser in the writer.
  assert.throws(() => f.record([passed, passed]), {
    code: 'TASK_STRATEGY_GREEN_FAILURE_STATE_INVALID',
  });
  assert.equal(f.calls('clock').length, 1);
  assert.equal(f.calls('write').length, 1);
});

test('every query port failure observes the exact original catch boundary and stops immediately', () => {
  const caught = new Set([
    ...initialAuthorityReads,
    'attempt',
    'invocation',
    'provider.verify',
    'caller.verify',
  ]);
  for (const kind of ['sealed-local', 'provider', 'caller-supplied'] as const) {
    const item = frame(kind, 1, true);
    const good = fixture([item]);
    good.resolve();
    for (const [index, e] of good.events.entries()) {
      const f = fixture([item]);
      f.state.failAt = e.name;
      f.state.failOccurrence = good.events
        .slice(0, index + 1)
        .filter((prior) => prior.name === e.name).length;
      if (caught.has(e.name)) assertStale(f.resolve, f.state.sentinel);
      else assert.throws(f.resolve, (error) => error === f.state.sentinel);
      assert.deepEqual(
        f.names(),
        good.names().slice(0, index + 1),
        `${kind}:${index}:${e.name}`,
      );
    }
  }
});

test('every recording port failure preserves ordering and unwrapped clock, pin and writer errors', () => {
  const item = frame();
  const good = fixture([item], true);
  good.record();
  for (const [index, e] of good.events.entries()) {
    const f = fixture([item], true);
    f.state.failAt = e.name;
    f.state.failOccurrence = good.events
      .slice(0, index + 1)
      .filter((prior) => prior.name === e.name).length;
    if (initialAuthorityReads.includes(e.name))
      assertStale(f.record, f.state.sentinel);
    else assert.throws(f.record, (error) => error === f.state.sentinel);
    assert.deepEqual(
      f.names(),
      good.names().slice(0, index + 1),
      `${index}:${e.name}`,
    );
  }
});
