/**
 * Preserves actionable archive failure details within the diagnostic byte
 * budget.
 *
 * Invariants:
 * - Each retained diagnostic component must fit within the budget after
 *   canonical serialization.
 */
import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';

const MAX_DIAGNOSTIC_BYTES = 8_192;

/**
 * Projects a failure cause into the bounded payload the archive error carries.
 * The archive wrapper used to keep only the cause's code, which discarded the
 * named requirements and scenarios that say what to repair. Everything here is
 * already schema-validated before it reaches an error, but size is bounded
 * again because diagnostics travel into logs and reports.
 */
export function boundedArchiveCauseDiagnostic(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof WorkflowError)) return {};
  const diagnostic: Record<string, unknown> = { causeCode: error.code };
  if (!withinDiagnosticBudget(diagnostic)) return {};

  const details = boundedStructuredCauseDetails(error.details, diagnostic);
  if (details !== undefined) {
    diagnostic.causeDetails = details;
  }

  const withMessage = { ...diagnostic, causeMessage: error.message };
  if (withinDiagnosticBudget(withMessage)) {
    diagnostic.causeMessage = error.message;
  }
  return diagnostic;
}

export function withinDiagnosticBudget(value: unknown): boolean {
  try {
    return (
      Buffer.byteLength(canonicalJson(value), 'utf8') <= MAX_DIAGNOSTIC_BYTES
    );
  } catch {
    return false;
  }
}

const STRUCTURED_REPAIR_HINT_KEYS = new Set([
  'capability',
  'faults',
  'from',
  'id',
  'identities',
  'identity',
  'issues',
  'message',
  'missingScenarios',
  'operation',
  'path',
  'reason',
  'rejectedSpecs',
  'renameCandidate',
  'renameCandidates',
  'renamed',
  'requirement',
  'scenario',
  'scenarios',
  'spec',
  'to',
]);

function boundedStructuredCauseDetails(
  details: Record<string, unknown> | undefined,
  diagnostic: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  if (withinDiagnosticBudget({ ...diagnostic, causeDetails: details })) {
    return details;
  }

  const projected = projectStructuredRepairHints(details, false, new Set());
  if (!isRecord(projected) || Object.keys(projected).length === 0) {
    return undefined;
  }
  if (withinDiagnosticBudget({ ...diagnostic, causeDetails: projected })) {
    return projected;
  }

  const bounded: Record<string, unknown> = {};
  for (const key of orderedRepairHintKeys(projected)) {
    const value = projected[key];
    if (
      withinDiagnosticBudget({
        ...diagnostic,
        causeDetails: { ...bounded, [key]: value },
      })
    ) {
      bounded[key] = value;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const entries: unknown[] = [];
    for (const entry of value) {
      if (
        !withinDiagnosticBudget({
          ...diagnostic,
          causeDetails: { ...bounded, [key]: [...entries, entry] },
        })
      ) {
        continue;
      }
      entries.push(entry);
    }
    if (entries.length > 0) bounded[key] = entries;
  }
  return Object.keys(bounded).length === 0 ? undefined : bounded;
}

function projectStructuredRepairHints(
  value: unknown,
  retainPrimitive: boolean,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return retainPrimitive ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    try {
      const entries = value.flatMap((entry) => {
        const projected = projectStructuredRepairHints(
          entry,
          retainPrimitive,
          ancestors,
        );
        return projected === undefined ? [] : [projected];
      });
      return entries.length === 0 ? undefined : entries;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value)) return undefined;
  if (ancestors.has(value)) return undefined;

  ancestors.add(value);
  try {
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCanonicalStrings)) {
      const child = projectStructuredRepairHints(
        value[key],
        STRUCTURED_REPAIR_HINT_KEYS.has(key),
        ancestors,
      );
      if (child !== undefined) projected[key] = child;
    }
    return Object.keys(projected).length === 0 ? undefined : projected;
  } finally {
    ancestors.delete(value);
  }
}

function orderedRepairHintKeys(value: Record<string, unknown>): string[] {
  const priority = [
    'capability',
    'requirement',
    'missingScenarios',
    'identities',
    'identity',
    'renameCandidates',
    'renameCandidate',
    'renamed',
    'from',
    'to',
    'faults',
    'rejectedSpecs',
    'issues',
    'spec',
    'path',
    'operation',
    'reason',
    'message',
    'id',
  ];
  return Object.keys(value).sort((left, right) => {
    const leftRank = priority.indexOf(left);
    const rightRank = priority.indexOf(right);
    return (
      (leftRank === -1 ? priority.length : leftRank) -
        (rightRank === -1 ? priority.length : rightRank) ||
      compareCanonicalStrings(left, right)
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
