/**
 * Validates bounded manifest values and canonical digest reference
 * collections.
 *
 * Invariants:
 * - Digest reference collections reject duplicates after sorting.
 */
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import crypto from 'node:crypto';
import type { InvestigationV3FailureCode } from './investigation-manifest.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const MAX_TEXT_BYTES = 16 * 1024;

export function normalizeSemanticAuthor(
  value: unknown,
): InvestigationSemanticAuthor {
  const record = assertRecord(value);
  assertExactKeys(record, ['id', 'provenance']);
  return {
    id: boundedText(record.id, 'semantic author ID'),
    provenance: boundedText(record.provenance, 'semantic author provenance'),
  };
}

export function normalizeDigestArray(
  value: unknown,
  allowEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string' || !DIGEST.test(entry))
  ) {
    throw unrepresentable('Digest reference array is malformed.');
  }
  const sorted = [...value].sort();
  assertUnique(sorted, 'digest references');
  return sorted;
}

export function normalizeTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw unrepresentable('Text array is malformed.');
  }
  const values = value.map((entry) => boundedText(entry, 'text value'));
  assertUnique(values, 'text values');
  return values;
}

export function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : boundedText(value, label);
}

export function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw unrepresentable(`${label} is malformed.`);
  }
  return value;
}

export function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw unrepresentable('Digest is malformed.');
  }
}

export function assertGitObjectId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    throw unrepresentable('Git object identity is malformed.');
  }
}

export function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw unrepresentable(`${label} contain duplicates.`);
  }
}

export function assertRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw unrepresentable('Manifest object is malformed.');
  }
  return value;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    !keys.every((key) => expected.includes(key))
  ) {
    throw unrepresentable('Manifest object has unknown or missing properties.');
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sourceTupleKey(pathRawBase64: string, blobOid: string): string {
  return canonicalJson([pathRawBase64, blobOid]);
}

export function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function rawSha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function digestWithDomain(domain: string, value: unknown): string {
  return digest({ domain, value });
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export class ManifestValidationError extends Error {
  readonly code: InvestigationV3FailureCode;

  constructor(code: InvestigationV3FailureCode, message: string) {
    super(message);
    this.name = 'ManifestValidationError';
    this.code = code;
  }
}

export function unrepresentable(message: string): ManifestValidationError {
  return new ManifestValidationError('MANIFEST_UNREPRESENTABLE', message);
}

export const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified' as const;
