/**
 * Validate provider subject manifests and normalized intent before deriving exact manifest digests.
 *
 * Invariants:
 * - Manifest variants, bounded text, source references, and digest bytes stay unchanged.
 * - Subject and planning snapshot validation remains tied to the requested manifest kind.
 */

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertChangeId,
  assertTaskId,
  assertSessionId,
} from '../../foundation/repository-path/repository-path.ts';
import {
  assertPlanReviewSubject,
  assertPlanReviewTargetSnapshot,
} from '../../modules/assurance/plan-review.ts';
import type { PlanReviewSubject } from '../../modules/assurance/plan-review-subject.ts';
import type { PlanReviewTargetSnapshot } from '../../modules/assurance/plan-review-target-snapshot-record.ts';
import {
  parseTaskDiffReviewRecord,
  assertTaskDiffReviewChallengeResponseCurrent,
  parseTaskDiffReviewChallengeResponseRecord,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type {
  TaskDiffReviewRecord,
  TaskDiffReviewChallengeResponseRecord,
} from '../../modules/assurance/task-diff-review-artifact-record.ts';
import {
  parseTaskDiffReviewSubject,
  parseTaskDiffReviewScope,
} from '../../modules/assurance/task-diff-review.ts';
import type {
  TaskDiffReviewSubject,
  TaskDiffReviewScope,
} from '../../modules/assurance/task-diff-review-record.ts';
import { assertTaskStrategyImplementationManifest } from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { BlindSurveyManifest } from '../../modules/investigation/manifest/blind-survey-manifest.ts';
import type { ProviderInvocationManifest } from '../../modules/provider-orchestration/provider-invocation-manifest.ts';
import type {
  PlanReviewManifest,
  TaskDiffReviewManifest,
  TaskDiffReviewContinuationManifest,
} from '../../modules/assurance/provider-review-manifests.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import {
  sha256,
  isRecord,
  hasExactKeys,
  GIT_OBJECT_ID,
  MAX_ARCHITECTURE_QUESTION_BYTES,
  blindManifestInvalid,
  MAX_BLIND_MANIFEST_BYTES,
  deepFreeze,
  invocationInvalid,
  MAX_INTENT_SUMMARY_BYTES,
  MAX_INTENT_FACTS_PER_KIND,
  SOURCE_REFERENCE,
  MAX_INTENT_FACT_BYTES,
} from './provider-invocation-common.ts';

export function blindSurveyManifestDigest(
  manifest: BlindSurveyManifest,
): string {
  return sha256(canonicalJson(assertBlindSurveyManifest(manifest)));
}

export function providerInvocationManifestDigest(
  manifest: ProviderInvocationManifest,
): string {
  return sha256(canonicalJson(assertProviderInvocationManifest(manifest)));
}

export function blindSurveyIntentDigest(manifest: BlindSurveyManifest): string {
  return sha256(
    canonicalJson(assertBlindSurveyManifest(manifest).normalizedIntent),
  );
}

export function assertBlindSurveyManifest(value: unknown): BlindSurveyManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'normalizedIntent',
      'architectureQuestion',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'blind-survey-manifest' ||
    typeof value.changeId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    !isBoundedBlindText(
      value.architectureQuestion,
      MAX_ARCHITECTURE_QUESTION_BYTES,
    ) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw blindManifestInvalid();
  }
  assertChangeId(value.changeId);
  assertNormalizedChangeIntent(value.normalizedIntent);
  if (
    Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_BLIND_MANIFEST_BYTES
  ) {
    throw blindManifestInvalid();
  }
  return deepFreeze(structuredClone(value)) as BlindSurveyManifest;
}

export function assertProviderInvocationManifest(
  value: unknown,
): ProviderInvocationManifest {
  if (isRecord(value) && value.kind === 'blind-survey-manifest') {
    return assertBlindSurveyManifest(value);
  }
  if (
    isRecord(value) &&
    value.kind === 'task-diff-review-continuation-manifest'
  ) {
    return assertTaskDiffReviewContinuationManifest(value);
  }
  if (isRecord(value) && value.kind === 'task-diff-review-manifest') {
    return assertTaskDiffReviewManifest(value);
  }
  if (
    isRecord(value) &&
    value.kind === 'task-strategy-implementation-manifest'
  ) {
    try {
      return assertTaskStrategyImplementationManifest(value);
    } catch {
      throw invocationInvalid();
    }
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'subject',
      ...(Object.hasOwn(value, 'planningTarget')
        ? ['planningTarget' as const]
        : []),
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-manifest' ||
    typeof value.changeId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw invocationInvalid();
  }
  assertChangeId(value.changeId);
  let subject: PlanReviewSubject;
  let planningTarget: PlanReviewTargetSnapshot | undefined;
  try {
    subject = assertPlanReviewSubject(value.subject);
    planningTarget =
      value.planningTarget === undefined
        ? undefined
        : assertPlanReviewTargetSnapshot(value.planningTarget);
  } catch {
    throw invocationInvalid();
  }
  if (
    planningTarget !== undefined &&
    (planningTarget.changeId !== value.changeId ||
      planningTarget.subjectDigest !== subject.subjectDigest ||
      planningTarget.planningGenerationId !== subject.planningGenerationId ||
      planningTarget.planTargetDigest !== subject.planTargetDigest)
  ) {
    throw invocationInvalid();
  }
  const manifest: PlanReviewManifest = {
    schemaVersion: 1,
    kind: 'plan-review-manifest',
    changeId: value.changeId,
    repositoryId: value.repositoryId,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    subject,
    ...(planningTarget ? { planningTarget } : {}),
    capabilityProfile: 'repository-read-only',
  };
  if (
    Buffer.byteLength(canonicalJson(manifest), 'utf8') >
    MAX_BLIND_MANIFEST_BYTES
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(manifest);
}

function assertTaskDiffReviewManifest(value: unknown): TaskDiffReviewManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'reviewScope',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-manifest' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    !isBoundedBlindText(value.repositoryIdentity, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw invocationInvalid();
  }
  try {
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
    assertSessionId(value.sessionId);
  } catch {
    throw invocationInvalid();
  }
  let subject: TaskDiffReviewSubject;
  let reviewScope: TaskDiffReviewScope;
  try {
    subject = parseTaskDiffReviewSubject(value.subject);
    reviewScope = parseTaskDiffReviewScope(value.reviewScope);
  } catch {
    throw invocationInvalid();
  }
  if (
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    subject.repositoryId !== value.repositoryIdentity ||
    subject.baseCommit !== value.baseCommit ||
    subject.baseTree !== value.baseTree ||
    reviewScope.currentSubjectDigest !== subject.subjectDigest
  ) {
    throw invocationInvalid();
  }
  const manifest: TaskDiffReviewManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    subject,
    reviewScope,
    capabilityProfile: 'repository-read-only',
  };
  if (
    Buffer.byteLength(canonicalJson(manifest), 'utf8') >
    MAX_BLIND_MANIFEST_BYTES
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(manifest);
}

function assertTaskDiffReviewContinuationManifest(
  value: unknown,
): TaskDiffReviewContinuationManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'review',
      'response',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-manifest' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isBoundedBlindText(value.repositoryId, 512) ||
    !isBoundedBlindText(value.repositoryIdentity, 512) ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw invocationInvalid();
  }
  try {
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
    assertSessionId(value.sessionId);
  } catch {
    throw invocationInvalid();
  }
  let subject: TaskDiffReviewSubject;
  let review: TaskDiffReviewRecord;
  let response: TaskDiffReviewChallengeResponseRecord;
  try {
    subject = parseTaskDiffReviewSubject(value.subject);
    review = parseTaskDiffReviewRecord(value.review);
    response = assertTaskDiffReviewChallengeResponseCurrent(
      review,
      parseTaskDiffReviewChallengeResponseRecord(value.response),
    );
  } catch {
    throw invocationInvalid();
  }
  if (
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    subject.repositoryId !== value.repositoryIdentity ||
    subject.baseCommit !== value.baseCommit ||
    subject.baseTree !== value.baseTree ||
    review.subjectDigest !== subject.subjectDigest ||
    canonicalJson(review.subject) !== canonicalJson(subject)
  ) {
    throw invocationInvalid();
  }
  const manifest: TaskDiffReviewContinuationManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    subject,
    review,
    response,
    capabilityProfile: 'repository-read-only',
  };
  if (
    Buffer.byteLength(canonicalJson(manifest), 'utf8') >
    MAX_BLIND_MANIFEST_BYTES
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(manifest);
}

function assertNormalizedChangeIntent(value: unknown): NormalizedChangeIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'summary',
      'sourceRefs',
      'explicitPaths',
      'explicitSymbols',
      'explicitConfigKeys',
      'renamePairs',
    ]) ||
    value.schemaVersion !== 1 ||
    !isBoundedBlindText(value.summary, MAX_INTENT_SUMMARY_BYTES) ||
    !isCanonicalSourceReferenceArray(value.sourceRefs) ||
    !isUniqueBoundedBlindStringArray(value.explicitPaths) ||
    !isUniqueBoundedBlindStringArray(value.explicitSymbols) ||
    !isUniqueBoundedBlindStringArray(value.explicitConfigKeys) ||
    !Array.isArray(value.renamePairs) ||
    value.renamePairs.length > MAX_INTENT_FACTS_PER_KIND
  ) {
    throw blindManifestInvalid();
  }
  const seenPairs = new Set<string>();
  for (const pair of value.renamePairs) {
    if (
      !isRecord(pair) ||
      !hasExactKeys(pair, ['from', 'to']) ||
      !isBoundedBlindFact(pair.from) ||
      !isBoundedBlindFact(pair.to) ||
      pair.from === pair.to
    ) {
      throw blindManifestInvalid();
    }
    const key = canonicalJson(pair);
    if (seenPairs.has(key)) {
      throw blindManifestInvalid();
    }
    seenPairs.add(key);
  }
  return deepFreeze(structuredClone(value)) as NormalizedChangeIntent;
}

function isCanonicalSourceReferenceArray(
  value: unknown,
): value is `SRC-${string}`[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_INTENT_FACTS_PER_KIND ||
    !value.every(
      (entry): entry is `SRC-${string}` =>
        typeof entry === 'string' && SOURCE_REFERENCE.test(entry),
    )
  ) {
    return false;
  }
  return value.every(
    (entry, index) => index === 0 || value[index - 1]!.localeCompare(entry) < 0,
  );
}

function isUniqueBoundedBlindStringArray(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_INTENT_FACTS_PER_KIND ||
    !value.every(isBoundedBlindFact)
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function isBoundedBlindFact(value: unknown): value is string {
  return (
    isBoundedBlindText(value, MAX_INTENT_FACT_BYTES) &&
    !containsDisallowedControl(value)
  );
}

function isBoundedBlindText(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !value.includes('\u0000')
  );
}

function containsDisallowedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      return true;
    }
  }
  return false;
}
