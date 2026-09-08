/**
 * Indexes semantic subjects by exact source, import bindings, and freshness policy.
 *
 * Invariants:
 * - Explanations remain in source headers; entries contain no second prose authority.
 * - Content-addressed entries preserve history and explicit supersession.
 */

import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SUBJECT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const SEMANTIC_SUBJECT_KINDS = Object.freeze([
  'file',
  'symbol',
  'schema-section',
  'config-contract',
  'state-transition',
  'cli-command',
  'persistence-format',
  'migration-step',
  'policy-rule',
  'test-contract',
  'document-section',
] as const);

export type SemanticSubjectKind = (typeof SEMANTIC_SUBJECT_KINDS)[number];

export function isSemanticSubjectId(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_ID.test(value);
}

/** Stable file-level fallback identity shared by planning and reconciliation. */
export function semanticFileSubjectId(subjectPath: string): string {
  return `file.${crypto.createHash('sha256').update(subjectPath).digest('hex')}`;
}

export type SemanticSubject = Readonly<{
  subjectId: string;
  kind: SemanticSubjectKind;
  path: string;
  symbol?: string;
}>;

export type SemanticBinding = Readonly<{
  baselineCommit: string;
  blobDigest: string;
  sourceDigest: string;
  semanticDigest: string;
  extractorVersion: string;
}>;

export type SemanticDependency = Readonly<{
  relation: string;
  subjectId: string;
  path: string;
  sourceDigest: string | null;
}>;

export type LedgerEntry = Readonly<{
  schemaVersion: 2;
  kind: 'semantic-ledger-entry';
  entryId: string;
  subject: SemanticSubject;
  binding: SemanticBinding;
  semanticDependencies: readonly SemanticDependency[];
  dependencySetDigest: string;
  policyDigest: string;
  provenance: Readonly<{ changeId: string; createdAtCommit: string }>;
  supersedes: string | null;
  status: 'current' | 'superseded' | 'tombstone';
}>;

export type LedgerEntryInput = Omit<
  LedgerEntry,
  'entryId' | 'dependencySetDigest'
>;

/**
 * The identity of an entry is its content. Two authors who record the same
 * understanding of the same subject under the same policy produce the same
 * entry, and any change to what was understood produces a different one —
 * which is what makes "is this still the entry we reviewed?" a question with
 * an answer.
 */
export function semanticLedgerEntryId(input: LedgerEntryInput): string {
  const semanticDependencies = canonicalDependencies(
    input.semanticDependencies,
  );
  return digest(
    canonicalJson({
      schemaVersion: input.schemaVersion,
      kind: input.kind,
      subject: input.subject,
      binding: input.binding,
      semanticDependencies,
      dependencySetDigest: dependencySetDigest(semanticDependencies),
      policyDigest: input.policyDigest,
      provenance: input.provenance,
      supersedes: input.supersedes,
      status: input.status,
    }),
  );
}

/**
 * Digest over the direct dependencies, sorted. Transitive reach is resolved
 * through the current graph rather than baked in here: an entry that pinned
 * its whole transitive closure would be invalidated by changes it does not
 * actually depend on.
 */
export function dependencySetDigest(
  dependencies: readonly SemanticDependency[],
): string {
  return digest(canonicalJson(canonicalDependencies(dependencies)));
}

export function createLedgerEntry(input: LedgerEntryInput): LedgerEntry {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'binding',
      'kind',
      'policyDigest',
      'provenance',
      'schemaVersion',
      'semanticDependencies',
      'status',
      'subject',
      'supersedes',
    ]) ||
    input.schemaVersion !== 2 ||
    input.kind !== 'semantic-ledger-entry' ||
    !['current', 'superseded', 'tombstone'].includes(input.status)
  ) {
    throw ledgerInvalid('A semantic ledger entry envelope is malformed.');
  }
  assertSubject(input.subject);
  assertBinding(input.binding);
  assertProvenance(input.provenance);
  if (!Array.isArray(input.semanticDependencies)) {
    throw ledgerInvalid('Semantic dependencies are malformed.');
  }
  for (const dependency of input.semanticDependencies) {
    if (
      !isPlainRecord(dependency) ||
      !hasExactKeys(dependency, [
        'path',
        'sourceDigest',
        'relation',
        'subjectId',
      ]) ||
      !isSemanticSubjectId(dependency.subjectId) ||
      typeof dependency.path !== 'string' ||
      dependency.path.trim() === '' ||
      (dependency.sourceDigest !== null &&
        (typeof dependency.sourceDigest !== 'string' ||
          !DIGEST.test(dependency.sourceDigest))) ||
      typeof dependency.relation !== 'string' ||
      dependency.relation.trim() === ''
    ) {
      throw ledgerInvalid('A semantic dependency is malformed.');
    }
  }
  if (
    typeof input.policyDigest !== 'string' ||
    !DIGEST.test(input.policyDigest)
  ) {
    throw ledgerInvalid('An entry records the policy that judged it.');
  }
  if (
    input.supersedes !== null &&
    (typeof input.supersedes !== 'string' || !DIGEST.test(input.supersedes))
  ) {
    throw ledgerInvalid('A superseded entry is named by digest.');
  }
  const semanticDependencies = Object.freeze(
    canonicalDependencies(input.semanticDependencies),
  );
  const normalized: LedgerEntryInput = Object.freeze({
    schemaVersion: 2,
    kind: 'semantic-ledger-entry',
    subject: input.subject,
    binding: input.binding,
    semanticDependencies,
    policyDigest: input.policyDigest,
    provenance: input.provenance,
    supersedes: input.supersedes,
    status: input.status,
  });
  return Object.freeze({
    ...normalized,
    dependencySetDigest: dependencySetDigest(semanticDependencies),
    entryId: semanticLedgerEntryId(normalized),
  });
}

function canonicalDependencies(
  dependencies: readonly SemanticDependency[],
): SemanticDependency[] {
  return [...dependencies].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

/** Recomputes identity on read; a claimed entry ID is never trusted. */
export function assertLedgerEntry(value: unknown): LedgerEntry {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'binding',
      'dependencySetDigest',
      'entryId',
      'kind',
      'policyDigest',
      'provenance',
      'schemaVersion',
      'semanticDependencies',
      'status',
      'subject',
      'supersedes',
    ])
  ) {
    throw ledgerInvalid('A ledger entry is an object.');
  }
  const raw = value;
  if (raw.schemaVersion !== 2 || raw.kind !== 'semantic-ledger-entry') {
    throw ledgerInvalid('Ledger entry identity is wrong.');
  }
  const { entryId, dependencySetDigest: claimed, ...rest } = raw;
  const rebuilt = createLedgerEntry(rest as unknown as LedgerEntryInput);
  if (rebuilt.entryId !== entryId || rebuilt.dependencySetDigest !== claimed) {
    throw ledgerInvalid('Ledger entry does not match its own content.');
  }
  return rebuilt;
}

function assertSubject(subject: unknown): asserts subject is SemanticSubject {
  if (
    !isPlainRecord(subject) ||
    !hasExactKeys(
      subject,
      Object.hasOwn(subject, 'symbol')
        ? ['kind', 'path', 'subjectId', 'symbol']
        : ['kind', 'path', 'subjectId'],
    ) ||
    !isSemanticSubjectId(subject.subjectId) ||
    !SEMANTIC_SUBJECT_KINDS.includes(subject.kind as SemanticSubjectKind) ||
    typeof subject.path !== 'string' ||
    (Object.hasOwn(subject, 'symbol') &&
      (typeof subject.symbol !== 'string' || subject.symbol.trim() === '')) ||
    subject.path.trim() === ''
  ) {
    throw ledgerInvalid('A semantic subject is malformed.');
  }
}

function assertBinding(subject: unknown): asserts subject is SemanticBinding {
  if (
    !isPlainRecord(subject) ||
    !hasExactKeys(subject, [
      'baselineCommit',
      'blobDigest',
      'extractorVersion',
      'semanticDigest',
      'sourceDigest',
    ])
  ) {
    throw ledgerInvalid('A semantic binding is malformed.');
  }
  const binding = subject;
  if (
    typeof binding.baselineCommit !== 'string' ||
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(binding.baselineCommit) ||
    typeof binding.blobDigest !== 'string' ||
    !DIGEST.test(binding.blobDigest) ||
    typeof binding.sourceDigest !== 'string' ||
    !DIGEST.test(binding.sourceDigest) ||
    typeof binding.semanticDigest !== 'string' ||
    !DIGEST.test(binding.semanticDigest) ||
    typeof binding.extractorVersion !== 'string' ||
    binding.extractorVersion.trim() === ''
  ) {
    throw ledgerInvalid('A semantic binding is malformed.');
  }
}

function assertProvenance(
  value: unknown,
): asserts value is LedgerEntry['provenance'] {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['changeId', 'createdAtCommit']) ||
    typeof value.changeId !== 'string' ||
    value.changeId.trim() === '' ||
    typeof value.createdAtCommit !== 'string' ||
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.createdAtCommit)
  ) {
    throw ledgerInvalid('Semantic ledger provenance is malformed.');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function ledgerInvalid(message: string) {
  return workflowError('SEMANTIC_LEDGER_INVALID', message, ExitCode.usage);
}
