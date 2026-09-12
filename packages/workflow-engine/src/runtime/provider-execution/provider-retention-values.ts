/**
 * Share exact retention limits, timestamp guards, digests, and failure values.
 *
 * Invariants:
 * - Limits, digest bytes, deny reasons, and error identities stay unchanged.
 * - Helpers never mutate retention state.
 */

import crypto from 'node:crypto';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import type { ProviderRetentionDenyReason } from './provider-retention.ts';
import type { CandidateDecision } from './provider-retention-observation.ts';

export const PROVIDER_RETENTION_DEFAULT_TTL_DAYS = 7;

export const PROVIDER_RETENTION_MAX_TTL_DAYS = 90;

export const PROVIDER_RETENTION_MAX_LIMIT = 100;

export function assertLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > PROVIDER_RETENTION_MAX_LIMIT
  ) {
    throw workflowError(
      'PROVIDER_RETENTION_LIMIT_INVALID',
      `Provider retention limit must be between 1 and ${PROVIDER_RETENTION_MAX_LIMIT}.`,
      ExitCode.usage,
    );
  }
  return value;
}

export function assertTtlDays(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > PROVIDER_RETENTION_MAX_TTL_DAYS
  ) {
    throw workflowError(
      'PROVIDER_RETENTION_TTL_INVALID',
      `Provider retention TTL must be between 1 and ${PROVIDER_RETENTION_MAX_TTL_DAYS} days.`,
      ExitCode.usage,
    );
  }
  return value;
}

export function parseTimestamp(value: string): Date {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw workflowError(
      'PROVIDER_RETENTION_NOW_INVALID',
      'Provider retention time must be an exact ISO-8601 timestamp.',
      ExitCode.usage,
    );
  }
  return new Date(timestamp);
}

export function deny(
  invocationId: string,
  reason: ProviderRetentionDenyReason,
): CandidateDecision {
  return { kind: 'deny', invocationId, reason };
}

export function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

export function runtimeUnsafe(): WorkflowError {
  return workflowError(
    'PROVIDER_RETENTION_RUNTIME_UNSAFE',
    'Provider runtime retention encountered an unsafe or unbound artifact.',
    ExitCode.unsafeEnvironment,
  );
}

export function receiptUnsafe(): WorkflowError {
  return workflowError(
    'PROVIDER_RETENTION_RECEIPT_UNSAFE',
    'Provider runtime pruning receipt is missing, malformed, or tampered.',
    ExitCode.unsafeEnvironment,
  );
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
