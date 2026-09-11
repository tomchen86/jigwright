/** Work Item aliases, origin unions and repository transition-policy values; no repository reads. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ChangeOriginV1,
  WorkItemReviewV1,
  WorkItemV1,
  WorkRegistryTransitionPolicyV1,
} from './work-registry-contracts.ts';
import {
  ORIGIN_KEYS,
  boundedText,
  hasExactKeys,
  isRecord,
  registryInvalid,
  workItemLane,
  workItemReferences,
} from './work-registry-record.ts';

export function mergeOrigin(
  existingText: string | null,
  sourceRefs: readonly `SRC-${string}`[],
  workItemRefs: readonly `WORK-${string}`[],
): ChangeOriginV1 {
  let existing: ChangeOriginV1 = {
    schemaVersion: 1,
    sourceRefs: [],
    workItemRefs: [],
  };
  if (existingText !== null) {
    const value: unknown = JSON.parse(existingText);
    if (!isRecord(value) || !hasExactKeys(value, ORIGIN_KEYS)) {
      throw registryInvalid('Change origin is invalid.');
    }
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.sourceRefs) ||
      !Array.isArray(value.workItemRefs) ||
      !value.sourceRefs.every((entry) => typeof entry === 'string') ||
      !value.workItemRefs.every((entry) => typeof entry === 'string')
    ) {
      throw registryInvalid('Change origin is invalid.');
    }
    existing = value as ChangeOriginV1;
  }
  const merged: ChangeOriginV1 = {
    schemaVersion: 1,
    sourceRefs: [...new Set([...existing.sourceRefs, ...sourceRefs])].sort(),
    workItemRefs: [
      ...new Set([...existing.workItemRefs, ...workItemRefs]),
    ].sort(),
  };
  return merged;
}

export function parseWorkRegistryTransitionPolicy(
  source: string | null,
): WorkRegistryTransitionPolicyV1 {
  if (source === null) {
    return {
      schemaVersion: 1,
      transitions: {
        intake: 'ordinary',
        prioritize: 'ordinary',
        promote: 'ordinary',
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw registryInvalid('Work Registry transition policy is invalid.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'transitions']) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.transitions) ||
    !hasExactKeys(value.transitions, ['intake', 'prioritize', 'promote']) ||
    !['ordinary', 'central-grant'].includes(String(value.transitions.intake)) ||
    !['ordinary', 'central-grant'].includes(
      String(value.transitions.prioritize),
    ) ||
    !['ordinary', 'central-grant'].includes(String(value.transitions.promote))
  ) {
    throw registryInvalid('Work Registry transition policy is invalid.');
  }
  return value as WorkRegistryTransitionPolicyV1;
}

export function workItemAliases(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== 'string' || !/^ISS-[0-9]+$/.test(entry),
    )
  ) {
    throw registryInvalid('Work Item aliases are invalid.');
  }
  const aliases = [...value].sort();
  if (new Set(aliases).size !== aliases.length) {
    throw registryInvalid('Work Item aliases are duplicated.');
  }
  return aliases;
}

export function promotionIneligible(message: string) {
  return workflowError(
    'WORK_REGISTRY_PROMOTION_INELIGIBLE',
    message,
    ExitCode.conflict,
  );
}

/** Validate transition-local facts before any related Work Item is observed. */
export function workItemReviewDependencies(
  item: WorkItemV1,
  review: WorkItemReviewV1,
): readonly WorkItemV1['id'][] {
  if (review.action === 'accept') {
    if (
      item.closure !== null ||
      item.stage === 'closed' ||
      (item.stage !== 'inbox' && item.interpretation.status !== 'agent-derived')
    )
      throw registryInvalid(
        'Accept requires an inbox item or an open item with a changed interpretation.',
      );
  } else if (review.action === 'prioritize') {
    if (item.stage !== 'backlog' || item.closure !== null)
      throw registryInvalid('Only an open backlog item can be prioritized.');
    const blockedBy = workItemReferences(review.blockedBy);
    if (blockedBy.includes(item.id))
      throw registryInvalid('A Work Item cannot block itself.');
    return blockedBy;
  } else if (item.stage !== 'inbox' && item.stage !== 'backlog')
    throw registryInvalid('Only an unpromoted Work Item can be declined.');
  return [];
}
/** Project a validated review after related blocker facts and cycle checks succeed. */
export function projectWorkItemReview(
  item: WorkItemV1,
  review: WorkItemReviewV1,
  at: string,
  blockedBy: readonly WorkItemV1['id'][],
): WorkItemV1 {
  let next: WorkItemV1;
  if (review.action === 'accept') {
    next = {
      ...item,
      stage: item.stage === 'inbox' ? 'backlog' : item.stage,
      interpretation: {
        summary: boundedText(review.summary, 2_000, 'summary'),
        status: 'maintainer-confirmed',
      },
      timeline: [...item.timeline, { at, event: 'accepted', changeId: null }],
    };
  } else if (review.action === 'prioritize') {
    next = {
      ...item,
      lane: workItemLane(review.lane),
      blockedBy,
      timeline: [
        ...item.timeline,
        { at, event: 'prioritized', changeId: null },
      ],
    };
  } else {
    next = {
      ...item,
      stage: 'closed',
      closure: { at, outcome: review.outcome, changeId: null },
      timeline: [...item.timeline, { at, event: 'closed', changeId: null }],
    };
  }

  return next;
}
export function assertPromotionCandidate(item: WorkItemV1): void {
  if (
    item.stage !== 'backlog' ||
    item.interpretation.status !== 'maintainer-confirmed' ||
    (item.lane !== 'now' && item.lane !== 'next') ||
    item.changeRefs.length !== 0 ||
    item.closure !== null
  )
    throw promotionIneligible(
      'Promotion requires one reviewed Now or Next backlog Work Item.',
    );
}
export function assertPromotionBlockerClosed(blocker: WorkItemV1): void {
  if (blocker.stage !== 'closed')
    throw promotionIneligible(
      'Promotion requires every blocking Work Item to be closed.',
    );
}
