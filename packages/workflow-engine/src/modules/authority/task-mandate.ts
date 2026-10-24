/** Pure mandate state, exact binding and observed repository trust decisions. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type MaintainerPolicy } from './maintainer-policy.ts';
import type { TaskMandateBinding } from './task-mandate-contract.ts';
import { canonicalTaskMandateEnvelope } from './task-mandate-records.ts';
import {
  exactTimestamp,
  TASK_MANDATE_INACTIVITY_DAYS,
  unsafeStore,
  type TaskMandateInspection,
  type TaskMandatePayload,
  type TaskMandateRecord,
} from './task-mandate-values.ts';

export function inspectRecord(
  record: TaskMandateRecord,
  now: Date,
): TaskMandateInspection {
  assertRecordClock(record, now);
  const state =
    record.state === 'revoked'
      ? 'revoked'
      : isInactive(record, now)
        ? 'expired'
        : 'active';
  return {
    mandateId: record.mandateId,
    changeId: record.changeId,
    externalAuditRoot: record.externalAuditRoot,
    taskId: record.taskId,
    state,
    intent: record.envelope.payload.intent,
    baseCommit: record.envelope.payload.baseCommit,
    signer: record.envelope.payload.signer,
    issuedAt: record.envelope.payload.issuedAt,
    lastActivityAt: record.lastActivityAt,
    providerUsage: Object.fromEntries(
      Object.entries(record.providerUsage).map(([providerId, usage]) => [
        providerId,
        { invocations: usage.invocations, budget: usage.budget },
      ]),
    ),
    inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    ...(record.revocationReason
      ? { revocationReason: record.revocationReason }
      : {}),
  };
}

export function assertRecordActive(record: TaskMandateRecord, now: Date): void {
  assertRecordClock(record, now);
  if (record.state === 'revoked') {
    throw workflowError(
      'TASK_MANDATE_REVOKED',
      'Task mandate has been revoked.',
      ExitCode.staleState,
    );
  }
  if (isInactive(record, now)) {
    throw workflowError(
      'TASK_MANDATE_EXPIRED',
      'Task mandate expired after fourteen days without activity.',
      ExitCode.staleState,
    );
  }
}

export function assertRecordClock(record: TaskMandateRecord, now: Date): void {
  const lastActivity = exactTimestamp(record.lastActivityAt);
  if (lastActivity === undefined || lastActivity > now.getTime() + 30_000) {
    throw unsafeStore();
  }
}

export function isInactive(record: TaskMandateRecord, now: Date): boolean {
  const lastActivity = exactTimestamp(record.lastActivityAt);
  if (lastActivity === undefined) throw unsafeStore();
  return (
    now.getTime() - lastActivity >=
    TASK_MANDATE_INACTIVITY_DAYS * 24 * 60 * 60_000
  );
}

export function taskMandateBinding(
  record: TaskMandateRecord,
): TaskMandateBinding {
  return {
    schemaVersion: 1,
    mandateTaskId: record.taskId,
    mandateId: record.mandateId,
    mandateDigest: crypto
      .createHash('sha256')
      .update(canonicalTaskMandateEnvelope(record.envelope))
      .digest('hex'),
    changeId: record.changeId,
    externalAuditRoot: record.externalAuditRoot,
  };
}

export function assertExactTaskMandateBinding(
  record: TaskMandateRecord,
  binding: TaskMandateBinding,
): void {
  const current = taskMandateBinding(record);
  if (canonicalJson(current) !== canonicalJson(binding)) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'The durable task mandate binding no longer matches the active mandate.',
      ExitCode.staleState,
    );
  }
}
export function assertTaskMandateRepositoryTrust(
  payload: TaskMandatePayload,
  base: { policy: MaintainerPolicy; policyBlob: string },
  currentPolicy: MaintainerPolicy,
  origin: string,
): void {
  if (
    base.policyBlob !== payload.policyBlob ||
    base.policy.repository.id !== payload.repositoryId ||
    base.policy.repository.origin !== payload.repositoryOrigin ||
    currentPolicy.repository.id !== payload.repositoryId ||
    currentPolicy.repository.origin !== payload.repositoryOrigin ||
    origin !== payload.repositoryOrigin ||
    !base.policy.trustedSigners.some(
      ({ identity }) => identity === payload.signer,
    )
  ) {
    throw workflowError(
      'TASK_MANDATE_REPOSITORY_MISMATCH',
      'Task mandate no longer matches this repository identity or trust base.',
      ExitCode.staleState,
    );
  }
}
