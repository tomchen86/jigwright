import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ImportedTaskStrategyPatch,
  validateTaskStrategyProviderPatch,
  importTaskStrategyProviderPatchUnderLifecycleLock,
} from './task-strategy-patch.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  assertTaskStrategyImplementationOutput,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  type AdmittedRoleResult,
  admitRoleResult,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type {
  TaskStrategyImplementationRuntimeBindings,
  TaskStrategyImplementationRuntimeData,
} from './task-strategy-implementation-lifecycle.ts';
type TaskStrategyImplementationReservation =
  TaskStrategyImplementationRuntimeData['TaskStrategyImplementationReservation'];
type TaskStrategyGreenFailureRecord =
  TaskStrategyImplementationRuntimeData['TaskStrategyGreenFailureRecord'];
type TaskStrategyCorrectionReservationAuthority =
  TaskStrategyImplementationRuntimeData['TaskStrategyCorrectionReservationAuthority'];
type TaskStrategyImplementationProviderAttempt =
  TaskStrategyImplementationRuntimeData['TaskStrategyImplementationProviderAttempt'];
type TaskStrategyImplementationResultBinding =
  TaskStrategyImplementationRuntimeData['TaskStrategyImplementationResultBinding'];
type TaskStrategyCorrectionResultAuthority =
  TaskStrategyImplementationRuntimeData['TaskStrategyCorrectionResultAuthority'];
type CollaborationGrantUseProjection =
  TaskStrategyImplementationRuntimeData['CollaborationGrantUseProjection'];
import type {
  BeginTaskStrategyImplementationOptions,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
import type { createTaskStrategyImplementationContext } from './task-strategy-implementation-context.ts';
export function createTaskStrategyProviderResults(
  runtime: TaskStrategyImplementationRuntimeBindings,
  context: ReturnType<typeof createTaskStrategyImplementationContext>,
) {
  const {
    loadInvestigationRuntimeContext,
    readTaskStrategyTransaction,
    reserveTaskStrategyCorrectionRound,
    DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
    readTaskStrategyCorrectionRound,
    taskStrategyImplementationProviderAttemptReservationDigest,
    publishTaskStrategyCorrectionRoundResult,
    publishTaskStrategyCorrectionRoundImport,
    loadActiveSessionContext,
    taskStrategyImplementationReservationForAttempt,
    readProviderInvocation,
    readTaskStrategyPatchRecord,
    readTaskStrategyImplementationResultBinding,
    readEvidenceNode,
    createEvidenceNode,
    writeEvidenceNode,
    createTaskStrategyImplementationResultBinding,
    assertTaskStrategyImplementationProviderAuthorityCurrent,
    runGit,
    consumeCollaborationGrantUnderLifecycleLock,
  } = runtime;
  const {
    implementationResultStale,
    renderStatus,
    sha256,
    baselineAdapterPolicy,
    implementationGrantRequest,
    requireRecordedRedAuthor,
    deriveCollaborationGrantBinding,
    resolveAuthoritativeCollaborationGrantVerifier,
  } = context;
  function ensureProviderCorrectionRoundReservation(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
    reservation: TaskStrategyImplementationReservation,
    greenFailureRecord: TaskStrategyGreenFailureRecord | null,
  ): void {
    const correction = reservation.subject.correction;
    if (greenFailureRecord === null) {
      if (correction !== undefined) throw implementationResultStale();
      return;
    }
    if (
      correction === undefined ||
      correction.greenFailureRecordDigest !== greenFailureRecord.recordDigest ||
      correction.greenFailureSubjectDigest !==
        greenFailureRecord.subjectDigest ||
      correction.candidateTree !== greenFailureRecord.candidateTree ||
      correction.failingCheckFingerprint !==
        greenFailureRecord.failingCheck.failureFingerprint ||
      canonicalJson(correction.currentPatchHead) !==
        canonicalJson(greenFailureRecord.currentPatchHead)
    ) {
      throw implementationResultStale();
    }
    reserveTaskStrategyCorrectionRound(runtime, {
      sessionId: reservation.sessionId,
      round: correction.round,
      policy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
      predecessorFailure: greenFailureRecord,
      correctionSubjectDigest: reservation.subject.subjectDigest,
      redSourceTree: transaction.red.candidateTree,
      authority: providerCorrectionReservationAuthority(reservation),
      createdAt: reservation.createdAt,
    });
  }

  function providerCorrectionRoundNeedsReconciliation(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
    reservation: TaskStrategyImplementationReservation,
  ): boolean {
    const correction = reservation.subject.correction;
    if (correction === undefined) return false;
    return (
      readTaskStrategyCorrectionRound(
        runtime,
        reservation.sessionId,
        transaction.recordDigest,
        correction.round,
      )?.importRecord === null
    );
  }

  function providerCorrectionReservationAuthority(
    reservation: TaskStrategyImplementationReservation,
  ): Extract<TaskStrategyCorrectionReservationAuthority, { kind: 'provider' }> {
    return Object.freeze({
      kind: 'provider' as const,
      providerRequest: Object.freeze({
        ownerInvestigationId: reservation.ownerInvestigationId,
        invocationId: reservation.request.invocationId,
        requestDigest: reservation.request.requestDigest,
      }),
      providerReservation: Object.freeze({
        reservationDigest: reservation.recordDigest,
        authorizationNodeId: reservation.authorizationNodeId,
        reservationNodeId: reservation.reservationNodeId,
      }),
    });
  }

  function providerCorrectionResultAuthority(
    reservation: TaskStrategyImplementationReservation,
    attempt: TaskStrategyImplementationProviderAttempt,
    binding: TaskStrategyImplementationResultBinding,
  ): TaskStrategyCorrectionResultAuthority {
    return Object.freeze({
      ...providerCorrectionReservationAuthority(reservation),
      kind: 'provider' as const,
      providerAttempt: Object.freeze({
        attempt: attempt.attempt,
        attemptReservationDigest:
          taskStrategyImplementationProviderAttemptReservationDigest(attempt),
        invocationId: attempt.request.invocationId,
        requestDigest: attempt.request.requestDigest,
      }),
      providerResult: Object.freeze({
        bindingDigest: binding.bindingDigest,
        invocationId: binding.invocationId,
        requestDigest: binding.requestDigest,
        outputDigest: binding.outputDigest,
        providerResultNodeId: binding.providerResultNodeId,
        providerResultDigest: binding.providerResultDigest,
      }),
    });
  }

  function publishProviderCorrectionRoundArtifacts(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
    reservation: TaskStrategyImplementationReservation,
    attempt: TaskStrategyImplementationProviderAttempt,
    binding: TaskStrategyImplementationResultBinding,
    imported: ImportedTaskStrategyPatch,
  ): void {
    const correction = reservation.subject.correction;
    if (correction === undefined) return;
    const authority = providerCorrectionResultAuthority(
      reservation,
      attempt,
      binding,
    );
    publishTaskStrategyCorrectionRoundResult(runtime, {
      sessionId: reservation.sessionId,
      currentRedTransactionDigest: transaction.recordDigest,
      round: correction.round,
      correctionSubjectDigest: reservation.subject.subjectDigest,
      authority,
      patchResult: {
        sourceTree: imported.record.sourceTree,
        targetCandidateTree: imported.record.candidateTree,
        patchRecordDigest: imported.record.recordDigest,
        patchDigest: imported.record.patchDigest,
      },
      createdAt: binding.createdAt,
    });
    publishTaskStrategyCorrectionRoundImport(runtime, {
      sessionId: reservation.sessionId,
      currentRedTransactionDigest: transaction.recordDigest,
      round: correction.round,
      correctionSubjectDigest: reservation.subject.subjectDigest,
      authority,
      importReceipt: {
        patchRecordDigest: imported.record.recordDigest,
        patchDigest: imported.record.patchDigest,
        receiptDigest: imported.receipt.receiptDigest,
        candidateTree: imported.record.candidateTree,
      },
      currentPatchHead: {
        bindingDigest: imported.binding.bindingDigest,
        recordDigest: imported.record.recordDigest,
        patchDigest: imported.record.patchDigest,
        receiptDigest: imported.receipt.receiptDigest,
      },
      importedAt: imported.receipt.importedAt,
    });
  }

  function reconcileProviderImplementationResult(
    cwd: string,
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
    root: TaskStrategyImplementationReservation,
    attempt: TaskStrategyImplementationProviderAttempt,
    options: BeginTaskStrategyImplementationOptions,
    assertOwned: () => void,
  ): TaskStrategyImplementationStatus {
    const reservation =
      taskStrategyImplementationReservationForAttempt(attempt);
    const invocation = readProviderInvocation(
      runtime,
      reservation.request.invocationId,
    );
    if (invocation.state !== 'succeeded' || invocation.result === null) {
      return renderStatus(runtime, root, attempt);
    }
    if (invocation.result.runtimeObservation === null) {
      throw workflowError(
        'TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OBSERVATION_REQUIRED',
        'Task implementation import requires a fixed-runner repository observation.',
        ExitCode.verification,
      );
    }
    const output = assertTaskStrategyImplementationOutput(
      invocation.result.output,
    );
    if (
      output.sessionId !== context.session.sessionId ||
      output.sourceTree !== reservation.subject.sourceTree
    ) {
      throw implementationResultStale();
    }
    const durablePatchRecord = readTaskStrategyPatchRecord(
      runtime,
      context.session.sessionId,
      output.patchDigest,
      output.sourceTree,
    );
    if (durablePatchRecord === null) {
      validateTaskStrategyProviderPatch(cwd, context.session.sessionId, {
        patch: Buffer.from(output.patchBase64, 'base64'),
        implementationReservationDigest: reservation.recordDigest,
        implementationSubjectDigest: reservation.subject.subjectDigest,
      });
    }

    let binding = readTaskStrategyImplementationResultBinding(
      runtime,
      context.session.sessionId,
      reservation.subject.subjectDigest,
    );
    if (binding === null) {
      const authorization = readEvidenceNode(
        runtime,
        reservation.authorizationNodeId,
      );
      const requestReservation = readEvidenceNode(
        runtime,
        reservation.reservationNodeId,
      );
      const observationNode = createEvidenceNode({
        type: 'task-strategy-implementation-provider-observation',
        nodeSchema:
          'workflow.task-strategy-implementation-provider-observation.v1',
        evaluator: 'workflow-task-strategy.v1',
        policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
        exactInputDigests: {
          output: invocation.result.outputDigest,
          request: reservation.request.requestDigest,
          runtimeObservation: sha256(
            canonicalJson(invocation.result.runtimeObservation),
          ),
          subject: reservation.subject.subjectDigest,
        },
        semanticParentResultDigests: {
          authorization: authorization.resultDigest,
          reservation: requestReservation.resultDigest,
        },
        provenanceParentNodeIds: {
          authorization: authorization.nodeId,
          reservation: requestReservation.nodeId,
        },
        outputSchema:
          'workflow.task-strategy-implementation-provider-observation-output.v1',
        output: {
          ownerInvestigationId: reservation.ownerInvestigationId,
          sessionId: reservation.sessionId,
          invocationId: invocation.invocationId,
          requestDigest: reservation.request.requestDigest,
          outputDigest: invocation.result.outputDigest,
          submission: output,
        },
        runtimeMetadata: {
          runtimeObservation: invocation.result.runtimeObservation,
        },
      });
      writeEvidenceNode(runtime, observationNode);
      const roleResult = admitTaskStrategyImplementationProviderResult({
        context,
        reservation,
        invocation: { ...invocation, result: invocation.result },
        observationNode,
        validation: options.collaborationGrant,
        assertOwned,
      });
      const resultNode = createEvidenceNode({
        type: 'task-strategy-implementation-provider-result',
        nodeSchema: 'workflow.task-strategy-implementation-provider-result.v1',
        evaluator: 'workflow-task-strategy.v1',
        policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
        exactInputDigests: {
          admission: roleResult.resultDigest,
          observation: observationNode.resultDigest,
          subject: reservation.subject.subjectDigest,
        },
        semanticParentResultDigests: {
          observation: observationNode.resultDigest,
        },
        provenanceParentNodeIds: { observation: observationNode.nodeId },
        outputSchema:
          'workflow.task-strategy-implementation-provider-result-output.v1',
        output: {
          ownerInvestigationId: reservation.ownerInvestigationId,
          sessionId: reservation.sessionId,
          invocationId: invocation.invocationId,
          roleResult,
          output,
        },
        runtimeMetadata: {},
      });
      writeEvidenceNode(runtime, resultNode);
      binding = createTaskStrategyImplementationResultBinding(runtime, {
        ownerInvestigationId: reservation.ownerInvestigationId,
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subject.subjectDigest,
        invocationId: invocation.invocationId,
        requestDigest: reservation.request.requestDigest,
        outputDigest: invocation.result.outputDigest,
        runtimeObservationDigest: sha256(
          canonicalJson(invocation.result.runtimeObservation),
        ),
        providerObservationNodeId: observationNode.nodeId,
        providerObservationDigest: observationNode.resultDigest,
        providerResultNodeId: resultNode.nodeId,
        providerResultDigest: resultNode.resultDigest,
        roleResult,
        output,
        createdAt: invocation.updatedAt,
      });
      if (options.testCrashAfter === 'provider-result-persisted') {
        throw new Error(
          'Simulated task implementation interruption after provider result persistence.',
        );
      }
    }
    assertTaskStrategyImplementationProviderAuthorityCurrent(
      runtime,
      reservation,
      invocation,
      binding,
    );
    const imported = importTaskStrategyProviderPatchUnderLifecycleLock(
      cwd,
      context.session.sessionId,
      {
        patch: Buffer.from(binding.output.patchBase64, 'base64'),
        implementationResultBindingDigest: binding.bindingDigest,
        implementationSubjectDigest: reservation.subject.subjectDigest,
        ...(options.testCrashAfter === 'patch-applied' ||
        options.testCrashAfter === 'receipt-persisted'
          ? { testCrashAfter: options.testCrashAfter }
          : {}),
      },
      assertOwned,
    );
    if (options.testCrashAfter === 'provider-patch-imported') {
      throw new Error(
        'Simulated task implementation interruption after provider patch import.',
      );
    }
    publishProviderCorrectionRoundArtifacts(
      runtime,
      transaction,
      root,
      attempt,
      binding,
      imported,
    );
    assertOwned();
    return renderStatus(runtime, root, attempt);
  }

  function admitTaskStrategyImplementationProviderResult(input: {
    context: ReturnType<typeof loadActiveSessionContext>;
    reservation: TaskStrategyImplementationReservation;
    invocation: ReturnType<typeof readProviderInvocation> & {
      result: NonNullable<ReturnType<typeof readProviderInvocation>['result']>;
    };
    observationNode: ReturnType<typeof createEvidenceNode>;
    validation: BeginTaskStrategyImplementationOptions['collaborationGrant'];
    assertOwned: () => void;
  }): AdmittedRoleResult {
    const assignment = input.reservation.assignment;
    const content = {
      kind: 'task-implementation' as const,
      nodeId: input.observationNode.nodeId,
      resultDigest: input.observationNode.resultDigest,
      outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
      evaluator: input.reservation.request.evaluatorVersion,
      policyDigest: input.reservation.request.policyDigest,
      contentDigest: input.observationNode.resultDigest,
      current: true as const,
    };
    let grantUse: CollaborationGrantUseProjection | null = null;
    let grantValidation: NonNullable<
      Parameters<typeof admitRoleResult>[0]['grantValidation']
    > | null = null;
    if ('grantId' in assignment) {
      if (
        input.validation !== undefined &&
        input.validation.grantId !== assignment.grantId
      ) {
        throw implementationResultStale();
      }
      const adapterPolicy = baselineAdapterPolicy(
        input.context.git.repositoryRoot,
        input.context.session.baseline.head,
      );
      const callableProviderIds = (['codex', 'claude'] as const).filter(
        (providerId) => adapterPolicy.policy.providers[providerId].enabled,
      );
      const grantCallableProviderIds =
        assignment.degradedForm === 'same-provider-fresh-session' &&
        assignment.providerId === input.reservation.redAuthor.providerId
          ? [assignment.providerId]
          : callableProviderIds;
      const grantRequest = implementationGrantRequest(
        input.context,
        input.reservation.subject,
        requireRecordedRedAuthor(input.reservation.redAuthor),
        grantCallableProviderIds,
      );
      if (grantRequest === null) throw implementationResultStale();
      const expectedBinding = deriveCollaborationGrantBinding(
        input.context.git.repositoryRoot,
        grantRequest,
      );
      const transitionDigest = sha256(
        canonicalJson({
          schemaVersion: 1,
          kind: 'collaboration-role-transition',
          expectedBinding,
        }),
      );
      const maintainerPolicy = parseMaintainerPolicy(
        JSON.parse(
          runGit(input.context.git.repositoryRoot, [
            'show',
            `${expectedBinding.baselineCommit}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      const verifier = resolveAuthoritativeCollaborationGrantVerifier(
        input.validation?.verifier,
      );
      const now = input.validation?.now ?? new Date();
      const consumed = consumeCollaborationGrantUnderLifecycleLock(
        input.context.git.gitCommonDirectory,
        assignment.grantId,
        {
          transitionDigest,
          assignment,
          contentAdmission: {
            kind: content.kind,
            nodeId: content.nodeId,
            resultDigest: content.resultDigest,
            current: true,
          },
          now,
          verifier,
        },
        input.assertOwned,
      );
      if (consumed.use === undefined) throw implementationResultStale();
      grantUse = consumed.use;
      grantValidation = {
        now,
        expectedBinding,
        policy: maintainerPolicy,
        verifier,
        transitionDigest,
      };
    }
    return admitRoleResult({
      assignment,
      author: input.reservation.redAuthor,
      participant:
        'grantId' in assignment
          ? assignment.participant
          : {
              providerId: assignment.providerId,
              sessionId: assignment.sessionId,
              principalId: null,
              identityAssurance: 'adapter-assigned',
              engineSpawned: true,
            },
      content,
      providerInvocation: {
        invocationId: input.invocation.invocationId,
        requestDigest: input.reservation.request.requestDigest,
        outputDigest: input.invocation.result.outputDigest,
        providerId: input.reservation.request.providerId,
        sessionId: assignment.sessionId,
        targetDigest: input.reservation.subject.subjectDigest,
        engineSpawned: true,
      },
      grantUse,
      grantValidation,
    });
  }

  return {
    ensureProviderCorrectionRoundReservation,
    providerCorrectionRoundNeedsReconciliation,
    reconcileProviderImplementationResult,
  };
}
