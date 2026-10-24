/** Exact external-effect request, payload and envelope codecs. */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';

import {
  EXTERNAL_EFFECT_MAX_TTL_SECONDS,
  UUID_V4,
  DIGEST,
  RAW_DIGEST,
  COMMIT_OID,
  TASK_ID,
  REF_NAME,
  SIMPLE_NAME,
  IDEMPOTENCY_KEY,
  EFFECT_KINDS,
  type Sha256Digest,
  type ExternalEffectKind,
  type ExternalEffectTarget,
  type ExternalEffectRollbackPlan,
  type ExternalEffectGrantRequest,
  type ExternalEffectGrantPayload,
  type ExternalEffectGrantEnvelope,
  PAYLOAD_KEYS,
  isTimestamp,
  assertSignature,
  hasExactKeys,
  invalidGrant,
} from './external-effect-grant.ts';

export function parseRequest(request: ExternalEffectGrantRequest) {
  const hasOwnTtlSeconds = Object.hasOwn(request, 'ttlSeconds');
  if (
    !isPlainOwnDataRecord(request) ||
    !hasExactKeys(request, [
      'mandateBinding',
      'effectKind',
      'target',
      'artifactDigest',
      'prestateDigest',
      'rollbackPlan',
      ...(hasOwnTtlSeconds ? ['ttlSeconds'] : []),
      'idempotencyKey',
    ]) ||
    !isRecord(request.mandateBinding) ||
    !hasExactKeys(request.mandateBinding, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    request.mandateBinding.schemaVersion !== 1 ||
    typeof request.mandateBinding.mandateTaskId !== 'string' ||
    !TASK_ID.test(request.mandateBinding.mandateTaskId) ||
    typeof request.mandateBinding.mandateId !== 'string' ||
    !UUID_V4.test(request.mandateBinding.mandateId) ||
    typeof request.mandateBinding.mandateDigest !== 'string' ||
    !RAW_DIGEST.test(request.mandateBinding.mandateDigest) ||
    typeof request.mandateBinding.changeId !== 'string' ||
    request.mandateBinding.changeId.length < 1 ||
    request.mandateBinding.changeId.length > 128 ||
    typeof request.mandateBinding.externalAuditRoot !== 'string' ||
    !path.isAbsolute(request.mandateBinding.externalAuditRoot) ||
    !EFFECT_KINDS.includes(request.effectKind as ExternalEffectKind) ||
    !DIGEST.test(String(request.artifactDigest)) ||
    !DIGEST.test(String(request.prestateDigest)) ||
    typeof request.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(request.idempotencyKey) ||
    (hasOwnTtlSeconds && typeof request.ttlSeconds !== 'number')
  ) {
    throw invalidGrant();
  }
  const target = parseTarget(request.target);
  const effectKind = request.effectKind as ExternalEffectKind;
  if (
    ((effectKind === 'publish-git-ref' ||
      effectKind === 'force-push-git-ref') &&
      target.kind !== 'git-ref') ||
    (effectKind !== 'publish-git-ref' &&
      effectKind !== 'force-push-git-ref' &&
      target.kind !== 'external-resource')
  ) {
    throw invalidGrant();
  }
  return {
    mandateBinding: {
      schemaVersion: 1 as const,
      mandateTaskId: request.mandateBinding.mandateTaskId,
      mandateId: request.mandateBinding.mandateId,
      mandateDigest: request.mandateBinding.mandateDigest,
      changeId: request.mandateBinding.changeId,
      externalAuditRoot: request.mandateBinding.externalAuditRoot,
    },
    effectKind,
    target,
    artifactDigest: request.artifactDigest as Sha256Digest,
    prestateDigest: request.prestateDigest as Sha256Digest,
    rollbackPlan: parseRollback(request.rollbackPlan),
    ttlSeconds: hasOwnTtlSeconds ? request.ttlSeconds : undefined,
    idempotencyKey: request.idempotencyKey,
  };
}

export function isPlainOwnDataRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        'value' in descriptor &&
        descriptor.enumerable === true
      );
    });
  } catch {
    return false;
  }
}

export function parsePayload(value: unknown): ExternalEffectGrantPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    value.kind !== 'external-effect-grant.v1' ||
    typeof value.grantId !== 'string' ||
    !UUID_V4.test(value.grantId) ||
    typeof value.repositoryId !== 'string' ||
    !/^github:[A-Za-z0-9_-]+$/.test(value.repositoryId) ||
    typeof value.repositoryOrigin !== 'string' ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      value.repositoryOrigin,
    ) ||
    typeof value.baseCommit !== 'string' ||
    !COMMIT_OID.test(value.baseCommit) ||
    typeof value.policyBlob !== 'string' ||
    !COMMIT_OID.test(value.policyBlob) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    value.externalAuditRoot.length > 4096 ||
    typeof value.changeId !== 'string' ||
    value.changeId.length < 1 ||
    value.changeId.length > 128 ||
    typeof value.mandateId !== 'string' ||
    !UUID_V4.test(value.mandateId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    typeof value.mandateDigest !== 'string' ||
    !RAW_DIGEST.test(value.mandateDigest) ||
    !EFFECT_KINDS.includes(value.effectKind as ExternalEffectKind) ||
    !DIGEST.test(String(value.artifactDigest)) ||
    !DIGEST.test(String(value.prestateDigest)) ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) >
      EXTERNAL_EFFECT_MAX_TTL_SECONDS * 1000 ||
    value.uses !== 1 ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.signer !== 'string' ||
    value.signer.length < 1 ||
    value.signer.length > 128
  ) {
    throw invalidGrant();
  }
  const target = parseTarget(value.target);
  const effectKind = value.effectKind as ExternalEffectKind;
  if (
    ((effectKind === 'publish-git-ref' ||
      effectKind === 'force-push-git-ref') &&
      target.kind !== 'git-ref') ||
    (effectKind !== 'publish-git-ref' &&
      effectKind !== 'force-push-git-ref' &&
      target.kind !== 'external-resource')
  ) {
    throw invalidGrant();
  }
  return {
    kind: 'external-effect-grant.v1',
    grantId: value.grantId,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    baseCommit: value.baseCommit,
    policyBlob: value.policyBlob,
    externalAuditRoot: value.externalAuditRoot,
    changeId: value.changeId,
    mandateId: value.mandateId,
    taskId: value.taskId,
    mandateDigest: value.mandateDigest,
    effectKind,
    target,
    artifactDigest: value.artifactDigest as Sha256Digest,
    prestateDigest: value.prestateDigest as Sha256Digest,
    rollbackPlan: parseRollback(value.rollbackPlan),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    uses: 1,
    idempotencyKey: value.idempotencyKey,
    signer: value.signer,
  };
}

export function parseEnvelope(value: unknown): ExternalEffectGrantEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    typeof value.signature !== 'string'
  ) {
    throw invalidGrant();
  }
  assertSignature(value.signature);
  return { payload: parsePayload(value.payload), signature: value.signature };
}

export function parseTarget(value: unknown): ExternalEffectTarget {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw invalidGrant();
  }
  if (value.kind === 'git-ref') {
    if (
      !hasExactKeys(value, [
        'kind',
        'remoteName',
        'remoteUrl',
        'refName',
        'sourceOid',
        'expectedRemoteOid',
      ]) ||
      typeof value.remoteName !== 'string' ||
      !SIMPLE_NAME.test(value.remoteName) ||
      typeof value.remoteUrl !== 'string' ||
      value.remoteUrl.length < 1 ||
      value.remoteUrl.length > 1024 ||
      /[\0\r\n]/.test(value.remoteUrl) ||
      typeof value.refName !== 'string' ||
      !REF_NAME.test(value.refName) ||
      typeof value.sourceOid !== 'string' ||
      !COMMIT_OID.test(value.sourceOid) ||
      (value.expectedRemoteOid !== null &&
        (typeof value.expectedRemoteOid !== 'string' ||
          !COMMIT_OID.test(value.expectedRemoteOid)))
    ) {
      throw invalidGrant();
    }
    return {
      kind: 'git-ref',
      remoteName: value.remoteName,
      remoteUrl: value.remoteUrl,
      refName: value.refName,
      sourceOid: value.sourceOid,
      expectedRemoteOid: value.expectedRemoteOid,
    };
  }
  if (
    value.kind === 'external-resource' &&
    hasExactKeys(value, ['kind', 'service', 'resource']) &&
    typeof value.service === 'string' &&
    SIMPLE_NAME.test(value.service) &&
    typeof value.resource === 'string' &&
    value.resource.length >= 1 &&
    value.resource.length <= 1024 &&
    !/[\0\r\n]/.test(value.resource)
  ) {
    return {
      kind: 'external-resource',
      service: value.service,
      resource: value.resource,
    };
  }
  throw invalidGrant();
}

export function parseRollback(
  value: unknown,
): ExternalEffectRollbackPlan | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'planDigest']) ||
    (value.kind !== 'restore-git-ref' && value.kind !== 'operator-procedure') ||
    typeof value.planDigest !== 'string' ||
    !DIGEST.test(value.planDigest)
  ) {
    throw invalidGrant();
  }
  return { kind: value.kind, planDigest: value.planDigest as Sha256Digest };
}

export function canonicalExternalEffectGrantPayload(
  payload: ExternalEffectGrantPayload,
): string {
  return `${canonicalJson(parsePayload(payload))}\n`;
}

export function canonicalExternalEffectGrantEnvelope(
  envelope: ExternalEffectGrantEnvelope,
): string {
  return `${canonicalJson(parseEnvelope(envelope))}\n`;
}

export function parseExternalEffectGrantEnvelope(
  raw: string,
): ExternalEffectGrantEnvelope {
  if (Buffer.byteLength(raw) > 16 * 1024) throw invalidGrant();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidGrant();
  }
  const envelope = parseEnvelope(value);
  if (canonicalExternalEffectGrantEnvelope(envelope) !== raw) {
    throw invalidGrant();
  }
  return envelope;
}
