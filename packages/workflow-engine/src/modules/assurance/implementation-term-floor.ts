/** Pure hunk extraction and bounded implementation-term delta decisions. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeInvestigationTerm } from '../investigation/domain/investigation-terms.ts';
import type {
  SearchTermKind as InvestigationTermKind,
  NormalizedSearchTerm as NormalizedInvestigationTerm,
} from '../source/search-term.ts';
import type {
  ImplementationTermOrigin,
  ImplementationDeltaTerm,
  ImplementationAffectedGroup,
  ImplementationTermDelta,
} from './implementation-term-dispositions.ts';
export { assertImplementationTermDispositions } from './implementation-term-dispositions.ts';
export type {
  ImplementationTermOrigin,
  ImplementationDeltaTerm,
  ImplementationAffectedGroup,
  ImplementationTermDelta,
  ImplementationTermDisposition,
} from './implementation-term-dispositions.ts';
/** The facts consumed by finalization, independent of scanner storage and grouping implementation. */
export type ImplementationTermScanObservation =
  | Readonly<{ outcome: 'requires-narrowing'; violations: unknown }>
  | Readonly<{
      outcome: 'ready';
      facts: unknown;
      groups: readonly Readonly<{
        key: string;
        selector: Pick<
          ImplementationAffectedGroup,
          'termId' | 'rootId' | 'extension' | 'mutationClass'
        >;
        hits: readonly Readonly<{
          path: Readonly<{ rawBase64: string; utf8: string | null }>;
        }>[];
      }>[];
    }>;
const MAX_FINALIZATION_TERMS = 64;
const TERM_ORIGINS = new Set<ImplementationTermOrigin>([
  'added-identifier',
  'deleted-identifier',
  'added-literal',
  'deleted-literal',
  'modified-outer-symbol',
  'alias-one-hop',
]);
const LANGUAGE_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

export function extractImplementationDeltaTerms(
  diffs: readonly string[],
  knownTermIds: readonly string[],
): ImplementationDeltaTerm[] {
  const extracted = new Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      origins: Set<ImplementationTermOrigin>;
    }
  >();
  for (const diff of diffs) {
    collectHunkTerms(diff, extracted);
  }
  const newTerms = [...extracted.values()]
    .filter(({ term }) => !knownTermIds.includes(term.termId))
    .map(({ term, origins }): ImplementationDeltaTerm =>
      Object.freeze({
        ...term,
        origins: Object.freeze([...origins].sort()),
      }),
    )
    .sort((left, right) => left.termId.localeCompare(right.termId));
  if (newTerms.length > MAX_FINALIZATION_TERMS) {
    throw workflowError(
      'IMPLEMENTATION_TERM_ESCALATION_REQUIRED',
      'Implementation hunks introduced more terms than one bounded incremental review can admit.',
      ExitCode.verification,
      { details: { observed: newTerms.length, limit: MAX_FINALIZATION_TERMS } },
    );
  }
  return newTerms;
}
export function buildImplementationTermDelta(input: {
  baselineCommit: string;
  implementationTree: string;
  knownTermIds: readonly string[];
  newTerms: readonly ImplementationDeltaTerm[];
  scan: ImplementationTermScanObservation;
}): ImplementationTermDelta {
  const { implementationTree, knownTermIds, newTerms } = input;
  if (newTerms.length === 0) {
    return deepFreeze({
      schemaVersion: 1,
      kind: 'implementation-term-delta',
      baselineCommit: input.baselineCommit,
      implementationTree,
      knownTermIds,
      newTerms: [],
      scanEvidenceDigest: sha256(canonicalJson([])),
      affectedGroups: [],
    });
  }
  const scan = input.scan;
  if (scan.outcome !== 'ready') {
    throw workflowError(
      'IMPLEMENTATION_TERM_ESCALATION_REQUIRED',
      'Implementation term scan exceeded the single bounded incremental round.',
      ExitCode.verification,
      { details: { violations: scan.violations } },
    );
  }
  const affectedGroups = scan.groups
    .map((group): ImplementationAffectedGroup => {
      return Object.freeze({
        groupId: group.key,
        termId: group.selector.termId,
        rootId: group.selector.rootId,
        extension: Object.freeze({ ...group.selector.extension }),
        mutationClass: group.selector.mutationClass,
        hitCount: group.hits.length,
        paths: Object.freeze(
          [
            ...new Set(
              group.hits.map(
                ({ path: hitPath }) =>
                  hitPath.utf8 ?? `base64:${hitPath.rawBase64}`,
              ),
            ),
          ].sort(),
        ),
      });
    })
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
  const representedTerms = new Set(affectedGroups.map(({ termId }) => termId));
  for (const term of newTerms) {
    if (representedTerms.has(term.termId)) continue;
    affectedGroups.push(
      Object.freeze({
        groupId: sha256(
          canonicalJson({
            schema: 'implementation-zero-hit-group.v1',
            termId: term.termId,
            tree: implementationTree,
          }),
        ),
        termId: term.termId,
        rootId: 'repository',
        extension: Object.freeze({
          rawBase64: Buffer.from('<zero-hit>', 'utf8').toString('base64'),
          utf8: '<zero-hit>',
        }),
        mutationClass: 'live',
        hitCount: 0,
        paths: Object.freeze([]),
      }),
    );
  }
  affectedGroups.sort((left, right) =>
    left.groupId.localeCompare(right.groupId),
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: 'implementation-term-delta',
    baselineCommit: input.baselineCommit,
    implementationTree,
    knownTermIds,
    newTerms,
    scanEvidenceDigest: sha256(canonicalJson(scan.facts)),
    affectedGroups,
  });
}
function collectHunkTerms(
  diff: string,
  target: Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      origins: Set<ImplementationTermOrigin>;
    }
  >,
): void {
  let outerSymbol: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      outerSymbol = declarationName(line.slice(line.indexOf('@@', 2) + 2));
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const marker = line[0];
    if (marker !== '+' && marker !== '-' && marker !== ' ') continue;
    const source = line.slice(1);
    const declaration = declarationName(source);
    if (declaration !== null) outerSymbol = declaration;
    if (marker === ' ') continue;
    const added = marker === '+';
    for (const identifier of identifiers(source)) {
      addTerm(
        target,
        'symbol',
        identifier,
        added ? 'added-identifier' : 'deleted-identifier',
      );
    }
    for (const literal of literals(source)) {
      addTerm(
        target,
        'literal-content',
        literal,
        added ? 'added-literal' : 'deleted-literal',
      );
    }
    for (const alias of aliases(source)) {
      addTerm(target, 'symbol', alias, 'alias-one-hop');
    }
    if (outerSymbol !== null) {
      addTerm(target, 'symbol', outerSymbol, 'modified-outer-symbol');
    }
  }
}

function addTerm(
  target: Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      origins: Set<ImplementationTermOrigin>;
    }
  >,
  kind: InvestigationTermKind,
  value: string,
  origin: ImplementationTermOrigin,
): void {
  if (!TERM_ORIGINS.has(origin)) throw termInvalid('Unknown hunk-term origin.');
  let term: NormalizedInvestigationTerm;
  try {
    term = normalizeInvestigationTerm({ kind, value });
  } catch {
    return;
  }
  const current = target.get(term.termId) ?? { term, origins: new Set() };
  current.origins.add(origin);
  target.set(term.termId, current);
}

function identifiers(source: string): string[] {
  const withoutQuotedLiterals = source.replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    ' ',
  );
  return [...withoutQuotedLiterals.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .map(([value]) => value)
    .filter((value) => !LANGUAGE_KEYWORDS.has(value));
}

function literals(source: string): string[] {
  const values: string[] = [];
  for (const expression of [
    /'((?:\\.|[^'\\])*)'/g,
    /"((?:\\.|[^"\\])*)"/g,
    /`((?:\\.|[^`\\])*)`/g,
  ]) {
    for (const match of source.matchAll(expression)) {
      if (match[1] !== undefined && match[1].length >= 3) values.push(match[1]);
    }
  }
  for (const match of source.matchAll(
    /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g,
  )) {
    if (match[0].length >= 3) values.push(match[0]);
  }
  return values;
}

function aliases(source: string): string[] {
  return [
    ...source.matchAll(
      /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    ),
  ].flatMap((match) => [match[1]!, match[2]!]);
}

function declarationName(source: string): string | null {
  return (
    /\b(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
      source,
    )?.[1] ?? null
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function termInvalid(message: string) {
  return workflowError(
    'IMPLEMENTATION_TERM_FLOOR_INVALID',
    message,
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
