/** Canonical values and identity checks for retained intervention metadata. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { Sha256Digest } from '../../modules/authority/intervention-control.ts';
import { MAX_RECORD_BYTES } from './intervention-persistence-contracts.ts';

export function serializeRecord(value: unknown): string {
  const serialized = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
    throw workflowError(
      'INTERVENTION_PERSISTENCE_RECORD_TOO_LARGE',
      'Persistence record exceeds the four-megabyte limit.',
      ExitCode.guard,
    );
  }
  return serialized;
}

export function withRecordDigest<T extends Record<string, unknown>>(
  payload: T,
): T & { recordDigest: Sha256Digest } {
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

export function verifyRecordDigest(value: Record<string, unknown>): boolean {
  if (!isDigest(value.recordDigest)) {
    return false;
  }
  const { recordDigest, ...payload } = value;
  return canonicalDigest(payload) === recordDigest;
}

export function canonicalDigest(value: unknown): Sha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

export function identityFileName(kind: string, identity: string): string {
  if (
    typeof identity !== 'string' ||
    identity.trim() !== identity ||
    identity.length === 0
  ) {
    throw workflowError(
      'INTERVENTION_PERSISTENCE_ID_INVALID',
      'Persistence identity must be a non-empty trimmed string.',
      ExitCode.usage,
    );
  }
  return crypto
    .createHash('sha256')
    .update(`${kind}\0${identity}`)
    .digest('hex');
}

export function assertAbsoluteWorkspacePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value === path.parse(value).root
  ) {
    throw workflowError(
      'INTERVENTION_CHILD_WORKSPACE_PATH_INVALID',
      'Workspace path must be an explicit normalized absolute path.',
      ExitCode.usage,
    );
  }
  return value;
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

export function assertSafeChangeRef(value: string): void {
  const hasControlOrSpace =
    typeof value === 'string' &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    });
  if (
    typeof value !== 'string' ||
    !value.startsWith('refs/heads/') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('\\') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.lock') ||
    hasControlOrSpace ||
    /[~^:?*[\]]/.test(value)
  ) {
    throw workflowError(
      'INTERVENTION_CHILD_WORKSPACE_REF_INVALID',
      'Child workspace metadata requires a safe branch ref.',
      ExitCode.usage,
    );
  }
}

export function exactDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      code,
      'Persistence clock is invalid.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(value.getTime());
}

export function exactIso(value: string, code: string): void {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw workflowError(
      code,
      'Stored timestamp is invalid.',
      ExitCode.verification,
    );
  }
}

export function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (!isDigest(value)) {
    throw workflowError(
      code,
      'Expected a canonical sha256 digest.',
      ExitCode.usage,
    );
  }
}

export function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function corruptPersistenceRecord() {
  return workflowError(
    'INTERVENTION_PERSISTENCE_RECORD_CORRUPT',
    'Persisted intervention record failed integrity verification.',
    ExitCode.verification,
  );
}

export function unsafePersistenceLock() {
  return workflowError(
    'INTERVENTION_PERSISTENCE_LOCK_UNSAFE',
    'Persistence operation lock is unsafe.',
    ExitCode.unsafeEnvironment,
  );
}
