/** Canonical bounded implementation-term review evidence. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { NormalizedSearchTerm } from '../source/search-term.ts';
const DISPOSITION_CLASSIFICATIONS = new Set([
  'load-bearing',
  'test-or-mirror',
  'generated',
  'incidental-reference',
  'irrelevant',
]);
export type ImplementationTermOrigin =
  | 'added-identifier'
  | 'deleted-identifier'
  | 'added-literal'
  | 'deleted-literal'
  | 'modified-outer-symbol'
  | 'alias-one-hop';

export type ImplementationDeltaTerm = NormalizedSearchTerm &
  Readonly<{ origins: readonly ImplementationTermOrigin[] }>;

export type ImplementationAffectedGroup = Readonly<{
  groupId: string;
  termId: string;
  rootId: string;
  extension: Readonly<{ rawBase64: string; utf8: string | null }>;
  mutationClass: string;
  hitCount: number;
  paths: readonly string[];
}>;

export type ImplementationTermDelta = Readonly<{
  schemaVersion: 1;
  kind: 'implementation-term-delta';
  baselineCommit: string;
  implementationTree: string;
  knownTermIds: readonly string[];
  newTerms: readonly ImplementationDeltaTerm[];
  scanEvidenceDigest: string;
  affectedGroups: readonly ImplementationAffectedGroup[];
}>;

export type ImplementationTermDisposition = Readonly<{
  groupId: string;
  classification: string;
  rationale: string;
  author: string;
}>;

export function assertImplementationTermDispositions(
  delta: ImplementationTermDelta,
  value: unknown,
): readonly ImplementationTermDisposition[] {
  if (!Array.isArray(value)) {
    throw termInvalid('Implementation term dispositions must be an array.');
  }
  const expected = new Set(delta.affectedGroups.map(({ groupId }) => groupId));
  const seen = new Set<string>();
  const dispositions = value.map((entry): ImplementationTermDisposition => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, [
        'groupId',
        'classification',
        'rationale',
        'author',
      ]) ||
      typeof entry.groupId !== 'string' ||
      !expected.has(entry.groupId) ||
      seen.has(entry.groupId) ||
      typeof entry.classification !== 'string' ||
      !DISPOSITION_CLASSIFICATIONS.has(entry.classification) ||
      typeof entry.rationale !== 'string' ||
      entry.rationale.trim() !== entry.rationale ||
      entry.rationale.length === 0 ||
      typeof entry.author !== 'string' ||
      entry.author.trim() !== entry.author ||
      entry.author.length === 0
    ) {
      throw workflowError(
        'IMPLEMENTATION_TERM_DISPOSITION_REQUIRED',
        'Every affected implementation-term group requires one typed disposition.',
        ExitCode.verification,
      );
    }
    seen.add(entry.groupId);
    return Object.freeze({
      groupId: entry.groupId,
      classification: entry.classification,
      rationale: entry.rationale,
      author: entry.author,
    });
  });
  dispositions.sort((left, right) => left.groupId.localeCompare(right.groupId));
  if (
    seen.size !== expected.size ||
    canonicalJson(dispositions) !== canonicalJson(value)
  ) {
    throw workflowError(
      'IMPLEMENTATION_TERM_DISPOSITION_REQUIRED',
      'Every affected implementation-term group requires one canonical typed disposition.',
      ExitCode.verification,
    );
  }
  return Object.freeze(dispositions);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function termInvalid(message: string) {
  return workflowError(
    'IMPLEMENTATION_TERM_FLOOR_INVALID',
    message,
    ExitCode.verification,
  );
}
