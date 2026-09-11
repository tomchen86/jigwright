/**
 * Defines and validates current execution workflow status and blocker
 * records.
 *
 * Invariants:
 * - The record parser admits only schema version 2 and registered workflow
 *   statuses.
 */
import { canonicalJson } from './canonical-json.ts';

export const EXECUTION_WORKFLOW_RECORD_CONTRACT_VERSION_V2 =
  'jigwright.execution-workflow-record.v2' as const;

export const EXECUTION_WORKFLOW_STATUSES_V2 = [
  'active',
  'completed',
  'cancelled',
  'superseded',
] as const;

export const EXECUTION_WORKFLOW_BLOCKER_KINDS_V2 = [
  'retry-delay',
  'provider-capacity',
  'human-grant',
  'human-input',
  'configuration',
  'dependency',
  'manual-reconciliation',
  'harness-intervention',
] as const;

export type ExecutionWorkflowStatusV2 =
  (typeof EXECUTION_WORKFLOW_STATUSES_V2)[number];

export type ExecutionWorkflowBlockerKindV2 =
  (typeof EXECUTION_WORKFLOW_BLOCKER_KINDS_V2)[number];

export type ExecutionWorkflowBlockerV2 = {
  kind: ExecutionWorkflowBlockerKindV2;
  since: string;
  jobId?: string;
  retryAt?: string;
  detailsDigest?: string;
  checkpointId?: string;
  blockedBy?: string;
};

export type ExecutionWorkflowRecordV2 = {
  schemaVersion: 2;
  workflowId: string;
  currentEpoch: number;
  contractVersion: number;
  contextDigest: string;
  checkpoint: string | null;
  status: ExecutionWorkflowStatusV2;
  blocker: ExecutionWorkflowBlockerV2 | null;
  engineBinding: string;
};

export class ExecutionWorkflowRecordCodecError extends TypeError {
  readonly code = 'EXECUTION_WORKFLOW_RECORD_INVALID';

  constructor(message = 'Workflow record is invalid.') {
    super(message);
    this.name = 'ExecutionWorkflowRecordCodecError';
  }
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const STATUS_SET = new Set<ExecutionWorkflowStatusV2>(
  EXECUTION_WORKFLOW_STATUSES_V2,
);
const BLOCKER_KIND_SET = new Set<ExecutionWorkflowBlockerKindV2>(
  EXECUTION_WORKFLOW_BLOCKER_KINDS_V2,
);

/** Admit and snapshot the exact current durable execution Workflow value. */
export function assertExecutionWorkflowRecordV2(
  value: unknown,
): ExecutionWorkflowRecordV2 {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'blocker',
      'checkpoint',
      'contextDigest',
      'contractVersion',
      'currentEpoch',
      'engineBinding',
      'schemaVersion',
      'status',
      'workflowId',
    ]) ||
    value.schemaVersion !== 2 ||
    !STATUS_SET.has(value.status as ExecutionWorkflowStatusV2)
  ) {
    throw new ExecutionWorkflowRecordCodecError();
  }
  assertIdentifier(value.workflowId, 'workflowId');
  assertPositiveInteger(value.currentEpoch, 'currentEpoch');
  assertPositiveInteger(value.contractVersion, 'contractVersion');
  assertDigest(value.contextDigest);
  assertDigest(value.engineBinding);
  if (value.checkpoint !== null) {
    assertIdentifier(value.checkpoint, 'checkpoint');
  }
  assertWorkflowBlocker(value.blocker);
  return deepFreeze(structuredClone(value) as ExecutionWorkflowRecordV2);
}

function assertWorkflowBlocker(value: unknown): void {
  if (value === null) return;
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      'blockedBy',
      'checkpointId',
      'detailsDigest',
      'jobId',
      'kind',
      'retryAt',
      'since',
    ]) ||
    !BLOCKER_KIND_SET.has(value.kind as ExecutionWorkflowBlockerKindV2)
  ) {
    throw new ExecutionWorkflowRecordCodecError('Workflow blocker is invalid.');
  }
  assertTimestamp(value.since);
  if (value.jobId !== undefined) assertIdentifier(value.jobId, 'blocker.jobId');
  if (value.retryAt !== undefined) assertTimestamp(value.retryAt);
  if (value.detailsDigest !== undefined) assertDigest(value.detailsDigest);
  if (value.checkpointId !== undefined) {
    assertIdentifier(value.checkpointId, 'blocker.checkpointId');
  }
  if (value.blockedBy !== undefined) {
    assertIdentifier(value.blockedBy, 'blocker.blockedBy');
  }
}

function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER.test(value) ||
    value !== value.normalize('NFC')
  ) {
    throw new ExecutionWorkflowRecordCodecError(`${label} is invalid.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExecutionWorkflowRecordCodecError(
      `${label} must be a positive integer.`,
    );
  }
  return value as number;
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new ExecutionWorkflowRecordCodecError('Digest is invalid.');
  }
  return value;
}

function assertTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ExecutionWorkflowRecordCodecError('Timestamp is invalid.');
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
