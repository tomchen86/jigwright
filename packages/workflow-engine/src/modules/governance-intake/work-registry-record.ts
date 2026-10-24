/**
 * Parses canonical Work Items, lifecycle records, and change origins.
 *
 * Invariants:
 * - Work Item aliases must be unique.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '@jigwright/core/canonical-json';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ChangeOriginV1,
  WorkItemKindV1,
  WorkItemLaneV1,
  WorkItemStageV1,
  WorkItemV1,
} from './work-registry-contracts.ts';

export const WORK_ITEM_FILE_MODE = 0o644;

export function workItemDigest(item: WorkItemV1): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(item)).digest('hex')}`;
}

export function parseWorkItem(value: unknown): WorkItemV1 {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) {
    throw registryInvalid('Work Item is invalid.');
  }
  const item = value as unknown as WorkItemV1;
  if (
    item.schemaVersion !== 1 ||
    !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(item.id) ||
    canonicalTimestamp(item.createdAt) !== item.createdAt ||
    workItemKind(item.kind) !== item.kind ||
    !['inbox', 'backlog', 'active', 'closed'].includes(item.stage) ||
    workItemLane(item.lane) !== item.lane ||
    boundedText(item.title, 160, 'title') !== item.title ||
    !isRecord(item.interpretation) ||
    !hasExactKeys(item.interpretation, ['status', 'summary']) ||
    boundedText(item.interpretation.summary, 2_000, 'summary') !==
      item.interpretation.summary ||
    !['agent-derived', 'maintainer-confirmed'].includes(
      item.interpretation.status,
    ) ||
    !Array.isArray(item.aliases) ||
    !item.aliases.every(
      (alias) =>
        typeof alias === 'string' &&
        /^(?:ISS-[0-9]+|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(alias),
    ) ||
    new Set(item.aliases).size !== item.aliases.length ||
    !isClosure(item.closure)
  ) {
    throw registryInvalid('Work Item is invalid.');
  }
  const canonicalAliases = [...item.aliases].sort();
  const canonicalSourceRefs = sourceReferences(item.sourceRefs);
  if (
    !Array.isArray(item.blockedBy) ||
    !item.blockedBy.every((entry) =>
      /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry),
    ) ||
    !Array.isArray(item.changeRefs) ||
    !item.changeRefs.every((entry) => changeIdentity(entry) === entry) ||
    !Array.isArray(item.timeline) ||
    item.timeline.length < 1 ||
    !item.timeline.every(isTimelineEntry)
  ) {
    throw registryInvalid('Work Item relations are invalid.');
  }
  const canonicalBlockedBy = workItemReferences(item.blockedBy);
  const canonicalChangeRefs = [...new Set(item.changeRefs)].sort();
  if (
    JSON.stringify(item.aliases) !== JSON.stringify(canonicalAliases) ||
    JSON.stringify(item.sourceRefs) !== JSON.stringify(canonicalSourceRefs) ||
    JSON.stringify(item.blockedBy) !== JSON.stringify(canonicalBlockedBy) ||
    canonicalChangeRefs.length !== item.changeRefs.length ||
    JSON.stringify(item.changeRefs) !== JSON.stringify(canonicalChangeRefs) ||
    !hasCoherentWorkItemLifecycle(item)
  ) {
    throw registryInvalid('Work Item relations are invalid.');
  }
  return item;
}

function hasCoherentWorkItemLifecycle(item: WorkItemV1): boolean {
  const first = item.timeline[0]!;
  const last = item.timeline.at(-1)!;
  const promoted = item.timeline.filter(({ event }) => event === 'promoted');
  if (
    first.event !== 'created' ||
    first.at !== item.createdAt ||
    first.changeId !== null ||
    item.timeline.filter(({ event }) => event === 'created').length !== 1
  ) {
    return false;
  }
  let observedStage: WorkItemStageV1 = 'inbox';
  for (const entry of item.timeline.slice(1)) {
    if (
      entry.event === 'accepted' &&
      observedStage !== 'closed' &&
      entry.changeId === null
    ) {
      if (observedStage === 'inbox') observedStage = 'backlog';
    } else if (
      entry.event === 'prioritized' &&
      observedStage === 'backlog' &&
      entry.changeId === null
    ) {
      continue;
    } else if (
      entry.event === 'promoted' &&
      observedStage === 'backlog' &&
      entry.changeId !== null
    ) {
      observedStage = 'active';
    } else if (entry.event === 'closed' && observedStage !== 'closed') {
      observedStage = 'closed';
    } else {
      return false;
    }
  }
  if (observedStage !== item.stage) return false;
  if (observedStage !== 'closed') {
    if (item.closure !== null) return false;
    if (observedStage !== 'active') return item.changeRefs.length === 0;
    return (
      promoted.length === 1 &&
      item.changeRefs.length === 1 &&
      item.changeRefs[0] === promoted[0]!.changeId
    );
  }
  if (
    item.closure === null ||
    last.event !== 'closed' ||
    last.at !== item.closure.at ||
    last.changeId !== item.closure.changeId
  ) {
    return false;
  }
  if (item.closure.outcome === 'delivered') {
    return (
      item.closure.changeId !== null &&
      promoted.length === 1 &&
      promoted[0]!.changeId === item.closure.changeId &&
      item.changeRefs.length === 1 &&
      item.changeRefs[0] === item.closure.changeId
    );
  }
  return (
    item.closure.changeId === null &&
    promoted.length === 0 &&
    item.changeRefs.length === 0
  );
}

function isTimelineEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['at', 'changeId', 'event']) &&
    typeof value.at === 'string' &&
    canonicalTimestamp(value.at) === value.at &&
    ['created', 'accepted', 'prioritized', 'promoted', 'closed'].includes(
      String(value.event),
    ) &&
    (value.changeId === null ||
      (typeof value.changeId === 'string' &&
        changeIdentity(value.changeId) === value.changeId))
  );
}

const ITEM_KEYS = [
  'aliases',
  'blockedBy',
  'changeRefs',
  'closure',
  'createdAt',
  'id',
  'interpretation',
  'kind',
  'lane',
  'schemaVersion',
  'sourceRefs',
  'stage',
  'timeline',
  'title',
] as const;

function isClosure(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['at', 'changeId', 'outcome']) &&
      typeof value.at === 'string' &&
      canonicalTimestamp(value.at) === value.at &&
      ['delivered', 'declined', 'duplicate', 'obsolete'].includes(
        String(value.outcome),
      ) &&
      (value.changeId === null ||
        (typeof value.changeId === 'string' &&
          changeIdentity(value.changeId) === value.changeId)))
  );
}

export function parseOrigin(existingText: string): ChangeOriginV1 {
  let value: unknown;
  try {
    value = JSON.parse(existingText);
  } catch {
    throw registryInvalid('Change origin is invalid.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ORIGIN_KEYS) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sourceRefs) ||
    !Array.isArray(value.workItemRefs) ||
    !value.sourceRefs.every(
      (entry) => typeof entry === 'string' && /^SRC-[0-9a-f]{64}$/.test(entry),
    ) ||
    !value.workItemRefs.every(
      (entry) =>
        typeof entry === 'string' &&
        /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry),
    )
  ) {
    throw registryInvalid('Change origin is invalid.');
  }
  const origin = value as unknown as ChangeOriginV1;
  const canonicalSourceRefs = sourceReferences(origin.sourceRefs);
  const canonicalWorkItemRefs = workItemReferences(origin.workItemRefs);
  if (
    JSON.stringify(origin.sourceRefs) !== JSON.stringify(canonicalSourceRefs) ||
    JSON.stringify(origin.workItemRefs) !==
      JSON.stringify(canonicalWorkItemRefs) ||
    existingText !== `${canonicalJson(origin)}\n`
  ) {
    throw registryInvalid('Change origin is invalid.');
  }
  return origin;
}

export const ORIGIN_KEYS = [
  'schemaVersion',
  'sourceRefs',
  'workItemRefs',
] as const;

export function workRegistryTextDigest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function workItemId(value: string): `WORK-${string}` {
  if (!/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw registryInvalid('Work Item identity is invalid.');
  }
  return value as `WORK-${string}`;
}

export function workItemKind(value: string): WorkItemKindV1 {
  if (!['feature', 'bug', 'improvement', 'chore', 'research'].includes(value)) {
    throw registryInvalid('Work Item kind is invalid.');
  }
  return value as WorkItemKindV1;
}

export function workItemLane(value: unknown): WorkItemLaneV1 {
  if (
    value !== null &&
    !['now', 'next', 'later', 'icebox'].includes(String(value))
  ) {
    throw registryInvalid('Work Item lane is invalid.');
  }
  return value as WorkItemLaneV1;
}

export function sourceReferences(value: readonly string[]): `SRC-${string}`[] {
  if (!Array.isArray(value))
    throw registryInvalid('Source references are invalid.');
  const refs = value.map((entry) => {
    if (!/^SRC-[0-9a-f]{64}$/.test(entry)) {
      throw registryInvalid('Source reference is invalid.');
    }
    return entry as `SRC-${string}`;
  });
  if (new Set(refs).size !== refs.length) {
    throw registryInvalid('Source references are duplicated.');
  }
  return refs.sort();
}

export function workItemReferences(
  value: readonly string[],
): `WORK-${string}`[] {
  if (!Array.isArray(value)) {
    throw registryInvalid('Work Item references are invalid.');
  }
  const refs = value.map((entry) => workItemId(entry));
  if (new Set(refs).size !== refs.length) {
    throw registryInvalid('Work Item references are duplicated.');
  }
  return refs.sort();
}

export function exactDigest(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw registryInvalid('Work Item review digest is invalid.');
  }
  return value as `sha256:${string}`;
}

export function boundedText(
  value: string,
  maximum: number,
  field: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    value.includes('\0')
  ) {
    throw registryInvalid(`Work Item ${field} is invalid.`);
  }
  return value;
}

export function changeIdentity(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw registryInvalid('Change identity is invalid.');
  }
  return value;
}

export function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw registryInvalid('Work Item timestamp is invalid.');
  }
  return value;
}

export function registryInvalid(message: string) {
  return workflowError('WORK_REGISTRY_INVALID', message, ExitCode.usage);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
