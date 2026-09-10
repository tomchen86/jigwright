/**
 * Parses canonical human revocation envelopes and validates their exact
 * subject bindings.
 *
 * Invariants:
 * - The `signatureNamespace` is fixed to
 *   `HUMAN_REVOCATION_SIGNATURE_NAMESPACE`; any other value is rejected.
 * - `parseHumanRevocationAuthorization` requires the raw input to
 *   re-serialize exactly to canonical JSON plus a trailing newline.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { Sha256Digest } from './intervention-control.ts';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;

const SUBJECT_KINDS = [
  'human-resolution-grant',
  'collaboration-grant',
  'harness-maintenance-grant',
] as const;

export const HUMAN_REVOCATION_SIGNATURE_NAMESPACE =
  'workflow.human-revocation.v1';

export type HumanRevocationSubjectKind = (typeof SUBJECT_KINDS)[number];

export type HumanRevocationAuditBinding = Readonly<{
  externalAuditRoot: string;
  repositoryId: Sha256Digest;
}>;

export type HumanRevocationBinding = Readonly<{
  subjectKind: HumanRevocationSubjectKind;
  grantId: string;
  grantDigest: Sha256Digest;
  repositoryId: string;
  repositoryOrigin: string;
  changeId: string;
  taskId: string | null;
  workflowId: string | null;
  audit: HumanRevocationAuditBinding | null;
}>;

export type HumanRevocationAuthorizationPayload = Readonly<{
  schemaVersion: 1;
  kind: 'human-revocation-authorization.v1';
  subjectKind: HumanRevocationSubjectKind;
  grantId: string;
  grantDigest: Sha256Digest;
  repositoryId: string;
  repositoryOrigin: string;
  changeId: string;
  taskId: string | null;
  workflowId: string | null;
  audit: HumanRevocationAuditBinding | null;
  reason: string;
  revokedAt: string;
  signer: string;
}>;

export type HumanRevocationAuthorization = Readonly<{
  payload: HumanRevocationAuthorizationPayload;
  signatureNamespace: typeof HUMAN_REVOCATION_SIGNATURE_NAMESPACE;
  signature: string;
}>;

export function digestHumanRevocationSubject(bytes: string): Sha256Digest {
  return digest(bytes);
}

export function canonicalHumanRevocationAuthorizationPayload(
  payload: HumanRevocationAuthorizationPayload,
): string {
  return `${canonicalJson(assertPayload(payload))}\n`;
}

export function canonicalHumanRevocationAuthorization(
  authorization: HumanRevocationAuthorization,
): string {
  const checked = assertHumanRevocationAuthorization(authorization);
  return `${canonicalJson(checked)}\n`;
}

export function parseHumanRevocationAuthorization(
  raw: string,
): HumanRevocationAuthorization {
  if (
    typeof raw !== 'string' ||
    !raw.endsWith('\n') ||
    Buffer.byteLength(raw) > 64 * 1024
  ) {
    throw invalidRevocation();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidRevocation();
  }
  const checked = assertHumanRevocationAuthorization(value);
  if (`${canonicalJson(checked)}\n` !== raw) throw invalidRevocation();
  return checked;
}

export function assertHumanRevocationAuthorization(
  value: unknown,
): HumanRevocationAuthorization {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'signatureNamespace', 'signature']) ||
    value.signatureNamespace !== HUMAN_REVOCATION_SIGNATURE_NAMESPACE ||
    typeof value.signature !== 'string' ||
    value.signature.length === 0 ||
    value.signature.length > 16_384 ||
    value.signature.includes('\r')
  ) {
    throw invalidRevocation();
  }
  return deepFreeze({
    payload: assertPayload(value.payload),
    signatureNamespace: HUMAN_REVOCATION_SIGNATURE_NAMESPACE,
    signature: value.signature,
  });
}

export function humanRevocationSignatureNamespace(
  authorization: HumanRevocationAuthorization,
): typeof HUMAN_REVOCATION_SIGNATURE_NAMESPACE {
  if (
    authorization.signatureNamespace === HUMAN_REVOCATION_SIGNATURE_NAMESPACE
  ) {
    return authorization.signatureNamespace;
  }
  throw invalidRevocation();
}

export function assertAuthorizationBinding(
  authorization: HumanRevocationAuthorization,
  binding: HumanRevocationBinding,
  reason: string,
): HumanRevocationAuthorization {
  const checked = assertHumanRevocationAuthorization(authorization);
  const observed = checked.payload;
  if (
    observed.reason !== reason ||
    canonicalJson({
      subjectKind: observed.subjectKind,
      grantId: observed.grantId,
      grantDigest: observed.grantDigest,
      repositoryId: observed.repositoryId,
      repositoryOrigin: observed.repositoryOrigin,
      changeId: observed.changeId,
      taskId: observed.taskId,
      workflowId: observed.workflowId,
      audit: observed.audit,
    }) !== canonicalJson(binding)
  ) {
    throw revocationConflict();
  }
  return checked;
}

export function assertBinding(value: unknown): HumanRevocationBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'subjectKind',
      'grantId',
      'grantDigest',
      'repositoryId',
      'repositoryOrigin',
      'changeId',
      'taskId',
      'workflowId',
      'audit',
    ]) ||
    !SUBJECT_KINDS.includes(value.subjectKind as HumanRevocationSubjectKind) ||
    !validSubject(value.grantId) ||
    !SHA256.test(String(value.grantDigest)) ||
    !validSubject(value.repositoryId) ||
    typeof value.repositoryOrigin !== 'string' ||
    value.repositoryOrigin.length === 0 ||
    value.repositoryOrigin.length > 2048 ||
    !validSubject(value.changeId) ||
    !validNullableSubject(value.taskId) ||
    !validNullableSubject(value.workflowId)
  ) {
    throw invalidRevocation();
  }
  let audit: HumanRevocationAuditBinding | null = null;
  if (value.audit !== null) {
    if (
      !isRecord(value.audit) ||
      !hasExactKeys(value.audit, ['externalAuditRoot', 'repositoryId']) ||
      typeof value.audit.externalAuditRoot !== 'string' ||
      !path.isAbsolute(value.audit.externalAuditRoot) ||
      path.normalize(value.audit.externalAuditRoot) !==
        value.audit.externalAuditRoot ||
      !SHA256.test(String(value.audit.repositoryId))
    ) {
      throw invalidRevocation();
    }
    audit = Object.freeze({
      externalAuditRoot: value.audit.externalAuditRoot,
      repositoryId: value.audit.repositoryId as Sha256Digest,
    });
  }
  return deepFreeze({
    subjectKind: value.subjectKind as HumanRevocationSubjectKind,
    grantId: value.grantId,
    grantDigest: value.grantDigest as Sha256Digest,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    changeId: value.changeId,
    taskId: value.taskId as string | null,
    workflowId: value.workflowId as string | null,
    audit,
  });
}

export function assertPayload(
  value: unknown,
): HumanRevocationAuthorizationPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'subjectKind',
      'grantId',
      'grantDigest',
      'repositoryId',
      'repositoryOrigin',
      'changeId',
      'taskId',
      'workflowId',
      'audit',
      'reason',
      'revokedAt',
      'signer',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-revocation-authorization.v1'
  ) {
    throw invalidRevocation();
  }
  const binding = assertBinding({
    subjectKind: value.subjectKind,
    grantId: value.grantId,
    grantDigest: value.grantDigest,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    changeId: value.changeId,
    taskId: value.taskId,
    workflowId: value.workflowId,
    audit: value.audit,
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: 'human-revocation-authorization.v1',
    ...structuredClone(binding),
    reason: boundedText(value.reason, 1024, 'reason'),
    revokedAt: exactTimestamp(value.revokedAt),
    signer: boundedText(value.signer, 192, 'signer'),
  });
}

function validSubject(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT.test(value);
}

function validNullableSubject(value: unknown): value is string | null {
  return value === null || validSubject(value);
}

export function boundedText(
  value: unknown,
  max: number,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > max ||
    containsControlCharacter(value)
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_INVALID',
      `Human revocation ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

export function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalidRevocation();
  return date;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw invalidRevocation();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw invalidRevocation();
  }
  return value;
}

export function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function invalidRevocation() {
  return workflowError(
    'HUMAN_REVOCATION_INVALID',
    'Human revocation authorization is invalid or unsafe.',
    ExitCode.guard,
  );
}

export function revocationConflict() {
  return workflowError(
    'HUMAN_REVOCATION_CONFLICT',
    'The grant already has a different durable revocation authorization.',
    ExitCode.conflict,
  );
}
