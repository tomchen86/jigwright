/**
 * Provides shared intervention value checks, signature namespaces and safe
 * verifier calls.
 *
 * Invariants:
 * - `verifyHumanSignatureSafely` wraps the injected verifier in try/catch
 *   and returns false on any thrown error.
 * - `assertSafePath` rejects any path with empty, '.', or '..' segments (as
 *   well as absolute, backslash, and non-NFC paths).
 */
import crypto from 'node:crypto';

import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type Sha256Digest = `sha256:${string}`;

export const HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE =
  'jigwright.harness-maintenance-grant.v1';

export type HumanSignatureVerifier = (
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
) => boolean;

export function verifyHumanSignatureSafely(
  verifier: HumanSignatureVerifier,
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
): boolean {
  try {
    return verifier(payload, signature, signer, namespace);
  } catch {
    return false;
  }
}

export function sha256(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalDigest(value: unknown): Sha256Digest {
  return sha256(canonicalJson(value));
}

export function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw workflowError(
      code,
      'Expected a canonical sha256 digest.',
      ExitCode.usage,
    );
  }
}

export function assertNonEmpty(
  value: unknown,
  code: string,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw workflowError(
      code,
      `${label} must be a non-empty trimmed string.`,
      ExitCode.usage,
    );
  }
}

export function assertIsoTimestamp(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw workflowError(
      code,
      'Expected a canonical ISO-8601 timestamp.',
      ExitCode.usage,
    );
  }
}

export function assertSortedUnique(
  values: readonly string[],
  code: string,
): void {
  const expected = [...new Set(values)].sort(compareCanonicalStrings);
  if (canonicalJson(values) !== canonicalJson(expected)) {
    throw workflowError(
      code,
      'Values must be sorted and unique.',
      ExitCode.usage,
    );
  }
}

export function assertSafePath(
  value: string,
  allowGlob: boolean,
  code: string,
): void {
  assertNonEmpty(value, code, 'Path');
  if (
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..') ||
    (!allowGlob && /[*?[\]{}]/.test(value))
  ) {
    throw workflowError(code, `Unsafe path: ${value}`, ExitCode.usage);
  }
}

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function hasExactObjectKeys(
  value: unknown,
  keys: readonly string[],
): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    sameJson(Object.keys(value).sort(), [...keys].sort())
  );
}

export function assertMonotonicTimestamp(
  previous: string,
  next: string,
  code: string,
): void {
  assertIsoTimestamp(next, code);
  if (Date.parse(next) < Date.parse(previous)) {
    throw workflowError(
      code,
      'Journal timestamps must be monotonic.',
      ExitCode.staleState,
    );
  }
}
