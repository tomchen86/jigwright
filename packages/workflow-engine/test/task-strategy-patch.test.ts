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
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../src/modules/planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyPatchRecord,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionProjection } from '../src/modules/assurance/task-strategy-correction-round-record.ts';
import type { TaskStrategyImplementationProviderAttempt } from '../src/modules/assurance/task-strategy-implementation-record.ts';
import type { ImportedTaskStrategyPatch } from '../src/modules/assurance/task-strategy-patch-contract.ts';
import type { TaskStrategyImplementationSubject } from '../src/modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import {
  prepareTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
} from '../src/modules/provider-orchestration/task-strategy-correction-record.ts';
import { createTaskStrategyPatchService } from '../src/application/execute-task/task-strategy-patch.ts';
import type {
  TaskStrategyPatchOperations,
  TaskStrategyPatchJournal,
} from '../src/application/execute-task/task-strategy-patch-operations.ts';
import type { TaskStrategyCorrectionReader } from '../src/application/execute-task/task-strategy-correction.ts';
import {
  prepareTaskStrategyPatchRecord,
  parseReservation,
  parseImportReceipt,
  parseCurrentBinding,
} from '../src/modules/assurance/task-strategy-patch-record.ts';
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
function baseFacts(
  options: {
    single?: boolean;
    correction?: boolean;
  } = {},
) {
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
  const projection: TaskStrategyCorrectionProjection = {
    transaction,
    head: null,
    failure: options.correction ? failure : null,
    completedCorrectionRounds: 0,
    exhausted: false,
    correctionState: options.correction
      ? { state: 'correction-required', round: 1, nextAction: 'reserve' }
      : null,
  };
  return {
    session,
    git,
    task,
    inspection,
    transaction: transaction as TaskStrategyTransaction | null,
    subject,
    initialSubject,
    failure,
    records,
    attempt,
    projection,
    authority: {
      subject,
      greenFailureRecord: options.correction ? failure : null,
    },
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
    limits: { timeoutMs: 10000, aggregateOutputBytes: 100000 },
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
const PATCH = Buffer.from('fixed implementation patch bytes');
const CANDIDATE = '6'.repeat(40);
const AUTH_STALE = { code: 'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE' };
const PATCH_STALE = { code: 'TASK_STRATEGY_PATCH_STALE' };
const CORRUPT = { code: 'TASK_STRATEGY_PATCH_STATE_CORRUPT' };
function fault<T>(value: T, key: string, replacement: unknown): T {
  const [field, ...tail] = key.split('.');
  const object = value as Record<string, unknown>;
  return {
    ...object,
    [field!]: tail.length
      ? fault(object[field!], tail.join('.'), replacement)
      : replacement,
  } as T;
}
function imported(record: TaskStrategyPatchRecord): ImportedTaskStrategyPatch {
  const reservation = parseReservation(
    seal(
      {
        schemaVersion: 1,
        kind: 'task-strategy-patch-reservation.v1',
        sessionId: record.sessionId,
        recordDigest: record.recordDigest,
        patchDigest: record.patchDigest,
        sourceTree: record.sourceTree,
        candidateTree: record.candidateTree,
        createdAt: record.createdAt,
      },
      'reservationDigest',
    ),
  );
  const receipt = parseImportReceipt(
    seal(
      {
        schemaVersion: 1,
        kind: 'task-strategy-patch-import-receipt.v1',
        sessionId: record.sessionId,
        recordDigest: record.recordDigest,
        patchDigest: record.patchDigest,
        candidateTree: record.candidateTree,
        importedAt: NOW,
      },
      'receiptDigest',
    ),
  );
  const binding = parseCurrentBinding(
    seal(
      {
        schemaVersion: 1,
        kind: 'task-strategy-patch-current.v1',
        sessionId: record.sessionId,
        recordDigest: record.recordDigest,
        patchDigest: record.patchDigest,
        receiptDigest: receipt.receiptDigest,
        candidateTree: record.candidateTree,
        createdAt: receipt.importedAt,
      },
      'bindingDigest',
    ),
  );
  return { record, reservation, receipt, binding };
}
function fixture(
  options: {
    single?: boolean;
    correction?: boolean;
  } = {},
) {
  const facts = baseFacts(options);
  const events: string[] = [];
  const args = new Map<string, unknown[][]>();
  const calls = (name: string, ...input: unknown[]) => {
    events.push(name);
    args.set(name, [...(args.get(name) ?? []), input]);
  };
  const layout = {
    root: ROOT,
    locks: ROOT + '/locks',
    operations: ROOT + '/operations',
    sessions: ROOT + '/sessions',
    reports: ROOT + '/reports',
    taskRevisions: ROOT + '/revisions',
  };
  const state = {
    tree: facts.subject.sourceTree,
    candidate: CANDIDATE,
    changedPaths: ['src/feature.ts'],
    clock: 0,
    environment: {} as NodeJS.ProcessEnv,
    records: new Map<string, TaskStrategyPatchRecord>(),
    reservations: new Map<string, ImportedTaskStrategyPatch['reservation']>(),
    receipts: new Map<string, ImportedTaskStrategyPatch['receipt']>(),
    bindings: new Map<string, ImportedTaskStrategyPatch['binding']>(),
    providerReservation: facts.records
      .reservation as TaskStrategyImplementationReservation | null,
    providerResult: facts.records
      .result as TaskStrategyImplementationResultBinding | null,
    callerReservation: facts.records
      .callerReservation as TaskStrategyCallerImplementationReservation | null,
    callerResult: facts.records
      .callerResult as TaskStrategyCallerImplementationBinding | null,
    attempt: facts.attempt as TaskStrategyImplementationProviderAttempt | null,
    currentAttempt:
      facts.attempt as TaskStrategyImplementationProviderAttempt | null,
  };
  const journal: TaskStrategyPatchJournal = {
    correction: {
      readTransaction: (id) => {
        calls('transaction', id);
        return facts.transaction;
      },
      readFailure: (...a) => {
        calls('failure', ...a);
        return facts.failure;
      },
      reserve: (v) => {
        calls('round.reserve', v);
      },
      publishResult: (v) => {
        calls('round.result', v);
      },
      publishImport: (v) => {
        calls('round.import', v);
      },
    },
    implementation: {
      readReservation: (...a) => {
        calls('provider.reservation', ...a);
        return state.providerReservation;
      },
      readResult: (...a) => {
        calls('provider.result', ...a);
        return state.providerResult;
      },
      readCallerReservation: (...a) => {
        calls('caller.reservation', ...a);
        return state.callerReservation;
      },
      readCallerResult: (...a) => {
        calls('caller.result', ...a);
        return state.callerResult;
      },
      readAttempt: (...a) => {
        calls('attempt', ...a);
        return state.attempt!;
      },
      readCurrentAttempt: (...a) => {
        calls('attempt.current', ...a);
        return state.currentAttempt!;
      },
    },
    patch: {
      readRecord: (id, p, source) => {
        calls('record.read', id, p, source);
        return state.records.get(source) ?? null;
      },
      readReservation: (...a) => {
        calls('reservation.read', ...a);
        return state.reservations.get(a[1]) ?? null;
      },
      readImportReceipt: (...a) => {
        calls('receipt.read', ...a);
        return state.receipts.get(a[2]) ?? null;
      },
      readCurrentBinding: (...a) => {
        calls('binding.read', ...a);
        return state.bindings.get(a[1]) ?? null;
      },
      reserve: (input) => {
        calls('reservation.write', input);
        const record = parseReservation(
          seal(
            {
              schemaVersion: 1,
              kind: 'task-strategy-patch-reservation.v1',
              ...input,
            },
            'reservationDigest',
          ),
        );
        state.reservations.set(input.sourceTree, record);
        return record;
      },
      persistRecord: (record) => {
        calls('record.write', record);
        state.records.set(record.sourceTree, record);
        return record;
      },
      createImportReceipt: (input, source) => {
        calls('receipt.write', input, source);
        const record = parseImportReceipt(
          seal(
            {
              schemaVersion: 1,
              kind: 'task-strategy-patch-import-receipt.v1',
              ...input,
            },
            'receiptDigest',
          ),
        );
        state.receipts.set(source, record);
        return record;
      },
      createCurrentBinding: (input, source) => {
        calls('binding.write', input, source);
        const record = parseCurrentBinding(
          seal(
            {
              schemaVersion: 1,
              kind: 'task-strategy-patch-current.v1',
              ...input,
            },
            'bindingDigest',
          ),
        );
        state.bindings.set(source, record);
        return record;
      },
    },
  };
  const owned = () => calls('owned');
  const operations: TaskStrategyPatchOperations = {
    session: {
      loadActive: (...a) => {
        calls('load', ...a);
        return {
          git: facts.git,
          config: facts.inspection.contract.config,
          runtime: layout,
          session: facts.session,
        };
      },
      inspect: (...a) => {
        calls('inspect', ...a);
        return facts.inspection;
      },
      inspectExpected: (...a) => {
        calls('inspect.expected', ...a);
        assert.equal(a[2], facts.inspection.session);
        return facts.inspection;
      },
      previewCandidate: (...a) => {
        calls('preview', ...a);
        return { tree: state.tree };
      },
    },
    locks: {
      repository: (runtime, run) => {
        calls('lock.repository', runtime);
        assert.equal(runtime, layout);
        return run(owned);
      },
      session: (runtime, id, run) => {
        calls('lock.session', runtime, id);
        return run();
      },
      runSessionOperation: (cwd, id, run) => {
        calls('lock.operation', cwd, id);
        return run();
      },
    },
    observeJournal: (...a) => {
      calls('journal', ...a);
      return journal;
    },
    repository: {
      applyPatchToIsolatedTree: (...a) => {
        calls('project', ...a);
        return {
          candidateTree: state.candidate,
          changedPaths: state.changedPaths,
        };
      },
      createBinaryPatch: (...a) => {
        calls('diff', ...a);
        return PATCH;
      },
      readRegularTreeEntry: (...a) => {
        calls('entry', ...a);
        return a[1] === facts.transaction!.red.candidateTree
          ? null
          : { mode: '100644', objectId: '7'.repeat(40) };
      },
      applyPatchToWorktree: (...a) => {
        calls('apply', ...a);
        state.tree = state.candidate;
      },
    },
    clock: {
      now: () => {
        calls('clock');
        return new Date(Date.parse(NOW) + 1000 * state.clock++);
      },
    },
    environment: () => {
      calls('environment');
      return state.environment;
    },
    correctionPolicy: { maxRepairAttempts: 3, maxSameFailureFingerprint: 2 },
  };
  const reader: TaskStrategyCorrectionReader = {
    resolveCurrentTaskStrategyCorrection: (...a) => {
      calls('correction', ...a);
      return facts.projection;
    },
    resolveCurrentTaskStrategyImplementationAuthority: (...a) => {
      calls('authority', ...a);
      return facts.authority;
    },
  };
  const service = createTaskStrategyPatchService(operations, reader);
  const input = { patch: PATCH, explicitActor: 'claude', environment: {} };
  const providerInput = {
    patch: PATCH,
    implementationSubjectDigest: facts.subject.subjectDigest,
    implementationResultBindingDigest: facts.records.result.bindingDigest,
  };
  const callerInput = {
    patch: PATCH,
    implementationSubjectDigest: facts.subject.subjectDigest,
    callerImplementationBindingDigest: facts.records.callerResult.bindingDigest,
  };
  const validateProviderInput = {
    patch: PATCH,
    implementationSubjectDigest: facts.subject.subjectDigest,
    implementationReservationDigest: facts.records.reservation.recordDigest,
  };
  const run = () =>
    service.importTaskStrategyPatch(ROOT, facts.session.sessionId, input);
  const seed = (value: ImportedTaskStrategyPatch) => {
    const source = value.record.sourceTree;
    state.records.set(source, value.record);
    state.reservations.set(source, value.reservation);
    state.receipts.set(source, value.receipt);
    state.bindings.set(source, value.binding);
  };
  return {
    facts,
    state,
    events,
    args,
    journal,
    operations,
    reader,
    service,
    input,
    providerInput,
    callerInput,
    validateProviderInput,
    run,
    seed,
    owned,
  };
}
test('actual factory is lazy, isolates instances and exposes all ten original methods', () => {
  const a = fixture(),
    b = fixture();
  assert.deepEqual(a.events, []);
  assert.deepEqual(b.events, []);
  assert.equal(Object.keys(a.service).length, 10);
  a.run();
  assert.deepEqual(b.events, []);
  assert.equal(b.state.records.size, 0);
});
test('validation order, buffer identity and shallow frozen results are preserved', () => {
  const f = fixture();
  const result = f.service.validateTaskStrategyPatch(
    ROOT,
    f.facts.session.sessionId,
    f.input,
  );
  assert.deepEqual(f.events, [
    'inspect',
    'journal',
    'transaction',
    'journal',
    'project',
    'preview',
    'entry',
    'entry',
  ]);
  assert.equal(f.args.get('project')![0]![2], PATCH);
  assert.equal(result.changedPaths, f.state.changedPaths);
  for (const item of [
    result,
    result.changedPaths,
    result.changes,
    result.implementer,
  ])
    assert.ok(Object.isFrozen(item));
  assert.ok(!Object.isFrozen(result.changes[0]));
  assert.equal(result.patchDigest, digest(PATCH));
});
for (const size of [0, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1])
  test(`patch byte limit ${size} is enforced before inspection`, () => {
    const f = fixture();
    const patch = Buffer.alloc(size, 42);
    if (size === 8 * 1024 * 1024) {
      f.service.validateTaskStrategyPatch(ROOT, f.facts.session.sessionId, {
        ...f.input,
        patch,
      });
      assert.equal(f.args.get('project')![0]![2], patch);
    } else {
      assert.throws(
        () =>
          f.service.validateTaskStrategyPatch(ROOT, f.facts.session.sessionId, {
            ...f.input,
            patch,
          }),
        { code: 'TASK_STRATEGY_PATCH_INVALID' },
      );
      assert.deepEqual(f.events, []);
    }
  });
for (const [field, value] of [
  ['phase', 'other'],
  ['changeId', 'other'],
  ['taskId', '1.2'],
  ['strategy', 'tdd-single-agent'],
  ['taskContractDigest', digest('other')],
  ['baseline.tree', '9'.repeat(40)],
] as const)
  test(`RED authority rejects ${field} before actor or projection`, () => {
    const f = fixture();
    f.facts.transaction = fault(f.facts.transaction, field, value);
    assert.throws(
      () =>
        f.service.validateTaskStrategyPatch(
          ROOT,
          f.facts.session.sessionId,
          f.input,
        ),
      { code: 'TASK_STRATEGY_RED_REQUIRED' },
    );
    assert.deepEqual(f.events, ['inspect', 'journal', 'transaction']);
  });
test('task and absent RED guards retain their distinct errors', () => {
  const f = fixture();
  f.facts.inspection = fault(
    f.facts.inspection,
    'contract.execution.tasks',
    {},
  );
  assert.throws(f.run, { code: 'TASK_STRATEGY_PATCH_NOT_APPLICABLE' });
  assert.deepEqual(f.events, ['lock.operation', 'inspect']);
  const g = fixture();
  g.facts.transaction = null;
  assert.throws(g.run, { code: 'TASK_STRATEGY_RED_REQUIRED' });
  assert.ok(!g.events.includes('environment'));
});
for (const [paths, code] of [
  [[], 'TASK_STRATEGY_PATCH_INVALID'],
  [
    Array.from({ length: 1025 }, (_, n) => `src/${n}`),
    'TASK_STRATEGY_PATCH_INVALID',
  ],
  [['test/feature.test.ts', 'elsewhere'], 'TASK_STRATEGY_PATCH_FROZEN_PATH'],
  [['elsewhere'], 'TASK_STRATEGY_PATCH_SCOPE_INVALID'],
] as const)
  test(`projected paths guard ${code} before entry reads`, () => {
    const f = fixture();
    f.state.changedPaths = [...paths];
    assert.throws(
      () =>
        f.service.validateTaskStrategyPatch(
          ROOT,
          f.facts.session.sessionId,
          f.input,
        ),
      { code },
    );
    assert.equal(f.events.at(-1), 'preview');
  });
test('ambient tree mismatch precedes empty/path guards; exact 1024 paths remains admissible', () => {
  const f = fixture();
  f.state.tree = 'f'.repeat(40);
  f.state.changedPaths = [];
  assert.throws(
    () =>
      f.service.validateTaskStrategyPatch(
        ROOT,
        f.facts.session.sessionId,
        f.input,
      ),
    { code: 'TASK_STRATEGY_RED_STALE' },
  );
  const g = fixture();
  g.state.changedPaths = Array.from(
    { length: 1024 },
    (_, n) => `src/${String(n).padStart(4, '0')}`,
  );
  assert.equal(
    g.service.validateTaskStrategyPatch(
      ROOT,
      g.facts.session.sessionId,
      g.input,
    ).changedPaths.length,
    1024,
  );
});
test('raw actor environment is late and optional; single-agent identity and cross-agent session guards remain', () => {
  const f = fixture();
  f.service.validateTaskStrategyPatch(ROOT, f.facts.session.sessionId, {
    patch: PATCH,
    explicitActor: 'claude',
  });
  assert.deepEqual(f.events.slice(0, 6), [
    'inspect',
    'journal',
    'transaction',
    'journal',
    'environment',
    'project',
  ]);
  const same = fixture();
  assert.throws(
    () =>
      same.service.validateTaskStrategyPatch(
        ROOT,
        same.facts.session.sessionId,
        { ...same.input, explicitActor: 'codex' },
      ),
    { code: 'TASK_STRATEGY_IMPLEMENTER_REQUIRED' },
  );
  const single = fixture({ single: true });
  assert.throws(
    () =>
      single.service.validateTaskStrategyPatch(
        ROOT,
        single.facts.session.sessionId,
        single.input,
      ),
    { code: 'TASK_STRATEGY_IMPLEMENTER_REQUIRED' },
  );
  single.service.validateTaskStrategyPatch(
    ROOT,
    single.facts.session.sessionId,
    { patch: PATCH, environment: { CODEX_SANDBOX: 'fixture' } },
  );
});
test('caller validation clones authority and wins over mixed provider discriminants without reading environment', () => {
  const f = fixture();
  const callerImplementer = {
    providerId: null,
    principalId: 'caller',
    assurance: 'runtime-hint' as const,
    degradedForm: 'caller-supplied' as const,
    grantId: GRANT_ID,
  };
  const result = f.service.validateTaskStrategyCallerPatch(
    ROOT,
    f.facts.session.sessionId,
    { ...f.validateProviderInput, callerImplementer },
  );
  assert.deepEqual(result.implementer, callerImplementer);
  assert.notEqual(result.implementer, callerImplementer);
  assert.ok(Object.isFrozen(result.implementer));
  assert.ok(!f.events.includes('provider.reservation'));
  assert.ok(!f.events.includes('environment'));
  assert.equal(f.args.get('authority')![0]![1], f.facts.projection);
  f.facts.authority = fault(
    f.facts.authority,
    'subject.transactionDigest',
    digest('other'),
  );
  assert.throws(
    () =>
      f.service.validateTaskStrategyCallerPatch(
        ROOT,
        f.facts.session.sessionId,
        {
          patch: PATCH,
          callerImplementer,
          implementationSubjectDigest: f.facts.subject.subjectDigest,
        },
      ),
    AUTH_STALE,
  );
});
const providerValidationFaults: [string, unknown][] = [
  ['providerReservation', null],
  ['currentAttempt', null],
  ['providerReservation.recordDigest', digest('other')],
  ['providerReservation.subject.transactionDigest', digest('other')],
  ['providerReservation.subject.sourceTree', '8'.repeat(40)],
  ['currentAttempt.assignment.providerId', null],
  ['currentAttempt.assignment.sessionId', null],
];
for (const [field, value] of providerValidationFaults)
  test(`provider validation rejects independently: ${field}`, () => {
    const f = fixture();
    Object.assign(f.state, fault(f.state, field, value));
    assert.throws(
      () =>
        f.service.validateTaskStrategyProviderPatch(
          ROOT,
          f.facts.session.sessionId,
          f.validateProviderInput,
        ),
      AUTH_STALE,
    );
    assert.ok(!f.events.includes('project'));
    assert.ok(!f.events.includes('environment'));
  });
test('provider reservation authority uses current attempt and permits fresh same-provider session', () => {
  const f = fixture();
  f.state.currentAttempt = fault(
    f.state.currentAttempt,
    'assignment.providerId',
    'codex',
  );
  const mixed = {
    ...f.validateProviderInput,
    implementationResultBindingDigest: 'ignored',
  };
  const result = f.service.validateTaskStrategyProviderPatch(
    ROOT,
    f.facts.session.sessionId,
    mixed,
  );
  assert.deepEqual(result.implementer, {
    providerId: 'codex',
    assurance: 'adapter-assigned',
  });
  assert.ok(!f.events.includes('provider.result'));
  f.state.currentAttempt = fault(
    f.state.currentAttempt,
    'assignment.sessionId',
    f.facts.session.sessionId,
  );
  assert.throws(
    () =>
      f.service.validateTaskStrategyProviderPatch(
        ROOT,
        f.facts.session.sessionId,
        f.validateProviderInput,
      ),
    { code: 'TASK_STRATEGY_IMPLEMENTER_REQUIRED' },
  );
});
const providerResultFaults: [string, unknown][] = [
  ['providerReservation', null],
  ['providerResult', null],
  ['attempt', null],
  ['currentAttempt', null],
  ['providerResult.bindingDigest', digest('other')],
  ['providerReservation.subject.transactionDigest', digest('other')],
  ['providerReservation.subject.sourceTree', '8'.repeat(40)],
  ['providerResult.subjectDigest', digest('other')],
  ['providerResult.roleResult.assignment.providerId', 'codex'],
  ['currentAttempt.request.invocationId', 'retry-new'],
  ['providerResult.output.sessionId', 'session-other'],
  ['providerResult.output.sourceTree', '9'.repeat(40)],
  ['providerResult.output.patchDigest', digest('other')],
  ['providerResult.roleResult.providerInvocation', null],
  ['providerResult.roleResult.assignment.providerId', null],
  ['providerResult.roleResult.assignment.sessionId', null],
];
for (const [field, value] of providerResultFaults)
  test(`provider import rejects independently: ${field}`, () => {
    const f = fixture();
    Object.assign(f.state, fault(f.state, field, value));
    // Assignment equality is a separate guard; keep both sides equal to reach null predicates.
    if (
      field.startsWith('providerResult.roleResult.assignment.') &&
      value === null
    )
      f.state.attempt = fault(
        f.state.attempt,
        field.replace('providerResult.roleResult.', ''),
        value,
      );
    assert.throws(
      () =>
        f.service.importTaskStrategyProviderPatch(
          ROOT,
          f.facts.session.sessionId,
          f.providerInput,
        ),
      AUTH_STALE,
    );
    assert.ok(!f.events.includes('record.read'));
  });
test('provider under-lock import reuses actual journal attempt identity and tail ownership', () => {
  const f = fixture();
  const result = f.service.importTaskStrategyProviderPatchUnderLifecycleLock(
    ROOT,
    f.facts.session.sessionId,
    f.providerInput,
    f.owned,
  );
  assert.equal(f.events[0], 'owned');
  assert.equal(f.events.at(-1), 'owned');
  assert.ok(!f.events.some((e) => e.startsWith('lock.')));
  assert.ok(!f.events.includes('environment'));
  assert.equal(f.args.get('attempt')![0]![0], f.state.providerReservation);
  assert.equal(
    f.args.get('attempt')![0]![1],
    f.state.providerResult!.invocationId,
  );
  assert.equal(result.record.implementer.assurance, 'adapter-assigned');
});
const callerFaults: [string, unknown][] = [
  ['callerResult', null],
  ['callerReservation', null],
  ['callerResult.bindingDigest', digest('other')],
  ['callerResult.subjectDigest', digest('other')],
  ['callerReservation.subjectDigest', digest('other')],
  ['callerResult.output.sessionId', 'session-other'],
  ['callerResult.output.sourceTree', '8'.repeat(40)],
  ['callerResult.output.patchDigest', digest('other')],
  ['callerResult.roleResult.form', 'ordinary-provider'],
  ['callerResult.roleResult.participant', undefined],
  ['callerResult.roleResult.participant.providerId', 'codex'],
  ['callerResult.roleResult.participant.principalId', null],
  [
    'callerResult.roleResult.participant.identityAssurance',
    'maintainer-signed',
  ],
  ['callerResult.roleResult.assignment', undefined],
  [
    'callerResult.roleResult.assignment.degradedForm',
    'same-provider-fresh-session',
  ],
];
for (const [field, value] of callerFaults)
  test(`caller import rejects independently: ${field}`, () => {
    const f = fixture();
    Object.assign(f.state, fault(f.state, field, value));
    assert.throws(
      () =>
        f.service.importTaskStrategyCallerPatchUnderLifecycleLock(
          ROOT,
          f.facts.session.sessionId,
          f.callerInput,
          f.owned,
        ),
      AUTH_STALE,
    );
    assert.equal(f.events.filter((e) => e === 'owned').length, 1);
    assert.ok(!f.events.includes('record.read'));
  });
test('caller under-lock import and reader exceptions preserve identity with no tail ownership', () => {
  const f = fixture();
  const result = f.service.importTaskStrategyCallerPatchUnderLifecycleLock(
    ROOT,
    f.facts.session.sessionId,
    f.callerInput,
    f.owned,
  );
  assert.equal(result.record.implementer.providerId, null);
  assert.equal(f.events.at(-1), 'owned');
  assert.ok(!f.events.includes('environment'));
  const g = fixture();
  const failure = new Error('reader');
  g.reader.resolveCurrentTaskStrategyCorrection = () => {
    throw failure;
  };
  assert.throws(
    () =>
      g.service.importTaskStrategyCallerPatchUnderLifecycleLock(
        ROOT,
        g.facts.session.sessionId,
        g.callerInput,
        g.owned,
      ),
    (e) => e === failure,
  );
  assert.equal(g.events.filter((e) => e === 'owned').length, 1);
});
for (const completed of [false, true])
  test(`provider correction source uses ${completed ? 'originating durable failure' : 'pending projection'} and all exact failure links`, () => {
    const run = (f: ReturnType<typeof fixture>) =>
      f.service.validateTaskStrategyProviderPatch(
        ROOT,
        f.facts.session.sessionId,
        f.validateProviderInput,
      );
    const configure = () => {
      const f = fixture({ correction: true });
      if (completed) {
        const head = imported(
          prepareTaskStrategyPatchRecord({
            sessionId: f.facts.session.sessionId,
            changeId: f.facts.session.changeId,
            taskId: f.facts.session.taskId,
            strategy: f.facts.task.strategy,
            sourceTree: f.facts.subject.sourceTree,
            candidateTree: CANDIDATE,
            taskContractDigest: f.facts.transaction!.taskContractDigest,
            patchDigest: digest(PATCH),
            patchBase64: PATCH.toString('base64'),
            changedPaths: ['src/feature.ts'],
            changes: [
              {
                path: 'src/feature.ts',
                before: null,
                after: { mode: '100644', objectId: '7'.repeat(40) },
              },
            ],
            implementer: {
              providerId: 'claude',
              assurance: 'adapter-assigned',
            },
            createdAt: NOW,
          }),
        );
        f.facts.projection = {
          ...f.facts.projection,
          failure: null,
          head,
          completedCorrectionRounds: 1,
        };
      }
      return f;
    };
    const f = configure();
    assert.equal(run(f).sourceTree, f.facts.failure.candidateTree);
    assert.equal(f.events.includes('failure'), completed);
    for (const [field, value] of [
      ['round', 3],
      ['greenFailureRecordDigest', digest('other')],
      ['greenFailureSubjectDigest', digest('other')],
      ['candidateTree', '8'.repeat(40)],
      ['failingCheckFingerprint', digest('other')],
      ['currentPatchHead.recordDigest', digest('other')],
    ] as const) {
      const g = configure();
      g.state.providerReservation = fault(
        g.state.providerReservation,
        `subject.correction.${field}`,
        value,
      );
      assert.throws(() => run(g), AUTH_STALE);
      assert.ok(!g.events.includes('project'));
    }
  });
test('fresh import deliberately reobserves and retains first metadata, actor and clock phases', () => {
  const f = fixture();
  const originalInspect = f.operations.session.inspect;
  let reads = 0;
  f.operations.session.inspect = (...a) => {
    const first = originalInspect(...a);
    reads++;
    return reads === 1
      ? { ...first, session: { ...first.session, changeId: 'first-change' } }
      : first;
  };
  f.operations.session.inspectExpected = (...a) => {
    f.events.push('inspect.expected');
    assert.equal(a[2].changeId, 'first-change');
    return f.facts.inspection;
  };
  let envReads = 0;
  f.operations.environment = () => {
    f.events.push('environment');
    envReads++;
    return envReads === 1 ? { CODEX_SANDBOX: 'first' } : { CLAUDECODE: '1' };
  };
  // Import captures the first actor; the fresh validation admits the second actor.
  const result = f.service.importTaskStrategyPatch(
    ROOT,
    f.facts.session.sessionId,
    { patch: PATCH },
  );
  assert.equal(reads, 2);
  assert.equal(envReads, 2);
  assert.equal(result.record.changeId, 'first-change');
  assert.equal(result.record.implementer.providerId, 'codex');
  assert.equal(result.record.createdAt, NOW);
  assert.equal(
    result.receipt.importedAt,
    new Date(Date.parse(NOW) + 1000).toISOString(),
  );
  assert.equal(result.binding.createdAt, result.receipt.importedAt);
  assert.equal(f.args.get('apply')![0]![1] instanceof Buffer, true);
  assert.deepEqual(f.args.get('apply')![0]![1], PATCH);
  assert.equal(f.events.filter((e) => e === 'transaction').length, 2);
  assert.equal(f.events.filter((e) => e === 'project').length, 1);
});
test('complete replay returns original durable references and performs no write, clock, projection or apply', () => {
  const f = fixture();
  const initial = f.run();
  f.events.length = 0;
  const replay = f.run();
  for (const key of ['record', 'reservation', 'receipt', 'binding'] as const)
    assert.equal(replay[key], initial[key]);
  assert.ok(Object.isFrozen(replay));
  assert.ok(
    !f.events.some(
      (e) => e.endsWith('.write') || ['clock', 'project', 'apply'].includes(e),
    ),
  );
  assert.equal(f.events.filter((e) => e === 'inspect').length, 1);
});
for (const phase of [
  'reservation-persisted',
  'record-persisted',
  'patch-applied',
  'receipt-persisted',
] as const)
  test(`original interruption ${phase} keeps durable prefix and replays exact remaining effects`, () => {
    const f = fixture();
    assert.throws(
      () =>
        f.service.importTaskStrategyPatch(ROOT, f.facts.session.sessionId, {
          ...f.input,
          testCrashAfter: phase,
        }),
      new RegExp(`after ${phase}`),
    );
    assert.equal(f.state.reservations.size, 1);
    assert.equal(
      f.state.records.size,
      phase === 'reservation-persisted' ? 0 : 1,
    );
    assert.equal(f.state.receipts.size, phase === 'receipt-persisted' ? 1 : 0);
    assert.equal(f.state.bindings.size, 0);
    assert.equal(
      f.state.tree,
      ['patch-applied', 'receipt-persisted'].includes(phase)
        ? CANDIDATE
        : f.facts.subject.sourceTree,
    );
    const time = f.state.clock;
    f.events.length = 0;
    const result = f.run();
    assert.equal(result.record.createdAt, NOW);
    assert.equal(
      f.events.filter((e) => e === 'apply').length,
      ['patch-applied', 'receipt-persisted'].includes(phase) ? 0 : 1,
    );
    assert.equal(f.state.clock - time, phase === 'receipt-persisted' ? 0 : 1);
  });
test('reservation conflict and orphan record fail before any publication', () => {
  const f = fixture();
  const record = f.run();
  f.state.reservations.set(
    record.record.sourceTree,
    fault(record.reservation, 'patchDigest', digest('other')),
  );
  f.events.length = 0;
  assert.throws(f.run, { code: 'TASK_STRATEGY_PATCH_RESERVATION_CONFLICT' });
  assert.equal(f.events.at(-1), 'reservation.read');
  const g = fixture();
  const original = g.run();
  g.state.reservations.clear();
  g.events.length = 0;
  assert.throws(g.run, CORRUPT);
  assert.equal(g.events.at(-1), 'record.read');
  assert.equal(
    g.state.records.get(original.record.sourceTree),
    original.record,
  );
});
for (const [field, value] of [
  ['sessionId', 'session-other'],
  ['changeId', 'other'],
  ['taskId', '1.2'],
  ['strategy', 'tdd-single-agent'],
  ['sourceTree', '8'.repeat(40)],
  ['candidateTree', '3'.repeat(40)],
  ['taskContractDigest', digest('other')],
  ['patchDigest', digest('other')],
  ['patchBase64', Buffer.from('other').toString('base64')],
  ['implementer.providerId', 'codex'],
] as const)
  test(`durable replay rejects current record mismatch ${field}`, () => {
    const f = fixture();
    const original = f.run();
    f.state.records.set(
      original.record.sourceTree,
      fault(original.record, field, value),
    );
    f.events.length = 0;
    assert.throws(f.run, PATCH_STALE);
    assert.equal(f.events.at(-1), 'record.read');
  });
for (const [store, fields] of [
  [
    'reservations',
    [
      'sessionId',
      'patchDigest',
      'recordDigest',
      'sourceTree',
      'candidateTree',
      'createdAt',
    ],
  ],
  ['receipts', ['recordDigest', 'sessionId', 'patchDigest', 'candidateTree']],
  [
    'bindings',
    [
      'sessionId',
      'patchDigest',
      'recordDigest',
      'receiptDigest',
      'candidateTree',
      'createdAt',
    ],
  ],
] as const)
  for (const field of fields)
    test(`durable relation rejects ${store}.${field}`, () => {
      const f = fixture();
      const original = f.run();
      const source = original.record.sourceTree;
      const map = f.state[store] as Map<string, object>;
      map.set(source, fault(map.get(source)!, field, 'different'));
      f.events.length = 0;
      assert.throws(f.run, {
        code:
          store === 'reservations' && field === 'patchDigest'
            ? 'TASK_STRATEGY_PATCH_RESERVATION_CONFLICT'
            : 'TASK_STRATEGY_PATCH_STATE_CORRUPT',
      });
      assert.ok(!f.events.includes('apply'));
      assert.ok(!f.events.some((e) => e.endsWith('.write')));
    });
test('binding without receipt and foreign whole tree are rejected without applying or republishing', () => {
  const f = fixture();
  f.run();
  f.state.receipts.clear();
  assert.throws(f.run, CORRUPT);
  const g = fixture();
  g.run();
  g.state.bindings.clear();
  g.state.receipts.clear();
  g.state.tree = '9'.repeat(40);
  g.events.length = 0;
  assert.throws(g.run, PATCH_STALE);
  assert.equal(g.events.at(-1), 'preview');
});
test('local adoption uses sealed author, repository/session locks and early RED null omits tail ownership', () => {
  const f = fixture({ single: true });
  assert.equal(
    f.service.adoptCurrentTaskStrategyImplementation(
      ROOT,
      f.facts.session.sessionId,
    ),
    null,
  );
  assert.deepEqual(f.events, [
    'load',
    'lock.repository',
    'lock.session',
    'owned',
    'inspect',
    'journal',
    'transaction',
    'preview',
  ]);
  f.state.tree = CANDIDATE;
  f.events.length = 0;
  const result = f.service.adoptCurrentTaskStrategyImplementation(
    ROOT,
    f.facts.session.sessionId,
  );
  assert.ok(result);
  assert.deepEqual(result.record.implementer, f.facts.transaction!.author);
  assert.notEqual(result.record.implementer, f.facts.transaction!.author);
  assert.ok(!f.events.includes('environment'));
  assert.ok(!f.events.includes('apply'));
  assert.equal(f.events.at(-1), 'owned');
  f.state.tree = f.facts.transaction!.red.candidateTree;
  assert.equal(
    f.service.adoptCurrentTaskStrategyImplementation(
      ROOT,
      f.facts.session.sessionId,
    ),
    null,
  );
});
test('local correction publishes exact round links in reserve→patch→result→import→owned order', () => {
  const f = fixture({ single: true, correction: true });
  f.state.tree = CANDIDATE;
  const result = f.service.adoptCurrentTaskStrategyCorrection(
    ROOT,
    f.facts.session.sessionId,
  );
  assert.ok(result);
  assert.deepEqual(
    f.events.filter(
      (e) => e.startsWith('round.') || e.endsWith('.write') || e === 'owned',
    ),
    [
      'owned',
      'round.reserve',
      'reservation.write',
      'record.write',
      'receipt.write',
      'binding.write',
      'round.result',
      'round.import',
      'owned',
    ],
  );
  const reserve = f.args.get('round.reserve')![0]![0] as Parameters<
    TaskStrategyPatchJournal['correction']['reserve']
  >[0];
  const published = f.args.get('round.result')![0]![0] as Parameters<
    TaskStrategyPatchJournal['correction']['publishResult']
  >[0];
  const importedRound = f.args.get('round.import')![0]![0] as Parameters<
    TaskStrategyPatchJournal['correction']['publishImport']
  >[0];
  assert.equal(reserve.predecessorFailure, f.facts.failure);
  assert.equal(reserve.policy, f.operations.correctionPolicy);
  assert.equal(
    published.correctionSubjectDigest,
    reserve.correctionSubjectDigest,
  );
  assert.deepEqual(published.patchResult, {
    sourceTree: result.record.sourceTree,
    targetCandidateTree: result.record.candidateTree,
    patchRecordDigest: result.record.recordDigest,
    patchDigest: result.record.patchDigest,
  });
  assert.equal(
    importedRound.currentPatchHead.bindingDigest,
    result.binding.bindingDigest,
  );
  assert.equal(
    importedRound.importReceipt.receiptDigest,
    result.receipt.receiptDigest,
  );
  assert.equal(importedRound.importedAt, result.receipt.importedAt);
});
for (const [field, value] of [
  ['exhausted', true],
  ['failure', null],
  ['correctionState', null],
  ['correctionState.state', 'correction-exhausted'],
] as const)
  test(`local correction guard ${field} precedes preview/reservation`, () => {
    const f = fixture({ single: true, correction: true });
    f.facts.projection = fault(f.facts.projection, field, value);
    assert.throws(
      () =>
        f.service.adoptCurrentTaskStrategyCorrection(
          ROOT,
          f.facts.session.sessionId,
        ),
      { code: 'TASK_STRATEGY_CORRECTION_NOT_APPLICABLE' },
    );
    assert.ok(!f.events.includes('preview'));
    assert.equal(f.events.filter((e) => e === 'owned').length, 1);
  });
test('local correction unchanged failure returns null and never writes or performs final owned check', () => {
  const f = fixture({ single: true, correction: true });
  assert.equal(
    f.service.adoptCurrentTaskStrategyCorrection(
      ROOT,
      f.facts.session.sessionId,
    ),
    null,
  );
  assert.equal(f.events.filter((e) => e === 'owned').length, 1);
  assert.ok(!f.events.some((e) => e.startsWith('round.')));
});
// Authenticated wire records form the complete chain. Only repository observations
// and actual reverse effects are in memory; the production policy performs traversal.
function restoration(
  candidates = ['4'.repeat(40), '5'.repeat(40), '6'.repeat(40)],
) {
  const f = fixture({ single: true });
  let source = f.facts.transaction!.red.candidateTree;
  const chain = candidates.map((candidate, index) => {
    const bytes = Buffer.from(`patch-${index}`);
    const record = prepareTaskStrategyPatchRecord({
      sessionId: f.facts.session.sessionId,
      changeId: f.facts.session.changeId,
      taskId: f.facts.session.taskId,
      strategy: f.facts.task.strategy,
      sourceTree: source,
      candidateTree: candidate,
      taskContractDigest: f.facts.transaction!.taskContractDigest,
      patchDigest: digest(bytes),
      patchBase64: bytes.toString('base64'),
      changedPaths: ['src/feature.ts'],
      changes: [
        {
          path: 'src/feature.ts',
          before: { mode: '100644', objectId: source },
          after: { mode: '100644', objectId: candidate },
        },
      ],
      implementer: f.facts.transaction!.author,
      createdAt: NOW,
    });
    source = candidate;
    const value = imported(record);
    f.seed(value);
    return value;
  });
  f.facts.projection = { ...f.facts.projection, head: chain.at(-1)! };
  f.state.tree = source;
  f.operations.repository.readRegularTreeEntry = (root, tree, p) => {
    f.events.push('entry');
    return { mode: '100644', objectId: tree };
  };
  f.operations.repository.applyPatchToWorktree = (root, bytes, reverse) => {
    assert.equal(reverse, true);
    const record = chain.find((value) =>
      Buffer.from(value.record.patchBase64, 'base64').equals(bytes),
    )!.record;
    assert.equal(f.state.tree, record.candidateTree);
    f.events.push(`reverse:${chain.findIndex((v) => v.record === record)}`);
    f.state.tree = record.sourceTree;
  };
  const run = (owned = f.owned) =>
    f.service.restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock(
      ROOT,
      f.facts.session.sessionId,
      f.facts.transaction!,
      owned,
    );
  return { ...f, chain, run };
}
test('three-record restoration resumes after two real reverse effects from only the remaining prefix', () => {
  const f = restoration();
  const interrupted = new Error('after-two');
  let owned = 0;
  assert.throws(
    () =>
      f.run(() => {
        f.owned();
        if (++owned === 3) throw interrupted;
      }),
    (e) => e === interrupted,
  );
  assert.equal(f.state.tree, f.chain[0]!.record.candidateTree);
  assert.deepEqual(
    f.events.filter((e) => e.startsWith('reverse:')),
    ['reverse:2', 'reverse:1'],
  );
  f.events.length = 0;
  assert.equal(f.run(), f.chain[0]!.record);
  assert.deepEqual(
    f.events.filter((e) => e.startsWith('reverse:')),
    ['reverse:0'],
  );
  assert.equal(f.state.tree, f.facts.transaction!.red.candidateTree);
  f.events.length = 0;
  assert.equal(f.run(), f.chain[0]!.record);
  assert.equal(f.events.filter((e) => e === 'binding.read').length, 3);
  assert.ok(!f.events.some((e) => e.startsWith('reverse:')));
});
test('repeated candidate tree selects latest authenticated boundary deterministically', () => {
  const duplicate = '4'.repeat(40);
  const f = restoration([duplicate, '5'.repeat(40), duplicate]);
  assert.equal(f.run(), f.chain[0]!.record);
  assert.deepEqual(
    f.events.filter((e) => e.startsWith('reverse:')),
    ['reverse:2', 'reverse:1', 'reverse:0'],
  );
});
test('restoration authenticates complete chain and head even when already at RED', () => {
  for (const defect of [
    'transaction',
    'head',
    'reservation',
    'receipt',
    'binding',
  ]) {
    const f = restoration();
    f.state.tree = f.facts.transaction!.red.candidateTree;
    if (defect === 'transaction')
      f.facts.projection = fault(
        f.facts.projection,
        'transaction.recordDigest',
        digest('other'),
      );
    else if (defect === 'head')
      f.facts.projection = fault(
        f.facts.projection,
        'head.record.recordDigest',
        digest('other'),
      );
    else {
      const key = f.chain[1]!.record.sourceTree;
      if (defect === 'reservation') f.state.reservations.delete(key);
      if (defect === 'receipt')
        f.state.receipts.set(
          key,
          fault(f.chain[1]!.receipt, 'candidateTree', '9'.repeat(40)),
        );
      if (defect === 'binding')
        f.state.bindings.set(
          key,
          fault(f.chain[1]!.binding, 'receiptDigest', digest('other')),
        );
    }
    assert.throws(() => f.run(), {
      code: ['transaction', 'head'].includes(defect)
        ? 'TASK_STRATEGY_PATCH_STALE'
        : 'TASK_STRATEGY_PATCH_STATE_CORRUPT',
    });
    assert.ok(!f.events.some((e) => e.startsWith('reverse:')));
  }
});
test('restoration refuses foreign full tree before reading entries and permits no-chain exact RED', () => {
  const f = restoration();
  f.state.tree = '9'.repeat(40);
  assert.throws(() => f.run(), PATCH_STALE);
  assert.ok(!f.events.includes('entry'));
  const g = fixture({ single: true });
  const run = () =>
    g.service.restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock(
      ROOT,
      g.facts.session.sessionId,
      g.facts.transaction!,
      g.owned,
    );
  assert.equal(run(), null);
  g.state.tree = '9'.repeat(40);
  assert.throws(run, PATCH_STALE);
});
test('reverse inspectExpected failure remains resumable from the exact applied boundary', () => {
  const f = restoration();
  const original = f.operations.session.inspectExpected;
  const failure = new Error('inspect after reverse');
  f.operations.session.inspectExpected = () => {
    throw failure;
  };
  assert.throws(
    () => f.run(),
    (e) => e === failure,
  );
  assert.equal(f.state.tree, f.chain[1]!.record.candidateTree);
  f.operations.session.inspectExpected = original;
  f.events.length = 0;
  f.run();
  assert.deepEqual(
    f.events.filter((e) => e.startsWith('reverse:')),
    ['reverse:1', 'reverse:0'],
  );
});
test('under-lifecycle entry and trailing ownership failures retain original error and committed prefix', () => {
  for (const tail of [false, true]) {
    const f = fixture();
    const failure = new Error(tail ? 'tail' : 'entry');
    let checks = 0;
    assert.throws(
      () =>
        f.service.importTaskStrategyProviderPatchUnderLifecycleLock(
          ROOT,
          f.facts.session.sessionId,
          f.providerInput,
          () => {
            if (++checks === (tail ? 2 : 1)) throw failure;
          },
        ),
      (e) => e === failure,
    );
    assert.equal(f.state.bindings.size, tail ? 1 : 0);
    assert.equal(f.events.length === 0, !tail);
    if (tail) {
      f.events.length = 0;
      f.service.importTaskStrategyProviderPatchUnderLifecycleLock(
        ROOT,
        f.facts.session.sessionId,
        f.providerInput,
        f.owned,
      );
      assert.ok(!f.events.includes('apply'));
      assert.ok(!f.events.includes('clock'));
    }
  }
});
test('caller current-subject and missing grant-key predicates stay distinct from wire parsing', () => {
  for (const changed of [
    'transactionDigest',
    'subjectDigest',
    'missingGrant',
  ]) {
    const f = fixture();
    if (changed === 'missingGrant') {
      const assignment = {
        ...f.state.callerResult!.roleResult.assignment,
      } as Record<string, unknown>;
      delete assignment.grantId;
      f.state.callerResult = fault(
        f.state.callerResult,
        'roleResult.assignment',
        assignment,
      );
    } else
      f.facts.authority = fault(
        f.facts.authority,
        `subject.${changed}`,
        digest('other'),
      );
    assert.throws(
      () =>
        f.service.importTaskStrategyCallerPatchUnderLifecycleLock(
          ROOT,
          f.facts.session.sessionId,
          f.callerInput,
          f.owned,
        ),
      AUTH_STALE,
    );
    assert.ok(!f.events.includes('record.read'));
  }
});
test('mixed provider-result and caller-result discriminants preserve provider-result priority', () => {
  const f = fixture();
  const mixed = { ...f.providerInput, ...f.callerInput };
  f.service.importTaskStrategyProviderPatch(
    ROOT,
    f.facts.session.sessionId,
    mixed,
  );
  assert.ok(f.events.includes('provider.result'));
  assert.ok(!f.events.includes('caller.result'));
});
test('same-provider same-session allowances require exact granted degradation in both provider paths', () => {
  const f = fixture();
  const assignment = {
    ...f.state.currentAttempt!.assignment,
    providerId: 'codex',
    sessionId: f.facts.session.sessionId,
    grantId: GRANT_ID,
    degradedForm: 'same-provider-fresh-session',
  };
  f.state.currentAttempt = fault(
    f.state.currentAttempt,
    'assignment',
    assignment,
  );
  assert.equal(
    f.service.validateTaskStrategyProviderPatch(
      ROOT,
      f.facts.session.sessionId,
      f.validateProviderInput,
    ).implementer.providerId,
    'codex',
  );
  const g = fixture();
  g.state.attempt = fault(g.state.attempt, 'assignment', assignment);
  g.state.currentAttempt = g.state.attempt;
  g.state.providerResult = fault(
    g.state.providerResult,
    'roleResult.assignment',
    assignment,
  );
  assert.throws(
    () =>
      g.service.importTaskStrategyProviderPatch(
        ROOT,
        g.facts.session.sessionId,
        g.providerInput,
      ),
    { code: 'TASK_STRATEGY_IMPLEMENTER_REQUIRED' },
  );
  g.state.providerResult = fault(
    g.state.providerResult,
    'roleResult.form',
    'granted-same-provider',
  );
  g.state.providerResult = fault(
    g.state.providerResult,
    'roleResult.grantUse',
    { degradedForm: 'same-provider-fresh-session' },
  );
  assert.equal(
    g.service.importTaskStrategyProviderPatch(
      ROOT,
      g.facts.session.sessionId,
      g.providerInput,
    ).record.implementer.providerId,
    'codex',
  );
});
test('sealed local authority never applies bytes if worktree reverts between adoption and import', () => {
  const f = fixture({ single: true });
  f.state.tree = CANDIDATE;
  f.service.adoptCurrentTaskStrategyImplementation(
    ROOT,
    f.facts.session.sessionId,
  );
  f.state.receipts.clear();
  f.state.bindings.clear();
  let previews = 0;
  f.operations.session.previewCandidate = () => ({
    tree: ++previews === 1 ? CANDIDATE : f.facts.transaction!.red.candidateTree,
  });
  f.events.length = 0;
  assert.throws(
    () =>
      f.service.adoptCurrentTaskStrategyImplementation(
        ROOT,
        f.facts.session.sessionId,
      ),
    PATCH_STALE,
  );
  assert.ok(!f.events.includes('apply'));
  assert.ok(!f.events.includes('clock'));
});
for (const [name, inject] of [
  [
    'inspection',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.session.inspect = () => {
        throw fail;
      };
    },
  ],
  [
    'journal',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.observeJournal = () => {
        throw fail;
      };
    },
  ],
  [
    'transaction',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.journal.correction.readTransaction = () => {
        throw fail;
      };
    },
  ],
  [
    'projection',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.repository.applyPatchToIsolatedTree = () => {
        throw fail;
      };
    },
  ],
  [
    'preview',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.session.previewCandidate = () => {
        throw fail;
      };
    },
  ],
  [
    'entry',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.repository.readRegularTreeEntry = () => {
        throw fail;
      };
    },
  ],
  [
    'clock',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.clock = {
        now: () => {
          throw fail;
        },
      };
    },
  ],
  [
    'reservation',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.journal.patch.reserve = () => {
        throw fail;
      };
    },
  ],
  [
    'record',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.journal.patch.persistRecord = () => {
        throw fail;
      };
    },
  ],
  [
    'apply',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.repository.applyPatchToWorktree = () => {
        throw fail;
      };
    },
  ],
  [
    'expected inspection',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.operations.session.inspectExpected = () => {
        throw fail;
      };
    },
  ],
  [
    'receipt',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.journal.patch.createImportReceipt = () => {
        throw fail;
      };
    },
  ],
  [
    'binding',
    (f: ReturnType<typeof fixture>, fail: Error) => {
      f.journal.patch.createCurrentBinding = () => {
        throw fail;
      };
    },
  ],
] as const)
  test(`original ${name} exception keeps identity and prevents trailing owned check`, () => {
    const f = fixture();
    const failure = new Error(name);
    inject(f, failure);
    assert.throws(
      () =>
        f.service.importTaskStrategyProviderPatchUnderLifecycleLock(
          ROOT,
          f.facts.session.sessionId,
          f.providerInput,
          f.owned,
        ),
      (e) => e === failure,
    );
    assert.equal(f.events.filter((e) => e === 'owned').length, 1);
  });
for (const count of [65, 66])
  test(`restoration head-before-limit precedence at ${count} authenticated records`, () => {
    const f = restoration(
      Array.from({ length: count }, (_, n) =>
        (n + 16).toString(16).padStart(40, '0'),
      ),
    );
    if (count === 65) {
      assert.equal(f.run(), f.chain[0]!.record);
      assert.equal(f.events.filter((e) => e.startsWith('reverse:')).length, 65);
    } else {
      assert.throws(() => f.run(), PATCH_STALE);
      assert.ok(!f.events.some((e) => e.startsWith('reverse:')));
      assert.equal(f.events.filter((e) => e === 'record.read').length, 65);
    }
  });
test('restoration rejects changed entries and verifies full source tree even when every entry looks restored', () => {
  for (const observed of ['foreign', 'before']) {
    const f = restoration();
    f.operations.repository.readRegularTreeEntry = () => ({
      mode: '100644',
      objectId:
        observed === 'foreign'
          ? '9'.repeat(40)
          : f.chain.at(-1)!.record.sourceTree,
    });
    assert.throws(() => f.run(), PATCH_STALE);
    assert.ok(!f.events.some((e) => e.startsWith('reverse:')));
    assert.ok(!f.events.includes('inspect.expected'));
  }
});

test('explicit environment is read directly without cloning or consulting production defaults', () => {
  const f = fixture({ single: true });
  const reads: string[] = [];
  const environment = new Proxy(
    { CODEX_SANDBOX: 'memory' },
    {
      ownKeys() {
        throw new Error('environment must not be cloned');
      },
      get(target, key, receiver) {
        assert.equal(receiver, environment);
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    },
  );
  f.service.validateTaskStrategyPatch(ROOT, f.facts.session.sessionId, {
    patch: PATCH,
    environment,
  });
  assert.deepEqual(reads, [
    'AGENT',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_SANDBOX',
  ]);
  assert.ok(!f.events.includes('environment'));
});

test('cyclic authenticated source chain with no matching head terminates before repository effects', () => {
  const f = restoration(['4'.repeat(40), '5'.repeat(40), '4'.repeat(40)]);
  f.facts.projection = fault(
    f.facts.projection,
    'head.record.recordDigest',
    digest('unreachable-head'),
  );
  assert.throws(() => f.run(), PATCH_STALE);
  assert.equal(f.events.filter((e) => e === 'record.read').length, 65);
  assert.ok(!f.events.includes('entry'));
  assert.ok(!f.events.some((e) => e.startsWith('reverse:')));
});
