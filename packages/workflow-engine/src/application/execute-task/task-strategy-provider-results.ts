import type { TaskStrategyImplementationOperations } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationSession } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationJournal } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyTransaction } from '../../modules/assurance/task-strategy-evidence.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import {
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
} from '../../modules/assurance/task-strategy-implementation-attempt.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { ImportedTaskStrategyPatch } from '../../modules/assurance/task-strategy-patch-contract.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  assertTaskStrategyImplementationOutput,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import { type AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';

import type {
  BeginTaskStrategyImplementationOptions,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
import type { createTaskStrategyImplementationContext } from './task-strategy-implementation-context.ts';

/**
 * Admits implementation provider results and reconciles correction round
 * evidence.
 *
 * Invariants:
 * - Correction reservations must match the current GREEN failure and patch
 *   head.
 */

import type { TaskStrategyImplementationReservation } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { TaskStrategyGreenFailureRecord } from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
import type { TaskStrategyCorrectionReservationAuthority } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type { TaskStrategyImplementationProviderAttempt } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { TaskStrategyImplementationResultBinding } from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionResultAuthority } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type { CollaborationGrantUseProjection } from '../../modules/authority/collaboration-grant-records.ts';

export function createTaskStrategyProviderResults(
  roleAdmission: Pick<RoleAdmissionServices, 'admitRoleResult'>,
  operations: Pick<
    TaskStrategyImplementationOperations,
    'baseline' | 'collaboration' | 'patches' | 'correctionPolicy' | 'clock'
  >,
  context: ReturnType<typeof createTaskStrategyImplementationContext>,
) {
  const { admitRoleResult } = roleAdmission;

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
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
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
    runtime.correction.reserve({
      sessionId: reservation.sessionId,
      round: correction.round,
      policy: operations.correctionPolicy,
      predecessorFailure: greenFailureRecord,
      correctionSubjectDigest: reservation.subject.subjectDigest,
      redSourceTree: transaction.red.candidateTree,
      authority: providerCorrectionReservationAuthority(reservation),
      createdAt: reservation.createdAt,
    });
  }

  function providerCorrectionRoundNeedsReconciliation(
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    reservation: TaskStrategyImplementationReservation,
  ): boolean {
    const correction = reservation.subject.correction;
    if (correction === undefined) return false;
    return (
      runtime.correction.readRound(
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
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
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
    runtime.correction.publishResult({
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
    runtime.correction.publishImport({
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
    context: TaskStrategyImplementationSession,
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    root: TaskStrategyImplementationReservation,
    attempt: TaskStrategyImplementationProviderAttempt,
    options: BeginTaskStrategyImplementationOptions,
    assertOwned: () => void,
  ): TaskStrategyImplementationStatus {
    const reservation =
      taskStrategyImplementationReservationForAttempt(attempt);
    const invocation = runtime.provider.read(reservation.request.invocationId);
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
    const durablePatchRecord = runtime.patch.readRecord(
      context.session.sessionId,
      output.patchDigest,
      output.sourceTree,
    );
    if (durablePatchRecord === null) {
      operations.patches.validateProvider(cwd, context.session.sessionId, {
        patch: Buffer.from(output.patchBase64, 'base64'),
        implementationReservationDigest: reservation.recordDigest,
        implementationSubjectDigest: reservation.subject.subjectDigest,
      });
    }

    let binding = runtime.implementation.readResult(
      context.session.sessionId,
      reservation.subject.subjectDigest,
    );
    if (binding === null) {
      const authorization = runtime.evidence.read(
        reservation.authorizationNodeId,
      );
      const requestReservation = runtime.evidence.read(
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
      runtime.evidence.write(observationNode);
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
      runtime.evidence.write(resultNode);
      binding = runtime.implementation.publishResult({
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
    runtime.implementation.assertProviderCurrent(
      reservation,
      invocation,
      binding,
    );
    const imported = operations.patches.importProvider(
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
    context: TaskStrategyImplementationSession;
    reservation: TaskStrategyImplementationReservation;
    invocation: ProviderInvocationRecord & {
      result: NonNullable<ProviderInvocationRecord['result']>;
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
      const callableProviderIds = listProviderIds().filter(
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
          operations.baseline.readDocument(
            input.context.git.repositoryRoot,
            expectedBinding.baselineCommit,
            'workflow/maintainer-policy.json',
          ),
        ),
      );
      const verifier = resolveAuthoritativeCollaborationGrantVerifier(
        input.validation?.verifier,
      );
      const now = input.validation?.now ?? operations.clock.now();
      const consumed = operations.collaboration.consume(
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
