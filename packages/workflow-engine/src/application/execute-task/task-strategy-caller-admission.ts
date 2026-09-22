import type { TaskStrategyImplementationOperations } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationSession } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationJournal } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyTransaction } from '../../modules/assurance/task-strategy-evidence.ts';
import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  assertTaskStrategyImplementationOutput,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import { type RoleParticipant } from '../../modules/provider-orchestration/role-assignment.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ImportedTaskStrategyPatch } from '../../modules/assurance/task-strategy-patch-contract.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  bindingFromPayload,
  type CollaborationGrantRequest,
} from '../../modules/authority/collaboration-grant-codec.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';

import type {
  BeginTaskStrategyImplementationOptions,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
import type { createTaskStrategyImplementationContext } from './task-strategy-implementation-context.ts';

/**
 * Admits caller-supplied implementations and reserves their correction
 * rounds.
 *
 * Invariants:
 * - Admitted implementation validation must retain the submitted patch and
 *   source tree.
 */

import type { TaskStrategyGreenFailureRecord } from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
import type { TaskStrategyCallerImplementationReservation } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { TaskStrategyCorrectionReservationAuthority } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type { TaskStrategyCallerImplementationBinding } from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionResultAuthority } from '../../modules/assurance/task-strategy-correction-round-record.ts';

export function createTaskStrategyCallerAdmission(
  roleAdmission: Pick<
    RoleAdmissionServices,
    'authorizeGrantedOrdinaryRole' | 'admitRoleResult'
  >,
  operations: Pick<
    TaskStrategyImplementationOperations,
    'baseline' | 'collaboration' | 'patches' | 'correctionPolicy' | 'clock'
  >,
  context: ReturnType<typeof createTaskStrategyImplementationContext>,
) {
  const { authorizeGrantedOrdinaryRole, admitRoleResult } = roleAdmission;

  const {
    sha256Bytes,
    implementationResultStale,
    deriveCollaborationGrantBinding,
    collaborationTransitionDigest,
    resolveAuthoritativeCollaborationGrantVerifier,
    sha256,
  } = context;
  function importCallerSuppliedImplementation(
    context: TaskStrategyImplementationSession,
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    subject: TaskStrategyImplementationSubject,
    greenFailureRecord: TaskStrategyGreenFailureRecord | null,
    author: RoleParticipant,
    collaborationGrant: NonNullable<
      BeginTaskStrategyImplementationOptions['collaborationGrant']
    >,
    testCrashAfter: BeginTaskStrategyImplementationOptions['testCrashAfter'],
    assertOwned: () => void,
  ): TaskStrategyImplementationStatus {
    const submitted = collaborationGrant.callerSupplied;
    if (submitted === undefined) {
      throw workflowError(
        'COLLABORATION_GRANT_FORM_REQUIRED',
        'A caller-supplied task implementation grant requires the exact caller identity, assurance, and bounded patch bytes.',
        ExitCode.guard,
      );
    }
    const patchBytes = Buffer.isBuffer(submitted.patch)
      ? Buffer.from(submitted.patch)
      : Buffer.from(submitted.patch, 'utf8');
    const output = assertTaskStrategyImplementationOutput({
      schemaVersion: 1,
      kind: 'task-strategy-patch-output.v1',
      sessionId: context.session.sessionId,
      sourceTree: subject.sourceTree,
      patchBase64: patchBytes.toString('base64'),
      patchDigest: sha256Bytes(patchBytes),
    });
    const callerImplementer = Object.freeze({
      providerId: null,
      principalId: submitted.callerId,
      assurance: submitted.assurance,
      degradedForm: 'caller-supplied' as const,
      grantId: collaborationGrant.grantId,
    });
    let reservation = runtime.implementation.readCallerReservation(
      context.session.sessionId,
      subject.subjectDigest,
    );
    if (reservation === null) {
      const validation = operations.patches.validateCaller(
        context.git.repositoryRoot,
        context.session.sessionId,
        {
          patch: patchBytes,
          callerImplementer,
          implementationSubjectDigest: subject.subjectDigest,
        },
      );
      if (
        validation.patchDigest !== output.patchDigest ||
        validation.sourceTree !== output.sourceTree
      ) {
        throw implementationResultStale();
      }
    }

    const grantRequest = callerImplementationGrantRequest(
      context,
      subject,
      submitted.callerId,
      submitted.assurance,
    );
    const expectedBinding = deriveCollaborationGrantBinding(
      context.git.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = collaborationTransitionDigest(expectedBinding);
    if (reservation === null) {
      const inspection = operations.collaboration.inspect(
        context.git.gitCommonDirectory,
        collaborationGrant.grantId,
        assertOwned,
      )[0];
      if (inspection === undefined) throw implementationResultStale();
      const grantReservation =
        inspection.state === 'available'
          ? operations.collaboration.reserve(
              context.git.repositoryRoot,
              collaborationGrant.grantId,
              {
                transitionDigest,
                expected: expectedBinding,
                ...(collaborationGrant.now === undefined
                  ? {}
                  : { now: collaborationGrant.now }),
                verifier: resolveAuthoritativeCollaborationGrantVerifier(
                  collaborationGrant.verifier,
                ),
              },
              assertOwned,
            )
          : inspection.state === 'reserved'
            ? operations.collaboration.readReserved(
                context.git.gitCommonDirectory,
                collaborationGrant.grantId,
                assertOwned,
              )
            : null;
      if (
        grantReservation === null ||
        grantReservation.transitionDigest !== transitionDigest ||
        canonicalJson(bindingFromPayload(grantReservation.envelope.payload)) !==
          canonicalJson(expectedBinding)
      ) {
        throw implementationResultStale();
      }
      const assignment = authorizeGrantedOrdinaryRole({
        role: 'task-implementer',
        author,
        targetDigest: subject.subjectDigest,
        reservation: grantReservation,
        actualParticipant: {
          providerId: undefined,
          sessionId: undefined,
          principalId: submitted.callerId,
          identityAssurance: submitted.assurance,
          engineSpawned: false,
        },
        callableProviderIds: [],
      });
      const submissionNode = createEvidenceNode({
        type: 'task-strategy-implementation-caller-submission',
        nodeSchema:
          'workflow.task-strategy-implementation-caller-submission.v1',
        evaluator: 'workflow-task-strategy.v1',
        policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
        exactInputDigests: {
          assignment: sha256(canonicalJson(assignment)),
          caller: sha256(
            canonicalJson({
              callerId: submitted.callerId,
              assurance: submitted.assurance,
            }),
          ),
          output: sha256(canonicalJson(output)),
          subject: subject.subjectDigest,
          transition: transitionDigest,
        },
        semanticParentResultDigests: {
          red: transaction.red.evidenceResultDigest,
        },
        provenanceParentNodeIds: { red: transaction.red.evidenceNodeId },
        outputSchema:
          'workflow.task-strategy-implementation-caller-submission-output.v1',
        output: {
          sessionId: context.session.sessionId,
          subjectDigest: subject.subjectDigest,
          transitionDigest,
          caller: {
            callerId: submitted.callerId,
            assurance: submitted.assurance,
          },
          assignment,
          output,
        },
        runtimeMetadata: {},
      });
      runtime.evidence.write(submissionNode);
      reservation = runtime.implementation.reserveCaller({
        sessionId: context.session.sessionId,
        subjectDigest: subject.subjectDigest,
        grantId: grantReservation.grantId,
        transitionDigest,
        assignment,
        submissionNodeId: submissionNode.nodeId,
        submissionResultDigest: submissionNode.resultDigest,
        output,
        createdAt: grantReservation.reservedAt,
      });
    }
    runtime.implementation.assertCallerReservationCurrent(
      transaction,
      subject,
      reservation,
    );
    if (
      reservation.grantId !== collaborationGrant.grantId ||
      reservation.assignment.participant.principalId !== submitted.callerId ||
      reservation.assignment.participant.identityAssurance !==
        submitted.assurance ||
      canonicalJson(reservation.output) !== canonicalJson(output)
    ) {
      throw implementationResultStale();
    }
    ensureCallerCorrectionRoundReservation(
      runtime,
      transaction,
      subject,
      greenFailureRecord,
      reservation,
    );

    let binding = runtime.implementation.readCallerResult(
      context.session.sessionId,
      subject.subjectDigest,
    );
    if (binding === null) {
      const maintainerPolicy = parseMaintainerPolicy(
        JSON.parse(
          operations.baseline.readDocument(
            context.git.repositoryRoot,
            expectedBinding.baselineCommit,
            'workflow/maintainer-policy.json',
          ),
        ),
      );
      const verifier = resolveAuthoritativeCollaborationGrantVerifier(
        collaborationGrant.verifier,
      );
      const now = collaborationGrant.now ?? operations.clock.now();
      const consumed = operations.collaboration.consume(
        context.git.gitCommonDirectory,
        reservation.grantId,
        {
          transitionDigest,
          assignment: reservation.assignment,
          contentAdmission: {
            kind: 'task-implementation',
            nodeId: reservation.submissionNodeId,
            resultDigest: reservation.submissionResultDigest,
            current: true,
          },
          now,
          verifier,
        },
        assertOwned,
      );
      if (consumed.use === undefined) throw implementationResultStale();
      const content = {
        kind: 'task-implementation' as const,
        nodeId: reservation.submissionNodeId,
        resultDigest: reservation.submissionResultDigest,
        outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
        evaluator: 'task-strategy-implementation.v1',
        policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
        contentDigest: reservation.submissionResultDigest,
        current: true as const,
      };
      const roleResult = admitRoleResult({
        assignment: reservation.assignment,
        author: reservation.assignment.author,
        participant: reservation.assignment.participant,
        content,
        providerInvocation: null,
        grantUse: consumed.use,
        grantValidation: {
          now,
          expectedBinding,
          policy: maintainerPolicy,
          verifier,
          transitionDigest,
        },
      });
      const resultNode = createEvidenceNode({
        type: 'task-strategy-implementation-caller-result',
        nodeSchema: 'workflow.task-strategy-implementation-caller-result.v1',
        evaluator: 'workflow-task-strategy.v1',
        policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
        exactInputDigests: {
          admission: roleResult.resultDigest,
          submission: reservation.submissionResultDigest,
          subject: subject.subjectDigest,
          transition: transitionDigest,
        },
        semanticParentResultDigests: {
          submission: reservation.submissionResultDigest,
        },
        provenanceParentNodeIds: {
          submission: reservation.submissionNodeId,
        },
        outputSchema:
          'workflow.task-strategy-implementation-caller-result-output.v1',
        output: {
          sessionId: reservation.sessionId,
          subjectDigest: reservation.subjectDigest,
          roleResult,
          output: reservation.output,
        },
        runtimeMetadata: {},
      });
      runtime.evidence.write(resultNode);
      binding = runtime.implementation.publishCallerResult({
        sessionId: reservation.sessionId,
        subjectDigest: reservation.subjectDigest,
        transitionDigest: reservation.transitionDigest,
        submissionNodeId: reservation.submissionNodeId,
        submissionResultDigest: reservation.submissionResultDigest,
        resultNodeId: resultNode.nodeId,
        resultDigest: resultNode.resultDigest,
        roleResult,
        output: reservation.output,
        createdAt: reservation.createdAt,
      });
      if (collaborationGrant.callerSupplied !== undefined) {
        if (
          collaborationGrant.callerSupplied.callerId !== submitted.callerId ||
          canonicalJson(reservation.output) !== canonicalJson(output)
        ) {
          throw implementationResultStale();
        }
      }
    }
    runtime.implementation.assertCallerCurrent(
      transaction,
      subject,
      reservation,
      binding,
    );
    if (testCrashAfter === 'provider-result-persisted') {
      throw new Error(
        'Simulated task implementation interruption after caller result persistence.',
      );
    }
    const imported = operations.patches.importCaller(
      context.git.repositoryRoot,
      context.session.sessionId,
      {
        patch: Buffer.from(binding.output.patchBase64, 'base64'),
        callerImplementationBindingDigest: binding.bindingDigest,
        implementationSubjectDigest: subject.subjectDigest,
        ...(testCrashAfter === 'patch-applied' ||
        testCrashAfter === 'receipt-persisted'
          ? { testCrashAfter }
          : {}),
      },
      assertOwned,
    );
    publishCallerCorrectionRoundArtifacts(
      runtime,
      transaction,
      subject,
      reservation,
      binding,
      imported,
    );
    assertOwned();
    return renderCallerImplementationStatus(
      runtime,
      subject,
      reservation,
      binding,
    );
  }

  function ensureCallerCorrectionRoundReservation(
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    subject: TaskStrategyImplementationSubject,
    greenFailureRecord: TaskStrategyGreenFailureRecord | null,
    reservation: TaskStrategyCallerImplementationReservation,
  ): void {
    const correction = subject.correction;
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
      correctionSubjectDigest: subject.subjectDigest,
      redSourceTree: transaction.red.candidateTree,
      authority: callerCorrectionReservationAuthority(reservation),
      createdAt: reservation.createdAt,
    });
  }

  function callerCorrectionReservationAuthority(
    reservation: TaskStrategyCallerImplementationReservation,
  ): Extract<
    TaskStrategyCorrectionReservationAuthority,
    { kind: 'caller-supplied' }
  > {
    return Object.freeze({
      kind: 'caller-supplied' as const,
      callerReservation: Object.freeze({
        reservationDigest: reservation.reservationDigest,
        grantId: reservation.grantId,
        transitionDigest: reservation.transitionDigest,
        submissionNodeId: reservation.submissionNodeId,
        submissionResultDigest: reservation.submissionResultDigest,
      }),
    });
  }

  function callerCorrectionResultAuthority(
    reservation: TaskStrategyCallerImplementationReservation,
    binding: TaskStrategyCallerImplementationBinding,
  ): Extract<
    TaskStrategyCorrectionResultAuthority,
    { kind: 'caller-supplied' }
  > {
    return Object.freeze({
      ...callerCorrectionReservationAuthority(reservation),
      kind: 'caller-supplied' as const,
      callerResult: Object.freeze({
        bindingDigest: binding.bindingDigest,
        resultNodeId: binding.resultNodeId,
        resultDigest: binding.resultDigest,
        roleResultDigest: binding.roleResult.resultDigest,
        grantUseDigest: sha256(canonicalJson(binding.roleResult.grantUse)),
      }),
    });
  }

  function publishCallerCorrectionRoundArtifacts(
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    subject: TaskStrategyImplementationSubject,
    reservation: TaskStrategyCallerImplementationReservation,
    binding: TaskStrategyCallerImplementationBinding,
    imported: ImportedTaskStrategyPatch,
  ): void {
    const correction = subject.correction;
    if (correction === undefined) return;
    const authority = callerCorrectionResultAuthority(reservation, binding);
    runtime.correction.publishResult({
      sessionId: reservation.sessionId,
      currentRedTransactionDigest: transaction.recordDigest,
      round: correction.round,
      correctionSubjectDigest: subject.subjectDigest,
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
      correctionSubjectDigest: subject.subjectDigest,
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

  function renderCallerImplementationStatus(
    runtime: TaskStrategyImplementationJournal,
    subject: TaskStrategyImplementationSubject,
    reservation: TaskStrategyCallerImplementationReservation,
    binding: TaskStrategyCallerImplementationBinding | null,
  ): TaskStrategyImplementationStatus {
    const patchBinding = runtime.patch.readCurrentBinding(
      reservation.sessionId,
      subject.sourceTree,
    );
    const imported =
      binding !== null &&
      patchBinding !== null &&
      patchBinding.patchDigest === binding.output.patchDigest &&
      patchBinding.candidateTree !== binding.output.sourceTree;
    return Object.freeze({
      state: imported
        ? ('patch-imported' as const)
        : ('caller-supplied-awaiting-import' as const),
      sessionId: reservation.sessionId,
      subject,
      assignment: reservation.assignment,
      ownerInvestigationId: null,
      invocationId: null,
      failure: null,
    });
  }

  function callerImplementationGrantRequest(
    context: TaskStrategyImplementationSession,
    subject: TaskStrategyImplementationSubject,
    callerId: string,
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned',
  ): CollaborationGrantRequest {
    return {
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      baselineCommit: context.session.baseline.head,
      baselineTree: context.session.baseline.tree,
      targetDigest: subject.subjectDigest,
      lifecyclePhase: 'task-implementation',
      rolePair: {
        authorRole: 'red-author',
        conflictingRole: 'task-implementer',
      },
      availableActor: { kind: 'caller', callerId, assurance },
      degradedForm: 'caller-supplied',
      reason:
        'No callable task implementation provider is enabled for this exact sealed RED subject.',
      ttlMinutes: 30,
      maxUses: 1,
    };
  }

  return {
    importCallerSuppliedImplementation,
    renderCallerImplementationStatus,
  };
}
