/** Canonical recovery Grant values, pure checks and the required persistence contract. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type ExitCodeValue,
} from '../../foundation/errors/errors.ts';
import type { Sha256Digest } from './intervention-control-values.ts';

export const HARNESS_RECOVERY_SIGNATURE_NAMESPACE = 'HARNESS_RECOVERY_GRANT_V1';

export const CONTROL_PLANE_RECOVERY_GRANT_TTL_MS = 5 * 60 * 1000;

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const RECOVERY_GRANT_ID = /^recovery-[0-9a-f]{64}$/;

export const PAYLOAD_KEYS = [
  'controlPlaneJournalDigest',
  'controlPlaneUpdateRecordDigest',
  'currentClosureDigest',
  'expiresAt',
  'externalAuditRoot',
  'grantId',
  'humanSigner',
  'issuedAt',
  'kind',
  'oneShot',
  'operation',
  'previousClosureDigest',
  'promotionBundleDigest',
  'recoveryBundleDigest',
  'repositoryId',
  'sourceControlPlaneGrantId',
  'sourceTransactionState',
  'supervisorGeneration',
  'supervisorStateDigest',
  'uses',
] as const;

export type ControlPlaneRecoverySourceState =
  'RECOVERY_VERIFIED' | 'SWITCHED' | 'ROLLBACK_REQUIRED';

export interface ControlPlaneRecoveryGrantPayload {
  kind: 'harness-recovery-grant.v1';
  grantId: string;
  repositoryId: string;
  sourceControlPlaneGrantId: string;
  operation: 'rollback-control-plane';
  previousClosureDigest: Sha256Digest;
  currentClosureDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  controlPlaneUpdateRecordDigest: Sha256Digest;
  controlPlaneJournalDigest: Sha256Digest;
  sourceTransactionState: ControlPlaneRecoverySourceState;
  supervisorStateDigest: Sha256Digest;
  supervisorGeneration: number;
  externalAuditRoot: string;
  uses: 1;
  oneShot: true;
  issuedAt: string;
  expiresAt: string;
  humanSigner: string;
}

export interface ControlPlaneRecoveryGrantEnvelope {
  payload: ControlPlaneRecoveryGrantPayload;
  signature: string;
}

export interface ControlPlaneRecoveryReceipt {
  kind: 'control-plane-recovery-receipt.v1';
  recoveryGrantId: string;
  sourceControlPlaneGrantId: string;
  repositoryId: string;
  operation: 'rollback-control-plane';
  previousClosureDigest: Sha256Digest;
  currentClosureDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest;
  controlPlaneJournalDigestBefore: Sha256Digest;
  controlPlaneJournalDigestAfter: Sha256Digest;
  supervisorStateDigestBefore: Sha256Digest;
  supervisorStateDigestAfter: Sha256Digest;
  result: 'rolled-back';
  completedAt: string;
  receiptDigest: Sha256Digest;
}

export interface ControlPlaneRecoveryFailure {
  kind: 'control-plane-recovery-failure.v1';
  recoveryGrantId: string;
  sourceControlPlaneGrantId: string;
  stage: 'restart-verification';
  errorCode: string;
  selectedClosureDigest: Sha256Digest;
  selectedArtifactId: string;
  supervisorStateDigest: Sha256Digest;
  supervisorGeneration: number;
  controlPlaneJournalDigest: Sha256Digest;
  failedAt: string;
  failureDigest: Sha256Digest;
}

export interface PersistedControlPlaneRecoveryGrant {
  kind: 'persisted-control-plane-recovery-grant.v1';
  state: 'reserved' | 'completion-pending' | 'consumed' | 'expired' | 'failed';
  envelope: ControlPlaneRecoveryGrantEnvelope;
  envelopeDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  receipt: ControlPlaneRecoveryReceipt | null;
  failure: ControlPlaneRecoveryFailure | null;
  createdAt: string;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

export type ControlPlaneRecoveryAuditEvent =
  'authorized' | 'expired' | 'failed' | 'rolled-back' | 'consumed';

export interface ControlPlaneRecoveryAuditRecord {
  kind: 'control-plane-recovery-audit.v1';
  recordId: Sha256Digest;
  repositoryId: string;
  externalAuditRoot: string;
  recoveryGrantId: string;
  sourceControlPlaneGrantId: string;
  humanSigner: string;
  operation: 'rollback-control-plane';
  sequence: 0 | 1 | 2;
  event: ControlPlaneRecoveryAuditEvent;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest | null;
  receiptDigest: Sha256Digest | null;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

export interface ControlPlaneRecoveryStateBinding {
  repositoryId: string;
  sourceControlPlaneGrantId: string;
  previousClosureDigest: Sha256Digest;
  currentClosureDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  controlPlaneUpdateRecordDigest: Sha256Digest;
  controlPlaneJournalDigest: Sha256Digest;
  sourceTransactionState: ControlPlaneRecoverySourceState;
  supervisorStateDigest: Sha256Digest;
  supervisorGeneration: number;
  externalAuditRoot: string;
}

export type ControlPlaneRecoveryConsumptionInput = {
  recoveryGrantId: string;
  expectedRecordDigest: Sha256Digest;
};

export type ControlPlaneRecoveryPreparationInput = {
  recoveryGrantId: string;
  expectedRecordDigest: Sha256Digest;
  receipt: ControlPlaneRecoveryReceipt;
};

export type ControlPlaneRecoveryFailureInput = {
  recoveryGrantId: string;
  expectedRecordDigest: Sha256Digest;
  failure: ControlPlaneRecoveryFailure;
};

export type ControlPlaneRecoveryExpiryInput = {
  recoveryGrantId: string;
  expectedRecordDigest: Sha256Digest;
  expiredAt: string;
};

/** Required synchronous operations used by the sealed recovery executor. */
export interface ControlPlaneRecoveryGrantPersistence {
  findForSource(
    storageRoot: string,
    sourceControlPlaneGrantId: string,
  ): PersistedControlPlaneRecoveryGrant | null;
  reserve(
    storageRoot: string,
    envelope: ControlPlaneRecoveryGrantEnvelope,
    at: string,
  ): PersistedControlPlaneRecoveryGrant;
  consume(
    storageRoot: string,
    input: ControlPlaneRecoveryConsumptionInput,
  ): PersistedControlPlaneRecoveryGrant;
  prepareConsumption(
    storageRoot: string,
    input: ControlPlaneRecoveryPreparationInput,
  ): PersistedControlPlaneRecoveryGrant;
  fail(
    storageRoot: string,
    input: ControlPlaneRecoveryFailureInput,
  ): PersistedControlPlaneRecoveryGrant;
  expire(
    storageRoot: string,
    input: ControlPlaneRecoveryExpiryInput,
  ): PersistedControlPlaneRecoveryGrant;
}

export function verifyRecordDigest(value: Record<string, unknown>): boolean {
  if (!isDigest(value.recordDigest)) return false;
  const { recordDigest, ...payload } = value;
  return recordDigest === canonicalDigest(payload);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

export function exactIso(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw recoveryError(code, 'Recovery timestamp is not canonical UTC.');
  }
  return value;
}

export function exactDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw recoveryError(code, 'Recovery clock is invalid.');
  }
  return new Date(value.getTime());
}

export function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (!isDigest(value)) throw recoveryError(code, 'Expected a SHA-256 digest.');
}

export function assertIdentifier(
  value: unknown,
  code: string,
): asserts value is string {
  if (!isNonEmpty(value)) {
    throw recoveryError(code, 'Recovery identity is invalid.');
  }
}

export function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r')
  );
}

export function isExactAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.includes('\0')
  );
}

export function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && DIGEST.test(value);
}

export function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(canonicalJson(value));
}

export function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function recoveryAlreadyConsumed(): Error & { code: string } {
  return recoveryError(
    'HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED',
    'Recovery Grant is a consumed one-shot tombstone and cannot replay.',
    ExitCode.conflict,
  );
}

export function recoveryAlreadyFailed(): Error & { code: string } {
  return recoveryError(
    'HARNESS_RECOVERY_GRANT_FAILED',
    'Recovery Grant terminalized after restart verification failed and cannot replay.',
    ExitCode.conflict,
  );
}

export function recoveryRecordCorrupt(): Error & { code: string } {
  return recoveryError(
    'HARNESS_RECOVERY_RECORD_CORRUPT',
    'Persisted Recovery Grant or receipt failed canonical integrity verification.',
    ExitCode.verification,
  );
}

export function recoveryError(
  code: string,
  message: string,
  exitCode: ExitCodeValue = ExitCode.guard,
): ReturnType<typeof workflowError> {
  return workflowError(code, message, exitCode);
}
