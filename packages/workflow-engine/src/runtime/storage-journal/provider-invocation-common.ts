/**
 * Share exact provider-store paths, digests, predicates, durability helpers, and errors.
 *
 * Invariants:
 * - Canonical bytes, private paths, error codes, and directory flush behavior stay stable.
 * - Provider timestamps and identifiers retain their existing validation semantics.
 *
 * Depends on: canonical JSON, investigation runtime paths, and provider record types.
 * Failure modes: Changed identities or errors break CAS, replay, and safe private-file handling.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import { assertProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';
import {
  type InvestigationStartReservation,
  type InvestigationStartReservationSnapshot,
} from './provider-invocation-types.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

export const SOURCE_REFERENCE = /^SRC-[0-9a-f]{64}$/;

export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const MAX_BLIND_MANIFEST_BYTES = 262_144;

export const MAX_INTENT_SUMMARY_BYTES = 4_096;

export const MAX_INTENT_FACT_BYTES = 512;

export const MAX_INTENT_FACTS_PER_KIND = 256;

export const MAX_ARCHITECTURE_QUESTION_BYTES = 16_384;

export const PROVIDER_COMPLETION_GRACE_MS = 30_000;

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function providerInvocationDirectory(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(paths.invocations, invocationId);
}

export function providerInvocationStatePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    providerInvocationDirectory(paths, invocationId),
    'state.json',
  );
}

export function providerInvocationCancellationRequestPath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    providerInvocationDirectory(paths, invocationId),
    'cancellation-request.json',
  );
}

export function providerCompletionCandidatePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    paths.root,
    'execution',
    'completion-candidates',
    `${sha256(invocationId)}.json`,
  );
}

export function investigationStartReservationPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-start.json`);
}

export function providerRetryReservationPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
  attempt: number,
): string {
  return path.join(
    paths.refs,
    `${investigationId}.provider-retry-${attempt}.json`,
  );
}

export function parseNow(value: string | undefined): number {
  const now = value === undefined ? Date.now() : Date.parse(value);
  if (!Number.isFinite(now)) {
    throw leaseInvalid();
  }
  return now;
}

export function isTaskMandateBinding(
  value: unknown,
  changeId: string,
): value is TaskMandateBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) &&
    value.schemaVersion === 1 &&
    value.changeId === changeId &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    typeof value.mandateTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    isDigest(value.mandateDigest)
  );
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function isBaseline(
  value: unknown,
): value is InvestigationStartReservation['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function providerSha256(value: string): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function blindManifestInvalid() {
  return workflowError(
    'BLIND_MANIFEST_INVALID',
    'Blind survey manifest is malformed, over-broad, or contains prior work.',
    ExitCode.guard,
  );
}

export function invocationUnsafe() {
  return workflowError(
    'PROVIDER_INVOCATION_STORE_UNSAFE',
    'Provider invocation storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function providerExecutionPolicySnapshotUnsafe() {
  return workflowError(
    'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE',
    'Durable provider execution policy snapshot is missing, malformed, or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}

export function providerExecutionPolicySnapshotMismatch() {
  return workflowError(
    'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
    'Durable provider execution policy snapshot is not bound to this request.',
    ExitCode.staleState,
  );
}

export function assertProviderAcceptanceBinding(
  binding: ProviderInvocationAcceptanceBinding,
): void {
  try {
    assertProviderInvocationAcceptanceBinding(
      binding,
      providerAcceptanceBindingStale,
    );
  } catch {
    throw providerAcceptanceBindingStale();
  }
}

export function providerAcceptanceBindingStale() {
  return workflowError(
    'PROVIDER_ACCEPTANCE_BINDING_STALE',
    'Provider execution authority changed before result acceptance.',
    ExitCode.staleState,
  );
}

export function invocationInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_INVALID',
    'Provider invocation is malformed or internally inconsistent.',
    ExitCode.staleState,
  );
}

export function providerCancellationInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_CANCELLATION_INVALID',
    'Provider invocation cancellation authority or storage is invalid.',
    ExitCode.guard,
  );
}

export function providerCancellationStateChanged() {
  return workflowError(
    'PROVIDER_INVOCATION_CANCELLATION_STATE_CHANGED',
    'Provider invocation changed after its exact cancellation binding was created.',
    ExitCode.staleState,
  );
}

export function invocationTransitionInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_TRANSITION_INVALID',
    'Provider invocation transition is not monotonic.',
    ExitCode.staleState,
  );
}

export function leaseInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_LEASE_INVALID',
    'Provider invocation lease request is malformed.',
    ExitCode.usage,
  );
}

export function resultInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_RESULT_INVALID',
    'Provider invocation result is not bound to its durable request.',
    ExitCode.verification,
  );
}

export function providerCompletionRecoveryConflict() {
  return workflowError(
    'PROVIDER_COMPLETION_RECOVERY_CONFLICT',
    'Provider state diverged from the exact durable completion candidate.',
    ExitCode.conflict,
  );
}

export function providerCasMismatch(expected: number, observed: number) {
  return workflowError(
    'PROVIDER_INVOCATION_CAS_MISMATCH',
    'Provider invocation changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

export function startReservationCasMismatch(
  expectedDigest: string | null,
  observedDigest: string | null,
) {
  return workflowError(
    'INVESTIGATION_START_RESERVATION_CAS_MISMATCH',
    'Investigation start reservation changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedDigest, observedDigest } },
  );
}

export function startReservationLockInvalid() {
  return workflowError(
    'INVESTIGATION_START_RESERVATION_LOCK_INVALID',
    'Investigation start reservation lock ownership changed during retirement.',
    ExitCode.staleState,
  );
}

export function invocationLockInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_LOCK_INVALID',
    'Provider invocation lock ownership changed during the transition.',
    ExitCode.staleState,
  );
}

export function providerWorkerFenceUnsafe() {
  return workflowError(
    'PROVIDER_INVOCATION_WORKER_FENCE_UNSAFE',
    'Provider worker activity fence is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function absentInvestigationStartReservationSnapshot(): InvestigationStartReservationSnapshot {
  return Object.freeze({
    rawDocument: null,
    digest: null,
    reservation: null,
  });
}
