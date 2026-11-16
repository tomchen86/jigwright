/**
 * Resolves review ancestry, candidate reuse, and durable supersession
 * recovery.
 *
 * Invariants:
 * - An exact external review cannot coexist with provider authority for the
 *   same subject.
 */
import type {
  TaskDiffReviewReservationRecord,
  TaskDiffReviewResultBinding,
} from '../../modules/assurance/task-diff-review-binding-record.ts';
import {
  reviewNotSatisfied,
  taskDiffReviewLineageConflict,
  taskDiffReviewPriorChallengeOpen,
  taskDiffReviewSupersessionReconciliationRequired,
  type TaskDiffReviewConsumedReplayValidation,
} from '../../modules/assurance/task-diff-review-values.ts';

// Resolve review ancestry, candidate reuse, and durable supersession recovery.
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  TaskDiffFinalAssuranceRecord,
  TaskDiffReviewRecord,
} from '../../modules/assurance/task-diff-review-artifact-record.ts';
import { assertTaskDiffReviewContentSatisfied } from '../../modules/assurance/task-diff-review-artifact.ts';
import { resolveTaskDiffReviewLineage } from '../../modules/assurance/task-diff-review-lineage.ts';
import type {
  TaskDiffReviewCandidatePlan,
  TaskDiffReviewSubject,
} from '../../modules/assurance/task-diff-review-record.ts';
import { deriveTaskDiffReviewCandidatePlan } from '../../modules/assurance/task-diff-review.ts';
import type {
  CurrentAuthenticatedTaskDiffReview,
  CurrentExternalTaskDiffReview,
  CurrentExternalTaskDiffTerminalAssurance,
  CurrentTaskDiffReviewForProviderContinuation,
  LoadedTaskDiffReviewLineageEntry,
  LoadedTaskDiffReviewLineageSource,
  ReconcileTaskDiffReviewOptions,
  ReplayedTaskDiffReviewTerminal,
  TaskDiffReviewReplayMode,
  TaskDiffReviewSupersessionRecoveryTarget,
} from '../../modules/lifecycle/task-diff-review-contracts.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { loadActiveSessionContext } from '../repository-observation/workflow-session-context.ts';
import {
  listAllTaskDiffExternalContinuationBindings,
  listAllTaskDiffExternalContinuationReservations,
  listTaskDiffExternalReviewBindings,
  readTaskDiffExternalReviewBinding,
} from '../storage-journal/task-diff-review-external-store.ts';
import {
  createTaskDiffReviewLineageSupersession,
  listAllTaskDiffReviewContinuationReservations,
  listAllTaskDiffReviewContinuationResultBindings,
  listAllTaskDiffReviewReservations,
  listAllTaskDiffReviewResultBindings,
  listTaskDiffReviewLineageSupersessions,
  readTaskDiffFinalAssuranceBinding,
  readTaskDiffReviewReservation,
  readTaskDiffReviewResultBinding,
} from '../storage-journal/task-diff-review-store.ts';
import type { TaskDiffReviewCapabilities } from './task-diff-review-capabilities.ts';
import {
  assertHistoricalExternalTaskDiffReviewBinding,
  authenticatedExternalReviewAuthority,
  bindingSubject,
  inspectExternalGrant,
} from './task-diff-review-external-binding.ts';
import {
  assertExternalTaskDiffContinuationProviderShortage,
  loadAuthenticatedExternalTaskDiffTerminalAssurance,
} from './task-diff-review-external-continuation-binding.ts';
import {
  assertCurrentTaskDiffFinalAssuranceBinding,
  assertCurrentTaskDiffReviewBinding,
  assertCurrentTaskDiffReviewContinuationBinding,
} from './task-diff-review-provider-binding.ts';
import {
  assertTaskDiffReviewCandidateCurrent,
  inspectTaskDiffReviewSubject,
} from './task-diff-review-subject.ts';

export function loadCurrentExternalTaskDiffTerminalAssurance(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  cwd: string,
  requestedSessionId: string,
  validation: TaskDiffReviewConsumedReplayValidation = {},
): CurrentExternalTaskDiffTerminalAssurance | null {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const current = loadCurrentAuthenticatedTaskDiffReview(
    capabilities,
    cwd,
    requestedSessionId,
    validation,
  );
  return loadAuthenticatedExternalTaskDiffTerminalAssurance(capabilities, {
    context,
    runtime,
    current,
    validation,
  });
}

export function loadCurrentAuthenticatedTaskDiffReview(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  cwd: string,
  requestedSessionId: string,
  validation: TaskDiffReviewConsumedReplayValidation = {},
): CurrentAuthenticatedTaskDiffReview {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  return loadCurrentTaskDiffReview(capabilities, context, runtime, validation);
}

export function loadCurrentTaskDiffReview(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  validation: TaskDiffReviewConsumedReplayValidation = {},
): CurrentTaskDiffReviewForProviderContinuation {
  const subject = inspectTaskDiffReviewSubject(
    capabilities,
    context.git.repositoryRoot,
    context.session.sessionId,
  );
  if (!subject.reviewRequirement.required) throw reviewNotSatisfied();
  const exactProvider = readExactProviderTaskDiffReviewSource(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  const exactExternal = readTaskDiffExternalReviewBinding(
    runtime,
    subject.subjectDigest,
  );
  if (
    exactExternal !== null &&
    (exactProvider.reservation !== null || exactProvider.binding !== null)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const plan = resolveTaskDiffReviewCandidatePlan(
    capabilities,
    context,
    runtime,
    subject,
    'governing',
    validation,
  );
  if (plan.action === 'review' || plan.action === 'not-required') {
    throw reviewNotSatisfied();
  }
  const reused = loadReusedTaskDiffReview(
    capabilities,
    runtime,
    context,
    subject,
    plan,
    'governing',
    validation,
  );
  if (reused.source === 'external') {
    assertTaskDiffReviewCandidateCurrent(subject, reused.review);
    return Object.freeze({
      source: 'external' as const,
      subject,
      review: reused.review,
      implementationActor: reused.current.implementationActor,
      authenticatedReviewAuthority: authenticatedExternalReviewAuthority(
        reused.current,
      ),
      reviewResultNodeId: reused.current.binding.authorityNodeId,
      reviewResultDigest: reused.current.binding.authorityResultDigest,
    });
  }
  assertTaskDiffReviewCandidateCurrent(subject, reused.review);
  const providerId = reused.review.assignment.reviewerProviderId;
  if (providerId === null) throw reviewNotSatisfied();
  return Object.freeze({
    source: 'provider' as const,
    subject,
    review: reused.review,
    implementationActor: reused.reservation.implementationActor,
    authenticatedReviewAuthority: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'review' as const,
      subjectDigest: reused.review.subjectDigest,
      reviewRecordDigest: reused.review.recordDigest,
      responseDigest: null,
      authorityNodeId: reused.binding.providerResultNodeId,
      authorityResultDigest: reused.binding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId: reused.review.assignment.reviewerPrincipalId,
        providerId,
        policyDigest: reused.review.subject.reviewPolicyDigest,
      }),
    }),
    reviewResultNodeId: reused.binding.providerResultNodeId,
    reviewResultDigest: reused.binding.providerResultDigest,
  });
}

export function resolveTaskDiffReviewCandidatePlan(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  replayMode: TaskDiffReviewReplayMode = 'governing',
  validation?: TaskDiffReviewConsumedReplayValidation,
): TaskDiffReviewCandidatePlan {
  return loadTaskDiffReviewLineage(
    capabilities,
    context,
    runtime,
    subject,
    replayMode,
    null,
    validation,
  ).candidatePlan;
}

export function readExactProviderTaskDiffReviewSource(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  sessionId: string,
  subjectDigest: string,
) {
  const reservation = readTaskDiffReviewReservation(
    runtime,
    sessionId,
    subjectDigest,
  );
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    sessionId,
    subjectDigest,
  );
  if (binding !== null && reservation === null) {
    throw taskDiffReviewLineageConflict();
  }
  return Object.freeze({ reservation, binding });
}

export function assertNoAllSessionProviderSourceCollision(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
): void {
  if (
    listAllTaskDiffReviewReservations(runtime).some(
      (reservation) => reservation.subject.subjectDigest === subjectDigest,
    ) ||
    listAllTaskDiffReviewResultBindings(runtime).some(
      (binding) => binding.subjectDigest === subjectDigest,
    )
  ) {
    throw taskDiffReviewLineageConflict();
  }
}

function loadTaskDiffReviewLineage(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  replayMode: TaskDiffReviewReplayMode = 'governing',
  allowedMissingSupersession: TaskDiffReviewSupersessionRecoveryTarget | null = null,
  collaborationGrantValidation?: ReconcileTaskDiffReviewOptions['collaborationGrantValidation'],
): Readonly<{
  candidatePlan: TaskDiffReviewCandidatePlan;
  predecessor: LoadedTaskDiffReviewLineageEntry | null;
  entries: readonly LoadedTaskDiffReviewLineageEntry[];
}> {
  const entries: LoadedTaskDiffReviewLineageEntry[] = [];
  const providerBindings = listAllTaskDiffReviewResultBindings(runtime);
  for (const binding of providerBindings) {
    const reservation = readTaskDiffReviewReservation(
      runtime,
      binding.sessionId,
      binding.subjectDigest,
    );
    if (reservation === null) throw taskDiffReviewLineageConflict();
    assertCurrentTaskDiffReviewBinding(
      capabilities,
      runtime,
      reservation,
      binding.review,
      replayMode,
      collaborationGrantValidation,
    );
    if (
      binding.review.subject.repositoryId !== subject.repositoryId ||
      binding.review.subject.changeId !== subject.changeId ||
      binding.review.subject.taskId !== subject.taskId ||
      binding.review.subject.baseCommit !== subject.baseCommit ||
      binding.review.subject.baseTree !== subject.baseTree
    ) {
      continue;
    }
    const source = {
      source: 'provider',
      subject: binding.review.subject,
      reviewRecordDigest: binding.review.recordDigest,
      reviewScope: binding.review.reviewScope,
      finalAssuranceCommitmentDigest: null,
      provider: Object.freeze({ reservation, binding }),
    } satisfies LoadedTaskDiffReviewLineageSource;
    const terminal = replayTaskDiffReviewTerminal(
      capabilities,
      context,
      runtime,
      source,
      replayMode,
      collaborationGrantValidation,
    );
    entries.push({
      ...source,
      finalAssuranceCommitmentDigest: terminal.commitmentDigest,
      terminal,
    });
  }
  for (const binding of listTaskDiffExternalReviewBindings(runtime)) {
    const reviewedSubject = bindingSubject(runtime, binding);
    if (
      reviewedSubject.repositoryId !== subject.repositoryId ||
      reviewedSubject.changeId !== subject.changeId ||
      reviewedSubject.taskId !== subject.taskId ||
      reviewedSubject.baseCommit !== subject.baseCommit ||
      reviewedSubject.baseTree !== subject.baseTree
    ) {
      continue;
    }
    const current = assertHistoricalExternalTaskDiffReviewBinding(
      capabilities,
      context,
      runtime,
      binding,
      undefined,
      replayMode,
      collaborationGrantValidation,
    );
    const source = {
      source: 'external',
      subject: current.review.subject,
      reviewRecordDigest: current.review.recordDigest,
      reviewScope: current.review.reviewScope,
      finalAssuranceCommitmentDigest: null,
      external: current,
    } satisfies LoadedTaskDiffReviewLineageSource;
    const terminal = replayTaskDiffReviewTerminal(
      capabilities,
      context,
      runtime,
      source,
      replayMode,
      collaborationGrantValidation,
    );
    entries.push({
      ...source,
      finalAssuranceCommitmentDigest: terminal.commitmentDigest,
      terminal,
    });
  }
  assertNoOrphanTaskDiffReviewContinuations(
    capabilities,
    context,
    runtime,
    entries,
  );
  assertTaskDiffReviewTerminalLineageEdges(entries);
  const resolved = resolveTaskDiffReviewLineage({
    current: subject,
    entries,
  });
  const predecessor =
    resolved.predecessor === null
      ? null
      : (entries.find(
          (entry) =>
            entry.reviewRecordDigest ===
            resolved.predecessor!.reviewRecordDigest,
        ) ?? null);
  if ((resolved.predecessor === null) !== (predecessor === null)) {
    throw taskDiffReviewLineageConflict();
  }
  if (
    predecessor?.terminal.state === 'challenge-open' &&
    resolved.candidatePlan.action !== 'reuse'
  ) {
    throw taskDiffReviewPriorChallengeOpen();
  }
  assertTaskDiffReviewLineageSupersessionProjection(
    runtime,
    entries,
    allowedMissingSupersession,
  );
  return Object.freeze({
    candidatePlan: resolved.candidatePlan,
    predecessor,
    entries: Object.freeze(entries),
  });
}

function assertTaskDiffReviewTerminalLineageEdges(
  entries: readonly LoadedTaskDiffReviewLineageEntry[],
): void {
  const byReview = new Map(
    entries.map((entry) => [entry.reviewRecordDigest, entry]),
  );
  for (const entry of entries) {
    const predecessor = entry.reviewScope.predecessor;
    if (predecessor === null) continue;
    const parent = byReview.get(predecessor.reviewRecordDigest);
    if (parent === undefined) continue;
    if (parent.terminal.state === 'challenge-open') {
      throw taskDiffReviewPriorChallengeOpen();
    }
    if (
      parent.terminal.commitmentDigest !==
      predecessor.finalAssuranceCommitmentDigest
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
}

function replayTaskDiffReviewTerminal(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  source: LoadedTaskDiffReviewLineageSource,
  replayMode: TaskDiffReviewReplayMode,
  validation?: TaskDiffReviewConsumedReplayValidation,
): ReplayedTaskDiffReviewTerminal {
  const current = authenticatedTaskDiffReviewFromLineageSource(source);
  const review = current.review;
  const providerReservations = listAllTaskDiffReviewContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.review.recordDigest === review.recordDigest,
  );
  const providerBindings = listAllTaskDiffReviewContinuationResultBindings(
    runtime,
  ).filter((binding) => binding.reviewRecordDigest === review.recordDigest);
  const externalReservations = listAllTaskDiffExternalContinuationReservations(
    runtime,
  ).filter(
    (reservation) => reservation.reviewRecordDigest === review.recordDigest,
  );
  const externalBindings = listAllTaskDiffExternalContinuationBindings(
    runtime,
  ).filter((binding) => binding.reviewRecordDigest === review.recordDigest);
  const activeExternalReservations = externalReservations.filter(
    (reservation) => {
      const inspection = inspectExternalGrant(
        context.git.gitCommonDirectory,
        reservation.grant.grantId,
      );
      return inspection.state === 'reserved' || inspection.state === 'consumed';
    },
  );
  if (
    providerReservations.length > 1 ||
    providerBindings.length > 1 ||
    activeExternalReservations.length > 1 ||
    externalBindings.length > 1 ||
    (providerBindings.length === 1 && providerReservations.length !== 1)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const providerReservation = providerReservations[0] ?? null;
  const providerBinding = providerBindings[0] ?? null;
  if (
    providerReservation !== null &&
    (canonicalJson(providerReservation.review) !== canonicalJson(review) ||
      providerReservation.subject.subjectDigest !== review.subjectDigest)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  if (
    providerBinding !== null &&
    (providerReservation === null ||
      providerBinding.sessionId !== providerReservation.sessionId ||
      providerBinding.subjectDigest !== review.subjectDigest ||
      providerBinding.responseDigest !==
        providerReservation.response.responseDigest)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const hasExternalContinuation =
    activeExternalReservations.length > 0 || externalBindings.length > 0;
  let providerReservationIsShortageProvenance = false;
  if (hasExternalContinuation && providerBinding === null) {
    assertExternalTaskDiffContinuationProviderShortage(
      context,
      runtime,
      context.session.sessionId,
      review,
    );
    providerReservationIsShortageProvenance = providerReservation !== null;
  }
  const hasProviderContinuation =
    !providerReservationIsShortageProvenance &&
    (providerReservation !== null || providerBinding !== null);
  if (hasProviderContinuation && hasExternalContinuation) {
    throw taskDiffReviewLineageConflict();
  }
  const storedAssurance = readTaskDiffFinalAssuranceBinding(
    runtime,
    review.subjectDigest,
  );
  if (review.challenges.length === 0) {
    if (
      hasProviderContinuation ||
      hasExternalContinuation ||
      storedAssurance !== null
    ) {
      throw taskDiffReviewLineageConflict();
    }
    assertTaskDiffReviewContentSatisfied(review.subject, review, null);
    return Object.freeze({
      state: 'satisfied' as const,
      finalAssurance: null,
      commitmentDigest: null,
      closureSource: null,
    });
  }
  if (hasProviderContinuation && providerReservation !== null) {
    if (providerBinding === null) {
      if (storedAssurance !== null) throw taskDiffReviewLineageConflict();
      return openTaskDiffReviewTerminal(null);
    }
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      providerReservation,
      providerBinding.submission,
    );
    const assurance = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current,
      providerReservation,
      providerBinding,
    );
    return assurance === null
      ? openTaskDiffReviewTerminal('provider')
      : closedTaskDiffReviewTerminal(assurance, 'provider');
  }
  if (externalBindings.length === 1) {
    const assurance = loadAuthenticatedExternalTaskDiffTerminalAssurance(
      capabilities,
      {
        context,
        runtime,
        current,
        replayMode,
        validation,
      },
    );
    return assurance === null
      ? openTaskDiffReviewTerminal('external')
      : closedTaskDiffReviewTerminal(assurance.finalAssurance, 'external');
  }
  if (storedAssurance !== null) throw taskDiffReviewLineageConflict();
  return openTaskDiffReviewTerminal(null);
}

export function authenticatedTaskDiffReviewFromLineageSource(
  source: LoadedTaskDiffReviewLineageSource,
): CurrentAuthenticatedTaskDiffReview {
  if (source.source === 'external') {
    return Object.freeze({
      source: 'external' as const,
      subject: source.subject,
      review: source.external.review,
      implementationActor: source.external.implementationActor,
      authenticatedReviewAuthority: authenticatedExternalReviewAuthority(
        source.external,
      ),
      reviewResultNodeId: source.external.binding.authorityNodeId,
      reviewResultDigest: source.external.binding.authorityResultDigest,
    });
  }
  const providerId =
    source.provider.binding.review.assignment.reviewerProviderId;
  if (providerId === null) throw reviewNotSatisfied();
  return Object.freeze({
    source: 'provider' as const,
    subject: source.subject,
    review: source.provider.binding.review,
    implementationActor: source.provider.reservation.implementationActor,
    authenticatedReviewAuthority: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'review' as const,
      subjectDigest:
        source.reviewRecordDigest ===
        source.provider.binding.review.recordDigest
          ? source.subject.subjectDigest
          : (() => {
              throw taskDiffReviewLineageConflict();
            })(),
      reviewRecordDigest: source.reviewRecordDigest,
      responseDigest: null,
      authorityNodeId: source.provider.binding.providerResultNodeId,
      authorityResultDigest: source.provider.binding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId:
          source.provider.binding.review.assignment.reviewerPrincipalId,
        providerId,
        policyDigest: source.subject.reviewPolicyDigest,
      }),
    }),
    reviewResultNodeId: source.provider.binding.providerResultNodeId,
    reviewResultDigest: source.provider.binding.providerResultDigest,
  });
}

function openTaskDiffReviewTerminal(
  closureSource: ReplayedTaskDiffReviewTerminal['closureSource'],
): ReplayedTaskDiffReviewTerminal {
  return Object.freeze({
    state: 'challenge-open' as const,
    finalAssurance: null,
    commitmentDigest: null,
    closureSource,
  });
}

function closedTaskDiffReviewTerminal(
  finalAssurance: TaskDiffFinalAssuranceRecord,
  closureSource: Exclude<ReplayedTaskDiffReviewTerminal['closureSource'], null>,
): ReplayedTaskDiffReviewTerminal {
  return Object.freeze({
    state: finalAssurance.verdict,
    finalAssurance,
    commitmentDigest: finalAssurance.commitmentDigest,
    closureSource,
  });
}

function assertNoOrphanTaskDiffReviewContinuations(
  capabilities: Pick<TaskDiffReviewCapabilities, 'changeContract'>,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  entries: readonly LoadedTaskDiffReviewLineageEntry[],
): void {
  const reviewDigests = new Set(
    entries.map(({ reviewRecordDigest }) => reviewRecordDigest),
  );
  const subjectDigests = new Set(
    entries.map(({ subject }) => subject.subjectDigest),
  );
  const currentSubject = inspectTaskDiffReviewSubject(
    capabilities,
    context.git.repositoryRoot,
    context.session.sessionId,
  );
  for (const reservation of listAllTaskDiffReviewContinuationReservations(
    runtime,
  )) {
    if (
      sameTaskDiffReviewLineage(reservation.subject, currentSubject) &&
      !reviewDigests.has(reservation.review.recordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const binding of listAllTaskDiffReviewContinuationResultBindings(
    runtime,
  )) {
    if (
      (reviewDigests.has(binding.reviewRecordDigest) ||
        subjectDigests.has(binding.subjectDigest)) &&
      !reviewDigests.has(binding.reviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const reservation of listAllTaskDiffExternalContinuationReservations(
    runtime,
  )) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      reservation.grant.grantId,
    );
    if (
      (inspection.state === 'reserved' || inspection.state === 'consumed') &&
      sameTaskDiffReviewLineage(reservation.subject, currentSubject) &&
      !reviewDigests.has(reservation.reviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const binding of listAllTaskDiffExternalContinuationBindings(runtime)) {
    if (
      (reviewDigests.has(binding.reviewRecordDigest) ||
        subjectDigests.has(binding.subjectDigest)) &&
      !reviewDigests.has(binding.reviewRecordDigest)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
}

function sameTaskDiffReviewLineage(
  left: TaskDiffReviewSubject,
  right: TaskDiffReviewSubject,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.changeId === right.changeId &&
    left.taskId === right.taskId &&
    left.baseCommit === right.baseCommit &&
    left.baseTree === right.baseTree
  );
}

function assertTaskDiffReviewLineageSupersessionProjection(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  entries: readonly LoadedTaskDiffReviewLineageEntry[],
  allowedMissingSupersession: TaskDiffReviewSupersessionRecoveryTarget | null,
): void {
  const byReview = new Map(
    entries.map((entry) => [entry.reviewRecordDigest, entry]),
  );
  const commonRelations = listTaskDiffReviewLineageSupersessions(runtime);
  for (const relation of commonRelations) {
    const predecessor = byReview.get(relation.predecessorReviewRecordDigest);
    const successor = byReview.get(relation.successorReviewRecordDigest);
    if (predecessor === undefined && successor === undefined) continue;
    if (
      predecessor === undefined ||
      successor === undefined ||
      canonicalJson(predecessor.subject) !==
        canonicalJson(relation.predecessorSubject) ||
      canonicalJson(
        predecessor.source === 'provider'
          ? predecessor.provider.binding.review
          : predecessor.external.review,
      ) !== canonicalJson(relation.predecessorReview) ||
      canonicalJson(successor.subject) !==
        canonicalJson(relation.successorSubject) ||
      canonicalJson(
        successor.source === 'provider'
          ? successor.provider.binding.review
          : successor.external.review,
      ) !== canonicalJson(relation.successorReview) ||
      canonicalJson(successor.reviewScope) !==
        canonicalJson(relation.successorReviewScope)
    ) {
      throw taskDiffReviewLineageConflict();
    }
  }
  for (const successor of entries) {
    const predecessor = successor.reviewScope.predecessor;
    if (predecessor === null) continue;
    const relation = commonRelations.find(
      (candidate) =>
        candidate.predecessorReviewRecordDigest ===
        predecessor.reviewRecordDigest,
    );
    if (relation !== undefined) continue;
    if (
      allowedMissingSupersession?.predecessorReviewRecordDigest ===
        predecessor.reviewRecordDigest &&
      allowedMissingSupersession.successorReviewRecordDigest ===
        successor.reviewRecordDigest
    ) {
      continue;
    }
    throw taskDiffReviewSupersessionReconciliationRequired();
  }
}

export function ensureTaskDiffReviewSupersession(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffReviewResultBinding,
  collaborationGrantValidation?: ReconcileTaskDiffReviewOptions['collaborationGrantValidation'],
): void {
  const scope = binding.review.reviewScope;
  const predecessor = scope.predecessor;
  if (predecessor === null) return;
  const lineage = loadTaskDiffReviewLineage(
    capabilities,
    context,
    runtime,
    binding.review.subject,
    'governing',
    {
      predecessorReviewRecordDigest: predecessor.reviewRecordDigest,
      successorReviewRecordDigest: binding.review.recordDigest,
    },
    collaborationGrantValidation,
  );
  const predecessorEntry = lineage.entries.find(
    (entry) => entry.reviewRecordDigest === predecessor.reviewRecordDigest,
  );
  const successorEntry = lineage.entries.find(
    (entry) => entry.reviewRecordDigest === binding.review.recordDigest,
  );
  if (
    predecessorEntry === undefined ||
    successorEntry === undefined ||
    predecessorEntry.subject.subjectDigest !== predecessor.subjectDigest ||
    predecessorEntry.terminal.state === 'challenge-open' ||
    predecessorEntry.terminal.commitmentDigest !==
      predecessor.finalAssuranceCommitmentDigest ||
    successorEntry.source !== 'provider' ||
    canonicalJson(successorEntry.provider.binding) !== canonicalJson(binding)
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const predecessorReview =
    predecessorEntry.source === 'provider'
      ? predecessorEntry.provider.binding.review
      : predecessorEntry.external.review;
  createTaskDiffReviewLineageSupersession(runtime, {
    predecessorSubject: predecessorEntry.subject,
    predecessorReview,
    successorSubject: binding.review.subject,
    successorReview: binding.review,
    successorReviewScope: binding.review.reviewScope,
    successorReviewScopeDigest: binding.review.reviewScope.scopeDigest,
  });
}

export function loadReusedTaskDiffReview(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  context: ReturnType<typeof loadActiveSessionContext>,
  currentSubject: TaskDiffReviewSubject,
  plan: Extract<TaskDiffReviewCandidatePlan, { action: 'reuse' }>,
  replayMode: TaskDiffReviewReplayMode = 'governing',
  validation?: TaskDiffReviewConsumedReplayValidation,
): Readonly<
  | {
      source: 'provider';
      subject: TaskDiffReviewSubject;
      reservation: TaskDiffReviewReservationRecord;
      binding: TaskDiffReviewResultBinding;
      review: TaskDiffReviewRecord;
      terminal: ReplayedTaskDiffReviewTerminal;
    }
  | {
      source: 'external';
      subject: TaskDiffReviewSubject;
      current: CurrentExternalTaskDiffReview;
      review: TaskDiffReviewRecord;
      terminal: ReplayedTaskDiffReviewTerminal;
    }
> {
  const lineage = loadTaskDiffReviewLineage(
    capabilities,
    context,
    runtime,
    currentSubject,
    replayMode,
    null,
    validation,
  );
  const predecessor = lineage.predecessor;
  if (
    predecessor === null ||
    predecessor.subject.subjectDigest !== plan.predecessor.subjectDigest ||
    predecessor.reviewRecordDigest !== plan.predecessor.reviewRecordDigest ||
    predecessor.finalAssuranceCommitmentDigest !==
      plan.predecessor.finalAssuranceCommitmentDigest
  ) {
    throw taskDiffReviewLineageConflict();
  }
  const replay = deriveTaskDiffReviewCandidatePlan({
    current: currentSubject,
    predecessor: {
      subject: predecessor.subject,
      reviewRecordDigest: predecessor.reviewRecordDigest,
      finalAssuranceCommitmentDigest:
        plan.predecessor.finalAssuranceCommitmentDigest,
    },
  });
  if (canonicalJson(replay) !== canonicalJson(plan)) {
    throw taskDiffReviewLineageConflict();
  }
  if (predecessor.source === 'external') {
    return Object.freeze({
      source: 'external' as const,
      subject: currentSubject,
      current: predecessor.external,
      review: predecessor.external.review,
      terminal: predecessor.terminal,
    });
  }
  return Object.freeze({
    source: 'provider' as const,
    subject: currentSubject,
    reservation: predecessor.provider.reservation,
    binding: predecessor.provider.binding,
    review: predecessor.provider.binding.review,
    terminal: predecessor.terminal,
  });
}
