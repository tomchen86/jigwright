import type {
  TaskMandateProviderAdmission,
  TaskMandateActiveBinding,
} from '../../modules/authority/task-mandate-access-contract.ts';
import type { HumanResolutionServices } from '../../modules/investigation/domain/human-resolution-grant-contract.ts';
import type {
  InvestigationHumanActionBlockerFactory,
  HumanResolutionNode,
  InvestigationResolutionState,
} from '../../modules/investigation/domain/human-resolution-contract.ts';
import { investigationResolutionStateDigest } from '../../modules/investigation/domain/human-resolution-contract.ts';
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  loadAiAdapterPolicy,
} from '../provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  createReplacementAttempt,
  providerExecutionEnvironmentDigest,
  providerExecutionPolicySnapshot,
} from '../../modules/provider-orchestration/execution-core.ts';
import type { RetryMode } from '../../modules/provider-orchestration/execution-core.ts';
import {
  loadProviderExecutionRepairContext,
  preflightProviderRepairRetry,
} from '../storage-journal/provider-execution-governance.ts';
import {
  assertInvestigationCheckpointEnvelope,
  checkpointContributionDigest,
  checkpointEnvelopeDigest,
} from '../../modules/investigation/domain/investigation-checkpoint-contract.ts';
import {
  compareAndSwapInvestigationSession,
  createCurrentInvestigationRef,
  createInvestigationId,
  createInvestigationSessionRecord,
  investigationSessionExists,
  readCurrentInvestigationRef,
  readInvestigationSession,
} from '../storage-journal/investigation-session-records.ts';
import {
  readHumanResolutionHead,
  readHumanResolutionNode,
} from '../storage-journal/human-resolution-nodes.ts';
import {
  deriveInvestigationSessionState,
  investigationCheckpointId,
} from '../../modules/investigation/domain/investigation-session-contract.ts';
import { inspectInvestigationResolutionState } from '../storage-journal/human-resolution-state.ts';
import type {
  InvestigationCheckpointEnvelope,
  InvestigationCheckpointKind,
  InvestigationSession,
  StoredInvestigationCheckpoint,
} from '../../modules/investigation/domain/investigation-session-types.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST } from '../../modules/investigation/manifest/plan-review-coverage-policy.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../foundation/repository-path/repository-path.ts';
import {
  type HeldChangeTransitionAuthority,
  assertHeldChangeTransitionAuthority,
  withInvestigationTransitionAuthority,
} from '../session-workspace/planning-lock.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  createInvestigationStartReservation,
  createProviderInvocation,
  createProviderRetryReservation,
  ensureProviderExecutionPolicySnapshot,
  ensureProviderExecutionPolicySnapshotFromSnapshot,
  expireProviderInvocationLeaseUnderLifecycleLock,
  providerInvocationExists,
  readBlindSurveyManifest,
  readInvestigationStartReservation,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
} from '../storage-journal/provider-invocation-store.ts';
import type { BlindSurveyManifest } from '../../modules/investigation/manifest/blind-survey-manifest.ts';
import type { InvestigationStartReservation } from '../../modules/provider-orchestration/provider-invocation-reservations.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import { inspectProviderInvocationActivity } from '../storage-journal/provider-invocation-activity.ts';
import {
  assertProviderExecutionGrantAuthorization,
  authorizeAutomaticProviderRetry,
} from '../../modules/provider-orchestration/provider-retry-decision.ts';
import type { ProviderExecutionGrantAuthorization } from '../../modules/provider-orchestration/provider-retry-decision.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import type { ReviewerTermResolutionAuthorization } from '../../modules/investigation/domain/reviewer-term-reopen.ts';

type TaskMandateDependencies = Pick<
  TaskMandateActiveBinding,
  'assertActiveTaskMandateBindingUnderLifecycleLock'
> &
  Pick<
    TaskMandateProviderAdmission,
    'authorizeTaskMandateProviderReservationUnderLifecycleLock'
  >;

export type StartInvestigationSessionInput = {
  changeId: string;
  blindManifest: BlindSurveyManifest;
  blindRequest: ProviderInvocationRequest;
  mandateBinding?: TaskMandateBinding;
};

export type RetryInvestigationProviderInput = {
  expectedRevision: number;
  replacementRequest: ProviderInvocationRequest;
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization;
};

export function startInvestigationSession(
  taskMandate: TaskMandateDependencies,
  cwd: string,
  input: StartInvestigationSessionInput,
): InvestigationStatus {
  assertExactStartInput(input);
  const changeId = assertChangeId(input.changeId);
  const context = loadInvestigationRuntimeContext(cwd);
  const manifestDigest = blindSurveyManifestDigest(input.blindManifest);
  const intentDigest = blindSurveyIntentDigest(input.blindManifest);
  assertStartBinding(context, changeId, input, manifestDigest, intentDigest);

  return withInvestigationTransitionAuthority(
    context.lifecycleRuntime,
    changeId,
    (assertOwned) =>
      startInvestigationSessionUnderLifecycleLock(
        taskMandate,
        cwd,
        input,
        context,
        assertOwned,
      ),
  );
}

export function startInvestigationSessionUnderLifecycleLock(
  taskMandate: TaskMandateDependencies,
  cwd: string,
  input: StartInvestigationSessionInput,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authority: HeldChangeTransitionAuthority,
): InvestigationStatus {
  assertExactStartInput(input);
  const changeId = assertChangeId(input.changeId);
  const assertOwned = assertHeldChangeTransitionAuthority(authority, changeId);
  const manifestDigest = blindSurveyManifestDigest(input.blindManifest);
  const intentDigest = blindSurveyIntentDigest(input.blindManifest);
  assertStartBinding(context, changeId, input, manifestDigest, intentDigest);
  assertOwned();
  const lockedContext = loadInvestigationRuntimeContext(cwd);
  assertStableStartContext(context, lockedContext);
  assertStartBinding(
    lockedContext,
    changeId,
    input,
    manifestDigest,
    intentDigest,
  );
  if (input.mandateBinding) {
    taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
      cwd,
      input.mandateBinding,
      assertOwned,
    );
  }
  const currentRef = readCurrentInvestigationRef(
    lockedContext.runtime,
    changeId,
  );
  if (currentRef !== null) {
    const current = readInvestigationSession(
      lockedContext.runtime,
      currentRef.investigationId,
    );
    if (current.blindManifestDigest === manifestDigest) {
      assertCurrentInvestigationContext(lockedContext, current);
      const reservation = readInvestigationStartReservation(
        lockedContext.runtime,
        changeId,
      );
      if (reservation === null) {
        throw workflowError(
          'INVESTIGATION_START_RESERVATION_MISSING',
          'Current investigation has no durable start reservation.',
          ExitCode.staleState,
        );
      }
      assertStartReservationSessionBinding(lockedContext, reservation, current);
      authorizeSurveyReservationMandate(
        taskMandate,
        cwd,
        reservation,
        assertOwned,
        false,
      );
      return statusFromSession(lockedContext, current);
    }
    throw workflowError(
      'CURRENT_INVESTIGATION_CONFLICT',
      `Change ${changeId} already has a different current investigation.`,
      ExitCode.conflict,
    );
  }

  const existingReservation = readInvestigationStartReservation(
    lockedContext.runtime,
    changeId,
  );
  if (
    existingReservation !== null &&
    existingReservation.manifestDigest !== manifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_CONFLICT',
      'Change already has a durable start reservation for different intent.',
      ExitCode.conflict,
    );
  }
  const reservation =
    existingReservation ??
    createInvestigationStartReservation(lockedContext.runtime, {
      changeId,
      investigationId: createInvestigationId(),
      repositoryRoot: lockedContext.git.repositoryRealPath,
      gitCommonDirectory: lockedContext.git.gitCommonDirectory,
      branch: lockedContext.git.branch,
      baseline: {
        head: lockedContext.git.head,
        tree: lockedContext.git.tree,
      },
      manifest: input.blindManifest,
      request: input.blindRequest,
      ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
      executionPolicy: loadAiAdapterPolicy(
        lockedContext.git.repositoryRealPath,
      ),
    });
  assertStartReservationContext(lockedContext, reservation);
  authorizeSurveyReservationMandate(
    taskMandate,
    cwd,
    reservation,
    assertOwned,
    false,
  );
  const reservedInput: StartInvestigationSessionInput = {
    changeId,
    blindManifest: reservation.manifest,
    blindRequest: reservation.request,
    ...(reservation.mandateBinding
      ? { mandateBinding: reservation.mandateBinding }
      : {}),
  };
  const reservedIntentDigest = blindSurveyIntentDigest(reservation.manifest);
  assertStartBinding(
    lockedContext,
    changeId,
    reservedInput,
    reservation.manifestDigest,
    reservedIntentDigest,
  );
  const existingPrepared = providerInvocationExists(
    lockedContext.runtime,
    reservation.invocationId,
  )
    ? readProviderInvocation(lockedContext.runtime, reservation.invocationId)
    : null;
  if (
    existingPrepared !== null &&
    (existingPrepared.changeId !== changeId ||
      canonicalJson(existingPrepared.mandateBinding ?? null) !==
        canonicalJson(reservation.mandateBinding ?? null) ||
      existingPrepared.investigationId !== reservation.investigationId ||
      existingPrepared.attempt !== 1 ||
      existingPrepared.requestDigest !== reservation.requestDigest ||
      existingPrepared.manifestDigest !== reservation.manifestDigest)
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_COLLISION',
      'The requested blind invocation ID belongs to different durable work.',
      ExitCode.conflict,
    );
  }
  const investigationId = reservation.investigationId;
  ensureProviderExecutionPolicySnapshot(
    lockedContext.runtime,
    reservation.request,
    loadAiAdapterPolicy(lockedContext.git.repositoryRealPath),
  );
  if (existingPrepared === null) {
    createProviderInvocation(lockedContext.runtime, {
      investigationId,
      changeId,
      ...(reservation.mandateBinding
        ? { mandateBinding: reservation.mandateBinding }
        : {}),
      attempt: 1,
      manifest: reservation.manifest,
      request: reservation.request,
    });
  }
  assertOwned();
  const now = new Date().toISOString();
  const session: InvestigationSession = {
    schemaVersion: 1,
    investigationId,
    revision: 0,
    semanticRevision: 0,
    lifecycleRevision: 0,
    state: 'awaiting-main-terms',
    changeId,
    ...(reservation.mandateBinding
      ? { mandateBinding: reservation.mandateBinding }
      : {}),
    repositoryRoot: lockedContext.git.repositoryRealPath,
    gitCommonDirectory: lockedContext.git.gitCommonDirectory,
    branch: lockedContext.git.branch,
    baseline: {
      head: lockedContext.git.head,
      tree: lockedContext.git.tree,
    },
    intentDigest: reservedIntentDigest,
    planReviewCoveragePolicyDigest: GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    blindManifestDigest: reservation.manifestDigest,
    blindRequestDigest: reservation.requestDigest,
    blindInvocationIds: [reservation.invocationId],
    currentBlindInvocationId: reservation.invocationId,
    milestones: {
      mainTerms: null,
      blindResult: null,
      reviewerTermSourceNodeId: null,
      groupDispositions: null,
      whyAnswers: null,
    },
    blocker: null,
    createdAt: now,
    updatedAt: now,
  };
  const persistedSession = investigationSessionExists(
    lockedContext.runtime,
    investigationId,
  )
    ? readInvestigationSession(lockedContext.runtime, investigationId)
    : createInvestigationSessionRecord(lockedContext.runtime, session);
  if (
    persistedSession.changeId !== changeId ||
    canonicalJson(persistedSession.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding ?? null) ||
    persistedSession.investigationId !== reservation.investigationId ||
    persistedSession.repositoryRoot !== reservation.repositoryRoot ||
    persistedSession.gitCommonDirectory !== reservation.gitCommonDirectory ||
    persistedSession.branch !== reservation.branch ||
    canonicalJson(persistedSession.baseline) !==
      canonicalJson(reservation.baseline) ||
    persistedSession.intentDigest !== reservedIntentDigest ||
    persistedSession.blindManifestDigest !== reservation.manifestDigest ||
    persistedSession.blindRequestDigest !== reservation.requestDigest ||
    persistedSession.currentBlindInvocationId !== reservation.invocationId ||
    canonicalJson(persistedSession.blindInvocationIds) !==
      canonicalJson([reservation.invocationId])
  ) {
    throw workflowError(
      'INVESTIGATION_SESSION_COLLISION',
      'Recovered investigation state belongs to different blind work.',
      ExitCode.conflict,
    );
  }
  assertOwned();
  const finalContext = loadInvestigationRuntimeContext(cwd);
  assertStableStartContext(lockedContext, finalContext);
  assertStartBinding(
    finalContext,
    changeId,
    reservedInput,
    reservation.manifestDigest,
    reservedIntentDigest,
  );
  createCurrentInvestigationRef(
    finalContext.runtime,
    changeId,
    investigationId,
  );
  assertOwned();
  return statusFromSession(finalContext, persistedSession);
}

export function getInvestigationStatus(
  cwd: string,
  requestedInvestigationId: string,
): InvestigationStatus {
  const context = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(context.runtime, investigationId);
  assertCurrentInvestigationContext(context, session);
  return statusFromSession(context, session);
}

export function resumeInvestigationSession(
  cwd: string,
  requestedInvestigationId: string,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      resumeInvestigationSessionUnlocked(context, current, checkpoint),
  );
}

export function resumeInvestigationSessionUnderAuthority(
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  checkpoint: InvestigationCheckpointEnvelope | undefined,
  authority: HeldChangeTransitionAuthority,
): InvestigationStatus {
  const assertOwned = assertHeldChangeTransitionAuthority(authority, changeId);
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      resumeInvestigationSessionUnlocked(context, current, checkpoint),
    { changeId: authority.changeId, assertOwned },
  );
}

function resumeInvestigationSessionUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  if (checkpoint === undefined) {
    const invocation = readProviderInvocation(
      context.runtime,
      current.currentBlindInvocationId,
    );
    if (invocation.state === 'succeeded') {
      return publishProviderResultUnlocked(context, current, {
        expectedRevision: current.revision,
        invocationId: invocation.invocationId,
      });
    }
    return statusFromSession(context, current);
  }

  const envelope = assertInvestigationCheckpointEnvelope(checkpoint);
  assertCheckpointBinding(current, envelope);
  const stored = storedCheckpointFor(current, envelope.kind);
  const digest = checkpointEnvelopeDigest(envelope);
  const contributionDigest = checkpointContributionDigest(envelope);
  if (stored !== null) {
    if (
      stored.envelope.contributionDigest === contributionDigest &&
      stored.envelope.envelope.checkpointId === envelope.checkpointId
    ) {
      return statusFromSession(context, current);
    }
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_CONFLICT',
      'This investigation checkpoint was already satisfied by different input.',
      ExitCode.conflict,
    );
  }

  const expectedKind = expectedCheckpointKind(current);
  if (
    expectedKind !== envelope.kind ||
    envelope.checkpointId !== investigationCheckpointId(current, envelope.kind)
  ) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_UNEXPECTED',
      'Caller input does not satisfy the investigation checkpoint now pending.',
      ExitCode.guard,
    );
  }
  const orthogonalMainJoin =
    envelope.kind === 'main-terms' &&
    current.milestones.mainTerms === null &&
    envelope.expectedRevision <= current.revision &&
    envelope.checkpointId === investigationCheckpointId(current, 'main-terms');
  if (envelope.expectedRevision !== current.revision && !orthogonalMainJoin) {
    throw investigationCasMismatch(envelope.expectedRevision, current.revision);
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    current.investigationId,
    current.revision,
    (session) => {
      const milestone: StoredInvestigationCheckpoint = {
        envelopeDigest: digest,
        contributionDigest,
        envelope,
      };
      const milestones = { ...session.milestones };
      if (envelope.kind === 'main-terms') {
        milestones.mainTerms = milestone;
      } else if (envelope.kind === 'group-dispositions') {
        milestones.groupDispositions = milestone;
      } else {
        milestones.whyAnswers = milestone;
      }
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        milestones,
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

export function publishProviderResultToInvestigation(
  cwd: string,
  requestedInvestigationId: string,
  input: {
    expectedRevision: number;
    invocationId: string;
  },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      publishProviderResultUnlocked(context, current, input),
  );
}

type ReopenInvestigationForReviewerTermsInput = {
  expectedRevision: number;
  sourceNodeId: string;
  usedReopens: number;
  pendingReviewDigest: string;
  authorizationResolutionNodeId: string | null;
};

type HeldInvestigationAuthority = {
  changeId: string;
  assertOwned: () => void;
};

export function reopenInvestigationForReviewerTerms(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  requestedInvestigationId: string,
  input: ReopenInvestigationForReviewerTermsInput,
): InvestigationStatus {
  return reopenInvestigationForReviewerTermsInternal(
    loadMaintainerPolicyForResolution,
    cwd,
    requestedInvestigationId,
    input,
  );
}

export function reopenInvestigationForReviewerTermsUnderAuthority(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: ReopenInvestigationForReviewerTermsInput,
  assertOwned: () => void,
): InvestigationStatus {
  return reopenInvestigationForReviewerTermsInternal(
    loadMaintainerPolicyForResolution,
    cwd,
    requestedInvestigationId,
    input,
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

function reopenInvestigationForReviewerTermsInternal(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  requestedInvestigationId: string,
  input: ReopenInvestigationForReviewerTermsInput,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !/^[0-9a-f]{64}$/.test(input.sourceNodeId) ||
        !Number.isSafeInteger(input.usedReopens) ||
        input.usedReopens < 0 ||
        !/^[0-9a-f]{64}$/.test(input.pendingReviewDigest)
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term reopening is not bound to the current investigation revision.',
          ExitCode.staleState,
        );
      }
      const humanAuthorized =
        current.blocker !== null &&
        !('code' in current.blocker) &&
        current.blocker.reasonCode ===
          'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED' &&
        input.authorizationResolutionNodeId !== null &&
        assertReviewerTermResolutionAuthorization(
          loadMaintainerPolicyForResolution,
          context,
          current,
          input.pendingReviewDigest,
          input.authorizationResolutionNodeId,
          'resume',
        );
      if (
        (humanAuthorized
          ? current.state !== 'human-action-required'
          : current.state !== 'investigation-sealed') ||
        current.milestones.groupDispositions === null ||
        current.milestones.whyAnswers === null ||
        (input.usedReopens >= 2 && !humanAuthorized)
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'Reviewer terms exhausted the automatic reopen allowance and require an exact human capability.',
          ExitCode.guard,
        );
      }
      if (current.blocker !== null && !humanAuthorized) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'A blocked reviewer-term reopen requires its exact human resolution.',
          ExitCode.guard,
        );
      }
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => {
          const candidate: InvestigationSession = {
            ...session,
            revision: session.revision + 1,
            blocker: null,
            milestones: {
              ...session.milestones,
              reviewerTermSourceNodeId: input.sourceNodeId,
              groupDispositions: null,
              whyAnswers: null,
            },
            updatedAt: new Date().toISOString(),
          };
          candidate.state = deriveInvestigationSessionState(candidate);
          return candidate;
        },
      );
      return statusFromSession(context, next);
    },
    authority,
  );
}

function assertReviewerTermResolutionAuthorization(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
  pendingReviewDigest: string,
  resolutionNodeId: string,
  expectedOutcome: 'resume' | 'close-input',
): boolean {
  if (
    session.blocker === null ||
    'code' in session.blocker ||
    session.blocker.reasonCode !==
      'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED' ||
    session.blocker.facts.pendingReviewDigest !== pendingReviewDigest ||
    readHumanResolutionHead(context.runtime, session.investigationId) !==
      resolutionNodeId
  ) {
    return false;
  }
  const node = readHumanResolutionNode(context.runtime, resolutionNodeId);
  if (
    node.target.workflowId !== session.investigationId ||
    node.target.changeId !== session.changeId ||
    node.expected.reasonCode !== session.blocker.reasonCode ||
    node.expected.blockedTransition !== session.blocker.blockedTransition ||
    !humanResolutionNodeBindsCurrentState(
      loadMaintainerPolicyForResolution,
      context,
      node,
    )
  ) {
    return false;
  }
  return expectedOutcome === 'resume'
    ? node.decision.kind === 'resume-with-capability'
    : node.decision.kind === 'close-input' ||
        node.decision.kind === 'waive-assurance';
}

function humanResolutionNodeBindsCurrentState(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  node: HumanResolutionNode,
): boolean {
  const repositoryId = loadMaintainerPolicyForResolution(
    context.git.repositoryRoot,
    context.git.head,
  ).policy.repository.id;
  let observed: InvestigationResolutionState;
  try {
    observed = inspectInvestigationResolutionState(
      context.runtime,
      node.target.workflowId,
      repositoryId,
    );
  } catch {
    return false;
  }
  if (observed.envelope.resolutionHeadNodeId !== node.nodeId) {
    return false;
  }
  return (
    investigationResolutionStateDigest({
      ...observed.envelope,
      resolutionHeadNodeId: node.previousResolutionNodeId,
    }) === node.expected.stateDigest
  );
}

export function inspectReviewerTermResolutionAuthorization(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  requestedInvestigationId: string,
  pendingReviewDigest: string,
): ReviewerTermResolutionAuthorization {
  const context = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(context.runtime, investigationId);
  if (
    !/^[0-9a-f]{64}$/.test(pendingReviewDigest) ||
    session.blocker === null ||
    'code' in session.blocker ||
    session.blocker.reasonCode !==
      'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED' ||
    session.blocker.facts.pendingReviewDigest !== pendingReviewDigest
  ) {
    return {
      outcome: 'none',
      resolutionNodeId: null,
    };
  }
  const nodeId = readHumanResolutionHead(context.runtime, investigationId);
  if (nodeId === null) {
    return {
      outcome: 'none',
      resolutionNodeId: null,
    };
  }
  const node = readHumanResolutionNode(context.runtime, nodeId);
  if (
    node.target.workflowId !== investigationId ||
    node.target.changeId !== session.changeId ||
    node.expected.reasonCode !== session.blocker.reasonCode ||
    node.expected.blockedTransition !== session.blocker.blockedTransition ||
    !humanResolutionNodeBindsCurrentState(
      loadMaintainerPolicyForResolution,
      context,
      node,
    )
  ) {
    return {
      outcome: 'none',
      resolutionNodeId: null,
    };
  }
  if (node.decision.kind === 'resume-with-capability') {
    return { outcome: 'resume', resolutionNodeId: nodeId };
  }
  if (
    node.decision.kind === 'close-input' ||
    node.decision.kind === 'waive-assurance'
  ) {
    return {
      outcome: 'close-input',
      resolutionNodeId: nodeId,
      assurance:
        node.consequences.assurance === 'human-waived'
          ? 'human-waived'
          : 'degraded',
    };
  }
  return {
    outcome: 'none',
    resolutionNodeId: null,
  };
}

type BlockInvestigationForReviewerTermsInput = {
  expectedRevision: number;
  pendingReviewDigest: string;
  usedReopens: number;
  proposedTermCount: number;
};

export function blockInvestigationForReviewerTerms(
  createInvestigationHumanActionBlocker: InvestigationHumanActionBlockerFactory,
  cwd: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForReviewerTermsInput,
): InvestigationStatus {
  return blockInvestigationForReviewerTermsInternal(
    createInvestigationHumanActionBlocker,
    cwd,
    requestedInvestigationId,
    input,
  );
}

export function blockInvestigationForReviewerTermsUnderAuthority(
  createInvestigationHumanActionBlocker: InvestigationHumanActionBlockerFactory,
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForReviewerTermsInput,
  assertOwned: () => void,
): InvestigationStatus {
  return blockInvestigationForReviewerTermsInternal(
    createInvestigationHumanActionBlocker,
    cwd,
    requestedInvestigationId,
    input,
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

function blockInvestigationForReviewerTermsInternal(
  createInvestigationHumanActionBlocker: InvestigationHumanActionBlockerFactory,
  cwd: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForReviewerTermsInput,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !/^[0-9a-f]{64}$/.test(input.pendingReviewDigest) ||
        !Number.isSafeInteger(input.usedReopens) ||
        input.usedReopens < 2 ||
        !Number.isSafeInteger(input.proposedTermCount) ||
        input.proposedTermCount < 1
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term blocker is not bound to the current review and allowance.',
          ExitCode.staleState,
        );
      }
      if (
        current.state !== 'investigation-sealed' ||
        current.blocker !== null ||
        current.milestones.groupDispositions === null ||
        current.milestones.whyAnswers === null
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'Only a currently sealed investigation can await reviewer-term human resolution.',
          ExitCode.guard,
        );
      }
      const blocker = createInvestigationHumanActionBlocker({
        reasonCode: 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED',
        blockedTransition: 'admit-plan-review',
        facts: {
          automaticAllowance: 2,
          humanGrantedAllowance: 0,
          usedReopens: input.usedReopens,
          proposedTermCount: input.proposedTermCount,
          pendingReviewDigest: input.pendingReviewDigest,
        },
      });
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => ({
          ...session,
          revision: session.revision + 1,
          state: 'human-action-required',
          blocker,
          updatedAt: new Date().toISOString(),
        }),
      );
      return statusFromSession(context, next);
    },
    authority,
  );
}

export type BlockInvestigationForPlanReviewRetryInput = {
  expectedRevision: number;
  failedInvocationId: string;
  attempt: number;
  retryReasonCode: string;
  failureCode: string;
};

/**
 * Park a sealed investigation on human action when its plan review cannot be
 * retried. The retry decision engine can conclude that no further automatic
 * attempt is authorized, and for a plan review no executor answers that
 * conclusion, so the alternative to this blocker is a refusal with no exit at
 * all. Blocking states the failure and hands the change to a person, which is
 * what an expensive, repeatedly failing retry is supposed to do.
 */
export function blockInvestigationForPlanReviewRetryUnderAuthority(
  createInvestigationHumanActionBlocker: InvestigationHumanActionBlockerFactory,
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForPlanReviewRetryInput,
  assertOwned: () => void,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !Number.isSafeInteger(input.attempt) ||
        input.attempt < 1
      ) {
        throw workflowError(
          'PLAN_REVIEW_RETRY_BLOCKER_STALE',
          'Plan-review retry blocker is not bound to the current attempt.',
          ExitCode.staleState,
        );
      }
      if (
        current.state !== 'investigation-sealed' ||
        current.blocker !== null
      ) {
        throw workflowError(
          'PLAN_REVIEW_RETRY_BLOCKER_INVALID',
          'Only a currently sealed investigation can await plan-review retry human resolution.',
          ExitCode.guard,
        );
      }
      const blocker = createInvestigationHumanActionBlocker({
        reasonCode: 'PLAN_REVIEW_RETRY_EXHAUSTED',
        blockedTransition: 'admit-plan-review',
        facts: {
          failedInvocationId: input.failedInvocationId,
          attempt: input.attempt,
          retryReasonCode: input.retryReasonCode,
          failureCode: input.failureCode,
        },
      });
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => ({
          ...session,
          revision: session.revision + 1,
          state: 'human-action-required',
          blocker,
          updatedAt: new Date().toISOString(),
        }),
      );
      return statusFromSession(context, next);
    },
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

type AcknowledgeReviewerTermInputClosureInput = {
  expectedRevision: number;
  pendingReviewDigest: string;
  authorizationResolutionNodeId: string;
};

export function acknowledgeReviewerTermInputClosure(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  requestedInvestigationId: string,
  input: AcknowledgeReviewerTermInputClosureInput,
): InvestigationStatus {
  return acknowledgeReviewerTermInputClosureInternal(
    loadMaintainerPolicyForResolution,
    cwd,
    requestedInvestigationId,
    input,
  );
}

export function acknowledgeReviewerTermInputClosureUnderAuthority(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: AcknowledgeReviewerTermInputClosureInput,
  assertOwned: () => void,
): InvestigationStatus {
  return acknowledgeReviewerTermInputClosureInternal(
    loadMaintainerPolicyForResolution,
    cwd,
    requestedInvestigationId,
    input,
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

function acknowledgeReviewerTermInputClosureInternal(
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'],
  cwd: string,
  requestedInvestigationId: string,
  input: AcknowledgeReviewerTermInputClosureInput,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !assertReviewerTermResolutionAuthorization(
          loadMaintainerPolicyForResolution,
          context,
          current,
          input.pendingReviewDigest,
          input.authorizationResolutionNodeId,
          'close-input',
        )
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_INPUT_CLOSURE_STALE',
          'Reviewer-term input closure is not bound to the exact blocker and grant.',
          ExitCode.staleState,
        );
      }
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => {
          const candidate: InvestigationSession = {
            ...session,
            revision: session.revision + 1,
            blocker: null,
            updatedAt: new Date().toISOString(),
          };
          candidate.state = deriveInvestigationSessionState(candidate);
          return candidate;
        },
      );
      return statusFromSession(context, next);
    },
    authority,
  );
}

function publishProviderResultUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  input: {
    expectedRevision: number;
    invocationId: string;
  },
): InvestigationStatus {
  const invocation = readProviderInvocation(
    context.runtime,
    input.invocationId,
  );
  assertProviderPublicationBinding(current, invocation);
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    throw workflowError(
      'PROVIDER_RESULT_NOT_AVAILABLE',
      'Provider invocation has no durable successful result to publish.',
      ExitCode.guard,
    );
  }
  const reference = {
    invocationId: invocation.invocationId,
    requestDigest: invocation.requestDigest,
    outputDigest: invocation.result.outputDigest,
  };
  if (current.milestones.blindResult !== null) {
    if (
      canonicalJson(current.milestones.blindResult) === canonicalJson(reference)
    ) {
      return statusFromSession(context, current);
    }
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_CONFLICT',
      'A different provider result is already current.',
      ExitCode.conflict,
    );
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    current.investigationId,
    input.expectedRevision,
    (session) => {
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        milestones: {
          ...session.milestones,
          blindResult: reference,
        },
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

export function retryInvestigationProvider(
  taskMandate: TaskMandateDependencies,
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader,
  cwd: string,
  requestedInvestigationId: string,
  input: RetryInvestigationProviderInput,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current, assertOwned) =>
      retryInvestigationProviderUnlocked(
        taskMandate,
        context,
        current,
        input,
        assertOwned,
        readProviderRetryAccountingEvidence,
      ),
  );
}

export function expireInvestigationProviderLease(
  cwd: string,
  requestedInvestigationId: string,
  input: {
    expectedSessionRevision: number;
    expectedInvocationRevision: number;
    now?: string;
  },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current, assertOwned) => {
      if (current.revision !== input.expectedSessionRevision) {
        throw investigationCasMismatch(
          input.expectedSessionRevision,
          current.revision,
        );
      }
      expireProviderInvocationLeaseUnderLifecycleLock(
        context.runtime,
        current.currentBlindInvocationId,
        {
          expectedRevision: input.expectedInvocationRevision,
          now: input.now,
        },
        assertOwned,
      );
      return statusFromSession(context, current);
    },
  );
}

function retryInvestigationProviderUnlocked(
  taskMandate: TaskMandateDependencies,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  input: RetryInvestigationProviderInput,
  assertOwned: () => void,
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader,
): InvestigationStatus {
  const investigationId = current.investigationId;
  if (current.revision !== input.expectedRevision) {
    throw workflowError(
      'INVESTIGATION_CAS_MISMATCH',
      'Investigation session changed before provider retry.',
      ExitCode.conflict,
    );
  }
  if (current.mandateBinding) {
    taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
      context.git.repositoryRealPath,
      current.mandateBinding,
      assertOwned,
    );
  }
  const previous = readProviderInvocation(
    context.runtime,
    current.currentBlindInvocationId,
  );
  if (
    previous.state !== 'failed' ||
    previous.failure === null ||
    previous.failure.kind !== 'retryable'
  ) {
    throw workflowError(
      previous.failure?.kind === 'repository-reconciliation-required'
        ? 'PROVIDER_REPOSITORY_RECONCILIATION_REQUIRED'
        : 'PROVIDER_INVOCATION_NOT_RETRYABLE',
      'Provider retry requires an explicit retryable terminal failure.',
      ExitCode.guard,
    );
  }
  const priorRequests = current.blindInvocationIds.map((invocationId) =>
    readProviderInvocationRequest(context.runtime, invocationId),
  );
  const manifest = readBlindSurveyManifest(
    context.runtime,
    previous.invocationId,
  );
  const attempt = previous.attempt + 1;
  const existingReservation = readProviderRetryReservation(
    context.runtime,
    investigationId,
    attempt,
  );
  const currentExecutionPolicy = loadAiAdapterPolicy(
    context.git.repositoryRealPath,
  );
  let retryAuthorization: ReturnType<
    typeof authorizeAutomaticProviderRetry
  > | null = null;
  if (existingReservation === null) {
    assertFreshProviderRetry(current, priorRequests, input.replacementRequest);
    assertReplacementRequestBinding(
      current,
      input.replacementRequest,
      manifest,
    );
    retryAuthorization = assertProviderRetryExecutionDecision(
      context.runtime,
      previous,
      input.replacementRequest,
      currentExecutionPolicy,
      input.executionGrantAuthorization,
      readProviderRetryAccountingEvidence,
    );
  } else if (existingReservation.schemaVersion !== 2) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_EVIDENCE_REQUIRED',
      'A historical retry reservation without decision evidence cannot authorize new provider work.',
      ExitCode.guard,
    );
  } else if (
    existingReservation.retryDecision.failedAttemptId !==
    `attempt-provider-${previous.invocationId}`
  ) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_EVIDENCE_STALE',
      'The durable retry decision does not bind the failed provider Attempt.',
      ExitCode.staleState,
    );
  }
  const reservation =
    existingReservation ??
    createProviderRetryReservation(context.runtime, {
      investigationId,
      changeId: current.changeId,
      attempt,
      previousInvocationId: previous.invocationId,
      manifest,
      request: input.replacementRequest,
      executionPolicy: currentExecutionPolicy,
      executionGrantAuthorization: input.executionGrantAuthorization,
      retryDecision: {
        schemaVersion: 1,
        kind: 'provider-retry-decision-binding',
        executionJobId: retryAuthorization!.job.jobId,
        executionRevision: retryAuthorization!.executionRevision,
        failedAttemptId: retryAuthorization!.attempt.attemptId,
        evidenceDigest: retryAuthorization!.evidenceDigest,
        evaluatedAt: retryAuthorization!.evaluatedAt,
      },
      ...(current.mandateBinding
        ? { mandateBinding: current.mandateBinding }
        : {}),
    });
  if (reservation.schemaVersion === 2) {
    authorizeSurveyRetryReservationMandate(
      taskMandate,
      context,
      current,
      reservation,
      assertOwned,
    );
  }
  if (
    reservation.changeId !== current.changeId ||
    reservation.previousInvocationId !== previous.invocationId ||
    reservation.manifestDigest !== current.blindManifestDigest
  ) {
    throw workflowError(
      'PROVIDER_RETRY_RESERVATION_CONFLICT',
      'Durable provider retry reservation belongs to another attempt.',
      ExitCode.conflict,
    );
  }
  assertFreshProviderRetry(current, priorRequests, reservation.request);
  assertReplacementRequestBinding(current, reservation.request, manifest);
  if (reservation.schemaVersion === 2) {
    ensureProviderExecutionPolicySnapshotFromSnapshot(
      context.runtime,
      reservation.request,
      reservation.executionPolicySnapshot,
    );
  } else {
    // The v1 branch is retained only for exhaustive typing; replay rejected it
    // above before any provider-side write.
    ensureProviderExecutionPolicySnapshot(
      context.runtime,
      reservation.request,
      currentExecutionPolicy,
    );
  }
  const replacement = providerInvocationExists(
    context.runtime,
    reservation.invocationId,
  )
    ? readProviderInvocation(context.runtime, reservation.invocationId)
    : createProviderInvocation(context.runtime, {
        investigationId,
        changeId: current.changeId,
        ...(reservation.schemaVersion === 2 && reservation.mandateBinding
          ? { mandateBinding: reservation.mandateBinding }
          : {}),
        attempt,
        manifest,
        request: reservation.request,
      });
  if (
    replacement.investigationId !== investigationId ||
    replacement.changeId !== current.changeId ||
    canonicalJson(replacement.mandateBinding ?? null) !==
      canonicalJson(
        reservation.schemaVersion === 2
          ? (reservation.mandateBinding ?? null)
          : null,
      ) ||
    replacement.attempt !== attempt ||
    replacement.requestDigest !== reservation.requestDigest ||
    replacement.manifestDigest !== current.blindManifestDigest
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_COLLISION',
      'Replacement invocation ID belongs to different durable work.',
      ExitCode.conflict,
    );
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    investigationId,
    input.expectedRevision,
    (session) => {
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        blindRequestDigest: replacement.requestDigest,
        blindInvocationIds: [
          ...session.blindInvocationIds,
          replacement.invocationId,
        ],
        currentBlindInvocationId: replacement.invocationId,
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

function assertProviderRetryExecutionDecision(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  previous: ProviderInvocationRecord,
  replacementRequest: ProviderInvocationRequest,
  replacementExecutionPolicy: ReturnType<typeof loadAiAdapterPolicy>,
  executionGrantAuthorization: ProviderExecutionGrantAuthorization | undefined,
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader,
): ReturnType<typeof authorizeAutomaticProviderRetry> {
  const previousRequest = readProviderInvocationRequest(
    paths,
    previous.invocationId,
  );
  const authorization = authorizeAutomaticProviderRetry(
    readProviderRetryAccountingEvidence(paths, previous, previousRequest),
    {
      failed: previous,
      failedRequest: previousRequest,
      replacementRequest,
      replacementExecutionPolicy,
      dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
      boundedGrantRequest: executionGrantAuthorization?.grantRequest,
      executionGrantAuthorization,
      now: new Date().toISOString(),
    },
  );
  const prior = authorization;
  const replacementPolicy = providerExecutionPolicySnapshot(replacementRequest);
  const now = authorization.evaluatedAt;
  const decision = authorization.decision;
  const replacementAttemptId = `attempt-provider-${replacementRequest.invocationId}`;
  if (executionGrantAuthorization !== undefined) {
    assertProviderExecutionGrantAuthorization(
      authorization,
      executionGrantAuthorization,
      replacementAttemptId,
    );
  } else if (!decision.retryable || !decision.automatic) {
    throw workflowError(
      decision.requiredGrant === undefined
        ? 'PROVIDER_RETRY_DECISION_DENIED'
        : 'PROVIDER_RETRY_GRANT_REQUIRED',
      'The execution RetryDecision does not authorize an automatic replacement Attempt.',
      ExitCode.guard,
      { details: { reasonCode: decision.reasonCode } },
    );
  }
  if (
    executionGrantAuthorization === undefined &&
    (decision.retryMode === 'new-context' || decision.retryMode === 'none')
  ) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_INVALID',
      'The execution RetryDecision returned an invalid replacement mode.',
      ExitCode.guard,
    );
  }
  const policyChanged =
    canonicalJson(prior.attempt.policySnapshot) !==
    canonicalJson(replacementPolicy);
  const retryMode: Exclude<RetryMode, 'new-context' | 'none'> =
    executionGrantAuthorization === undefined
      ? (decision.retryMode as Exclude<RetryMode, 'new-context' | 'none'>)
      : prior.attempt.failure?.retryClass === 'repairable'
        ? 'repair'
        : policyChanged
          ? 'execution-policy-change'
          : 'same-input';
  if (retryMode === 'repair') {
    preflightProviderRepairRetry(paths, {
      history: authorization.sourceInvocationIds.map((invocationId) => ({
        record: readProviderInvocation(paths, invocationId),
        request: readProviderInvocationRequest(paths, invocationId),
      })),
      failedRecord: previous,
      failedRequest: previousRequest,
    });
  }
  if (retryMode === 'strategy-change' && !policyChanged) {
    throw workflowError(
      'PROVIDER_RETRY_STRATEGY_CHANGE_REQUIRED',
      'The repeated failure fingerprint requires a changed provider execution strategy.',
      ExitCode.guard,
      { details: { failureFingerprint: prior.attempt.failureFingerprint } },
    );
  }
  const replacement = createReplacementAttempt({
    workflow: prior.workflow,
    job: prior.job,
    previousAttempt: prior.attempt,
    attemptId: replacementAttemptId,
    retryMode,
    currentExecutionPolicy: replacementPolicy,
    repairContext:
      retryMode === 'repair'
        ? loadProviderExecutionRepairContext(
            paths,
            previous,
            readProviderInvocationRequest(paths, previous.invocationId),
          )
        : undefined,
    strategyChanges:
      retryMode === 'strategy-change'
        ? ['provider-execution-policy-changed']
        : undefined,
    grantId: executionGrantAuthorization?.grantId,
    environmentDigest: providerExecutionEnvironmentDigest(replacementRequest),
    createdAt: now,
  });
  if (
    replacement.job.jobId !== prior.job.jobId ||
    replacement.job.workflowId !== prior.job.workflowId ||
    replacement.job.epoch !== prior.job.epoch ||
    replacement.job.contextDigest !== prior.job.contextDigest ||
    replacement.attempt.attemptNumber !== previous.attempt + 1
  ) {
    throw workflowError(
      'PROVIDER_RETRY_EXECUTION_LINEAGE_INVALID',
      'Replacement provider work changed stable semantic Job identity.',
      ExitCode.staleState,
    );
  }
  return authorization;
}

function assertFreshProviderRetry(
  current: InvestigationSession,
  priorRequests: ProviderInvocationRequest[],
  replacementRequest: ProviderInvocationRequest,
): void {
  if (
    current.blindInvocationIds.includes(replacementRequest.invocationId) ||
    priorRequests.some((request) => request.nonce === replacementRequest.nonce)
  ) {
    throw workflowError(
      'PROVIDER_RETRY_NOT_FRESH',
      'Provider retry requires a new invocation ID and nonce.',
      ExitCode.guard,
    );
  }
}

function withInvestigationMutation(
  cwd: string,
  requestedInvestigationId: string,
  operation: (
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    current: InvestigationSession,
    assertOwned: () => void,
  ) => InvestigationStatus,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const initial = readInvestigationSession(
    initialContext.runtime,
    investigationId,
  );
  if (authority !== undefined) {
    authority.assertOwned();
    if (initial.changeId !== authority.changeId) {
      throw workflowError(
        'INVESTIGATION_TRANSITION_UNBOUND',
        'Held investigation authority belongs to another change.',
        ExitCode.guard,
      );
    }
    assertCurrentInvestigationContext(initialContext, initial);
    assertInvestigationProviderHistory(initialContext, initial);
    const result = operation(initialContext, initial, authority.assertOwned);
    authority.assertOwned();
    return result;
  }
  return withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    initial.changeId,
    (assertOwned) => {
      assertOwned();
      const context = loadInvestigationRuntimeContext(cwd);
      const current = readInvestigationSession(
        context.runtime,
        investigationId,
      );
      assertCurrentInvestigationContext(context, current);
      assertInvestigationProviderHistory(context, current);
      const result = operation(context, current, assertOwned);
      assertOwned();
      return result;
    },
  );
}

function statusFromSession(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): InvestigationStatus {
  const invocation = readProviderInvocation(
    context.runtime,
    session.currentBlindInvocationId,
  );
  assertProviderPublicationBinding(session, invocation, false);
  assertInvestigationProviderHistory(context, session);
  const checkpointKind = expectedCheckpointKind(session);
  const checkpoint =
    checkpointKind === null
      ? null
      : {
          schemaVersion: 1 as const,
          kind: checkpointKind,
          checkpointId: investigationCheckpointId(session, checkpointKind),
        };
  return deepFreeze({
    kind: 'investigation' as const,
    investigationId: session.investigationId,
    changeId: session.changeId,
    revision: session.revision,
    semanticRevision: session.semanticRevision,
    lifecycleRevision: session.lifecycleRevision,
    state: session.state,
    baseline: { ...session.baseline },
    intentDigest: session.intentDigest,
    blindManifestDigest: session.blindManifestDigest,
    providerInvocationId: session.currentBlindInvocationId,
    provider: {
      state: invocation.state,
      providerId: invocation.providerId,
      attempt: invocation.attempt,
      revision: invocation.revision,
      leaseGeneration: invocation.leaseGeneration,
      leaseExpiresAt: invocation.lease?.expiresAt ?? null,
      failure: invocation.failure,
      resultDigest: invocation.result?.outputDigest ?? null,
      activity: inspectProviderInvocationActivity(context.runtime, invocation),
    },
    checkpoint,
    nextAction: deriveNextAction(session, invocation),
  });
}

function deriveNextAction(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
): InvestigationStatus['nextAction'] {
  if (session.state === 'actor-resolution-required') {
    return 'resolve-actor';
  }
  if (session.state === 'human-action-required') {
    return 'human-action';
  }
  if (session.state === 'awaiting-main-terms') {
    return 'submit-main-terms';
  }
  if (session.state === 'waiting-for-provider') {
    if (invocation.failure?.kind === 'repository-reconciliation-required') {
      return 'reconcile-repository';
    }
    if (invocation.state === 'failed') {
      return 'retry-provider';
    }
    if (
      invocation.state === 'leased' &&
      invocation.lease !== null &&
      Date.now() >= Date.parse(invocation.lease.expiresAt)
    ) {
      return 'expire-provider-lease';
    }
    return invocation.state === 'succeeded'
      ? 'resume-provider-result'
      : 'wait-for-provider';
  }
  if (session.state === 'awaiting-group-dispositions') {
    return 'submit-group-dispositions';
  }
  if (session.state === 'awaiting-ledger-answers') {
    return 'submit-why-answers';
  }
  return 'investigation-complete';
}

function expectedCheckpointKind(
  session: InvestigationSession,
): InvestigationCheckpointKind | null {
  if (session.state === 'awaiting-main-terms') {
    return 'main-terms';
  }
  if (session.state === 'awaiting-group-dispositions') {
    return 'group-dispositions';
  }
  if (session.state === 'awaiting-ledger-answers') {
    return 'why-answers';
  }
  return null;
}

function storedCheckpointFor(
  session: InvestigationSession,
  kind: InvestigationCheckpointKind,
): { envelope: StoredInvestigationCheckpoint } | null {
  const checkpoint =
    kind === 'main-terms'
      ? session.milestones.mainTerms
      : kind === 'group-dispositions'
        ? session.milestones.groupDispositions
        : session.milestones.whyAnswers;
  return checkpoint === null ? null : { envelope: checkpoint };
}

function assertCheckpointBinding(
  session: InvestigationSession,
  envelope: InvestigationCheckpointEnvelope,
): void {
  if (
    envelope.investigationId !== session.investigationId ||
    envelope.changeId !== session.changeId ||
    canonicalJson(envelope.baseline) !== canonicalJson(session.baseline) ||
    envelope.intentDigest !== session.intentDigest ||
    envelope.blindManifestDigest !== session.blindManifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_STALE',
      'Investigation checkpoint is bound to a different session or baseline.',
      ExitCode.staleState,
    );
  }
}

function assertCurrentInvestigationContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): void {
  const current = readCurrentInvestigationRef(
    context.runtime,
    session.changeId,
  );
  const resolutionNodeId = readHumanResolutionHead(
    context.runtime,
    session.investigationId,
  );
  if (resolutionNodeId !== null) {
    const resolution = readHumanResolutionNode(
      context.runtime,
      resolutionNodeId,
    );
    if (
      resolution.decision.kind === 'abort' ||
      resolution.decision.kind === 'quarantine' ||
      resolution.decision.kind === 'supersede' ||
      resolution.decision.kind === 'repair'
    ) {
      throw workflowError(
        'INVESTIGATION_TERMINALLY_RESOLVED',
        'A terminal human resolution prevents this investigation from being revived.',
        ExitCode.staleState,
      );
    }
  }
  // A session born on a working or ceremony branch must still be able to
  // reach the planning transition, which demands the change's canonical
  // template branch. With the exact pinned head and tree unchanged, moving to
  // that one name is ref renaming within the same lineage, not a context
  // change; every other branch stays a staleness signal.
  const canonicalBranch = context.config.branchTemplate.replaceAll(
    '{changeId}',
    session.changeId,
  );
  if (
    current?.investigationId !== session.investigationId ||
    context.git.repositoryRealPath !== session.repositoryRoot ||
    context.git.gitCommonDirectory !== session.gitCommonDirectory ||
    (context.git.branch !== session.branch &&
      context.git.branch !== canonicalBranch) ||
    context.git.head !== session.baseline.head ||
    context.git.tree !== session.baseline.tree
  ) {
    throw workflowError(
      'INVESTIGATION_CONTEXT_STALE',
      'Investigation repository, branch, baseline, or current ref changed.',
      ExitCode.staleState,
    );
  }
}

function assertProviderPublicationBinding(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
  requireCurrent = true,
): void {
  if (
    invocation.investigationId !== session.investigationId ||
    invocation.changeId !== session.changeId ||
    (requireCurrent &&
      invocation.invocationId !== session.currentBlindInvocationId) ||
    invocation.requestDigest !== session.blindRequestDigest ||
    invocation.manifestDigest !== session.blindManifestDigest ||
    invocation.purpose !== 'survey'
  ) {
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_STALE',
      'Provider result is not bound to the current blind investigation attempt.',
      ExitCode.staleState,
    );
  }
}

function assertPublishedProviderMilestone(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
): void {
  const published = session.milestones.blindResult;
  if (published === null) {
    return;
  }
  if (
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    published.invocationId !== invocation.invocationId ||
    published.requestDigest !== invocation.requestDigest ||
    published.outputDigest !== invocation.result.outputDigest
  ) {
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_STALE',
      'Published provider milestone is not an exact durable successful result.',
      ExitCode.staleState,
    );
  }
}

function assertInvestigationProviderHistory(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): void {
  const startReservation = readInvestigationStartReservation(
    context.runtime,
    session.changeId,
  );
  if (startReservation === null) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_MISSING',
      'Investigation provider history has no durable start reservation.',
      ExitCode.staleState,
    );
  }
  assertStartReservationSessionBinding(context, startReservation, session);
  if (session.currentBlindInvocationId !== session.blindInvocationIds.at(-1)) {
    throw providerHistoryInvalid();
  }

  const invocations = session.blindInvocationIds.map((invocationId) =>
    readProviderInvocation(context.runtime, invocationId),
  );
  const requests = session.blindInvocationIds.map((invocationId) =>
    readProviderInvocationRequest(context.runtime, invocationId),
  );
  if (
    new Set(requests.map((request) => request.nonce)).size !== requests.length
  ) {
    throw providerHistoryInvalid();
  }
  for (const [index, invocation] of invocations.entries()) {
    const attempt = index + 1;
    if (
      invocation.investigationId !== session.investigationId ||
      invocation.changeId !== session.changeId ||
      invocation.attempt !== attempt ||
      invocation.manifestDigest !== session.blindManifestDigest
    ) {
      throw providerHistoryInvalid();
    }
    if (attempt === 1) {
      if (
        invocation.invocationId !== startReservation.invocationId ||
        invocation.requestDigest !== startReservation.requestDigest
      ) {
        throw providerHistoryInvalid();
      }
      continue;
    }
    const retryReservation = readProviderRetryReservation(
      context.runtime,
      session.investigationId,
      attempt,
    );
    const previous = invocations[index - 1];
    if (
      retryReservation === null ||
      previous === undefined ||
      retryReservation.changeId !== session.changeId ||
      retryReservation.previousInvocationId !== previous.invocationId ||
      retryReservation.invocationId !== invocation.invocationId ||
      retryReservation.requestDigest !== invocation.requestDigest ||
      retryReservation.requestDigest !== requests[index]?.requestDigest ||
      retryReservation.manifestDigest !== invocation.manifestDigest ||
      previous.state !== 'failed' ||
      previous.failure?.kind !== 'retryable'
    ) {
      throw providerHistoryInvalid();
    }
  }
  const current = invocations.at(-1);
  if (
    current === undefined ||
    current.requestDigest !== session.blindRequestDigest
  ) {
    throw providerHistoryInvalid();
  }
  assertPublishedProviderMilestone(session, current);
}

function providerHistoryInvalid() {
  return workflowError(
    'INVESTIGATION_PROVIDER_HISTORY_INVALID',
    'Investigation provider attempts do not form the reserved monotonic history.',
    ExitCode.staleState,
  );
}

function assertStartBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  changeId: string,
  input: StartInvestigationSessionInput,
  manifestDigest: string,
  intentDigest: string,
): void {
  const request = input.blindRequest;
  const manifest = input.blindManifest;
  if (
    manifest.changeId !== changeId ||
    manifest.baseCommit !== context.git.head ||
    manifest.baseTree !== context.git.tree ||
    manifest.repositoryId !== context.config.repositoryName ||
    request.repositoryId !== manifest.repositoryId ||
    request.baseCommit !== manifest.baseCommit ||
    request.baseTree !== manifest.baseTree ||
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'plan-reviewer' ||
    request.targetDigest !== intentDigest ||
    request.roleAssignment.targetDigest !== intentDigest ||
    request.inputManifestDigest !== manifestDigest ||
    request.capabilityProfile !== 'repository-read-only'
  ) {
    throw workflowError(
      'INVESTIGATION_BLIND_REQUEST_UNBOUND',
      'Blind provider request is not bound to the sealed manifest and baseline.',
      ExitCode.guard,
    );
  }
}

function assertStableStartContext(
  before: ReturnType<typeof loadInvestigationRuntimeContext>,
  after: ReturnType<typeof loadInvestigationRuntimeContext>,
): void {
  if (
    before.git.repositoryRealPath !== after.git.repositoryRealPath ||
    before.git.gitCommonDirectory !== after.git.gitCommonDirectory ||
    before.config.runtimeDirectory !== after.config.runtimeDirectory ||
    before.git.branch !== after.git.branch ||
    before.git.head !== after.git.head ||
    before.git.tree !== after.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Repository identity, branch, or pinned baseline changed during start.',
      ExitCode.staleState,
    );
  }
}

function authorizeSurveyReservationMandate(
  taskMandate: TaskMandateDependencies,
  cwd: string,
  reservation: InvestigationStartReservation,
  assertOwned: () => void,
  retry: boolean,
): void {
  if (reservation.mandateBinding === undefined) return;
  taskMandate.authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd,
    reservation.mandateBinding,
    reservation.invocationId,
    {
      providerId: reservation.request.providerId,
      dataTypes: ['repository-metadata', 'source-code', 'task-intent'],
      sourceCode: true,
      secrets: false,
      retry,
      budget: null,
      requestDigest: reservation.request.requestDigest,
    },
    assertOwned,
  );
}

function authorizeSurveyRetryReservationMandate(
  taskMandate: TaskMandateDependencies,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
  reservation: Extract<
    ReturnType<typeof readProviderRetryReservation>,
    { schemaVersion: 2 }
  >,
  assertOwned: () => void,
): void {
  if (
    canonicalJson(session.mandateBinding ?? null) !==
    canonicalJson(reservation.mandateBinding ?? null)
  ) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'The provider retry reservation does not match its durable task mandate binding.',
      ExitCode.staleState,
    );
  }
  if (reservation.mandateBinding === undefined) return;
  taskMandate.authorizeTaskMandateProviderReservationUnderLifecycleLock(
    context.git.repositoryRealPath,
    reservation.mandateBinding,
    reservation.invocationId,
    {
      providerId: reservation.request.providerId,
      dataTypes: ['repository-metadata', 'source-code', 'task-intent'],
      sourceCode: true,
      secrets: false,
      retry: true,
      budget: null,
      requestDigest: reservation.request.requestDigest,
    },
    assertOwned,
  );
}

function assertStartReservationContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  reservation: {
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string | null;
    changeId: string;
    baseline: {
      head: string;
      tree: string;
    };
  },
): void {
  // The same canonical-branch tolerance as the session context: at the exact
  // pinned head and tree, the change's template branch is the one rename the
  // planning transition itself demands.
  const canonicalBranch = context.config.branchTemplate.replaceAll(
    '{changeId}',
    reservation.changeId,
  );
  if (
    reservation.repositoryRoot !== context.git.repositoryRealPath ||
    reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
    (reservation.branch !== context.git.branch &&
      context.git.branch !== canonicalBranch) ||
    reservation.baseline.head !== context.git.head ||
    reservation.baseline.tree !== context.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Durable investigation start belongs to another worktree, branch, or baseline.',
      ExitCode.staleState,
    );
  }
}

function assertStartReservationSessionBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  reservation: InvestigationStartReservation,
  session: InvestigationSession,
): void {
  assertStartReservationContext(context, reservation);
  const initialInvocation = readProviderInvocation(
    context.runtime,
    reservation.invocationId,
  );
  if (
    session.investigationId !== reservation.investigationId ||
    session.changeId !== reservation.changeId ||
    canonicalJson(session.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding ?? null) ||
    session.repositoryRoot !== reservation.repositoryRoot ||
    session.gitCommonDirectory !== reservation.gitCommonDirectory ||
    session.branch !== reservation.branch ||
    canonicalJson(session.baseline) !== canonicalJson(reservation.baseline) ||
    session.intentDigest !== blindSurveyIntentDigest(reservation.manifest) ||
    session.blindManifestDigest !== reservation.manifestDigest ||
    session.blindInvocationIds[0] !== reservation.invocationId ||
    initialInvocation.investigationId !== reservation.investigationId ||
    initialInvocation.changeId !== reservation.changeId ||
    initialInvocation.attempt !== 1 ||
    initialInvocation.requestDigest !== reservation.requestDigest ||
    initialInvocation.manifestDigest !== reservation.manifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_CONFLICT',
      'Durable investigation start artifacts disagree.',
      ExitCode.staleState,
    );
  }
}

function assertReplacementRequestBinding(
  session: InvestigationSession,
  request: ProviderInvocationRequest,
  manifest: BlindSurveyManifest,
): void {
  if (
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'plan-reviewer' ||
    request.baseCommit !== session.baseline.head ||
    request.baseTree !== session.baseline.tree ||
    request.targetDigest !== session.intentDigest ||
    request.roleAssignment.targetDigest !== session.intentDigest ||
    request.inputManifestDigest !== session.blindManifestDigest ||
    request.repositoryId !== manifest.repositoryId
  ) {
    throw workflowError(
      'PROVIDER_RETRY_REQUEST_UNBOUND',
      'Replacement provider request is not bound to the current investigation.',
      ExitCode.guard,
    );
  }
}

function assertExactStartInput(
  value: unknown,
): asserts value is StartInvestigationSessionInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.keys(value).length !== 3 && Object.keys(value).length !== 4) ||
    !Object.prototype.hasOwnProperty.call(value, 'changeId') ||
    !Object.prototype.hasOwnProperty.call(value, 'blindManifest') ||
    !Object.prototype.hasOwnProperty.call(value, 'blindRequest') ||
    (Object.keys(value).length === 4 &&
      !Object.prototype.hasOwnProperty.call(value, 'mandateBinding'))
  ) {
    throw workflowError(
      'INVESTIGATION_START_INPUT_INVALID',
      'Investigation start accepts only changeId, sealed blind inputs, and an optional exact mandate binding.',
      ExitCode.usage,
    );
  }
}

function investigationCasMismatch(expected: number, observed: number) {
  return workflowError(
    'INVESTIGATION_CAS_MISMATCH',
    'Investigation session changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
