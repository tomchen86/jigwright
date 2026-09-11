/**
 * Captures and validates verbatim governance Sources with explicit
 * authorship and content identity.
 *
 * Invariants:
 * - Maintainer Sources require a direct-human or maintainer-confirmation
 *   reference; secret-like text is rejected.
 */
import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';

export type GovernanceSourceAuthorV1 = 'maintainer' | 'agent';

export type GovernanceSourceV1 = Readonly<{
  schemaVersion: 1;
  id: `SRC-${string}`;
  semanticAuthor: GovernanceSourceAuthorV1;
  capturedBy: string;
  capturedAt: string;
  contextRef: string;
  text: string;
  textDigest: `sha256:${string}`;
  supersedes: `SRC-${string}` | null;
}>;

export type GovernanceSourceAuthoringV1 = Readonly<{
  semanticAuthor: GovernanceSourceAuthorV1;
  capturedBy: string;
  capturedAt: string;
  contextRef: string;
  text: string;
  supersedes: `SRC-${string}` | null;
}>;

export type GovernanceSourceErrorCode =
  | 'GOVERNANCE_SOURCE_INVALID'
  | 'GOVERNANCE_SOURCE_AUTHORSHIP_UNPROVEN'
  | 'GOVERNANCE_SOURCE_SECRET_REJECTED'
  | 'GOVERNANCE_SOURCE_IDENTITY_INVALID';

export class GovernanceSourceError extends TypeError {
  readonly code: GovernanceSourceErrorCode;

  constructor(code: GovernanceSourceErrorCode, message: string) {
    super(message);
    this.name = 'GovernanceSourceError';
    this.code = code;
  }
}

const SOURCE_ID = /^SRC-[0-9a-f]{64}$/;
const BOUNDED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;
const MAINTAINER_CONTEXT = /^(?:direct-human|maintainer-confirmation):.+/;
const SECRET_LIKE =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b/i;

/** The writer and native agent guidance use the same exact-text contract. */
export const GOVERNANCE_SOURCE_TEXT_POLICY = Object.freeze({
  preservation: 'verbatim',
  echoField: 'originalText',
  maxBytes: 16_384,
} as const);

export function createGovernanceSourceV1(
  input: GovernanceSourceAuthoringV1,
): GovernanceSourceV1 {
  const semanticAuthor = assertAuthor(input.semanticAuthor);
  const capturedBy = boundedToken(input.capturedBy, 'capturedBy');
  const capturedAt = canonicalTimestamp(input.capturedAt);
  const contextRef = boundedToken(input.contextRef, 'contextRef');
  const text = exactSourceText(input.text);
  const supersedes = optionalSourceId(input.supersedes);

  if (semanticAuthor === 'maintainer' && !MAINTAINER_CONTEXT.test(contextRef)) {
    throw new GovernanceSourceError(
      'GOVERNANCE_SOURCE_AUTHORSHIP_UNPROVEN',
      'Maintainer authorship needs a direct-human reference or explicit maintainer confirmation.',
    );
  }
  if (SECRET_LIKE.test(text)) {
    throw new GovernanceSourceError(
      'GOVERNANCE_SOURCE_SECRET_REJECTED',
      'Secret-like text cannot be stored in the governance Source ledger.',
    );
  }

  const textDigest = sha256(text);
  const payload = {
    schemaVersion: 1 as const,
    semanticAuthor,
    capturedBy,
    capturedAt,
    contextRef,
    text,
    textDigest,
    supersedes,
  };
  return {
    schemaVersion: 1,
    id: `SRC-${digestHex(canonicalJson(payload))}`,
    semanticAuthor,
    capturedBy,
    capturedAt,
    contextRef,
    text,
    textDigest,
    supersedes,
  };
}

export function parseGovernanceSourceV1(value: unknown): GovernanceSourceV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) {
    throw invalidSource();
  }
  if (value.schemaVersion !== 1 || typeof value.id !== 'string') {
    throw invalidSource();
  }
  const source = createGovernanceSourceV1({
    semanticAuthor: assertAuthor(value.semanticAuthor),
    capturedBy: boundedToken(value.capturedBy, 'capturedBy'),
    capturedAt: canonicalTimestamp(value.capturedAt),
    contextRef: boundedToken(value.contextRef, 'contextRef'),
    text: exactSourceText(value.text),
    supersedes: optionalSourceId(value.supersedes),
  });
  if (
    value.id !== source.id ||
    value.textDigest !== source.textDigest ||
    !SOURCE_ID.test(value.id)
  ) {
    throw new GovernanceSourceError(
      'GOVERNANCE_SOURCE_IDENTITY_INVALID',
      'Governance Source identity does not match its exact canonical payload.',
    );
  }
  return source;
}

const SOURCE_KEYS = [
  'capturedAt',
  'capturedBy',
  'contextRef',
  'id',
  'schemaVersion',
  'semanticAuthor',
  'supersedes',
  'text',
  'textDigest',
] as const;

function assertAuthor(value: unknown): GovernanceSourceAuthorV1 {
  if (value !== 'maintainer' && value !== 'agent') throw invalidSource();
  return value;
}

function boundedToken(value: unknown, field: string): string {
  if (typeof value !== 'string' || !BOUNDED_TOKEN.test(value)) {
    throw new GovernanceSourceError(
      'GOVERNANCE_SOURCE_INVALID',
      `Governance Source ${field} is invalid.`,
    );
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw invalidSource();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw invalidSource();
  }
  return value;
}

function exactSourceText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > GOVERNANCE_SOURCE_TEXT_POLICY.maxBytes ||
    value.includes('\0')
  ) {
    throw invalidSource();
  }
  return value;
}

function optionalSourceId(value: unknown): `SRC-${string}` | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SOURCE_ID.test(value)) {
    throw invalidSource();
  }
  return value as `SRC-${string}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${digestHex(value)}`;
}

function digestHex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidSource(): GovernanceSourceError {
  return new GovernanceSourceError(
    'GOVERNANCE_SOURCE_INVALID',
    'Governance Source is invalid.',
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
