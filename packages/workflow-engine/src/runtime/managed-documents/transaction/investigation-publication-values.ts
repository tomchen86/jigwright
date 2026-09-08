/**
 * Defines exact publication path, digest, and internal error primitives.
 *
 * Invariants:
 * - Canonical path spelling, digest bytes, and failure identity remain stable.
 * - Shared helpers perform no publication or recovery transition.
 *
 * Depends on: canonical JSON, workflow errors, and publication naming rules.
 * Failure modes: changed journal identities, unsafe path admission, or inconsistent publication failures.
 */
import { workflowError, ExitCode } from '../../../foundation/errors/errors.ts';
import path from 'node:path';
import type { InvestigationV3FailureCode } from '../../../modules/investigation/manifest/investigation-manifest.ts';
import crypto from 'node:crypto';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Publication roles are engine-owned lowercase-ASCII POSIX paths.
const PUBLICATION_PATH = /^[a-z0-9._/-]+$/u;

export function isBoundedPublicationPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4_096 &&
    !/[\0\r\n]/.test(value)
  );
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

export function publicationFailureSourceInvalid(message: string) {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_SOURCE_INVALID',
    message,
    ExitCode.guard,
  );
}

export function isCanonicalPublicationRelativePath(
  value: unknown,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !PUBLICATION_PATH.test(value) ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  return !value
    .split('/')
    .some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    );
}

export class PublicationFailure extends Error {
  readonly code: InvestigationV3FailureCode;

  constructor(code: InvestigationV3FailureCode, message: string) {
    super(message);
    this.name = 'PublicationFailure';
    this.code = code;
  }
}

export function publicationFailure(
  code: InvestigationV3FailureCode,
  message: string,
): PublicationFailure {
  return new PublicationFailure(code, message);
}

export function prefixedDigest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
