/**
 * Validates investigation session milestones and monotonic state transitions.
 *
 * Invariants:
 * - Derived state and checkpoint ownership match the exact persisted session content.
 * - Transitions preserve completed milestones and reject forbidden semantic rewrites.
 */
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST } from '../../assurance/plan-review-coverage-policy.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
} from '../../../foundation/repository-path/repository-path.ts';
import {
  advertisedHumanResolutions,
  type InvestigationHumanActionBlocker,
} from './human-resolution-contract.ts';
import {
  assertInvestigationCheckpointEnvelope,
  assertInvestigationScanSaturationAcceptanceEnvelope,
  checkpointContributionDigest,
  checkpointEnvelopeDigest,
  scanSaturationAcceptanceEnvelopeDigest,
  isBaseline,
} from './investigation-checkpoint-contract.ts';
import { isBoundedResolutionText } from './human-resolution-values.ts';
import {
  type BlindResultReference,
  type InvestigationCheckpointKind,
  type InvestigationSession,
  type InvestigationSessionState,
  type StoredInvestigationCheckpoint,
  type StoredInvestigationScanSaturationAcceptance,
} from './investigation-session-types.ts';
import {
  hasExactKeys,
  isDigest,
  isRecord,
  isStringArray,
  isTaskMandateBinding,
  isTimestamp,
  sha256,
} from './investigation-store-values.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

export function investigationCheckpointId(
  session: InvestigationSession,
  kind: InvestigationCheckpointKind,
): string {
  const prerequisites =
    kind === 'main-terms'
      ? {
          blindManifestDigest: session.blindManifestDigest,
          intentDigest: session.intentDigest,
          baseline: session.baseline,
        }
      : kind === 'group-dispositions'
        ? {
            mainTermsDigest:
              session.milestones.mainTerms?.contributionDigest ?? null,
            blindResult: session.milestones.blindResult,
            reviewerTermSourceNodeId:
              session.milestones.reviewerTermSourceNodeId,
            ...(session.scanSaturationAcceptance === undefined
              ? {}
              : {
                  scanSaturationAcceptanceDigest:
                    session.scanSaturationAcceptance.envelopeDigest,
                }),
          }
        : {
            groupDispositionsDigest:
              session.milestones.groupDispositions?.contributionDigest ?? null,
          };
  return `checkpoint-${sha256(
    canonicalJson({
      schemaVersion: 1,
      investigationId: session.investigationId,
      changeId: session.changeId,
      kind,
      prerequisites,
    }),
  )}`;
}

export function deriveInvestigationSessionState(
  session: Pick<InvestigationSession, 'blocker' | 'milestones'>,
): InvestigationSessionState {
  if (session.blocker !== null) {
    return session.blocker.state;
  }
  if (session.milestones.mainTerms === null) {
    return 'awaiting-main-terms';
  }
  if (session.milestones.blindResult === null) {
    return 'waiting-for-provider';
  }
  if (session.milestones.groupDispositions === null) {
    return 'awaiting-group-dispositions';
  }
  if (session.milestones.whyAnswers === null) {
    return 'awaiting-ledger-answers';
  }
  return 'investigation-sealed';
}

export function assertInvestigationSession(
  value: unknown,
): InvestigationSession {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'investigationId',
      'revision',
      'semanticRevision',
      'lifecycleRevision',
      'state',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'intentDigest',
      'planReviewCoveragePolicyDigest',
      'blindManifestDigest',
      'blindRequestDigest',
      'blindInvocationIds',
      'currentBlindInvocationId',
      ...(Object.prototype.hasOwnProperty.call(
        value,
        'scanSaturationAcceptance',
      )
        ? ['scanSaturationAcceptance']
        : []),
      'milestones',
      'blocker',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.investigationId !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.semanticRevision) ||
    (value.semanticRevision as number) < 0 ||
    !Number.isSafeInteger(value.lifecycleRevision) ||
    (value.lifecycleRevision as number) < 0 ||
    (value.semanticRevision as number) > (value.lifecycleRevision as number) ||
    value.lifecycleRevision !== value.revision ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    (value.branch !== null && typeof value.branch !== 'string') ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    value.planReviewCoveragePolicyDigest !==
      GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST ||
    !isDigest(value.blindManifestDigest) ||
    !isDigest(value.blindRequestDigest) ||
    !isStringArray(value.blindInvocationIds) ||
    value.blindInvocationIds.length < 1 ||
    typeof value.currentBlindInvocationId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'scanSaturationAcceptance') &&
      !isStoredScanSaturationAcceptance(value.scanSaturationAcceptance)) ||
    !isMilestones(value.milestones) ||
    !isBlocker(value.blocker) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw sessionInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  for (const invocationId of value.blindInvocationIds) {
    assertInvocationId(invocationId);
  }
  assertInvocationId(value.currentBlindInvocationId);
  if (
    new Set(value.blindInvocationIds).size !==
      value.blindInvocationIds.length ||
    !value.blindInvocationIds.includes(value.currentBlindInvocationId)
  ) {
    throw sessionInvalid();
  }
  const session = value as InvestigationSession;
  if (
    session.state !== deriveInvestigationSessionState(session) ||
    !milestonesBelongToSession(session)
  ) {
    throw sessionInvalid();
  }
  return session;
}

function milestonesBelongToSession(session: InvestigationSession): boolean {
  for (const [kind, stored] of [
    ['main-terms', session.milestones.mainTerms],
    ['group-dispositions', session.milestones.groupDispositions],
    ['why-answers', session.milestones.whyAnswers],
  ] as const) {
    if (stored === null) {
      continue;
    }
    const envelope = stored.envelope;
    if (
      envelope.kind !== kind ||
      envelope.investigationId !== session.investigationId ||
      envelope.changeId !== session.changeId ||
      envelope.expectedRevision > session.revision ||
      canonicalJson(envelope.baseline) !== canonicalJson(session.baseline) ||
      envelope.intentDigest !== session.intentDigest ||
      envelope.blindManifestDigest !== session.blindManifestDigest ||
      envelope.checkpointId !== investigationCheckpointId(session, kind)
    ) {
      return false;
    }
  }
  const saturationAcceptance = session.scanSaturationAcceptance;
  if (
    saturationAcceptance !== undefined &&
    (saturationAcceptance.envelope.investigationId !==
      session.investigationId ||
      saturationAcceptance.envelope.changeId !== session.changeId ||
      saturationAcceptance.envelope.expectedRevision >= session.revision ||
      canonicalJson(saturationAcceptance.envelope.baseline) !==
        canonicalJson(session.baseline) ||
      saturationAcceptance.envelope.intentDigest !== session.intentDigest ||
      saturationAcceptance.envelope.blindManifestDigest !==
        session.blindManifestDigest)
  ) {
    return false;
  }
  const blindResult = session.milestones.blindResult;
  return (
    blindResult === null ||
    (blindResult.invocationId === session.currentBlindInvocationId &&
      blindResult.requestDigest === session.blindRequestDigest)
  );
}

export function assertMonotonicSessionTransition(
  current: InvestigationSession,
  next: InvestigationSession,
): void {
  for (const key of [
    'schemaVersion',
    'investigationId',
    'changeId',
    'mandateBinding',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'intentDigest',
    'planReviewCoveragePolicyDigest',
    'blindManifestDigest',
    'createdAt',
  ] as const) {
    if (
      canonicalJson(current[key] ?? null) !== canonicalJson(next[key] ?? null)
    ) {
      throw sessionTransitionInvalid();
    }
  }
  const blockerEntered =
    current.blocker === null &&
    next.blocker !== null &&
    !('code' in next.blocker) &&
    next.blocker.state === 'human-action-required';
  const blockerCleared =
    current.blocker !== null &&
    !('code' in current.blocker) &&
    next.blocker === null;
  if (
    next.revision !== current.revision + 1 ||
    next.lifecycleRevision !== current.lifecycleRevision + 1 ||
    next.semanticRevision !==
      current.semanticRevision +
        (semanticSessionContentChanged(current, next) ? 1 : 0) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    (canonicalJson(next.blocker) !== canonicalJson(current.blocker) &&
      !blockerEntered &&
      !blockerCleared) ||
    next.blindInvocationIds.length < current.blindInvocationIds.length ||
    current.blindInvocationIds.some(
      (invocationId, index) => next.blindInvocationIds[index] !== invocationId,
    )
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    next.currentBlindInvocationId === current.currentBlindInvocationId &&
    (next.blindRequestDigest !== current.blindRequestDigest ||
      next.blindInvocationIds.length !== current.blindInvocationIds.length)
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    next.currentBlindInvocationId !== current.currentBlindInvocationId &&
    (next.blindInvocationIds.length !== current.blindInvocationIds.length + 1 ||
      next.currentBlindInvocationId !== next.blindInvocationIds.at(-1) ||
      next.blindRequestDigest === current.blindRequestDigest)
  ) {
    throw sessionTransitionInvalid();
  }
  const reviewerReopen =
    current.milestones.reviewerTermSourceNodeId !==
      next.milestones.reviewerTermSourceNodeId &&
    next.milestones.reviewerTermSourceNodeId !== null;
  if (
    (!reviewerReopen &&
      next.milestones.reviewerTermSourceNodeId !==
        current.milestones.reviewerTermSourceNodeId) ||
    (reviewerReopen &&
      (!isDigest(next.milestones.reviewerTermSourceNodeId) ||
        next.milestones.groupDispositions !== null ||
        next.milestones.whyAnswers !== null))
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    blockerEntered &&
    canonicalJson(next.milestones) !== canonicalJson(current.milestones)
  ) {
    throw sessionTransitionInvalid();
  }
  const beforeSaturationAcceptance = current.scanSaturationAcceptance ?? null;
  const afterSaturationAcceptance = next.scanSaturationAcceptance ?? null;
  if (
    (beforeSaturationAcceptance !== null &&
      canonicalJson(beforeSaturationAcceptance) !==
        canonicalJson(afterSaturationAcceptance)) ||
    (beforeSaturationAcceptance === null &&
      afterSaturationAcceptance !== null &&
      afterSaturationAcceptance.envelope.expectedRevision !== current.revision)
  ) {
    throw sessionTransitionInvalid();
  }
  for (const key of ['mainTerms', 'blindResult'] as const) {
    const before = current.milestones[key];
    const after = next.milestones[key];
    if (before !== null && canonicalJson(before) !== canonicalJson(after)) {
      throw sessionTransitionInvalid();
    }
  }
  for (const key of ['groupDispositions', 'whyAnswers'] as const) {
    const before = current.milestones[key];
    const after = next.milestones[key];
    if (
      before !== null &&
      canonicalJson(before) !== canonicalJson(after) &&
      !(reviewerReopen && after === null)
    ) {
      throw sessionTransitionInvalid();
    }
  }
}

export function semanticSessionContentChanged(
  current: InvestigationSession,
  next: InvestigationSession,
): boolean {
  return (
    canonicalJson(current.milestones) !== canonicalJson(next.milestones) ||
    canonicalJson(current.scanSaturationAcceptance ?? null) !==
      canonicalJson(next.scanSaturationAcceptance ?? null)
  );
}

function isMilestones(
  value: unknown,
): value is InvestigationSession['milestones'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'mainTerms',
      'blindResult',
      'reviewerTermSourceNodeId',
      'groupDispositions',
      'whyAnswers',
    ]) ||
    !isStoredCheckpoint(value.mainTerms, 'main-terms') ||
    !isBlindResult(value.blindResult) ||
    (value.reviewerTermSourceNodeId !== null &&
      !isDigest(value.reviewerTermSourceNodeId)) ||
    !isStoredCheckpoint(value.groupDispositions, 'group-dispositions') ||
    !isStoredCheckpoint(value.whyAnswers, 'why-answers')
  ) {
    return false;
  }
  if (
    value.groupDispositions !== null &&
    (value.mainTerms === null || value.blindResult === null)
  ) {
    return false;
  }
  if (value.whyAnswers !== null && value.groupDispositions === null) {
    return false;
  }
  return true;
}

function isStoredCheckpoint(
  value: unknown,
  kind: InvestigationCheckpointKind,
): value is StoredInvestigationCheckpoint | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ]) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.contributionDigest)
  ) {
    return false;
  }
  try {
    const envelope = assertInvestigationCheckpointEnvelope(value.envelope);
    return (
      envelope.kind === kind &&
      checkpointEnvelopeDigest(envelope) === value.envelopeDigest &&
      checkpointContributionDigest(envelope) === value.contributionDigest
    );
  } catch {
    return false;
  }
}

function isStoredScanSaturationAcceptance(
  value: unknown,
): value is StoredInvestigationScanSaturationAcceptance {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['envelopeDigest', 'envelope']) ||
    !isDigest(value.envelopeDigest)
  ) {
    return false;
  }
  try {
    const envelope = assertInvestigationScanSaturationAcceptanceEnvelope(
      value.envelope,
    );
    return (
      scanSaturationAcceptanceEnvelopeDigest(envelope) === value.envelopeDigest
    );
  } catch {
    return false;
  }
}

function isBlindResult(value: unknown): value is BlindResultReference | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['invocationId', 'requestDigest', 'outputDigest']) ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest)
  ) {
    return false;
  }
  try {
    assertInvocationId(value.invocationId);
    return true;
  } catch {
    return false;
  }
}

function isBlocker(value: unknown): value is InvestigationSession['blocker'] {
  if (value === null) {
    return true;
  }
  if (
    isRecord(value) &&
    hasExactKeys(value, ['state', 'code']) &&
    (value.state === 'actor-resolution-required' ||
      value.state === 'human-action-required') &&
    typeof value.code === 'string' &&
    value.code.length > 0
  ) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'reasonCode',
      'blockedTransition',
      'enteredAt',
      'facts',
      'availableResolutions',
    ]) ||
    value.schemaVersion !== 2 ||
    value.state !== 'human-action-required' ||
    !isBoundedResolutionText(value.reasonCode, 256) ||
    !isBoundedResolutionText(value.blockedTransition, 256) ||
    !isTimestamp(value.enteredAt) ||
    !isRecord(value.facts) ||
    !Array.isArray(value.availableResolutions)
  ) {
    return false;
  }
  const expected = advertisedHumanResolutions(
    value as InvestigationHumanActionBlocker,
  );
  return (
    canonicalJson(value.availableResolutions) === canonicalJson(expected) &&
    Buffer.byteLength(canonicalJson(value), 'utf8') <= 65_536
  );
}

export function sessionInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_INVALID',
    'Investigation session is malformed or internally inconsistent.',
    ExitCode.staleState,
  );
}

export function sessionTransitionInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_TRANSITION_INVALID',
    'Investigation session transition is not monotonic.',
    ExitCode.staleState,
  );
}
