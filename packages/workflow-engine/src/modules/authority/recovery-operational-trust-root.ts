/**
 * Normalizes the operational trust root and its trusted maintainer signer
 * identities.
 *
 * Invariants:
 * - normalizeRoot rejects any root whose rootDigest does not equal the
 *   recomputed canonicalDigest of its payload.
 * - Each signer's fingerprint must equal the SHA256 fingerprint recomputed
 *   from its SSH public-key blob.
 */
import crypto from 'node:crypto';
import { ExitCode } from '../../foundation/errors/errors.ts';
import type { RecoveryAuthoritySha256Digest } from './recovery-authority-contract.ts';
import {
  canonicalDigest,
  isRecord,
  hasExactKeys,
  isDigest,
  deepFreeze,
  isIdentifier,
  isPositiveInteger,
  exactIso,
  SSH_PUBLIC_KEY,
  FINGERPRINT,
  restoreError,
} from './recovery-trust-root-values.ts';

const ROOT_PAYLOAD_KEYS = [
  'createdAt',
  'generation',
  'kind',
  'purpose',
  'repositoryId',
  'signatureNamespace',
  'trustedSigners',
] as const;

const ROOT_KEYS = [...ROOT_PAYLOAD_KEYS, 'rootDigest'] as const;

const SIGNER_KEYS = ['fingerprint', 'identity', 'publicKey'] as const;

export interface RecoveryOperationalTrustSigner {
  identity: string;
  publicKey: string;
  fingerprint: string;
}

export interface RecoveryOperationalTrustRootPayload {
  kind: 'recovery-operational-trust-root.v1';
  repositoryId: string;
  generation: number;
  purpose: 'workflow-maintainer-signatures';
  signatureNamespace: 'workflow.maintainer-grant.v1';
  trustedSigners: RecoveryOperationalTrustSigner[];
  createdAt: string;
}

export interface RecoveryOperationalTrustRoot extends RecoveryOperationalTrustRootPayload {
  rootDigest: RecoveryAuthoritySha256Digest;
}

export function recoveryOperationalTrustRootDigest(
  value: RecoveryOperationalTrustRootPayload,
): RecoveryAuthoritySha256Digest {
  return canonicalDigest(normalizeRootPayload(value));
}

export function normalizeRoot(value: unknown): RecoveryOperationalTrustRoot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_KEYS) ||
    !isDigest(value.rootDigest)
  ) {
    throw rootInvalid();
  }
  const { rootDigest, ...rawPayload } = value;
  const payload = normalizeRootPayload(rawPayload);
  const expected = canonicalDigest(payload);
  if (rootDigest !== expected) throw rootInvalid();
  return deepFreeze({ ...payload, rootDigest: expected });
}

function normalizeRootPayload(
  value: unknown,
): RecoveryOperationalTrustRootPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_PAYLOAD_KEYS) ||
    value.kind !== 'recovery-operational-trust-root.v1' ||
    !isIdentifier(value.repositoryId) ||
    !isPositiveInteger(value.generation) ||
    value.purpose !== 'workflow-maintainer-signatures' ||
    value.signatureNamespace !== 'workflow.maintainer-grant.v1' ||
    !Array.isArray(value.trustedSigners) ||
    value.trustedSigners.length === 0 ||
    value.trustedSigners.length > 64
  ) {
    throw rootInvalid();
  }
  const trustedSigners = value.trustedSigners.map(normalizeSigner);
  const sorted = [...trustedSigners].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
  if (
    trustedSigners.some(
      (signer, index) => signer.identity !== sorted[index]?.identity,
    ) ||
    new Set(trustedSigners.map(({ identity }) => identity)).size !==
      trustedSigners.length ||
    new Set(trustedSigners.map(({ publicKey }) => publicKey)).size !==
      trustedSigners.length ||
    new Set(trustedSigners.map(({ fingerprint }) => fingerprint)).size !==
      trustedSigners.length
  ) {
    throw rootInvalid();
  }
  return deepFreeze({
    kind: 'recovery-operational-trust-root.v1',
    repositoryId: value.repositoryId,
    generation: value.generation,
    purpose: 'workflow-maintainer-signatures',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    trustedSigners,
    createdAt: exactIso(value.createdAt),
  });
}

function normalizeSigner(value: unknown): RecoveryOperationalTrustSigner {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SIGNER_KEYS) ||
    !isIdentifier(value.identity) ||
    typeof value.publicKey !== 'string' ||
    !SSH_PUBLIC_KEY.test(value.publicKey) ||
    typeof value.fingerprint !== 'string' ||
    !FINGERPRINT.test(value.fingerprint) ||
    publicKeyFingerprint(value.publicKey) !== value.fingerprint
  ) {
    throw rootInvalid();
  }
  return deepFreeze({
    identity: value.identity,
    publicKey: value.publicKey,
    fingerprint: value.fingerprint,
  });
}

function publicKeyFingerprint(publicKey: string): string {
  const [algorithm, encoded, ...rest] = publicKey.split(' ');
  if (algorithm === undefined || encoded === undefined || rest.length !== 0) {
    throw rootInvalid();
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, 'base64');
  } catch {
    throw rootInvalid();
  }
  if (
    blob.length < 5 ||
    blob.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    throw rootInvalid();
  }
  const algorithmLength = blob.readUInt32BE(0);
  if (
    algorithmLength === 0 ||
    algorithmLength > blob.length - 4 ||
    blob.subarray(4, 4 + algorithmLength).toString('ascii') !== algorithm
  ) {
    throw rootInvalid();
  }
  return `SHA256:${crypto
    .createHash('sha256')
    .update(blob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function rootInvalid() {
  return restoreError(
    'RECOVERY_TRUST_ROOT_REPLACEMENT_INVALID',
    'Operational trust-root replacement does not match its exact schema or digest.',
    ExitCode.guard,
  );
}
