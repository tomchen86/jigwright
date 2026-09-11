/**
 * Validates recovery authority descriptors against their canonical payload
 * and external expectations.
 *
 * Invariants:
 * - A descriptor is accepted only when its descriptorDigest equals the
 *   sha256 of its canonical payload.
 * - assertRecoveryAuthorityDomain rejects any namespace that is not a known
 *   recovery domain or not listed in the descriptor's allowedDomains.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

/**
 * Phase-one fail-closed substrate only. This module never discovers authority
 * from a checkout, provisions an authority automatically, rotates an existing
 * authority, or connects the descriptor to a production launcher.
 */
export const MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES = 64 * 1024;

/**
 * The legacy Recovery Grant namespace remains rollback-only. Every new
 * recovery effect has its own signature domain so that a signature cannot be
 * replayed merely by changing an operation discriminator.
 */
export const RECOVERY_AUTHORITY_KNOWN_DOMAINS = Object.freeze([
  'HARNESS_RECOVERY_ENTER_QUARANTINE_V1',
  'HARNESS_RECOVERY_GRANT_V1',
  'HARNESS_RECOVERY_RELEASE_QUARANTINE_V1',
  'HARNESS_RECOVERY_RESTORE_OPERATIONAL_TRUST_ROOT_V1',
  'HARNESS_RECOVERY_SUPERSEDE_WORKFLOW_V1',
] as const);

export type RecoveryAuthorityDomain =
  (typeof RECOVERY_AUTHORITY_KNOWN_DOMAINS)[number];

export type RecoveryAuthoritySha256Digest = `sha256:${string}`;

export interface RecoveryAuthorityRepositoryIdentityV1 {
  repositoryId: string;
  origin: string;
  gitObjectFormat: 'sha1' | 'sha256';
}

export interface RecoveryAuthoritySealedRuntimeBindingV1 {
  artifactId: RecoveryAuthoritySha256Digest;
  executableDigest: RecoveryAuthoritySha256Digest;
  closureDigest: RecoveryAuthoritySha256Digest;
  protocolVersion: number;
}

export interface RecoveryAuthorityAuditBindingV1 {
  ledgerId: string;
  rootBindingDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryAuthoritySignerV1 {
  identity: string;
  publicKey: string;
  fingerprint: string;
}

export interface RecoveryAuthorityDescriptorPayloadV1 {
  kind: 'harness-recovery-authority.v1';
  repositoryIdentity: RecoveryAuthorityRepositoryIdentityV1;
  repositoryIdentityDigest: RecoveryAuthoritySha256Digest;
  generation: number;
  signer: RecoveryAuthoritySignerV1;
  allowedDomains: RecoveryAuthorityDomain[];
  sealedRuntime: RecoveryAuthoritySealedRuntimeBindingV1;
  auditLedger: RecoveryAuthorityAuditBindingV1;
  createdAt: string;
}

export interface RecoveryAuthorityDescriptorV1 extends RecoveryAuthorityDescriptorPayloadV1 {
  descriptorDigest: RecoveryAuthoritySha256Digest;
}

/**
 * Every expectation is supplied by the sealed bootstrap/out-of-band ceremony.
 * No API in this module accepts a repository root or consults Git/HEAD.
 */
export interface RecoveryAuthorityExpectations {
  repositoryIdentity: RecoveryAuthorityRepositoryIdentityV1;
  generation: number;
  signerFingerprint: string;
  sealedRuntime: RecoveryAuthoritySealedRuntimeBindingV1;
  auditLedger: RecoveryAuthorityAuditBindingV1;
  descriptorDigest: RecoveryAuthoritySha256Digest;
}

export interface RecoveryAuthorityImportBoundary {
  repositoryWorktreeRoot: string;
  gitCommonDirectory: string;
}

export type RecoveryAuthorityImportPhase =
  'prepare-prefix-written' | 'prepare-fsynced' | 'prepared' | 'published';

/** Deterministic crash injection for integration assurance only. */
export interface RecoveryAuthorityImportHooks {
  afterPhase(phase: RecoveryAuthorityImportPhase): void;
}

export const PRIVATE_DIRECTORY_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

export const PREPARED_DESCRIPTOR_NAME = 'descriptor.prepare.json';

export const PREPARATION_FILE =
  /^descriptor\.prepare\.([0-9a-f]{64})\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

const DESCRIPTOR_KEYS = [
  'allowedDomains',
  'auditLedger',
  'createdAt',
  'descriptorDigest',
  'generation',
  'kind',
  'repositoryIdentity',
  'repositoryIdentityDigest',
  'sealedRuntime',
  'signer',
] as const;

const PAYLOAD_KEYS = DESCRIPTOR_KEYS.filter(
  (key) => key !== 'descriptorDigest',
);

const REPOSITORY_KEYS = ['gitObjectFormat', 'origin', 'repositoryId'] as const;

const SIGNER_KEYS = ['fingerprint', 'identity', 'publicKey'] as const;

const RUNTIME_KEYS = [
  'artifactId',
  'closureDigest',
  'executableDigest',
  'protocolVersion',
] as const;

const AUDIT_KEYS = ['ledgerId', 'rootBindingDigest'] as const;

const EXPECTATION_KEYS = [
  'auditLedger',
  'descriptorDigest',
  'generation',
  'repositoryIdentity',
  'sealedRuntime',
  'signerFingerprint',
] as const;

export const IMPORT_BOUNDARY_KEYS = [
  'gitCommonDirectory',
  'repositoryWorktreeRoot',
] as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const REPOSITORY_ID = /^github:[A-Za-z0-9_.:/-]{1,500}$/;

const REPOSITORY_ORIGIN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

const SIGNER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

const SSH_PUBLIC_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;

const LEDGER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function recoveryAuthorityRepositoryIdentityDigest(
  repositoryIdentity: RecoveryAuthorityRepositoryIdentityV1,
): RecoveryAuthoritySha256Digest {
  const normalized = normalizeRepositoryIdentity(repositoryIdentity);
  return canonicalDigest({
    kind: 'recovery-authority-repository-identity.v1',
    ...normalized,
  });
}

export function recoveryAuthorityDescriptorDigest(
  payload: RecoveryAuthorityDescriptorPayloadV1,
): RecoveryAuthoritySha256Digest {
  return canonicalDigest(normalizePayload(payload));
}

/** Parse schema and intrinsic digests. Parsing alone does not establish trust. */
export function parseRecoveryAuthorityDescriptor(
  value: unknown,
): RecoveryAuthorityDescriptorV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, DESCRIPTOR_KEYS) ||
    !isDigest(value.descriptorDigest)
  ) {
    throw descriptorInvalid();
  }
  const { descriptorDigest, ...rawPayload } = value;
  const payload = normalizePayload(rawPayload);
  const expectedDigest = canonicalDigest(payload);
  if (descriptorDigest !== expectedDigest) throw descriptorInvalid();
  return deepFreeze({
    ...payload,
    descriptorDigest: expectedDigest,
  });
}

/**
 * Verify a descriptor against independently supplied expectations. Callers
 * must not populate these expectations from the descriptor being verified.
 */
export function verifyRecoveryAuthorityDescriptor(
  value: unknown,
  expected: RecoveryAuthorityExpectations,
): RecoveryAuthorityDescriptorV1 {
  const descriptor = parseRecoveryAuthorityDescriptor(value);
  const pinned = normalizeExpectations(expected);
  const repositoryIdentity = pinned.repositoryIdentity;
  if (
    canonicalJson(descriptor.repositoryIdentity) !==
      canonicalJson(repositoryIdentity) ||
    descriptor.repositoryIdentityDigest !==
      recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_REPOSITORY_MISMATCH',
      'Recovery authority belongs to a different out-of-band repository identity.',
      ExitCode.staleState,
    );
  }
  if (descriptor.generation !== pinned.generation) {
    throw authorityError(
      'RECOVERY_AUTHORITY_GENERATION_MISMATCH',
      'Recovery authority generation differs from the out-of-band expectation.',
      ExitCode.staleState,
    );
  }
  if (descriptor.signer.fingerprint !== pinned.signerFingerprint) {
    throw authorityError(
      'RECOVERY_AUTHORITY_SIGNER_FINGERPRINT_MISMATCH',
      'Recovery authority signer fingerprint differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  if (
    canonicalJson(descriptor.sealedRuntime) !==
    canonicalJson(pinned.sealedRuntime)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_RUNTIME_MISMATCH',
      'Recovery authority sealed runtime binding differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  if (
    canonicalJson(descriptor.auditLedger) !== canonicalJson(pinned.auditLedger)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_AUDIT_BINDING_MISMATCH',
      'Recovery authority audit binding differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  if (descriptor.descriptorDigest !== pinned.descriptorDigest) {
    throw authorityError(
      'RECOVERY_AUTHORITY_DESCRIPTOR_DIGEST_MISMATCH',
      'Recovery authority descriptor digest differs from the out-of-band expectation.',
      ExitCode.verification,
    );
  }
  return descriptor;
}

/**
 * Check the exact signature-domain/fingerprint pair after descriptor
 * verification. This function does not verify a grant signature itself.
 */
export function assertRecoveryAuthorityDomain(
  descriptor: RecoveryAuthorityDescriptorV1,
  expected: RecoveryAuthorityExpectations,
  namespace: string,
  signerFingerprint: string,
): void {
  const exact = verifyRecoveryAuthorityDescriptor(descriptor, expected);
  if (exact.signer.fingerprint !== signerFingerprint) {
    throw authorityError(
      'RECOVERY_AUTHORITY_SIGNER_FINGERPRINT_MISMATCH',
      'Recovery signature signer differs from the pinned recovery authority.',
      ExitCode.verification,
    );
  }
  if (
    typeof namespace !== 'string' ||
    !(RECOVERY_AUTHORITY_KNOWN_DOMAINS as readonly string[]).includes(
      namespace,
    ) ||
    !exact.allowedDomains.includes(namespace as RecoveryAuthorityDomain)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_DOMAIN_FORBIDDEN',
      'Recovery authority cannot be replayed into this signature domain.',
      ExitCode.guard,
    );
  }
}

function normalizePayload(
  value: unknown,
): RecoveryAuthorityDescriptorPayloadV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    value.kind !== 'harness-recovery-authority.v1' ||
    !isDigest(value.repositoryIdentityDigest) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !Array.isArray(value.allowedDomains) ||
    !isAllowedDomainSubset(value.allowedDomains) ||
    typeof value.createdAt !== 'string' ||
    !isExactIso(value.createdAt)
  ) {
    throw descriptorInvalid();
  }
  const repositoryIdentity = normalizeRepositoryIdentity(
    value.repositoryIdentity,
  );
  if (
    value.repositoryIdentityDigest !==
    recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity)
  ) {
    throw descriptorInvalid();
  }
  return {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity,
    repositoryIdentityDigest: value.repositoryIdentityDigest,
    generation: value.generation as number,
    signer: normalizeSigner(value.signer),
    allowedDomains: [...value.allowedDomains] as RecoveryAuthorityDomain[],
    sealedRuntime: normalizeSealedRuntime(value.sealedRuntime),
    auditLedger: normalizeAuditLedger(value.auditLedger),
    createdAt: value.createdAt,
  };
}

function normalizeRepositoryIdentity(
  value: unknown,
): RecoveryAuthorityRepositoryIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REPOSITORY_KEYS) ||
    typeof value.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(value.repositoryId) ||
    typeof value.origin !== 'string' ||
    !REPOSITORY_ORIGIN.test(value.origin) ||
    (value.gitObjectFormat !== 'sha1' && value.gitObjectFormat !== 'sha256')
  ) {
    throw descriptorInvalid();
  }
  return {
    repositoryId: value.repositoryId,
    origin: value.origin,
    gitObjectFormat: value.gitObjectFormat,
  };
}

function normalizeSigner(value: unknown): RecoveryAuthoritySignerV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SIGNER_KEYS) ||
    typeof value.identity !== 'string' ||
    !SIGNER_IDENTITY.test(value.identity) ||
    typeof value.publicKey !== 'string' ||
    !SSH_PUBLIC_KEY.test(value.publicKey) ||
    typeof value.fingerprint !== 'string' ||
    !SSH_FINGERPRINT.test(value.fingerprint) ||
    sshPublicKeyFingerprint(value.publicKey) !== value.fingerprint
  ) {
    throw descriptorInvalid();
  }
  return {
    identity: value.identity,
    publicKey: value.publicKey,
    fingerprint: value.fingerprint,
  };
}

function normalizeSealedRuntime(
  value: unknown,
): RecoveryAuthoritySealedRuntimeBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RUNTIME_KEYS) ||
    !isDigest(value.artifactId) ||
    !isDigest(value.executableDigest) ||
    !isDigest(value.closureDigest) ||
    !Number.isSafeInteger(value.protocolVersion) ||
    (value.protocolVersion as number) < 1
  ) {
    throw descriptorInvalid();
  }
  return {
    artifactId: value.artifactId,
    executableDigest: value.executableDigest,
    closureDigest: value.closureDigest,
    protocolVersion: value.protocolVersion as number,
  };
}

function normalizeAuditLedger(value: unknown): RecoveryAuthorityAuditBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, AUDIT_KEYS) ||
    typeof value.ledgerId !== 'string' ||
    !LEDGER_ID.test(value.ledgerId) ||
    !isDigest(value.rootBindingDigest)
  ) {
    throw descriptorInvalid();
  }
  return {
    ledgerId: value.ledgerId,
    rootBindingDigest: value.rootBindingDigest,
  };
}

function normalizeExpectations(value: unknown): RecoveryAuthorityExpectations {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, EXPECTATION_KEYS) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.signerFingerprint !== 'string' ||
    !SSH_FINGERPRINT.test(value.signerFingerprint) ||
    !isDigest(value.descriptorDigest)
  ) {
    throw expectationInvalid();
  }
  try {
    return {
      repositoryIdentity: normalizeRepositoryIdentity(value.repositoryIdentity),
      generation: value.generation as number,
      signerFingerprint: value.signerFingerprint,
      sealedRuntime: normalizeSealedRuntime(value.sealedRuntime),
      auditLedger: normalizeAuditLedger(value.auditLedger),
      descriptorDigest: value.descriptorDigest,
    };
  } catch (error) {
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_DESCRIPTOR_INVALID')) {
      throw expectationInvalid();
    }
    throw error;
  }
}

function isAllowedDomainSubset(value: unknown[]): boolean {
  const known = RECOVERY_AUTHORITY_KNOWN_DOMAINS as readonly string[];
  if (
    value.length === 0 ||
    value.some(
      (domain) => typeof domain !== 'string' || !known.includes(domain),
    )
  ) {
    return false;
  }
  const sortedUnique = [...new Set(value)].sort();
  return (
    value.length === sortedUnique.length &&
    value.every((domain, index) => domain === sortedUnique[index])
  );
}

function sshPublicKeyFingerprint(publicKey: string): string {
  const [algorithm, encoded, ...extra] = publicKey.split(' ');
  if (!algorithm || !encoded || extra.length !== 0) throw descriptorInvalid();
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, 'base64');
  } catch {
    throw descriptorInvalid();
  }
  if (
    blob.length < 5 ||
    blob.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    throw descriptorInvalid();
  }
  const algorithmLength = blob.readUInt32BE(0);
  if (
    algorithmLength === 0 ||
    algorithmLength > blob.length - 4 ||
    blob.subarray(4, 4 + algorithmLength).toString('ascii') !== algorithm
  ) {
    throw descriptorInvalid();
  }
  return `SHA256:${crypto
    .createHash('sha256')
    .update(blob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function isExactIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function canonicalDigest(value: unknown): RecoveryAuthoritySha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function isDigest(value: unknown): value is RecoveryAuthoritySha256Digest {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function descriptorInvalid() {
  return authorityError(
    'RECOVERY_AUTHORITY_DESCRIPTOR_INVALID',
    'Recovery Authority Descriptor does not match its exact schema or intrinsic bindings.',
    ExitCode.verification,
  );
}

function expectationInvalid() {
  return authorityError(
    'RECOVERY_AUTHORITY_EXPECTATION_INVALID',
    'Recovery authority requires complete exact out-of-band expectations.',
    ExitCode.unsafeEnvironment,
  );
}

export function replacementForbidden() {
  return authorityError(
    'RECOVERY_AUTHORITY_REPLACEMENT_FORBIDDEN',
    'An imported Recovery Authority cannot authorize or overwrite its own replacement.',
    ExitCode.guard,
  );
}

export function preparationIncomplete() {
  return authorityError(
    'RECOVERY_AUTHORITY_PREPARATION_INCOMPLETE',
    'Recovery Authority preparation is incomplete.',
    ExitCode.unsafeEnvironment,
  );
}

export function storeUnsafe() {
  return authorityError(
    'RECOVERY_AUTHORITY_STORE_UNSAFE',
    'Recovery Authority private store is unavailable or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}

export function storeCorrupt() {
  return authorityError(
    'RECOVERY_AUTHORITY_STORE_CORRUPT',
    'Recovery Authority private store failed integrity verification.',
    ExitCode.verification,
  );
}

export function authorityError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}

export function hasWorkflowCode(error: unknown, code?: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    (code === undefined || error.code === code)
  );
}

export function isNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
