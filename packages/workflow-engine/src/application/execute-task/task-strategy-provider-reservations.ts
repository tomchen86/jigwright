import type { TaskStrategyImplementationOperations } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationSession } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationJournal } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyTransaction } from '../../modules/assurance/task-strategy-evidence.ts';
import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import { taskStrategyImplementationReservationForAttempt } from '../../modules/assurance/task-strategy-implementation-attempt.ts';
import type { TaskMandateProviderAdmission } from '../../modules/authority/task-mandate-access-contract.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';

import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
/**
 * Reserves implementation providers and authorizes their retry attempts.
 *
 * Invariants:
 * - A retry reservation requires the same failed attempt with a retryable
 *   failure.
 */
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  createTaskStrategyImplementationManifest,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type RoleParticipant,
  scheduleOrdinaryRole,
  type ProviderRoleAssignment,
  type GrantedSameProviderRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';
import { type TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { authorizeAutomaticProviderRetry } from '../../modules/provider-orchestration/provider-retry-decision.ts';
import {
  createReplacementAttempt,
  providerExecutionPolicySnapshot,
  providerExecutionEnvironmentDigest,
} from '../../modules/provider-orchestration/execution-core.ts';
import { bindingFromPayload } from '../../modules/authority/collaboration-grant-codec.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type {
  BeginTaskStrategyImplementationOptions,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
import type { TaskStrategyGreenFailureRecord } from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
import type { TaskStrategyImplementationReservation } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { TaskStrategyImplementationProviderAttempt } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { ProviderRetryDecisionBinding } from '../../modules/provider-orchestration/provider-invocation-reservations.ts';

import type { createTaskStrategyImplementationContext } from './task-strategy-implementation-context.ts';
import type { createTaskStrategyCallerAdmission } from './task-strategy-caller-admission.ts';
export function createTaskStrategyProviderReservations(
  roleAdmission: Pick<RoleAdmissionServices, 'authorizeGrantedOrdinaryRole'>,
  operations: Pick<
    TaskStrategyImplementationOperations,
    'collaboration' | 'dataPolicy' | 'clock'
  >,
  context: ReturnType<typeof createTaskStrategyImplementationContext>,
  callerAdmission: ReturnType<typeof createTaskStrategyCallerAdmission>,
  taskMandate: Pick<
    TaskMandateProviderAdmission,
    'authorizeTaskMandateProviderReservationUnderLifecycleLock'
  >,
) {
  const { authorizeTaskMandateProviderReservationUnderLifecycleLock } =
    taskMandate;
  const { authorizeGrantedOrdinaryRole } = roleAdmission;

  const {
    implementationTask,
    baselineAdapterPolicy,
    sha256,
    recordRedAuthor,
    implementationGrantRequest,
    collaborationPause,
    deriveCollaborationGrantBinding,
    resolveAuthoritativeCollaborationGrantVerifier,
    implementationResultStale,
    requireRecordedRedAuthor,
    collaborationTransitionDigest,
    requestConflict,
  } = context;
  const { importCallerSuppliedImplementation } = callerAdmission;
  function createImplementationReservation(
    context: TaskStrategyImplementationSession,
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    subject: TaskStrategyImplementationSubject,
    greenFailureRecord: TaskStrategyGreenFailureRecord | null,
    task: ReturnType<typeof implementationTask>,
    collaborationGrant:
      BeginTaskStrategyImplementationOptions['collaborationGrant'] | undefined,
    testCrashAfter: BeginTaskStrategyImplementationOptions['testCrashAfter'],
    assertOwned: () => void,
  ): TaskStrategyImplementationReservation | TaskStrategyImplementationStatus {
    if (collaborationGrant === undefined) {
      const binding = runtime.implementation.readCallerResult(
        context.session.sessionId,
        subject.subjectDigest,
      );
      if (binding !== null) {
        const reservation = runtime.implementation.readCallerReservation(
          context.session.sessionId,
          subject.subjectDigest,
        );
        if (reservation === null) throw implementationResultStale();
        runtime.implementation.assertCallerCurrent(
          transaction,
          subject,
          reservation,
          binding,
        );
        const participant = reservation.assignment.participant;
        if (
          participant.principalId === null ||
          (participant.identityAssurance !== 'self-declared' &&
            participant.identityAssurance !== 'runtime-hint' &&
            participant.identityAssurance !== 'adapter-assigned')
        ) {
          throw implementationResultStale();
        }
        const redAuthor = recordRedAuthor(transaction);
        return importCallerSuppliedImplementation(
          context,
          runtime,
          transaction,
          subject,
          greenFailureRecord,
          {
            providerId: redAuthor.providerId ?? undefined,
            sessionId: redAuthor.sessionId ?? undefined,
            principalId: redAuthor.principalId ?? undefined,
            identityAssurance: redAuthor.identityAssurance,
            engineSpawned: false,
          },
          {
            grantId: reservation.grantId,
            callerSupplied: {
              callerId: participant.principalId,
              assurance: participant.identityAssurance,
              patch: Buffer.from(binding.output.patchBase64, 'base64'),
            },
          },
          testCrashAfter,
          assertOwned,
        );
      }
    }
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    const seed = sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-strategy-implementation-owner.v1',
        sessionId: context.session.sessionId,
        subjectDigest: subject.subjectDigest,
      }),
    );
    const providerSessionId = `provider-session-task-implementation-${seed}`;
    const redAuthor = recordRedAuthor(transaction);
    const author: RoleParticipant = {
      providerId: redAuthor.providerId ?? undefined,
      sessionId: redAuthor.sessionId ?? undefined,
      principalId: redAuthor.principalId ?? undefined,
      identityAssurance: redAuthor.identityAssurance,
      engineSpawned: false,
    };
    const candidates = listProviderIds().map((providerId) => ({
      providerId,
      sessionId: providerSessionId,
      enabled: policy.policy.providers[providerId].enabled,
      available: policy.policy.providers[providerId].enabled,
    }));
    const scheduled = scheduleOrdinaryRole({
      role: 'task-implementer',
      author,
      targetDigest: subject.subjectDigest,
      candidates,
    });
    let assignment: ProviderRoleAssignment;
    if (scheduled.outcome !== 'assigned') {
      const callableProviderIds = candidates
        .filter(({ enabled, available }) => enabled && available)
        .map(({ providerId }) => providerId);
      const grantRequest = implementationGrantRequest(
        context,
        subject,
        redAuthor,
        callableProviderIds,
      );
      if (collaborationGrant === undefined) {
        return collaborationPause(
          context.session.sessionId,
          subject,
          grantRequest,
        );
      }
      if (grantRequest === null) {
        return importCallerSuppliedImplementation(
          context,
          runtime,
          transaction,
          subject,
          greenFailureRecord,
          author,
          collaborationGrant,
          testCrashAfter,
          assertOwned,
        );
      }
      const expected = deriveCollaborationGrantBinding(
        context.git.repositoryRoot,
        grantRequest,
      );
      const reservation = operations.collaboration.reserve(
        context.git.repositoryRoot,
        collaborationGrant.grantId,
        {
          transitionDigest: sha256(
            canonicalJson({
              schemaVersion: 1,
              kind: 'collaboration-role-transition',
              expectedBinding: expected,
            }),
          ),
          expected,
          ...(collaborationGrant.now === undefined
            ? {}
            : { now: collaborationGrant.now }),
          verifier: resolveAuthoritativeCollaborationGrantVerifier(
            collaborationGrant.verifier,
          ),
        },
        assertOwned,
      );
      assignment = authorizeGrantedOrdinaryRole({
        role: 'task-implementer',
        author,
        targetDigest: subject.subjectDigest,
        reservation,
        actualParticipant: {
          providerId: redAuthor.providerId ?? undefined,
          sessionId: providerSessionId,
          principalId: `collaboration-grant:${reservation.grantId}:task-implementer`,
          identityAssurance: redAuthor.identityAssurance,
          engineSpawned: true,
        },
        callableProviderIds,
      }) as GrantedSameProviderRoleAssignment;
    } else {
      assignment = scheduled.assignment;
    }

    const ownerInvestigationId = `investigation-task-implementation-${seed}`;
    const mandateBinding = (context.session.mandateBinding ??
      null) as TaskMandateBinding | null;
    const authorization = createEvidenceNode({
      type: 'task-strategy-implementation-authorization',
      nodeSchema: 'workflow.task-strategy-implementation-authorization.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        author: sha256(canonicalJson(redAuthor)),
        mandate: sha256(canonicalJson(mandateBinding)),
        session: sha256(
          canonicalJson({
            sessionId: context.session.sessionId,
            changeId: context.session.changeId,
            taskId: context.session.taskId,
          }),
        ),
        subject: subject.subjectDigest,
        transaction: transaction.recordDigest,
      },
      semanticParentResultDigests: {
        red: transaction.red.evidenceResultDigest,
      },
      provenanceParentNodeIds: { red: transaction.red.evidenceNodeId },
      outputSchema:
        'workflow.task-strategy-implementation-authorization-output.v1',
      output: {
        ownerInvestigationId,
        sessionId: context.session.sessionId,
        changeId: context.session.changeId,
        taskId: context.session.taskId,
        subject,
        redAuthor,
        assignment,
        mandateBinding,
      },
      runtimeMetadata: {},
    });
    runtime.evidence.write(authorization);
    const manifest = createTaskStrategyImplementationManifest({
      repositoryId: context.config.repositoryName,
      baseCommit: context.session.baseline.head,
      baseTree: context.session.baseline.tree,
      subject,
      behaviorContractRefs: task.behaviorContractRefs,
      implementationPathScopes: task.implementationPathScopes,
      ...(greenFailureRecord === null ? {} : { greenFailureRecord }),
    });
    const request = createProviderInvocationRequest({
      invocationId: `invocation-task-implementation-${seed}`,
      nonce: `task-implementation-${seed}`,
      purpose: 'task-implementation',
      providerId: assignment.providerId,
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: context.config.repositoryName,
      baseCommit: context.session.baseline.head,
      baseTree: context.session.baseline.tree,
      targetDigest: subject.subjectDigest,
      inputManifestDigest: sha256(canonicalJson(manifest)),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
      evaluatorVersion: 'task-strategy-implementation.v1',
      policyDigest: policy.digest,
      limits: {
        timeoutMs: policy.policy.limits.timeoutMs,
        aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
      },
    });
    const requestReservation = createEvidenceNode({
      type: 'task-strategy-implementation-request-reservation',
      nodeSchema: 'workflow.task-strategy-implementation-reservation.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        manifest: request.inputManifestDigest,
        request: request.requestDigest,
        subject: subject.subjectDigest,
      },
      semanticParentResultDigests: {
        authorization: authorization.resultDigest,
      },
      provenanceParentNodeIds: { authorization: authorization.nodeId },
      outputSchema:
        'workflow.task-strategy-implementation-reservation-output.v1',
      output: {
        ownerInvestigationId,
        sessionId: context.session.sessionId,
        changeId: context.session.changeId,
        taskId: context.session.taskId,
        subject,
        redAuthor,
        assignment,
        manifest,
        request,
        mandateBinding,
      },
      runtimeMetadata: {},
    });
    runtime.provider.storePolicy(request, policy);
    runtime.evidence.write(requestReservation);
    return runtime.implementation.reserve({
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      repositoryRoot: context.git.repositoryRealPath,
      gitCommonDirectory: context.git.gitCommonDirectory,
      branch: context.session.branch,
      baseline: context.session.baseline,
      mandateBinding,
      subject,
      redAuthor,
      assignment,
      manifest,
      request,
      authorizationNodeId: authorization.nodeId,
      reservationNodeId: requestReservation.nodeId,
      createdAt: transaction.createdAt,
    });
  }

  function reserveProviderRetryAttempt(
    context: TaskStrategyImplementationSession,
    runtime: TaskStrategyImplementationJournal,
    root: TaskStrategyImplementationReservation,
    failedAttempt: TaskStrategyImplementationProviderAttempt,
    options: BeginTaskStrategyImplementationOptions,
    assertOwned: () => void,
    readProviderRetryAccountingEvidence: ProviderRetryAccountingReader,
  ):
    | TaskStrategyImplementationProviderAttempt
    | TaskStrategyImplementationStatus {
    const failed = runtime.provider.read(failedAttempt.request.invocationId);
    if (
      failed.state !== 'failed' ||
      failed.failure === null ||
      failed.failure.kind !== 'retryable' ||
      failed.attempt !== failedAttempt.attempt
    ) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_NOT_ALLOWED',
        root.sessionId,
      );
    }
    const nextAttempt = failed.attempt + 1;
    const retrySeed = sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-strategy-implementation-transport-retry.v1',
        rootReservationDigest: root.recordDigest,
        failedInvocationId: failed.invocationId,
        failedRevision: failed.revision,
        failure: failed.failure,
        attempt: nextAttempt,
      }),
    );
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    let assignment = failedAttempt.assignment;
    let authorizationNode = runtime.evidence.read(
      failedAttempt.authorizationNodeId,
    );
    let replacementRequest = createProviderRetryRequest({
      failedAttempt,
      assignment,
      authorizationNodeId: authorizationNode.nodeId,
      policy,
      retrySeed,
    });
    let authorization = authorizeAutomaticProviderRetry(
      readProviderRetryAccountingEvidence(
        runtime.paths,
        failed,
        failedAttempt.request,
      ),
      {
        failed,
        failedRequest: failedAttempt.request,
        replacementRequest,
        replacementExecutionPolicy: policy,
        dataAuthorizationPolicyPort: operations.dataPolicy,
        now: operations.clock.now().toISOString(),
      },
    );
    let strategyChanges: string[] = [];
    if (authorization.decision.retryMode === 'strategy-change') {
      const changed = authorizeTaskStrategyRetryStrategyChange({
        context,
        root,
        failedAttempt,
        retrySeed,
        policy,
        collaborationGrant: options.collaborationGrant,
        assertOwned,
      });
      if ('state' in changed) return changed;
      assignment = changed.assignment;
      strategyChanges =
        failedAttempt.assignment.providerId === assignment.providerId
          ? [
              `provider-session:${failedAttempt.assignment.sessionId}->${assignment.sessionId}`,
            ]
          : [
              `provider:${failedAttempt.assignment.providerId}->${assignment.providerId}`,
            ];
      authorizationNode = createProviderRetryAuthorization(
        runtime,
        root,
        assignment,
      );
      replacementRequest = createProviderRetryRequest({
        failedAttempt,
        assignment,
        authorizationNodeId: authorizationNode.nodeId,
        policy,
        retrySeed,
      });
      authorization = authorizeAutomaticProviderRetry(
        readProviderRetryAccountingEvidence(
          runtime.paths,
          failed,
          failedAttempt.request,
        ),
        {
          failed,
          failedRequest: failedAttempt.request,
          replacementRequest,
          replacementExecutionPolicy: policy,
          dataAuthorizationPolicyPort: operations.dataPolicy,
          now: operations.clock.now().toISOString(),
        },
      );
    } else if (options.collaborationGrant !== undefined) {
      if (
        !('grantId' in root.assignment) ||
        root.assignment.grantId !== options.collaborationGrant.grantId
      ) {
        throw providerRetryDenied(
          'TASK_STRATEGY_IMPLEMENTATION_RETRY_GRANT_OWNER_MISMATCH',
          root.sessionId,
        );
      }
    }
    const retryMode = authorization.decision.retryMode;
    if (
      !authorization.decision.retryable ||
      !authorization.decision.automatic ||
      (retryMode !== 'same-input' && retryMode !== 'strategy-change') ||
      (retryMode === 'strategy-change' && strategyChanges.length === 0)
    ) {
      throw providerRetryDenied(
        authorization.decision.reasonCode,
        root.sessionId,
      );
    }
    const replacement = createReplacementAttempt({
      workflow: authorization.workflow,
      job: authorization.job,
      previousAttempt: authorization.attempt,
      attemptId: `attempt-provider-${replacementRequest.invocationId}`,
      retryMode,
      currentExecutionPolicy:
        providerExecutionPolicySnapshot(replacementRequest),
      strategyChanges,
      environmentDigest: providerExecutionEnvironmentDigest(replacementRequest),
      createdAt: authorization.evaluatedAt,
    });
    if (
      replacement.job.jobId !== authorization.job.jobId ||
      replacement.attempt.attemptNumber !== nextAttempt ||
      replacement.attempt.retryOf !== authorization.attempt.attemptId
    ) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_LINEAGE_INVALID',
        root.sessionId,
      );
    }
    const retryDecision: ProviderRetryDecisionBinding = Object.freeze({
      schemaVersion: 1,
      kind: 'provider-retry-decision-binding',
      executionJobId: authorization.job.jobId,
      executionRevision: authorization.executionRevision,
      failedAttemptId: authorization.attempt.attemptId,
      evidenceDigest: authorization.evidenceDigest,
      evaluatedAt: authorization.evaluatedAt,
    });
    const requestReservation = createProviderRetryRequestReservation(
      runtime,
      root,
      failedAttempt,
      replacementRequest,
      authorizationNode,
      retryDecision,
    );
    const persisted = runtime.provider.reserveRetry({
      investigationId: root.ownerInvestigationId,
      changeId: root.changeId,
      attempt: nextAttempt,
      previousInvocationId: failed.invocationId,
      manifest: root.manifest,
      request: replacementRequest,
      executionPolicy: policy,
      retryDecision,
      replacement: {
        attemptId: replacement.attempt.attemptId,
        retryMode: replacement.attempt.retryMode as
          'same-input' | 'strategy-change',
        strategyChanges: [...replacement.attempt.strategyChanges],
        environmentDigest: replacement.attempt.environmentDigest,
        executionGrantId: replacement.attempt.grantId,
        authorizationNodeId: authorizationNode.nodeId,
        reservationNodeId: requestReservation.nodeId,
      },
      ...(root.mandateBinding === null
        ? {}
        : { mandateBinding: root.mandateBinding }),
      createdAt: authorization.evaluatedAt,
    });
    if (persisted.schemaVersion !== 3) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_RESERVATION_INVALID',
        root.sessionId,
      );
    }
    if (options.testCrashAfter === 'provider-retry-reservation-persisted') {
      throw new Error(
        'Simulated task implementation interruption after provider retry reservation persistence.',
      );
    }
    return runtime.implementation.readCurrentAttempt(root);
  }

  function createProviderRetryRequest(input: {
    failedAttempt: TaskStrategyImplementationProviderAttempt;
    assignment: ProviderRoleAssignment;
    authorizationNodeId: string;
    policy: ReturnType<typeof baselineAdapterPolicy>;
    retrySeed: string;
  }) {
    return createProviderInvocationRequest({
      invocationId: `invocation-task-implementation-retry-${input.retrySeed}`,
      nonce: `task-implementation-retry-${input.retrySeed}`,
      purpose: input.failedAttempt.request.purpose,
      providerId: input.assignment.providerId,
      roleAssignment: input.assignment,
      capabilityProfile: input.failedAttempt.request.capabilityProfile,
      repositoryId: input.failedAttempt.request.repositoryId,
      baseCommit: input.failedAttempt.request.baseCommit,
      baseTree: input.failedAttempt.request.baseTree,
      targetDigest: input.failedAttempt.request.targetDigest,
      inputManifestDigest: input.failedAttempt.request.inputManifestDigest,
      authorizationNodeId: input.authorizationNodeId,
      writeAllowedPaths: [...input.failedAttempt.request.writeAllowedPaths],
      outputSchema: input.failedAttempt.request.outputSchema,
      evaluatorVersion: input.failedAttempt.request.evaluatorVersion,
      policyDigest: input.policy.digest,
      limits: {
        timeoutMs: input.policy.policy.limits.timeoutMs,
        aggregateOutputBytes: input.policy.policy.limits.aggregateOutputBytes,
      },
    });
  }

  function createProviderRetryAuthorization(
    runtime: TaskStrategyImplementationJournal,
    root: TaskStrategyImplementationReservation,
    assignment: ProviderRoleAssignment,
  ) {
    const authorization = createEvidenceNode({
      type: 'task-strategy-implementation-authorization',
      nodeSchema: 'workflow.task-strategy-implementation-authorization.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        author: sha256(canonicalJson(root.redAuthor)),
        mandate: sha256(canonicalJson(root.mandateBinding)),
        session: sha256(
          canonicalJson({
            sessionId: root.sessionId,
            changeId: root.changeId,
            taskId: root.taskId,
          }),
        ),
        subject: root.subject.subjectDigest,
        transaction: root.subject.transactionDigest,
      },
      semanticParentResultDigests: {
        red: root.subject.redEvidenceResultDigest,
      },
      provenanceParentNodeIds: { red: root.subject.redEvidenceNodeId },
      outputSchema:
        'workflow.task-strategy-implementation-authorization-output.v1',
      output: {
        ownerInvestigationId: root.ownerInvestigationId,
        sessionId: root.sessionId,
        changeId: root.changeId,
        taskId: root.taskId,
        subject: root.subject,
        redAuthor: root.redAuthor,
        assignment,
        mandateBinding: root.mandateBinding,
      },
      runtimeMetadata: {},
    });
    runtime.evidence.write(authorization);
    return authorization;
  }

  function createProviderRetryRequestReservation(
    runtime: TaskStrategyImplementationJournal,
    root: TaskStrategyImplementationReservation,
    failedAttempt: TaskStrategyImplementationProviderAttempt,
    request: ReturnType<typeof createProviderInvocationRequest>,
    authorization: ReturnType<typeof createEvidenceNode>,
    retryDecision: ProviderRetryDecisionBinding,
  ) {
    const failed = runtime.provider.read(failedAttempt.request.invocationId);
    if (failed.failure === null) throw implementationResultStale();
    const reservation = createEvidenceNode({
      type: 'task-strategy-implementation-request-reservation',
      nodeSchema: 'workflow.task-strategy-implementation-reservation.v1',
      evaluator: 'workflow-task-strategy.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      exactInputDigests: {
        failure: sha256(canonicalJson(failed.failure)),
        manifest: request.inputManifestDigest,
        previousRequest: failedAttempt.request.requestDigest,
        request: request.requestDigest,
        retryDecision: retryDecision.evidenceDigest,
        subject: root.subject.subjectDigest,
      },
      semanticParentResultDigests: {
        authorization: authorization.resultDigest,
      },
      provenanceParentNodeIds: { authorization: authorization.nodeId },
      outputSchema:
        'workflow.task-strategy-implementation-reservation-output.v1',
      output: {
        ownerInvestigationId: root.ownerInvestigationId,
        sessionId: root.sessionId,
        changeId: root.changeId,
        taskId: root.taskId,
        subject: root.subject,
        redAuthor: root.redAuthor,
        assignment: request.roleAssignment,
        manifest: root.manifest,
        request,
        mandateBinding: root.mandateBinding,
        previousInvocationId: failed.invocationId,
        retryDecision,
      },
      runtimeMetadata: {},
    });
    runtime.evidence.write(reservation);
    return reservation;
  }

  function authorizeTaskStrategyRetryStrategyChange(input: {
    context: TaskStrategyImplementationSession;
    root: TaskStrategyImplementationReservation;
    failedAttempt: TaskStrategyImplementationProviderAttempt;
    retrySeed: string;
    policy: ReturnType<typeof baselineAdapterPolicy>;
    collaborationGrant:
      BeginTaskStrategyImplementationOptions['collaborationGrant'] | undefined;
    assertOwned: () => void;
  }):
    | Readonly<{ assignment: ProviderRoleAssignment }>
    | TaskStrategyImplementationStatus {
    const providerSessionId = `provider-session-task-implementation-retry-${input.retrySeed}`;
    const redAuthor = requireRecordedRedAuthor(input.root.redAuthor);
    const author: RoleParticipant = {
      providerId: redAuthor.providerId,
      sessionId: redAuthor.sessionId,
      principalId: redAuthor.principalId,
      identityAssurance: redAuthor.identityAssurance,
      engineSpawned: false,
    };
    let candidates = listProviderIds()
      .filter(
        (providerId) =>
          providerId !== input.failedAttempt.assignment.providerId &&
          input.policy.policy.providers[providerId].enabled,
      )
      .map((providerId) => ({
        providerId,
        sessionId: providerSessionId,
        enabled: true,
        available: true,
      }));
    if (candidates.length === 0) {
      const currentProvider = input.failedAttempt.assignment.providerId;
      if (!input.policy.policy.providers[currentProvider].enabled) {
        throw providerRetryDenied(
          'TASK_STRATEGY_IMPLEMENTATION_RETRY_STRATEGY_UNAVAILABLE',
          input.root.sessionId,
        );
      }
      candidates = [
        {
          providerId: currentProvider,
          sessionId: providerSessionId,
          enabled: true,
          available: true,
        },
      ];
    }
    if (candidates.length !== 1) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_STRATEGY_UNAVAILABLE',
        input.root.sessionId,
      );
    }
    const scheduled = scheduleOrdinaryRole({
      role: 'task-implementer',
      author,
      targetDigest: input.root.subject.subjectDigest,
      candidates,
    });
    if (scheduled.outcome === 'assigned') {
      return Object.freeze({ assignment: scheduled.assignment });
    }
    const callableProviderIds = candidates.map(({ providerId }) => providerId);
    const grantRequest = implementationGrantRequest(
      input.context,
      input.root.subject,
      redAuthor,
      callableProviderIds,
    );
    if (grantRequest === null) {
      throw providerRetryDenied(
        'TASK_STRATEGY_IMPLEMENTATION_RETRY_STRATEGY_UNAVAILABLE',
        input.root.sessionId,
      );
    }
    if (input.collaborationGrant === undefined) {
      return collaborationPause(
        input.root.sessionId,
        input.root.subject,
        grantRequest,
      );
    }
    const expected = deriveCollaborationGrantBinding(
      input.context.git.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = collaborationTransitionDigest(expected);
    const inspection = operations.collaboration.inspect(
      input.context.git.gitCommonDirectory,
      input.collaborationGrant.grantId,
      input.assertOwned,
    )[0];
    if (inspection === undefined) throw implementationResultStale();
    const grantReservation =
      inspection.state === 'available'
        ? operations.collaboration.reserve(
            input.context.git.repositoryRoot,
            input.collaborationGrant.grantId,
            {
              transitionDigest,
              expected,
              ...(input.collaborationGrant.now === undefined
                ? {}
                : { now: input.collaborationGrant.now }),
              verifier: resolveAuthoritativeCollaborationGrantVerifier(
                input.collaborationGrant.verifier,
              ),
            },
            input.assertOwned,
          )
        : inspection.state === 'reserved'
          ? operations.collaboration.readReserved(
              input.context.git.gitCommonDirectory,
              input.collaborationGrant.grantId,
              input.assertOwned,
            )
          : null;
    if (
      grantReservation === null ||
      grantReservation.transitionDigest !== transitionDigest ||
      canonicalJson(bindingFromPayload(grantReservation.envelope.payload)) !==
        canonicalJson(expected)
    ) {
      throw implementationResultStale();
    }
    const providerId = callableProviderIds[0]!;
    return Object.freeze({
      assignment: authorizeGrantedOrdinaryRole({
        role: 'task-implementer',
        author,
        targetDigest: input.root.subject.subjectDigest,
        reservation: grantReservation,
        actualParticipant: {
          providerId,
          sessionId: providerSessionId,
          principalId: `collaboration-grant:${grantReservation.grantId}:task-implementer`,
          identityAssurance: redAuthor.identityAssurance,
          engineSpawned: true,
        },
        callableProviderIds,
      }) as GrantedSameProviderRoleAssignment,
    });
  }

  function ensureProviderInvocation(
    context: TaskStrategyImplementationSession,
    runtime: TaskStrategyImplementationJournal,
    attempt: TaskStrategyImplementationProviderAttempt,
    assertOwned: () => void,
  ): void {
    const reservation =
      taskStrategyImplementationReservationForAttempt(attempt);
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    runtime.provider.storePolicy(reservation.request, policy);
    if (reservation.mandateBinding !== null) {
      authorizeTaskMandateProviderReservationUnderLifecycleLock(
        context.git.repositoryRoot,
        reservation.mandateBinding,
        reservation.request.invocationId,
        {
          providerId: reservation.request.providerId,
          dataTypes: [
            'diff',
            'repository-metadata',
            'source-code',
            'test-output',
          ],
          sourceCode: true,
          secrets: false,
          retry: attempt.attempt > 1,
          budget: null,
          requestDigest: reservation.request.requestDigest,
        },
        assertOwned,
      );
    }
    if (runtime.provider.exists(reservation.request.invocationId)) {
      const invocation = runtime.provider.read(
        reservation.request.invocationId,
      );
      const request = runtime.provider.readRequest(
        reservation.request.invocationId,
      );
      const manifest = runtime.provider.readManifest(
        reservation.request.invocationId,
      );
      if (
        invocation.investigationId !== reservation.ownerInvestigationId ||
        invocation.changeId !== reservation.changeId ||
        invocation.attempt !== attempt.attempt ||
        invocation.requestDigest !== reservation.request.requestDigest ||
        canonicalJson(invocation.mandateBinding ?? null) !==
          canonicalJson(reservation.mandateBinding) ||
        canonicalJson(request) !== canonicalJson(reservation.request) ||
        canonicalJson(manifest) !== canonicalJson(reservation.manifest)
      ) {
        throw requestConflict();
      }
      return;
    }
    runtime.provider.create({
      investigationId: reservation.ownerInvestigationId,
      changeId: reservation.changeId,
      ...(reservation.mandateBinding === null
        ? {}
        : { mandateBinding: reservation.mandateBinding }),
      attempt: attempt.attempt,
      manifest: reservation.manifest,
      request: reservation.request,
      createdAt: reservation.createdAt,
    });
    assertOwned();
  }

  function providerRetryDenied(reasonCode: string, sessionId: string) {
    return workflowError(
      'TASK_STRATEGY_IMPLEMENTATION_RETRY_DENIED',
      'The bounded provider RetryDecision does not authorize this exact task implementation replacement Attempt.',
      ExitCode.guard,
      {
        details: { reasonCode },
        recovery: `pnpm workflow resume ${sessionId} --json`,
      },
    );
  }

  return {
    createImplementationReservation,
    reserveProviderRetryAttempt,
    ensureProviderInvocation,
  };
}
