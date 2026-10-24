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
import { createTaskStrategyLifecycle } from '../src/application/execute-task/task-strategy-lifecycle.ts';
import type {
  TaskStrategyLifecycleOperations,
  TaskStrategyLifecycleJournal,
  ResumeTaskStrategyOptions,
} from '../src/application/execute-task/task-strategy-lifecycle-operations.ts';
import type { TaskStrategyImplementationStatus } from '../src/application/execute-task/task-strategy-implementation-lifecycle.ts';
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

const NOW = '2026-09-23T01:00:00.000Z';
const CREATED_AT = NOW;
const ROOT = '/memory/task-strategy';
const GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROLE_RESULT_SCHEMA = 'admitted-role-result.v1';
const hash = (value: unknown) => digest(canonicalJson(value));
const unexpected = (): never => {
  throw new Error('unexpected capability');
};
const STALE = { code: 'TASK_STRATEGY_LIFECYCLE_STALE' };

// Complete typed wire fixtures use pure canonical builders. No store, Git,
// production binding or whole-use-case substitute participates in these tests.
function frame(options: { single?: boolean; correction?: boolean } = {}) {
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

type Frame = ReturnType<typeof frame>;
type Event = { name: string; args: unknown[]; frame: number; journal?: number };
const transitions = [
  'mechanical.resume',
  'red.seal',
  'red.beginRevision',
  'red.continueRevision',
  'adopt.implementation',
  'adopt.correction',
  'implementation.begin',
] as const;
type Transition = (typeof transitions)[number];

// Every actual inspect selects a fresh frame. Journal readers capture that
// observation, while begin can replace the frame for the separate late read.
// All transitions are forbidden by default, including in every inspect case.
function fixture(
  frames: Frame[] = [frame()],
  allowed: readonly Transition[] = [],
) {
  const events: Event[] = [];
  let index = -1;
  let journalId = 0;
  let observed = frames[0]!;
  const state: {
    failAt?: string;
    failOccurrence: number;
    sentinel: Error;
    forbiddenReads: Set<string>;
    lateFrame?: Frame;
    seal: TaskStrategyTransaction;
    adopted: ImportedTaskStrategyPatch | null;
    advanced: TaskStrategyImplementationStatus;
  } = {
    failOccurrence: 1,
    sentinel: new Error('injected port failure'),
    forbiddenReads: new Set(),
    seal: frames[0]!.projection.transaction,
    adopted: null,
    advanced: {
      state: 'ready',
      sessionId: frames[0]!.session.sessionId,
      subject: frames[0]!.authority.subject,
    },
  };
  const emit = (name: string, args: unknown[], journal?: number) => {
    events.push({
      name,
      args,
      frame: index,
      ...(journal === undefined ? {} : { journal }),
    });
    if (state.forbiddenReads.has(name))
      throw new Error(`unexpected reader: ${name}`);
    if (
      state.failAt === name &&
      events.filter((e) => e.name === name).length === state.failOccurrence
    )
      throw state.sentinel;
  };
  const command = (name: Transition, args: unknown[]) => {
    emit(name, args);
    if (!allowed.includes(name))
      throw new Error(`unexpected transition: ${name}`);
  };
  const operations: TaskStrategyLifecycleOperations = {
    session: {
      read(...args) {
        index += 1;
        observed = frames[Math.min(index, frames.length - 1)]!;
        emit('session.read', args);
        return observed.session;
      },
      discoverRepository(...args) {
        emit('repository.discover', args);
        return observed.git;
      },
      loadStableContract(...args) {
        emit('contract.load', args);
        return {
          git: observed.git,
          contract: observed.inspection.contract,
          get consumedPlanReviewReplay() {
            return unexpected();
          },
          get planningAssurance() {
            return unexpected();
          },
          get planningPaths() {
            return unexpected();
          },
          readSystemDescription: unexpected,
        };
      },
      inspect(...args) {
        emit('session.inspect', args);
        return observed.inspection;
      },
      resolveCorrection(...args) {
        emit('correction.resolve', args);
        return observed.projection;
      },
      resolveImplementationAuthority(...args) {
        emit('authority.resolve', args);
        return observed.authority;
      },
    },
    observeJournal(...args) {
      const current = observed;
      const id = ++journalId;
      emit('journal.observe', args, id);
      return {
        correction: {
          readTransaction(...args) {
            emit('transaction.read', args, id);
            return current.transaction;
          },
        },
        implementation: {
          readReservation(...args) {
            emit('provider.reservation', args, id);
            return current.reservation;
          },
          readCallerReservation(...args) {
            emit('caller.reservation', args, id);
            return current.callerReservation;
          },
          readCallerResult(...args) {
            emit('caller.result', args, id);
            return current.callerResult;
          },
          readCurrentAttempt(...args) {
            emit('provider.attempt', args, id);
            return current.attempt;
          },
          readResult(...args) {
            emit('provider.result', args, id);
            return current.result;
          },
        },
        provider: {
          exists(...args) {
            emit('invocation.exists', args, id);
            return current.invocationExists;
          },
          read(...args) {
            emit('invocation.read', args, id);
            return current.invocation;
          },
        },
      } satisfies TaskStrategyLifecycleJournal;
    },
    mechanical: {
      inspect(...args) {
        emit('mechanical.inspect', args);
        return observed.mechanical;
      },
      resume(...args) {
        command('mechanical.resume', args);
      },
    },
    red: {
      seal(...args) {
        command('red.seal', args);
        return state.seal;
      },
      beginRevision(...args) {
        command('red.beginRevision', args);
      },
      continueRevision(...args) {
        command('red.continueRevision', args);
      },
    },
    adopt: {
      implementation(...args) {
        command('adopt.implementation', args);
        return state.adopted;
      },
      correction(...args) {
        command('adopt.correction', args);
        return state.adopted;
      },
    },
    implementation: {
      beginTaskStrategyImplementation(...args) {
        command('implementation.begin', args);
        if (state.lateFrame !== undefined) observed = state.lateFrame;
        return state.advanced;
      },
    },
    readProviderRetryAccountingEvidence: unexpected,
  };
  const lifecycle = createTaskStrategyLifecycle(operations);
  return {
    operations,
    lifecycle,
    events,
    state,
    frames,
    inspect: () =>
      lifecycle.inspectTaskStrategyLifecycle(ROOT, 'requested-session'),
    resume: (options?: ResumeTaskStrategyOptions) =>
      lifecycle.resumeTaskStrategy(ROOT, 'requested-session', options),
    names: () => events.map((e) => e.name),
    calls: (name: string) => events.filter((e) => e.name === name),
  };
}
const baseReads = ['session.read', 'journal.observe', 'transaction.read'];
const contractReads = [...baseReads, 'repository.discover', 'contract.load'];
const tddReads = [
  ...contractReads,
  'session.inspect',
  'correction.resolve',
  'authority.resolve',
];
const crossReads = [
  ...tddReads,
  'provider.reservation',
  'caller.reservation',
  'caller.result',
];
function event(f: ReturnType<typeof fixture>, name: string) {
  const found = f.calls(name).at(-1);
  assert.ok(found, `missing ${name}`);
  return found;
}
function setTask(f: Frame, task: ExecutionTask | undefined) {
  assert.ok(f.inspection.contract.execution);
  f.inspection.contract.execution.tasks =
    task === undefined ? {} : { [f.session.taskId]: task };
  f.transaction = null;
  return f;
}
function direct() {
  const f = frame();
  return setTask(f, {
    strategy: 'direct-reviewed',
    enforcement: 'planned',
    diffReview: 'required',
    allowedPaths: ['docs/**'],
    requiredChecks: [],
    exemptionKind: 'documentation-only',
    exemptionReason: 'Documentation fixture',
  });
}
function mechanical() {
  const f = frame();
  return setTask(f, {
    strategy: 'mechanical-transform',
    enforcement: 'planned',
    diffReview: 'required',
    allowedPaths: ['src/**'],
    requiredChecks: [],
    transformationContract: {
      rule: 'Rename symbol',
      examples: [{ before: 'old', after: 'new' }],
      fileScopes: ['src/**'],
      oldTerms: [],
      replacementTerms: [],
      retainedDispositions: [],
      redInapplicableReason: 'Mechanical rename',
    },
  });
}
function red() {
  const f = frame();
  f.transaction = null;
  return f;
}
function provider(state: ProviderInvocationRecord['state'] = 'prepared') {
  const f = frame();
  f.reservation = f.records.reservation;
  f.invocationExists = true;
  f.invocation.state = state;
  return f;
}
function imported(single = false, correction = false) {
  const f = frame({ single, correction });
  f.projection = {
    ...f.projection,
    head: f.imported,
    completedCorrectionRounds: correction ? 1 : 0,
  };
  if (!single) {
    f.callerReservation = f.records.callerReservation;
    f.callerResult = f.records.callerResult;
  }
  return f;
}
function exhausted() {
  const f = frame();
  f.projection = { ...f.projection, exhausted: true };
  return f;
}
function correction(single = true) {
  const f = frame({ single, correction: true });
  f.projection = { ...f.projection, failure: f.failure, head: f.imported };
  return f;
}
function revision(f: Frame): TaskStrategyRedRevisionRequest {
  return {
    schemaVersion: 1,
    kind: 'task-strategy-red-revision-request',
    sessionId: f.session.sessionId,
    expectedTransactionDigest: f.projection.transaction.recordDigest,
    reason: 'Reproduce corrected scenario',
  };
}
function assertWire(
  status: ReturnType<ReturnType<typeof fixture>['inspect']>,
  expected: string,
) {
  assert.equal(status.state, expected);
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.kind, 'task-strategy-lifecycle-status.v1');
  assert.equal(Object.isFrozen(status), true);
}

test('construction is lazy, instances are isolated, and all seven transition guards reject calls', () => {
  const a = fixture();
  const b = fixture([red()]);
  assert.deepEqual(a.events, []);
  assert.deepEqual(b.events, []);
  const o = a.operations;
  const f = a.frames[0]!;
  const probes: Record<Transition, () => unknown> = {
    'mechanical.resume': () => o.mechanical.resume(ROOT, f.session.sessionId),
    'red.seal': () => o.red.seal(ROOT, f.session.sessionId, {}),
    'red.beginRevision': () => o.red.beginRevision(ROOT, revision(f)),
    'red.continueRevision': () =>
      o.red.continueRevision(ROOT, f.session.sessionId),
    'adopt.implementation': () =>
      o.adopt.implementation(ROOT, f.session.sessionId),
    'adopt.correction': () => o.adopt.correction(ROOT, f.session.sessionId),
    'implementation.begin': () =>
      o.implementation.beginTaskStrategyImplementation(
        o.readProviderRetryAccountingEvidence,
        ROOT,
        f.session.sessionId,
      ),
  };
  for (const name of transitions)
    assert.throws(probes[name], { message: `unexpected transition: ${name}` });
  a.events.length = 0;
  assertWire(a.inspect(), 'ready');
  assert.deepEqual(b.events, []);
  assertWire(b.inspect(), 'red-authoring');
});

test('terminal reads transaction first and skips all active observations', () => {
  for (const terminal of ['committed', 'aborted', 'revising'] as const) {
    for (const withTransaction of [false, true]) {
      const item = frame();
      item.session.state = terminal;
      if (!withTransaction) item.transaction = null;
      const f = fixture([item]);
      const status = f.inspect();
      assertWire(status, 'session-terminal');
      assert.equal(status.sessionId, item.session.sessionId);
      assert.equal(status.sessionState, terminal);
      assert.equal(status.strategy, item.transaction?.strategy ?? null);
      assert.equal(
        status.transactionDigest,
        item.transaction?.recordDigest ?? null,
      );
      assert.deepEqual(f.names(), baseReads);
      const bad = fixture([item]);
      bad.state.failAt = 'transaction.read';
      assert.throws(bad.inspect, (e) => e === bad.state.sentinel);
      assert.deepEqual(bad.names(), baseReads);
    }
  }
});

test('mechanical, direct, absent-task and missing-RED branches preserve observation order', () => {
  for (const state of [
    'transformation-required',
    'transformation-produced',
  ] as const) {
    const item = mechanical();
    item.mechanical = { state, projectionDigest: digest(state) };
    const f = fixture([item]);
    assertWire(f.inspect(), state);
    assert.deepEqual(f.names(), [...contractReads, 'mechanical.inspect']);
  }
  for (const item of [direct(), setTask(frame(), undefined)]) {
    const f = fixture([item]);
    const status = f.inspect();
    assertWire(status, 'not-required');
    assert.equal(status.transactionDigest, null);
    assert.deepEqual(f.names(), contractReads);
  }
  const f = fixture([red()]);
  assertWire(f.inspect(), 'red-authoring');
  assert.deepEqual(f.names(), contractReads);
  for (const item of [mechanical(), direct(), setTask(frame(), undefined)]) {
    item.transaction = item.projection.transaction;
    const bad = fixture([item]);
    assert.throws(bad.inspect, STALE);
    assert.deepEqual(bad.names(), contractReads);
  }
  const item = mechanical();
  item.mechanical = null;
  const bad = fixture([item]);
  assert.throws(bad.inspect, STALE);
  assert.deepEqual(bad.names(), [...contractReads, 'mechanical.inspect']);
});

test('each transaction currentness field rejects before fresh session inspection (port fault injection)', () => {
  const original = frame().projection.transaction;
  const mismatches: Partial<TaskStrategyTransaction>[] = [
    { sessionId: 'another-session' },
    { changeId: 'another-change' },
    { taskId: '2.1' },
    { strategy: 'tdd-single-agent' },
    { baseline: { ...original.baseline, head: 'a'.repeat(40) } },
    { baseline: { ...original.baseline, tree: 'b'.repeat(40) } },
    { taskContractDigest: digest('stale-contract') },
  ];
  for (const mismatch of mismatches) {
    const item = frame();
    item.transaction = { ...original, ...mismatch };
    const f = fixture([item]);
    assert.throws(f.inspect, STALE);
    assert.deepEqual(f.names(), contractReads);
  }
  const item = frame();
  item.inspection.contract.execution!.tasks[item.session.taskId] = {
    ...item.task,
    greenChecks: ['new-check'],
  };
  const f = fixture([item]);
  assert.throws(f.inspect, STALE);
  assert.deepEqual(f.names(), contractReads);
});

test('inspection preserves full Git, fresh inspection/projection identities and original call arity', () => {
  const item = frame();
  // Different observations are intentional. Do not add cross-observation gates.
  item.inspection = {
    ...item.inspection,
    session: { ...item.session, taskId: '2.2' },
  };
  const f = fixture([item]);
  assertWire(f.inspect(), 'ready');
  assert.deepEqual(event(f, 'session.read').args, [ROOT, 'requested-session']);
  assert.deepEqual(event(f, 'contract.load').args, [
    item.git,
    item.session.changeId,
  ]);
  assert.strictEqual(event(f, 'contract.load').args[0], item.git);
  assert.deepEqual(event(f, 'session.inspect').args, [
    ROOT,
    item.session.sessionId,
  ]);
  assert.strictEqual(event(f, 'correction.resolve').args[0], item.inspection);
  assert.equal(event(f, 'authority.resolve').args.length, 2);
  assert.strictEqual(event(f, 'authority.resolve').args[0], item.inspection);
  assert.strictEqual(event(f, 'authority.resolve').args[1], item.projection);
  assert.deepEqual(f.names(), crossReads);
});

test('exhausted and single-agent projections resolve authority but never read implementation journal', () => {
  const cases = [
    [exhausted(), 'correction-exhausted'],
    [frame({ single: true }), 'implementation-required'],
    [correction(), 'correction-required'],
    [imported(true), 'patch-imported'],
  ] as const;
  for (const [item, expected] of cases) {
    const f = fixture([item]);
    f.state.forbiddenReads = new Set([
      'provider.reservation',
      'caller.reservation',
      'caller.result',
      'provider.attempt',
      'invocation.exists',
      'invocation.read',
      'provider.result',
    ]);
    assertWire(f.inspect(), expected);
    assert.deepEqual(f.names(), tddReads);
  }
  const item = correction();
  item.projection = { ...item.projection, exhausted: true };
  const f = fixture([item]);
  assertWire(f.inspect(), 'correction-exhausted');
  assert.deepEqual(f.names(), tddReads);
});

test('completed correction uses authority subject instead of rebuilding initial RED subject', () => {
  const item = imported(false, true);
  const f = fixture([item]);
  assert.notEqual(
    item.authority.subject.subjectDigest,
    item.initialSubject.subjectDigest,
  );
  assert.equal(item.projection.failure, null);
  assertWire(f.inspect(), 'patch-imported');
  for (const name of [
    'provider.reservation',
    'caller.reservation',
    'caller.result',
  ]) {
    assert.deepEqual(event(f, name).args, [
      item.session.sessionId,
      item.authority.subject.subjectDigest,
    ]);
  }
});

test('cross-agent projection always performs all three strict reads on one journal, even with provider reservation', () => {
  const item = provider();
  // A provider reservation wins after strict caller reads, even if a caller
  // binding is also available. Its presence must not select caller projection.
  item.callerReservation = item.records.callerReservation;
  item.callerResult = item.records.callerResult;
  item.projection = { ...item.projection, head: item.imported };
  const f = fixture([item]);
  assertWire(f.inspect(), 'waiting-for-provider');
  assert.deepEqual(f.names(), [
    ...crossReads,
    'provider.attempt',
    'invocation.exists',
    'invocation.read',
  ]);
  const ids = f.events
    .filter((e) => e.journal !== undefined)
    .map((e) => e.journal);
  assert.deepEqual([...new Set(ids)], [1]);
  for (const name of ['caller.reservation', 'caller.result']) {
    const bad = fixture([item]);
    bad.state.failAt = name;
    assert.throws(bad.inspect, (e) => e === bad.state.sentinel);
    assert.deepEqual(
      bad.names(),
      crossReads.slice(0, crossReads.indexOf(name) + 1),
    );
  }
});

test('caller reservation/result/head combinations retain exact status and stale checks', () => {
  for (const result of [
    'missing',
    'matching',
    'wrong-subject',
    'wrong-patch',
  ] as const) {
    for (const withHead of [false, true]) {
      const item = frame();
      item.callerReservation = item.records.callerReservation;
      item.callerResult =
        result === 'missing' ? null : item.records.callerResult;
      // Wrong-subject and wrong-patch are deliberate consumer port faults.
      if (result === 'wrong-subject')
        item.callerResult = {
          ...item.records.callerResult,
          subjectDigest: digest('other'),
        };
      if (result === 'wrong-patch')
        item.callerResult = {
          ...item.records.callerResult,
          output: {
            ...item.records.callerResult.output,
            patchDigest: digest('other'),
          },
        };
      if (withHead)
        item.projection = { ...item.projection, head: item.imported };
      const f = fixture([item]);
      assertWire(
        f.inspect(),
        result === 'matching' && withHead
          ? 'patch-imported'
          : 'caller-supplied-awaiting-import',
      );
      assert.deepEqual(f.names(), crossReads);
    }
  }
  for (const missing of [false, true]) {
    const item = frame();
    item.callerResult = item.records.callerResult;
    item.callerReservation = missing
      ? null
      : { ...item.records.callerReservation, subjectDigest: digest('other') };
    const f = fixture([item]);
    assert.throws(f.inspect, STALE);
    assert.deepEqual(f.names(), crossReads);
  }
  const item = correction(false);
  const f = fixture([item]);
  assertWire(f.inspect(), 'correction-required');
  assert.deepEqual(f.names(), crossReads);
  // No extra candidate-tree inequality gate belongs to this projection.
  const sameTree = imported();
  sameTree.projection = {
    ...sameTree.projection,
    head: {
      ...sameTree.imported,
      binding: {
        ...sameTree.imported.binding,
        candidateTree: sameTree.authority.subject.sourceTree,
      },
    },
  };
  assertWire(fixture([sameTree]).inspect(), 'patch-imported');
});

test('provider subject/transaction faults are stale only after all three strict reads', () => {
  for (const mismatch of [
    { subjectDigest: digest('other') },
    { transactionDigest: digest('other') },
  ]) {
    const item = provider();
    item.reservation = {
      ...item.records.reservation,
      subject: { ...item.authority.subject, ...mismatch },
    };
    const f = fixture([item]);
    assert.throws(f.inspect, STALE);
    assert.deepEqual(f.names(), crossReads);
  }
});

test('provider projection follows effective attempt ID and reads results only for succeeded', () => {
  for (const state of ['missing', 'prepared', 'leased', 'failed'] as const) {
    const item = provider(state === 'missing' ? 'prepared' : state);
    item.invocationExists = state !== 'missing';
    // Canonical retry request, separate from the root request. The attempt
    // selector owns retry lineage; this consumer must use its returned request.
    const {
      requestDigest: _digest,
      schemaVersion: _schema,
      roleAssignmentDigest: _roleDigest,
      ...requestInput
    } = item.attempt.request;
    const request = createProviderInvocationRequest({
      ...requestInput,
      invocationId: 'invocation-effective-attempt',
      nonce: 'effective-attempt',
    });
    item.attempt = { ...item.attempt, request };
    item.invocation = {
      ...item.invocation,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
    };
    const f = fixture([item]);
    f.state.failAt = 'provider.result';
    const status = f.inspect();
    assertWire(
      status,
      state === 'missing'
        ? 'reservation-persisted'
        : state === 'failed'
          ? 'provider-failed'
          : 'waiting-for-provider',
    );
    assert.equal(status.invocationId, request.invocationId);
    assert.strictEqual(event(f, 'provider.attempt').args[0], item.reservation);
    assert.deepEqual(event(f, 'invocation.exists').args, [
      request.invocationId,
    ]);
    assert.deepEqual(f.names(), [
      ...crossReads,
      'provider.attempt',
      'invocation.exists',
      ...(state === 'missing' ? [] : ['invocation.read']),
    ]);
  }
});

test('succeeded projection reads result even for result=null port fault and matches subject plus patch head', () => {
  for (const result of [
    'missing',
    'matching',
    'wrong-subject',
    'wrong-patch',
  ] as const) {
    for (const withHead of [false, true]) {
      // This is a consumer-condition fault/control fixture, not a claim that
      // the durable producer admits succeeded invocations with a null result.
      const item = provider('succeeded');
      assert.equal(item.invocation.result, null);
      item.result = result === 'missing' ? null : item.records.result;
      if (result === 'wrong-subject')
        item.result = {
          ...item.records.result,
          subjectDigest: digest('other'),
        };
      if (result === 'wrong-patch')
        item.result = {
          ...item.records.result,
          output: {
            ...item.records.result.output,
            patchDigest: digest('other'),
          },
        };
      if (withHead)
        item.projection = { ...item.projection, head: item.imported };
      const f = fixture([item]);
      assertWire(
        f.inspect(),
        result === 'matching' && withHead
          ? 'patch-imported'
          : 'provider-succeeded-awaiting-import',
      );
      assert.deepEqual(f.names(), [
        ...crossReads,
        'provider.attempt',
        'invocation.exists',
        'invocation.read',
        'provider.result',
      ]);
      assert.deepEqual(event(f, 'provider.result').args, [
        item.session.sessionId,
        item.authority.subject.subjectDigest,
      ]);
    }
  }
});

test('resume option precedence returns not-required and rejects terminal before validating options', () => {
  const item = direct();
  const options: ResumeTaskStrategyOptions = {
    explicitActor: '',
    collaborationGrant: { grantId: GRANT_ID },
    redRevisionRequest: revision(item),
  };
  const f = fixture([item]);
  assertWire(f.resume(options), 'not-required');
  assert.deepEqual(f.names(), contractReads);
  const terminal = frame();
  terminal.session.state = 'committed';
  const bad = fixture([terminal]);
  assert.throws(() => bad.resume(options), {
    code: 'TASK_STRATEGY_RESUME_NOT_APPLICABLE',
  });
  assert.deepEqual(bad.names(), baseReads);
});

test('mechanical resume rejects every supplied input, then re-observes after an accepted transition', () => {
  const item = mechanical();
  for (const options of [
    { explicitActor: '' },
    { collaborationGrant: { grantId: GRANT_ID } },
    { redRevisionRequest: revision(item) },
  ]) {
    const f = fixture([item]);
    assert.throws(() => f.resume(options), {
      code: 'TASK_MECHANICAL_TRANSFORMATION_INPUT_INVALID',
    });
    assert.deepEqual(f.names(), [...contractReads, 'mechanical.inspect']);
  }
  const next = mechanical();
  next.mechanical = {
    state: 'transformation-produced',
    projectionDigest: digest('next'),
  };
  const f = fixture([item, next], ['mechanical.resume']);
  assertWire(
    f.resume({
      explicitActor: undefined,
      collaborationGrant: undefined,
      redRevisionRequest: undefined,
    }),
    'transformation-produced',
  );
  assert.deepEqual(f.names(), [
    ...contractReads,
    'mechanical.inspect',
    'mechanical.resume',
    ...contractReads,
    'mechanical.inspect',
  ]);
  assert.deepEqual(event(f, 'mechanical.resume').args, [
    ROOT,
    item.session.sessionId,
  ]);
});

test('explicit RED revision preserves request identity and excludes ordinary transitions', () => {
  const item = frame();
  const request = revision(item);
  for (const options of [
    { redRevisionRequest: { ...request, sessionId: 'other' } },
    { redRevisionRequest: request, explicitActor: '' },
    { redRevisionRequest: request, collaborationGrant: { grantId: GRANT_ID } },
  ]) {
    const f = fixture([item]);
    assert.throws(() => f.resume(options), {
      code: 'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
    });
    assert.deepEqual(f.names(), crossReads);
  }
  const f = fixture([item, red()], ['red.beginRevision']);
  assertWire(f.resume({ redRevisionRequest: request }), 'red-authoring');
  assert.deepEqual(f.names(), [
    ...crossReads,
    'red.beginRevision',
    ...contractReads,
  ]);
  assert.equal(event(f, 'red.beginRevision').args.length, 2);
  assert.strictEqual(event(f, 'red.beginRevision').args[1], request);
});

test('ordinary resume continues revision even when initial state is imported or exhausted', () => {
  for (const initial of [imported(), exhausted()]) {
    const fresh = frame({ single: true });
    fresh.transaction = {
      ...fresh.projection.transaction,
      recordDigest: digest('recovered-transaction'),
    };
    const f = fixture(
      [initial, fresh, fresh],
      ['red.continueRevision', 'adopt.implementation'],
    );
    const status = f.resume();
    assertWire(status, 'implementation-required');
    assert.equal(status.transactionDigest, fresh.transaction.recordDigest);
    assert.equal(status.strategy, 'tdd-single-agent');
    assert.equal(f.calls('session.read').length, 3);
    assert.ok(
      f.names().indexOf('red.continueRevision') <
        f.names().indexOf('adopt.implementation'),
    );
    assert.deepEqual(event(f, 'red.continueRevision').args, [
      ROOT,
      initial.session.sessionId,
    ]);
  }
  for (const item of [imported(), exhausted()]) {
    const f = fixture([item], ['red.continueRevision']);
    assertWire(
      f.resume(),
      item.projection.exhausted ? 'correction-exhausted' : 'patch-imported',
    );
    assert.equal(f.calls('session.read').length, 3);
    assert.equal(f.calls('red.continueRevision').length, 1);
  }
});

test('without seal, the third fresh observation determines adoption or begin', () => {
  for (const finalState of ['local', 'provider-failed'] as const) {
    const second = imported();
    const third =
      finalState === 'local' ? frame({ single: true }) : provider('failed');
    const f = fixture(
      [frame(), second, third],
      [
        'red.continueRevision',
        ...(finalState === 'local'
          ? ['adopt.implementation' as const]
          : ['implementation.begin' as const]),
      ],
    );
    const status = f.resume();
    assertWire(
      status,
      finalState === 'local' ? 'implementation-required' : 'ready',
    );
    assert.equal(f.calls('session.read').length, 3);
    assert.equal(f.calls('red.seal').length, 0);
    if (finalState === 'provider-failed')
      assert.deepEqual(event(f, 'implementation.begin').args[3], {
        retryProviderFailure: true,
      });
  }
});

test('seal receives only supplied actor and single-agent seal returns a fresh status without adoption', () => {
  for (const explicitActor of [undefined, '', 'codex']) {
    const next = frame({ single: true });
    const f = fixture(
      [red(), red(), next],
      ['red.continueRevision', 'red.seal'],
    );
    f.state.seal = next.projection.transaction;
    assertWire(f.resume({ explicitActor }), 'implementation-required');
    assert.deepEqual(event(f, 'red.seal').args, [
      ROOT,
      next.session.sessionId,
      explicitActor === undefined ? {} : { explicitActor },
    ]);
    assert.deepEqual(f.names(), [
      ...contractReads,
      'red.continueRevision',
      ...contractReads,
      'red.seal',
      ...tddReads,
    ]);
  }
});

test('cross-agent seal continues through fresh inspection and delegates without the actor option', () => {
  const f = fixture(
    [red(), red(), frame()],
    ['red.continueRevision', 'red.seal', 'implementation.begin'],
  );
  const status = f.resume({ explicitActor: 'codex' });
  assertWire(status, 'ready');
  assert.deepEqual(event(f, 'red.seal').args[2], { explicitActor: 'codex' });
  assert.deepEqual(event(f, 'implementation.begin').args[3], {});
  assert.deepEqual(f.names(), [
    ...contractReads,
    'red.continueRevision',
    ...contractReads,
    'red.seal',
    ...crossReads,
    'implementation.begin',
    'journal.observe',
    'transaction.read',
  ]);
});

test('local implementation/correction adoption re-inspects only for non-null results', () => {
  for (const isCorrection of [false, true]) {
    for (const adopted of [false, true]) {
      const item = isCorrection ? correction() : frame({ single: true });
      const next = imported(true, isCorrection);
      const name = isCorrection ? 'adopt.correction' : 'adopt.implementation';
      const f = fixture(
        [frame(), imported(), item, next],
        ['red.continueRevision', name],
      );
      f.state.adopted = adopted ? next.imported : null;
      const status = f.resume();
      assertWire(
        status,
        adopted
          ? 'patch-imported'
          : isCorrection
            ? 'correction-required'
            : 'implementation-required',
      );
      assert.equal(f.calls('session.read').length, adopted ? 4 : 3);
      assert.deepEqual(event(f, name).args, [ROOT, item.session.sessionId]);
      assert.equal(f.calls('implementation.begin').length, 0);
      assert.equal(f.events.at(-1)!.name, adopted ? 'authority.resolve' : name);
    }
  }
});

test('begin uses original accounting/grant references, exact omitted keys, and only latest failed status enables retry', () => {
  for (const failed of [false, true]) {
    for (const supplied of [false, true]) {
      const grant = { grantId: GRANT_ID, now: new Date(NOW) };
      const latest = failed ? provider('failed') : frame();
      const f = fixture(
        [provider('failed'), frame(), latest],
        ['red.continueRevision', 'implementation.begin'],
      );
      f.resume({
        explicitActor: 'codex',
        ...(supplied ? { collaborationGrant: grant } : {}),
      });
      const args = event(f, 'implementation.begin').args;
      assert.equal(args.length, 4);
      assert.strictEqual(
        args[0],
        f.operations.readProviderRetryAccountingEvidence,
      );
      assert.deepEqual(args.slice(1, 3), [ROOT, latest.session.sessionId]);
      const options = args[3] as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(options).sort(),
        [
          ...(failed ? ['retryProviderFailure'] : []),
          ...(supplied ? ['collaborationGrant'] : []),
        ].sort(),
      );
      if (failed) assert.equal(options.retryProviderFailure, true);
      if (supplied) assert.strictEqual(options.collaborationGrant, grant);
    }
  }
});

test('after begin a separate journal supplies the new transaction strategy/digest and advanced session identity', () => {
  const f = fixture(
    [frame()],
    ['red.continueRevision', 'implementation.begin'],
  );
  const late = frame({ single: true });
  late.transaction = {
    ...late.projection.transaction,
    recordDigest: digest('late-transaction'),
  };
  f.state.lateFrame = late;
  f.state.advanced = {
    state: 'provider-not-required',
    sessionId: 'advanced-session',
    subject: late.authority.subject,
  };
  const status = f.resume();
  assert.deepEqual(status, {
    schemaVersion: 1,
    kind: 'task-strategy-lifecycle-status.v1',
    invocationId: null,
    sessionId: 'advanced-session',
    strategy: 'tdd-single-agent',
    state: 'implementation-required',
    transactionDigest: late.transaction.recordDigest,
    sessionState: 'active',
  });
  assert.equal(Object.isFrozen(status), true);
  assert.equal(f.calls('session.read').length, 3);
  assert.deepEqual(f.names().slice(-3), [
    'implementation.begin',
    'journal.observe',
    'transaction.read',
  ]);
  assert.notEqual(
    f.calls('journal.observe').at(-1)!.journal,
    f.calls('journal.observe').at(-2)!.journal,
  );
  assert.deepEqual(event(f, 'transaction.read').args, [late.session.sessionId]);
});

test('late missing/corrupt transaction fails after successful begin without further observation', () => {
  for (const fault of ['null', 'error', 'observe-error'] as const) {
    const f = fixture(
      [frame()],
      ['red.continueRevision', 'implementation.begin'],
    );
    const late = frame();
    late.transaction = null;
    f.state.lateFrame = late;
    if (fault === 'error' || fault === 'observe-error') {
      f.state.failAt =
        fault === 'error' ? 'transaction.read' : 'journal.observe';
      f.state.failOccurrence = 4;
    }
    if (fault === 'null') assert.throws(f.resume, STALE);
    else assert.throws(f.resume, (e) => e === f.state.sentinel);
    assert.deepEqual(
      f.names().slice(f.names().indexOf('implementation.begin')),
      fault === 'observe-error'
        ? ['implementation.begin', 'journal.observe']
        : ['implementation.begin', 'journal.observe', 'transaction.read'],
    );
    assert.equal(f.calls('implementation.begin').length, 1);
    assert.equal(f.calls('session.read').length, 3);
  }
});

test('advanced projection preserves all status families and shallow input-schema identity', () => {
  const item = frame();
  const common = {
    sessionId: 'advanced-session',
    subject: item.authority.subject,
  };
  const schema = {
    schemaVersion: 1 as const,
    kind: 'collaboration-grant-selection' as const,
    lifecyclePhase: 'task-implementation' as const,
    conflictingRole: 'task-implementer' as const,
    grantRequest: null,
    allowedDegradedForms: ['caller-supplied' as const],
    resumeOption: '--grant <grant-id>' as const,
  };
  const statuses: TaskStrategyImplementationStatus[] = [
    { ...common, state: 'provider-not-required' },
    { ...common, state: 'ready' },
    { ...common, state: 'reservation-persisted' },
    { ...common, state: 'collaboration-grant-required', inputSchema: schema },
    ...(
      [
        'waiting-for-provider',
        'provider-succeeded-awaiting-import',
        'provider-failed',
      ] as const
    ).map((state) => ({
      ...common,
      state,
      assignment: item.records.reservation.assignment,
      ownerInvestigationId: item.records.reservation.ownerInvestigationId,
      invocationId: 'advanced-invocation',
      failure: null,
    })),
    ...(['caller-supplied-awaiting-import', 'patch-imported'] as const).map(
      (state) => ({
        ...common,
        state,
        assignment: item.records.callerReservation.assignment,
        ownerInvestigationId: null,
        invocationId: null,
        failure: null,
      }),
    ),
  ];
  for (const advanced of statuses) {
    const f = fixture([item], ['red.continueRevision', 'implementation.begin']);
    f.state.advanced = advanced;
    const status = f.resume();
    assertWire(
      status,
      advanced.state === 'provider-not-required'
        ? 'implementation-required'
        : advanced.state,
    );
    assert.equal(
      status.invocationId,
      'invocationId' in advanced ? advanced.invocationId : null,
    );
    assert.equal('inputSchema' in status, 'inputSchema' in advanced);
    if ('inputSchema' in advanced) {
      assert.strictEqual(status.inputSchema, schema);
      assert.equal(Object.isFrozen(schema), false);
    }
  }
  // Presence, not truthiness, is the original projection condition. This typed
  // extension is a consumer port control, not a durable producer assertion.
  const advanced: TaskStrategyImplementationStatus & {
    inputSchema: undefined;
  } = { ...common, state: 'ready', inputSchema: undefined };
  const f = fixture([item], ['red.continueRevision', 'implementation.begin']);
  f.state.advanced = advanced;
  const status = f.resume();
  assert.equal('inputSchema' in status, true);
  assert.equal(status.inputSchema, undefined);
});

test('every observation error is preserved by identity and stops at its exact read', () => {
  const allObservationNames = [
    ...crossReads,
    'provider.attempt',
    'invocation.exists',
    'invocation.read',
    'provider.result',
  ];
  for (const name of allObservationNames) {
    const f = fixture([provider('succeeded')]);
    f.state.failAt = name;
    assert.throws(f.inspect, (e) => e === f.state.sentinel);
    assert.deepEqual(
      f.names(),
      allObservationNames.slice(0, allObservationNames.indexOf(name) + 1),
    );
  }
  const f = fixture([mechanical()]);
  f.state.failAt = 'mechanical.inspect';
  assert.throws(f.inspect, (e) => e === f.state.sentinel);
  assert.deepEqual(f.names(), [...contractReads, 'mechanical.inspect']);
});

test('every transition error is preserved by identity and stops before downstream reads or transitions', () => {
  const cases: {
    name: Transition;
    frames: Frame[];
    options?: ResumeTaskStrategyOptions;
  }[] = [
    { name: 'mechanical.resume', frames: [mechanical()] },
    {
      name: 'red.beginRevision',
      frames: [frame()],
      options: { redRevisionRequest: revision(frame()) },
    },
    { name: 'red.continueRevision', frames: [frame()] },
    { name: 'red.seal', frames: [red()] },
    { name: 'adopt.implementation', frames: [frame({ single: true })] },
    { name: 'adopt.correction', frames: [correction()] },
    { name: 'implementation.begin', frames: [frame()] },
  ];
  for (const c of cases) {
    const good = fixture(c.frames, transitions);
    if (c.name === 'red.seal')
      good.state.seal = frame({ single: true }).projection.transaction;
    good.resume(c.options);
    const expected = good.names().slice(0, good.names().indexOf(c.name) + 1);
    const bad = fixture(c.frames, transitions);
    bad.state.failAt = c.name;
    assert.throws(
      () => bad.resume(c.options),
      (e) => e === bad.state.sentinel,
    );
    assert.deepEqual(bad.names(), expected);
  }
});

test('completed provider correction reads and matches the correction authority subject', () => {
  const item = frame({ correction: true });
  item.projection = {
    ...item.projection,
    head: item.imported,
    completedCorrectionRounds: 1,
  };
  item.reservation = item.records.reservation;
  item.result = item.records.result;
  item.invocationExists = true;
  item.invocation.state = 'succeeded';
  const f = fixture([item]);
  assertWire(f.inspect(), 'patch-imported');
  assert.notEqual(
    item.authority.subject.subjectDigest,
    item.initialSubject.subjectDigest,
  );
  for (const name of [
    'provider.reservation',
    'caller.reservation',
    'caller.result',
    'provider.result',
  ]) {
    assert.deepEqual(event(f, name).args, [
      item.session.sessionId,
      item.authority.subject.subjectDigest,
    ]);
  }
});

test('resume preserves errors from fresh post-transition inspections without executing the next action', () => {
  const cases = [
    {
      frames: [mechanical()],
      allowed: ['mechanical.resume'] as const,
      options: undefined,
    },
    {
      frames: [frame()],
      allowed: ['red.beginRevision'] as const,
      options: { redRevisionRequest: revision(frame()) },
    },
    {
      frames: [frame()],
      allowed: ['red.continueRevision'] as const,
      options: undefined,
    },
  ];
  for (const c of cases) {
    const f = fixture(c.frames, c.allowed);
    f.state.failAt = 'session.read';
    f.state.failOccurrence = 2;
    assert.throws(
      () => f.resume(c.options),
      (e) => e === f.state.sentinel,
    );
    assert.deepEqual(f.names().slice(-2), [c.allowed[0], 'session.read']);
  }
  const f = fixture(
    [frame(), imported(), frame({ single: true })],
    ['red.continueRevision'],
  );
  f.state.failAt = 'transaction.read';
  f.state.failOccurrence = 3;
  assert.throws(f.resume, (e) => e === f.state.sentinel);
  assert.deepEqual(f.names().slice(-3), baseReads);
  assert.equal(f.calls('adopt.implementation').length, 0);
});
